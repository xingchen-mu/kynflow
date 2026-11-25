// Explicitly opt-in: this script submits real GPU jobs, unlike the protocol benchmark.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AgentRunTrace, CanvasItem, Task } from '../shared/types.ts';
import { config } from '../server/config.ts';
import { SettingsStore } from '../server/settings.ts';
import { AssetStore, publicAsset } from '../server/assets/store.ts';
import { ProjectStore } from '../server/projects/store.ts';
import { PresetStore } from '../server/workflows/presets.ts';
import { WorkflowStore } from '../server/workflows/store.ts';
import { TaskManager } from '../server/tasks/manager.ts';
import { ComfyClient } from '../server/comfy/client.ts';
import { createCapabilities } from '../server/comfy/capabilities.ts';
import { AgentHub } from '../server/agent/runtime.ts';
import { GpuSubmissionBudget } from '../server/agent/evaluation/gpu-budget.ts';
import { gpuReportLabel, gpuReportPath } from '../server/agent/evaluation/gpu-report.ts';
import { redactTraceText } from '../server/agent/trace/redact.ts';

const args = process.argv.slice(2);
if (!args.includes('--real-gpu')) throw new Error('This test uses the configured GPU. Pass --real-gpu to opt in.');
const value = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const output = gpuReportPath(value('--output') ?? 'output/agent-gpu-evaluation.json');
const artifactDirectory = join(dirname(output), `${basename(output, '.json')}-assets`);
await mkdir(artifactDirectory, { recursive: true });
const settings = new SettingsStore();
await settings.init();
// The explicit --real-gpu opt-in authorizes this bounded test, without changing saved app settings.
settings.value.agentApprovalMode = 'risky';
if (!settings.agentConfig().apiKey) throw new Error('A configured Agent API key is required for live GPU evaluation');
const comfy = new ComfyClient(settings.value.comfyUrl, `kynflow-gpu-eval-${randomUUID()}`);
const initialQueue = await comfy.queue();
if (initialQueue.queue_running.length || initialQueue.queue_pending.length) throw new Error('ComfyUI queue is busy; no GPU test was submitted');
const workflows = new WorkflowStore();
const presets = new PresetStore();
await Promise.all([workflows.init(), presets.init()]);
const capabilities = createCapabilities(comfy, workflows, presets, settings);
const caps = await capabilities.get();
if (!caps.comfyOnline) throw new Error('Configured ComfyUI is offline');
const comfyVersion = gpuReportLabel(caps.comfyVersion);
const gpu = gpuReportLabel(caps.gpu);
const ownerDataDirectory = config.dataDir;
const temporary = await mkdtemp(join(tmpdir(), 'kynflow-real-gpu-'));
config.dataDir = temporary;
const assets = new AssetStore();
const projects = new ProjectStore();
await Promise.all([assets.init(), projects.init()]);
const project = await projects.create('Real GPU agent evaluation');
const tasks = new TaskManager(comfy, assets, (id) => workflows.get(id) ?? presets.get(id), capabilities.cachedObjectInfo);
const budget = new GpuSubmissionBudget();
const submit = tasks.create.bind(tasks);
tasks.create = (request, id) => budget.submit(() => submit(request, id));
const hub = new AgentHub({ assets, projects, tasks, workflows: () => [...workflows.list(), ...presets.list()], capabilities: () => capabilities.get(), changed: () => {}, commercialOnly: () => Boolean(settings.value.commercialOnly) }, (event) => {
  if (event.entry?.kind === 'tool' && event.entry.status !== 'running') console.log(`tool ${event.entry.tool}: ${event.entry.status}`);
}, { profile: 'enhanced', generationEnvironment: 'comfyui', budget: { toolCalls: 18, modelCalls: 20, tokens: 240000, durationMs: 900000, maxOutputTokens: 2500 } }, settings);
comfy.connect((event) => tasks.onComfyEvent(event), (online) => { if (online) tasks.onReconnect(); });
const poll = setInterval(() => tasks.onReconnect(), 3000);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const phases: { name: string; request: string; sessionId: string; tasks: Task[]; traces: AgentRunTrace[]; outputItems: CanvasItem[]; executionPassed: boolean }[] = [];
let error: string | undefined;
let reference: CanvasItem | undefined;

async function runPhase(name: string, request: string, selection: string[], limit: number) {
  budget.start(limit);
  const session = (await hub.view(project.id)).sessionId;
  const beforeTasks = new Set(tasks.list().map((task) => task.id));
  const beforeItems = new Set((await projects.get(project.id))!.items.map((item) => item.id));
  console.log(`phase ${name}: starting; real GPU submission limit ${limit}`);
  await hub.send(project.id, { text: request, selection });
  const deadline = Date.now() + 920000;
  let quietSince = Date.now();
  let lastProgress = '';
  for (;;) {
    const view = await hub.view(project.id);
    const active = tasks.active();
    if (view.running || active.length) quietSince = Date.now();
    const progress = active.map((task) => `${task.id}: ${task.stage ?? task.status} ${Math.round(task.progress * 100)}%`).join('; ');
    if (progress && progress !== lastProgress) { console.log(progress); lastProgress = progress; }
    if (!view.running && !active.length && Date.now() - quietSince > 1000) break;
    if (Date.now() > deadline) throw new Error(`GPU phase ${name} exceeded its wall-clock budget`);
    await pause(500);
  }
  const board = (await projects.get(project.id))!;
  const phaseTasks = tasks.list().filter((task) => !beforeTasks.has(task.id));
  const outputs = board.items.filter((item) => !beforeItems.has(item.id) && item.asset);
  const traces = await hub.runTraces(project.id, session);
  const passed = traces.length > 0 && traces.every((trace) => trace.execution === 'completed') && (limit === 0 ? phaseTasks.length === 0 : phaseTasks.length === 1 && phaseTasks[0].status === 'done' && outputs.length > 0);
  phases.push({ name, request, sessionId: session, tasks: structuredClone(phaseTasks), traces, outputItems: structuredClone(outputs), executionPassed: passed });
  console.log(`phase ${name}: ${passed ? 'EXECUTED' : 'INCOMPLETE'}; ${phaseTasks.length} real GPU submissions`);
  return outputs.find((item) => item.kind === 'image');
}

try {
  await hub.init();
  if (!hub.status.ready) throw new Error(hub.status.reason ?? 'Agent model unavailable');
  if (value('--input')) {
    const input = resolve(value('--input')!);
    const asset = publicAsset(await assets.save(await readFile(input), { filename: basename(input), mime: 'image/png' }));
    reference = { id: 'gpu-reference', kind: 'image', name: 'Original orange mug', asset, x: 0, y: 0, w: 512, h: 512, createdAt: Date.now() };
    await projects.patchItems(project.id, { upsert: [reference] });
  } else {
    reference = await runPhase('text-to-image', '这是实际 GPU 的单图端到端测试。用 Z-Image 生成一张 1k、1:1 的产品照片：木桌上的一个橙色陶瓷杯，单个杯把，浅灰背景、柔和摄影布光。只允许提交一次生成，不做批量、不重试、不需要任务图。等待实际结果，看图后如实记录检查结论；不符合就说明缺陷，不要为通过测试而说通过。', [], 1);
  }
  if (!reference?.asset) throw new Error('No reference image is available for the editing phase');
  if (phases.length) await hub.newSession(project.id);
  const edited = await runPhase('reference-edit', '这是实际 GPU 的参考图编辑测试。保持选中照片的橙色杯子、杯把、形状、颜色和木桌不变，只把浅灰背景改成柔和的浅蓝色。使用支持参考图的 Qwen 或编辑工作流，必须传原图。只允许一次生成，不做视频、不重试，不需要任务图。等结果完成后与原图对照检查，记录实际可确认的结果与不确定之处。', [reference.id], 1);
  if (!edited?.asset) throw new Error('The editing phase produced no usable image');
  const editPhase = phases[phases.length - 1];
  if (!editPhase.tasks.every((task) => 'images' in task.request && task.request.images?.includes(reference!.asset!.id))) editPhase.executionPassed = false;
  await hub.newSession(project.id);
  await runPhase('independent-visual-review', `只做独立视觉审查，不生成。请调用 visual_critic 审查节点 ${edited.id}，原始参考为 ${reference.id}。目标是保持同一个橙色杯子、杯把、木桌和构图，只把背景改成浅蓝色。identity 阈值 85、composition 阈值 80。给出可见证据与不确定性，不要把工具执行成功当成质量通过，也不要重做。`, [reference.id, edited.id], 0);
  const final = (await projects.get(project.id))!.items.find((item) => item.id === edited.id);
  if (!final?.critic) phases[phases.length - 1].executionPassed = false;
} catch (caught) { error = redactTraceText((caught as Error).message); }
finally {
  await hub.abort(project.id).catch(() => {});
  // Never cancel jobs belonging to another client or project.
  const queue = await comfy.queue().catch(() => undefined);
  if (queue) for (const task of tasks.active()) {
    if (queue.queue_running.some((entry) => entry[1] === task.promptId) || queue.queue_pending.some((entry) => entry[1] === task.promptId)) await tasks.cancel(task.id);
  }
  clearInterval(poll);
  const settleDeadline = Date.now() + 10000;
  while ((await hub.view(project.id)).running && Date.now() < settleDeadline) await pause(100);
  const stillRunning = (await hub.view(project.id)).running;
  if (stillRunning) error ??= 'Agent did not settle after abort; isolated data retained';
  const board = (await projects.get(project.id))!;
  const images: { itemId: string; path: string; width: number; height: number; critic?: CanvasItem['critic']; review?: CanvasItem['review'] }[] = [];
  for (const item of board.items) if (item.asset) {
    const stored = assets.get(item.asset.id);
    if (!stored) continue;
    const path = join(artifactDirectory, `${item.id}-${stored.file}`);
    await writeFile(path, await assets.read(stored));
    images.push({ itemId: item.id, path, width: item.asset.width, height: item.asset.height, ...(item.critic ? { critic: item.critic } : {}), ...(item.review ? { review: item.review } : {}) });
  }
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* source archive */ }
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const report = { version: 1, at: new Date().toISOString(), revision, dirty, model: settings.agentConfig().model, comfyUI: comfyVersion, gpu, suppliedInput: value('--input') ? resolve(value('--input')!) : undefined,
    generationEnvironment: 'comfyui', executionPassed: !error && phases.length >= 2 && phases.every((phase) => phase.executionPassed), error, phases, images,
    interpretation: 'Small real-GPU end-to-end validation. Agent and independent model judgments are not human-confirmed quality scores, and this is not a paired capability benchmark.' };
  // codeql[js/http-to-file-access] Intentional JSON telemetry archive: remote labels are bounded/validated; only the local CLI selects the .json destination. This file is never executed.
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await Promise.all([assets.flush(), tasks.flush()]);
  comfy.close();
  config.dataDir = ownerDataDirectory;
  if (!stillRunning) await rm(temporary, { recursive: true, force: true });
  console.log(`Real GPU report: ${output}; execution ${report.executionPassed ? 'passed' : 'incomplete'}`);
  if (!report.executionPassed) process.exitCode = 1;
}
