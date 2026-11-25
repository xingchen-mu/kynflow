import { join } from 'node:path';
import sharp from 'sharp';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentHarnessProfile, CanvasItem } from '../../../shared/types.ts';
import { config } from '../../config.ts';
import { AssetStore, publicAsset } from '../../assets/store.ts';
import { ProjectStore } from '../../projects/store.ts';
import { TaskManager } from '../../tasks/manager.ts';
import { ComfyClient } from '../../comfy/client.ts';
import { SettingsStore } from '../../settings.ts';
import { AgentHub, type AgentHubOptions } from '../runtime.ts';
import { MemoryStore } from '../memory.ts';
import { MockComfyServer, benchmarkWorkflows } from './mock-comfy.ts';
import { evaluateBenchmark } from './metrics.ts';
import type { AgentBenchmarkCase, BenchmarkObservation } from './types.ts';
import { MOCK_PROTOCOL_INSTRUCTIONS } from './protocol.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call in an isolated worker with its own DATA_DIR. Never reuses the owner's boards or ComfyUI. */
export async function runBenchmarkCase(spec: AgentBenchmarkCase, options: { mode: 'scripted' | 'live'; profile: AgentHarnessProfile }) {
  const assets = new AssetStore();
  const projects = new ProjectStore();
  await Promise.all([assets.init(), projects.init()]);
  const leftRight = await sharp(Buffer.from('<svg width="256" height="128" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="128" fill="white"/><rect x="12" y="20" width="88" height="88" fill="#f00000"/><rect x="156" y="20" width="88" height="88" fill="#0000f0"/></svg>')).png().toBuffer();
  const circle = await sharp(Buffer.from('<svg width="256" height="128" xmlns="http://www.w3.org/2000/svg"><rect width="256" height="128" fill="white"/><circle cx="128" cy="64" r="48" fill="#00a000"/></svg>')).png().toBuffer();
  const source = publicAsset(await assets.save(leftRight, { filename: 'left-right.png', mime: 'image/png' }));
  const second = publicAsset(await assets.save(circle, { filename: 'circle.png', mime: 'image/png' }));
  const project = await projects.create(`benchmark-${spec.id}`);
  const images: CanvasItem[] = ['a', 'b', 'c'].map((id, index) => ({ id: `image-${id}`, name: `镜头 ${index + 1}`, kind: 'image', asset: index === 1 ? second : source, x: index * 300, y: 0, w: 256, h: 128, createdAt: 1 }));
  if (spec.setup === 'composition_failure' || spec.setup === 'text_failure') images[1] = { ...images[1], review: { verdict: 'fail', reason: spec.setup === 'text_failure' ? 'text_wrong' : 'composition', at: 1 }, request: { op: 'image.generate', model: 'qwen', prompt: '旧版本', aspect: '1:1', quality: '1k', images: [source.id] } };
  const script = spec.setup === 'long_note'
    ? `${Array.from({ length: 100 }, (_, index) => `背景资料 ${index}：雨夜车站，保持场景连续。`).join('\n')}\nS03 对白：晚风会带你回家。\n${'其它镜头备注：注意机位和视线。\n'.repeat(100)}`
    : 'S01 开场；S02 相遇；S03 归途。';
  await projects.patchItems(project.id, { upsert: [...images, { id: 'note-script', name: '分镜表', kind: 'text', text: script, x: 0, y: 220, w: 600, h: 400, createdAt: 1 }] });
  const before = structuredClone((await projects.get(project.id))!.items);
  const mock = new MockComfyServer(leftRight, spec.setup === 'oom');
  await mock.start();
  const client = new ComfyClient(mock.url, `benchmark-${spec.id}`);
  const workflows = benchmarkWorkflows().filter((workflow) => spec.setup !== 'upscale_only' || workflow.id === 'eval-upscale');
  const tasks = new TaskManager(client, assets, (id) => workflows.find((workflow) => workflow.id === id), () => undefined);
  mock.onEvent = (event) => tasks.onComfyEvent(event);
  const unavailable: Record<string, string[]> = spec.setup === 'upscale_only' ? { 'image.generate:qwen': ['Reference-image generation is unavailable in this fixture'] } : {};
  const deps = { assets, projects, tasks, workflows: () => workflows,
    capabilities: async () => ({ comfyOnline: spec.setup !== 'offline', comfyUrl: mock.url,
      features: unavailable, models: {} }),
    changed: () => {}, commercialOnly: () => false };
  const opts: AgentHubOptions = { profile: options.profile, generationEnvironment: 'mock', evaluationInstructions: MOCK_PROTOCOL_INSTRUCTIONS, budget: { ...spec.budget, maxOutputTokens: 2500 } };
  let settings: SettingsStore | undefined;
  if (options.mode === 'scripted') {
    const faux = fauxProvider({ provider: 'benchmark', models: [{ id: 'scripted-v1', input: ['text', 'image'], contextWindow: 200000 }] });
    const models = createModels();
    models.setProvider(faux.provider);
    opts.models = models;
    opts.model = 'benchmark/scripted-v1';
    let at = 0;
    const reply = async () => {
      const action = spec.script[at++];
      if (!action) return fauxAssistantMessage(spec.scriptedAnswer);
      const board = (await projects.get(project.id))!;
      const generated = board.items.filter((item) => !before.some((old) => old.id === item.id) && item.request).map((item) => item.id);
      const resolve = (value: unknown): unknown => {
        if (value === '$layout') return board.items.findLast((item) => item.name === '修复站位')?.id;
        if (Array.isArray(value)) return value.flatMap((entry) => entry === '$generated' ? generated : [resolve(entry)]);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolve(entry)]));
        return value;
      };
      return fauxAssistantMessage(fauxToolCall(action.tool, resolve(action.args) as Parameters<typeof fauxToolCall>[1]));
    };
    faux.setResponses(Array.from({ length: spec.script.length + 8 }, () => reply));
  } else {
    settings = new SettingsStore();
    await settings.init();
  }
  const hub = new AgentHub(deps, () => {}, opts, settings);
  const observation: BenchmarkObservation = { before, after: before, traces: [], tasks: [] };
  try {
    await hub.init();
    if (!hub.status.ready) throw new Error(hub.status.reason ?? 'Model unavailable');
    if (spec.setup === 'preference' || spec.setup === 'character') {
      const memory = new MemoryStore(join(config.dataDir, 'agent'));
      await memory.replace('board', project.id, { entries: [{ type: spec.setup === 'character' ? 'setting' : 'preference',
        text: spec.setup === 'character' ? '林晚：短发，穿深蓝色外套。' : '产品图背景一律使用冷蓝色，不用暖色。', pinned: true }] });
    }
    await hub.send(project.id, { text: spec.request, selection: spec.selection });
    const deadline = Date.now() + spec.budget.durationMs + 4000;
    let quietSince = Date.now();
    while (true) {
      const view = await hub.view(project.id);
      const active = tasks.active().length > 0;
      if (view.running || active) quietSince = Date.now();
      if (!view.running && !active && Date.now() - quietSince > 800) break;
      if (Date.now() > deadline) { await hub.abort(project.id); throw new Error('Case wall-clock budget exceeded'); }
      await pause(25);
    }
  } catch (error) { observation.error = (error as Error).message; }
  finally {
    await hub.abort(project.id).catch(() => {});
    observation.after = structuredClone((await projects.get(project.id))!.items);
    observation.tasks = structuredClone(tasks.list());
    observation.traces = await hub.runTraces(project.id);
    await Promise.all([assets.flush(), tasks.flush()]);
    await mock.close();
    client.close();
  }
  return { result: evaluateBenchmark(spec, observation, options.profile, options.mode), observation, mockRequests: mock.submissions.length };
}
