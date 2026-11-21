import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanvasItem, CustomWorkflow, Project, Task, TaskRequest, WorkflowInput, WorkflowLike } from '../shared/types.ts';
import { describeItem } from '../server/agent/board.ts';
import { describeCapability } from '../server/workflows/capability.ts';
import { RETRY_LIMIT, retriesLeft, retryDepth } from '../server/agent/review.ts';
import { canvasTools } from '../server/agent/tools.ts';

const img = (id: string, extra: Partial<CanvasItem> = {}): CanvasItem => ({
  id,
  kind: 'image',
  x: 0,
  y: 0,
  w: 512,
  h: 288,
  createdAt: 1,
  asset: { id: `a-${id}`, url: '', kind: 'image', mime: 'image/png', width: 1376, height: 768 },
  ...extra,
});

/** An in-memory board behind the canvas tools. */
function board(
  items: CanvasItem[],
  options: { workflows?: WorkflowLike[]; features?: Record<string, string[]>; history?: Task[] } = {},
) {
  const project: Project = { id: 'board00001', name: 't', items, viewport: { x: 0, y: 0, zoom: 1 }, createdAt: 0, updatedAt: 0 };
  const created: TaskRequest[] = [];
  let queued = 0;
  const deps = {
    tasks: {
      list: () => options.history ?? [],
      create: async (request: TaskRequest) => {
        created.push(request);
        const task: Task = {
          id: `task${++queued}`,
          request,
          status: 'running',
          progress: 0,
          expected: { kind: 'image', width: 1024, height: 1024 },
          results: [],
          seed: 0,
          createdAt: Date.now(),
        };
        return task;
      },
    },
    projects: {
      get: async () => project,
      patchItems: async (_id: string, patch: { upsert?: CanvasItem[]; remove?: string[] }) => {
        const drop = new Set(patch.remove ?? []);
        const next = new Map(project.items.filter((i) => !drop.has(i.id)).map((i) => [i.id, i]));
        for (const u of patch.upsert ?? []) next.set(u.id, u);
        project.items = [...next.values()];
        return project;
      },
    },
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: options.features ?? {}, models: {} }),
    workflows: () => options.workflows ?? [],
    changed: () => {},
  } as unknown as Parameters<typeof canvasTools>[0];
  const writer = { track: () => {} } as unknown as Parameters<typeof canvasTools>[1];
  const tools = canvasTools(deps, writer);
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const item = (id: string) => project.items.find((i) => i.id === id)!;
  return { project, tool, item, deps, created };
}
const ctx = { projectId: 'board00001' };

test('a retry chain counts its hops, and the budget stops at the limit', () => {
  const project: Project = {
    id: 'p',
    name: 't',
    items: [img('r0'), img('r1', { retryOf: 'r0' }), img('r2', { retryOf: 'r1' })],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 0,
    updatedAt: 0,
  };
  assert.equal(retryDepth(project, project.items[0]), 0);
  assert.equal(retryDepth(project, project.items[2]), 2);
  assert.equal(retriesLeft(project, project.items[0]), RETRY_LIMIT);
  assert.equal(retriesLeft(project, project.items[2]), 0);
  // A broken link (the source was deleted) does not loop or throw.
  const orphan: Project = { ...project, items: [img('x', { retryOf: 'gone' })] };
  assert.equal(retryDepth(orphan, orphan.items[0]), 1);
});

test('record_review writes pass/fail with a reason onto the items', async () => {
  const b = board([img('ok'), img('bad')]);
  const out = await b.tool('record_review').run(
    {
      entries: [
        { id: 'ok', verdict: 'pass' },
        { id: 'bad', verdict: 'fail', reason: 'subject_too_small', note: '人在画面里太小' },
      ],
    },
    { projectId: 'board00001' },
  );
  assert.equal(b.item('ok').review?.verdict, 'pass');
  assert.equal(b.item('ok').review?.reason, undefined);
  assert.equal(b.item('bad').review?.verdict, 'fail');
  assert.equal(b.item('bad').review?.reason, 'subject_too_small');
  assert.equal(b.item('bad').review?.note, '人在画面里太小');
  // The failed line names the retry action and what is left of the budget.
  assert.match(out.text, /crop_image/);
  assert.match(out.text, new RegExp(`还能重做 ${RETRY_LIMIT} 次`));
  assert.equal(out.summary, '1 个通过，1 个不通过');
});

test('record_review refuses items with no result and text items', async () => {
  const b = board([img('waiting', { asset: undefined, taskId: 'task9' }), { ...img('note'), kind: 'text', asset: undefined, text: '剧本' }]);
  await assert.rejects(() => b.tool('record_review').run({ entries: [{ id: 'waiting', verdict: 'pass' }] }, { projectId: 'board00001' }), /还没有结果/);
  await assert.rejects(() => b.tool('record_review').run({ entries: [{ id: 'note', verdict: 'pass' }] }, { projectId: 'board00001' }), /文本节点/);
});

test('a retry is linked to the item it replaces, and a spent budget refuses more', async () => {
  const b = board([img('bad')]);
  await b.tool('record_review').run({ entries: [{ id: 'bad', verdict: 'fail', reason: 'composition' }] }, { projectId: 'board00001' });
  const out = await b.tool('generate_image').run({ prompt: '重新出图', retry_of: 'bad' }, { projectId: 'board00001' });
  const fresh = b.project.items.find((i) => i.id !== 'bad')!;
  assert.equal(fresh.retryOf, 'bad');
  assert.equal(b.project.items.length, 2);

  // Two retries up the chain, then the budget is gone.
  const third = await b.tool('generate_image').run({ prompt: '再出', retry_of: fresh.id }, { projectId: 'board00001' });
  assert.ok(third.items?.length);
  await assert.rejects(() => b.tool('generate_image').run({ prompt: '还出', retry_of: third.items![0] }, { projectId: 'board00001' }), /重试预算/);
  assert.match(out.text, /已提交/);
});

test('read_board shows the verdict recorded on an item', async () => {
  const b = board([img('bad')]);
  await b.tool('record_review').run({ entries: [{ id: 'bad', verdict: 'fail', reason: 'clipping', note: '手和桌子粘在一起' }] }, { projectId: 'board00001' });
  const out = await b.tool('read_board').run({ ids: ['bad'] }, ctx);
  assert.match(out.text, /检查不通过（穿模\/粘连）：手和桌子粘在一起/);
  assert.match(describeItem(b.deps, b.item('bad'), 40), /检查不通过/);
});

const custom = (id: string, kind: 'image' | 'video', types: WorkflowInput['type'][]): CustomWorkflow => {
  const inputs = types.map((type, index) => ({ id: `${type}${index + 1}`, type, node: '1', field: `${type}${index + 1}`, label: type }));
  const wf: CustomWorkflow = {
    id,
    name: id,
    kind,
    graph: { 1: { class_type: 'KSampler', inputs: {} } },
    inputs,
    outputs: ['1'],
    createdAt: 0,
    updatedAt: 0,
  };
  wf.capability = describeCapability(wf);
  return wf;
};

test('list_workflows keeps background editing and image-to-video in separate candidate sets', async () => {
  const b = board([], {
    workflows: [
      custom('text-image', 'image', ['prompt']),
      custom('background-edit', 'image', ['prompt', 'image', 'width', 'height']),
      custom('image-video', 'video', ['prompt', 'image', 'aspect']),
    ],
  });
  const edit = await b.tool('list_workflows').run({ capability: 'image_edit', image_count: 1, aspect: '16:9' }, ctx);
  assert.equal(edit.summary, '1 个可用');
  assert.match(edit.text, /background-edit/);
  assert.match(edit.text, /图生图\/编辑 · 图片 1–1 张 · 可改比例/);
  assert.doesNotMatch(edit.text, /text-image|image-video/);

  const video = await b.tool('list_workflows').run({ capability: 'image_to_video', image_count: 1 }, ctx);
  assert.equal(video.summary, '1 个可用');
  assert.match(video.text, /image-video/);
  assert.doesNotMatch(video.text, /text-image|background-edit/);
});

test('empty workflow candidates explain capability, count and aspect remedies without substitutes', async () => {
  const b = board([], { workflows: [custom('background-edit', 'image', ['prompt', 'image'])] });
  const capability = await b.tool('list_workflows').run({ capability: 'image_to_video', image_count: 1 }, ctx);
  assert.match(capability.text, /没有满足「图生视频」/);
  assert.match(capability.text, /请导入一个能力与输入类型相符/);
  assert.match(capability.text, /不要运行其它能力代替/);

  const count = await b.tool('list_workflows').run({ capability: 'image_edit', image_count: 0 }, ctx);
  assert.match(count.text, /实际素材数量不符/);
  assert.match(count.text, /图片需 1–1 张/);
  assert.match(count.text, /调整素材数量/);

  const aspect = await b.tool('list_workflows').run({ capability: 'image_edit', image_count: 1, aspect: '16:9' }, ctx);
  assert.match(aspect.text, /不支持把比例改为 16:9/);
  assert.match(aspect.text, /添加宽高或比例输入映射/);
});

test('run_workflow refuses blocked or incompatible requests and writes aspect into queued tasks', async () => {
  const b = board([], {
    workflows: [
      custom('blocked', 'image', ['prompt']),
      custom('sized', 'image', ['prompt', 'width', 'height']),
      custom('fixed', 'image', ['prompt']),
      custom('needs-image', 'image', ['prompt', 'image']),
    ],
    features: { 'custom:blocked': ['节点 MissingNode'] },
  });
  await assert.rejects(() => b.tool('run_workflow').run({ workflow_id: 'blocked', prompt: 'x' }, ctx), /暂时不可用.*MissingNode/);
  assert.equal(b.created.length, 0);

  await b.tool('run_workflow').run({ workflow_id: 'sized', prompt: '雪山', aspect: '16:9' }, ctx);
  assert.equal(b.created.length, 1);
  assert.equal(b.created[0].op, 'custom');
  assert.equal(b.created[0].aspect, '16:9');

  await assert.rejects(() => b.tool('run_workflow').run({ workflow_id: 'fixed', prompt: 'x', aspect: '9:16' }, ctx), /不支持调整画面比例/);
  await assert.rejects(() => b.tool('run_workflow').run({ workflow_id: 'needs-image', prompt: 'x' }, ctx), /需要 1 个图片输入/);
  assert.equal(b.created.length, 1);
});
