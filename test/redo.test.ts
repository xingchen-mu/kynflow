import assert from 'node:assert/strict';
import { test } from 'node:test';

// The frontend store and tasks touch browser globals at import time; stub them first.
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {} };
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh' }, configurable: true });
(globalThis as any).document = { documentElement: { lang: '' } };
(globalThis as any).window = { innerWidth: 1280, innerHeight: 800 };

test('redoShot resubmits the same item with a fresh seed and leaves every other node untouched', async () => {
  const [{ api }, { useStore }, { redoShot }] = await Promise.all([
    import('../src/lib/api.ts'),
    import('../src/store.ts'),
    import('../src/generation/tasks.ts'),
  ]);
  type CanvasItem = import('../shared/types.ts').CanvasItem;
  type Task = import('../shared/types.ts').Task;
  type TaskRequest = import('../shared/types.ts').TaskRequest;
  type VideoReq = Extract<TaskRequest, { op: 'video.generate' }>;

  const video = (id: string, request?: TaskRequest, extra: Partial<CanvasItem> = {}): CanvasItem => ({
    id,
    kind: 'video',
    x: 0,
    y: 0,
    w: 320,
    h: 180,
    name: id,
    createdAt: 1,
    request,
    ...extra,
  });
  const req = (seed: number): VideoReq => ({ op: 'video.generate', model: 'minimax', prompt: 'a cat', seed, duration: 5, aspect: '16:9', quality: '720p' });

  const items: CanvasItem[] = [
    video('A', undefined, { asset: { id: 'a', url: '/a.mp4', kind: 'video', mime: 'video/mp4', width: 320, height: 180 } }),
    video('B', req(42), { asset: { id: 'b', url: '/b.mp4', kind: 'video', mime: 'video/mp4', width: 320, height: 180 } }),
    video('C', req(7), { asset: { id: 'c', url: '/c.mp4', kind: 'video', mime: 'video/mp4', width: 320, height: 180 } }),
  ];
  useStore.setState({ items: [...items], past: [], future: [], tasks: {} });

  let captured: TaskRequest | undefined;
  const original = api.createTask;
  api.createTask = async (r: TaskRequest, id?: string) => {
    captured = r;
    return {
      id: id ?? 't1',
      request: r,
      status: 'queued',
      progress: 0,
      expected: { kind: 'video', width: 320, height: 180 },
      results: [],
      seed: 999,
      createdAt: Date.now(),
    } as Task;
  };

  try {
    redoShot(items[1]);
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(captured, 'a task was submitted');
    const cap = captured as VideoReq;
    assert.equal(cap.seed, undefined, 'the original seed is dropped');
    assert.equal(cap.model, 'minimax');
    assert.equal(cap.prompt, 'a cat');

    const state = useStore.getState();
    assert.ok(state.items.find((i) => i.id === 'B')?.taskId, 'B got a taskId');
    assert.equal(state.items.find((i) => i.id === 'A')?.taskId, undefined, 'A is untouched');
    assert.equal(state.items.find((i) => i.id === 'C')?.taskId, undefined, 'C is untouched');
    assert.equal(state.items.length, 3, 'no new nodes were added');
  } finally {
    api.createTask = original;
  }
});
