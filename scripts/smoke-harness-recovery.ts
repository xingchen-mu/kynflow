// Opt-in real executor check: one prompt, close/reopen local tracking, never resubmit on recovery.
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from '../server/config.ts';
import { SettingsStore } from '../server/settings.ts';
import { AssetStore } from '../server/assets/store.ts';
import { ComfyClient } from '../server/comfy/client.ts';
import { TaskManager } from '../server/tasks/manager.ts';
import { resolveModels } from '../server/workflows/models.ts';
import { gpuReportLabel } from '../server/agent/evaluation/gpu-report.ts';

if (!process.argv.includes('--real-gpu')) throw new Error('Pass --real-gpu to submit exactly one real image job');
const settings = new SettingsStore(); await settings.init();
const originalDirectory = config.dataDir;
const temporary = await mkdtemp(join(tmpdir(), 'kynflow-recovery-smoke-'));
const output = resolve('output/harness-recovery'); await mkdir(output, { recursive: true });
const clientId = `recovery-${randomUUID()}`;
const clients: ComfyClient[] = [];
const managers: TaskManager[] = [];
let queueCalls = 0;
let exported: string | undefined;
let passed = false;

function client() {
  const comfy = new ComfyClient(settings.value.comfyUrl, clientId);
  const queue = comfy.queuePrompt.bind(comfy);
  comfy.queuePrompt = async (graph, id, signal) => {
    const stored = JSON.parse(await readFile(join(temporary, 'tasks.json'), 'utf8')) as { promptId?: string }[];
    if (!stored.some((task) => task.promptId === id)) throw new Error('Prompt id was not durable before remote submission');
    queueCalls++;
    if (queueCalls > 1) throw new Error('Recovery must never issue a second submission');
    return queue(graph, id, signal);
  };
  clients.push(comfy); return comfy;
}

try {
  const first = client();
  const queued = await first.queue();
  if (queued.queue_running.length || queued.queue_pending.length) throw new Error('GPU busy; no prompt submitted');
  const stats = await first.systemStats();
  resolveModels(await first.objectInfo());
  config.dataDir = temporary;
  const assets = new AssetStore(); await assets.init();
  const manager = new TaskManager(first, assets, () => undefined, () => undefined); managers.push(manager);
  first.connect((event) => manager.onComfyEvent(event), () => {});
  const task = await manager.create({ op: 'image.generate', model: 'zimage', prompt: 'A single orange ceramic mug on a wooden table, plain gray background, soft studio light, product photograph.', aspect: '1:1', quality: '1k', seed: 42 }, undefined, { owner: { projectId: 'recovery-smoke', sessionId: 'session-probe', runId: 'run-probe', operationKey: clientId } });
  const before = { id: task.id, promptId: task.promptId, status: task.status };
  await manager.close(); first.close();
  const second = client();
  const restored = new TaskManager(second, assets, () => undefined, () => undefined); managers.push(restored);
  await restored.init();
  second.connect((event) => restored.onComfyEvent(event), () => restored.onReconnect());
  if (restored.list()[0]?.promptId !== task.promptId) throw new Error('Recovery lost the original prompt id');
  const replay = await restored.create(task.request, undefined, { owner: task.agentOwner });
  if (replay.id !== task.id || queueCalls !== 1) throw new Error('Idempotent replay failed');
  const deadline = Date.now() + 240000;
  let last = '';
  while (restored.active().length && Date.now() < deadline) {
    const status = restored.list()[0];
    const progress = `${status.status}: ${status.stage ?? ''}`;
    if (progress !== last) { console.log(progress); last = progress; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const result = restored.list()[0];
  if (result.status !== 'done' || !result.results[0]) throw new Error(result.error ?? 'Recovered GPU job did not complete');
  const stored = assets.get(result.results[0].id)!;
  exported = join(output, 'recovered-image.png'); await writeFile(exported, await assets.read(stored));
  const report = { at: new Date().toISOString(), passed: queueCalls === 1, queueCalls, before, after: { id: result.id, promptId: result.promptId, status: result.status }, image: exported, width: result.results[0].width, height: result.results[0].height, comfyVersion: gpuReportLabel(stats.system.comfyui_version), gpu: gpuReportLabel(stats.devices[0]?.name), model: 'zimage', seed: 42 };
  // codeql[js/http-to-file-access] Intentional JSON smoke-test telemetry; device labels are validated and the output path is local and fixed. It is never executed.
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await assets.flush();
  passed = report.passed;
  console.log(`Recovery smoke: ${passed ? 'passed' : 'failed'}, ${queueCalls} submission, ${exported}`);
} finally {
  for (const manager of managers) await manager.close().catch(() => {});
  for (const comfy of clients) comfy.close();
  config.dataDir = originalDirectory;
  // Keep isolated state on failure for diagnosis; never cancel another client's GPU job.
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Recovery smoke isolated state retained: ${temporary}`);
}
