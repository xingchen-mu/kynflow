import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { Task, TaskRequest } from '../shared/types.ts';
import { ComfyError, type ComfyClient } from '../server/comfy/client.ts';
import type { AssetStore } from '../server/assets/store.ts';

process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'kynflow-submit-recovery-'));
const { config } = await import('../server/config.ts');
const { TaskManager } = await import('../server/tasks/manager.ts');
const request: TaskRequest = { op: 'image.generate', model: 'zimage', prompt: 'A cup', aspect: '1:1', quality: '1k' };

test('the prompt lookup id is durable before ComfyUI can accept a job, including after lost acknowledgement', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-submit-boundary-'));
  config.dataDir = directory;
  const pending: unknown[][] = [];
  let submissions = 0;
  let promptId = '';
  const comfy = {
    online: false,
    async queuePrompt(_graph: unknown, id: string) {
      submissions++;
      promptId = id;
      const saved = JSON.parse(await readFile(join(directory, 'tasks.json'), 'utf8')) as Task[];
      assert.equal(saved.length, 1);
      assert.equal(saved[0].promptId, id);
      assert.equal(saved[0].submissionState, 'prepared');
      pending.push([0, id]);
      throw new ComfyError('Connection reset after acceptance');
    },
    history: async () => undefined,
    queue: async () => ({ queue_running: [], queue_pending: pending }),
  } as unknown as ComfyClient;
  const manager = new TaskManager(comfy, { get: () => undefined } as unknown as AssetStore, () => undefined, () => undefined);
  const restored = new TaskManager(comfy, { get: () => undefined } as unknown as AssetStore, () => undefined, () => undefined);
  t.after(async () => { await restored.close(); await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = { projectId: 'project', sessionId: 'session', runId: 'original-run', operationKey: 'session/task/1', graphTaskId: 'shot', attempt: 1 };
  const task = await manager.create(request, undefined, { owner });
  assert.equal(task.promptId, promptId);
  assert.equal(task.status, 'queued');
  assert.equal(task.submissionState, 'uncertain');
  await manager.close();
  await restored.init();
  await (restored as unknown as { poll(force: boolean): Promise<void> }).poll(true);
  assert.equal(restored.list()[0].promptId, promptId);
  assert.equal(restored.list()[0].status, 'queued');
  assert.equal(restored.list()[0].submissionState, 'accepted');
  assert.equal((await restored.create(request, undefined, { owner })).id, task.id);
  assert.equal(submissions, 1, 'restart only reconciles queue/history; it never resubmits');
});

test('cancelling during asset upload prevents a later prompt submission even if the upload ignores cancellation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-submit-cancel-'));
  config.dataDir = directory;
  let release!: (value: string) => void;
  let started!: () => void;
  const uploading = new Promise<void>((resolve) => { started = resolve; });
  const uploaded = new Promise<string>((resolve) => { release = resolve; });
  let submissions = 0;
  const comfy = { upload: async () => { started(); return uploaded; }, queuePrompt: async () => { submissions++; } } as unknown as ComfyClient;
  const assets = { get: () => ({ id: 'reference', kind: 'image', file: 'ref.png', width: 32, height: 32 }), read: async () => Buffer.from('uploaded-image'), setComfyName: () => {} } as unknown as AssetStore;
  const manager = new TaskManager(comfy, assets, () => undefined, () => undefined);
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const work = manager.create({ ...request, model: 'qwen', images: ['reference'] }, undefined, { signal: controller.signal });
  await uploading;
  controller.abort(); release('input.png');
  await assert.rejects(work);
  assert.equal(submissions, 0);
  assert.equal(manager.list()[0].status, 'cancelled');
});

test('a restored prepared submission gets a confirmation window instead of an immediate failure or resubmit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-submit-uncertain-'));
  config.dataDir = directory;
  const manager = new TaskManager({ online: false, queuePrompt: async () => { throw new ComfyError('upstream unavailable', 503); }, history: async () => undefined, queue: async () => ({ queue_running: [], queue_pending: [] }) } as unknown as ComfyClient, { get: () => undefined } as unknown as AssetStore, () => undefined, () => undefined);
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const task = await manager.create(request);
  await (manager as unknown as { poll(force: boolean): Promise<void> }).poll(true);
  assert.equal(task.status, 'queued');
  assert.equal(task.submissionState, 'uncertain');
});
