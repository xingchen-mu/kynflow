// Scenario-level evals for the canvas assistant, scripted on pi's faux model: no API key, no ComfyUI.
// Each eval pins the tool sequence and what the panel shows, never the model's wording.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'infinode-eval-test-'));
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');
const { AssetStore } = await import('../server/assets/store.ts');
const { ProjectStore } = await import('../server/projects/store.ts');
const { AgentHub } = await import('../server/agent/runtime.ts');
type Task = import('../shared/types.ts').Task;
type TaskRequest = import('../shared/types.ts').TaskRequest;
type AgentEventData = import('../shared/types.ts').AgentEventData;
type AgentView = import('../shared/types.ts').AgentView;
/** A scripted reply, or a function of what the model was sent. */
type Step = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A task queue that accepts everything; tests finish or fail tasks by hand. */
function fakeTasks() {
  let n = 0;
  const events = new EventEmitter();
  const records = new Map<string, Task>();
  const created: TaskRequest[] = [];
  return Object.assign(events, {
    records,
    created,
    list(ids?: string[]) {
      return ids ? ids.map((id) => records.get(id)).filter((t): t is Task => Boolean(t)) : [...records.values()];
    },
    async create(request: TaskRequest) {
      created.push(request);
      const video = request.op === 'video.generate';
      const task: Task = {
        id: `task${Date.now()}${++n}`.slice(-14),
        request,
        status: 'queued',
        progress: 0,
        results: [],
        seed: 1,
        createdAt: Date.now(),
        expected: { kind: video ? 'video' : 'image', width: 1344, height: 768 },
      };
      records.set(task.id, task);
      return task;
    },
    fail(id: string, error: string) {
      const t = records.get(id)!;
      Object.assign(t, { status: 'error', progress: 0.3, error, finishedAt: Date.now() });
      events.emit('task', t);
    },
  });
}

const projects = new ProjectStore();
const assets = new AssetStore();
await Promise.all([projects.init(), assets.init()]);

async function hubWith(tasks: ReturnType<typeof fakeTasks>, responses: Step[]) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-eval', input: ['text', 'image'], contextWindow: 200_000 }] });
  faux.setResponses(responses);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = {
    projects,
    tasks,
    assets,
    workflows: () => [],
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: {}, models: {} }),
    changed: () => {},
    commercialOnly: () => false,
  } as unknown as ConstructorParameters<typeof AgentHub>[0];
  // Everything the panel was sent, in order.
  const emitted: AgentEventData[] = [];
  // Each eval starts with no notices left by the previous one's unfinished batches.
  rmSync(join(process.env.DATA_DIR!, 'agent', 'watches.json'), { force: true });
  const hub = new AgentHub(deps, (e) => emitted.push(e), { models, model: 'faux/faux-eval' });
  await hub.init();
  assert.equal(hub.status.ready, true, hub.status.reason ?? '');
  return { hub, emitted };
}

async function settled(hub: InstanceType<typeof AgentHub>, projectId: string) {
  for (let i = 0; i < 400; i++) {
    const v = await hub.view(projectId);
    if (!v.running) return v;
    await sleep(20);
  }
  throw new Error('the run did not settle');
}

/** Polls the panel until `ready` holds; the failure notice arrives on a timer, not with the call. */
async function until(hub: InstanceType<typeof AgentHub>, projectId: string, ready: (v: AgentView) => boolean, what: string) {
  for (let i = 0; i < 400; i++) {
    const v = await hub.view(projectId);
    if (ready(v)) return v;
    await sleep(20);
  }
  throw new Error(what);
}

const toolRows = (view: AgentView) => view.entries.filter((e) => e.kind === 'tool');
const GENERATION_TOOLS = new Set(['batch_generate_videos', 'generate_video', 'batch_generate_images', 'generate_image', 'run_workflow']);
const frameItem = (id: string, assetId: string) => ({
  id,
  kind: 'image' as const,
  x: 0,
  y: 0,
  w: 512,
  h: 288,
  createdAt: 1,
  name: 'S01',
  group: '关键帧',
  asset: { id: assetId, url: `/files/${assetId}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 },
});

// 防住的回退：待办不再写进面板（update_todos 与面板状态脱钩），或助手对空画布一上来就提交生成任务。
test('an empty board and "15 秒雨夜短剧": the plan lands in the panel first, and nothing is generated yet', async () => {
  const board = await projects.create('eval plan first');
  const tasks = fakeTasks();
  const steps = [
    { content: '写雨夜短剧的 3 个镜头', status: 'pending' as const },
    { content: '出 3 张关键帧', status: 'pending' as const },
    { content: '出 15 秒视频（3 段 × 5 秒）', status: 'pending' as const },
  ];
  const { hub, emitted } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('update_todos', { todos: steps })),
    fauxAssistantMessage([fauxToolCall('read_guide', { name: 'short_drama' }), fauxToolCall('ask_user', { question: '雨夜的光比选哪种？', options: [{ label: '霓虹冷光' }, { label: '路灯暖光' }] })]),
    fauxAssistantMessage('先定下光比，再写镜头。'),
  ]);
  await hub.send(board.id, { text: '做一个 15 秒雨夜短剧' });
  const view = await settled(hub, board.id);

  assert.deepEqual(view.todos, steps, 'the plan is the panel state');
  assert.deepEqual(
    toolRows(view).map((e) => e.kind === 'tool' && [e.tool, e.status]),
    [
      ['read_guide', 'done'],
      ['ask_user', 'waiting'],
    ],
    'planning and asking, not generating',
  );
  assert.ok(!toolRows(view).some((e) => e.kind === 'tool' && GENERATION_TOOLS.has(e.tool)), 'no generation call');
  assert.equal(tasks.created.length, 0, 'nothing queued on the GPU');
  assert.equal((await projects.get(board.id))!.items.length, 0, 'the board stays empty');

  // The to-do list reaches the panel before the first tool row.
  const todoAt = emitted.findIndex((e) => e.todos?.length === steps.length);
  const toolAt = emitted.findIndex((e) => e.entry?.kind === 'tool');
  assert.ok(todoAt >= 0 && toolAt >= 0 && todoAt < toolAt, `todos ${todoAt} before tool ${toolAt}`);
});

// 防住的回退：批量出视频绕过确认卡直接排队（15 秒视频在用户点确认前就烧掉 GPU）。
test('a video batch waits on its confirmation card, and only confirming queues the 15 seconds', async () => {
  const board = await projects.create('eval video card');
  const frame = frameItem('frame00001', 'aframe');
  await projects.patchItems(board.id, { upsert: [frame] });
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('batch_generate_videos', {
      jobs: [
        { prompt: '雨里，她把伞收起来', first_frame_id: frame.id, name: 'S01', duration: 5 },
        { prompt: '她抬头看霓虹灯牌', first_frame_id: frame.id, name: 'S02', duration: 5 },
        { prompt: '她走进便利店的暖光里', first_frame_id: frame.id, name: 'S03', duration: 5 },
      ],
    })),
    fauxAssistantMessage('在等你确认这三段视频。'),
  ]);
  await hub.send(board.id, { text: '做成 15 秒视频' });
  const view = await settled(hub, board.id);

  const card = toolRows(view).find((e) => e.kind === 'tool' && e.tool === 'batch_generate_videos');
  assert.ok(card?.kind === 'tool' && card.status === 'waiting' && card.approval, JSON.stringify(card));
  assert.equal(card.approval.frames?.length, 3);
  assert.ok(card.approval.frames?.every((id) => id === frame.id));
  assert.equal(tasks.created.length, 0, 'nothing submitted before the user agrees');
  assert.equal((await projects.get(board.id))!.items.filter((i) => i.kind === 'video').length, 0);

  await hub.approve(board.id, card.id, true);
  assert.deepEqual(
    tasks.created.map((r) => r.op === 'video.generate' && [r.duration, r.images]),
    [
      [5, ['aframe']],
      [5, ['aframe']],
      [5, ['aframe']],
    ],
  );
  assert.equal((await projects.get(board.id))!.items.filter((i) => i.kind === 'video').length, 3, 'three new video nodes');
});

// 防住的回退：计划模式下的写操作防线失效（方案还没确认就开始改画布）。
test('in plan mode the assistant reads but cannot write the board', async () => {
  const board = await projects.create('eval plan mode');
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage([fauxToolCall('write_note', { title: '雨夜剧本', content: '- 第一场：便利店门口' }), fauxToolCall('read_board', {})]),
    fauxAssistantMessage('先看画布，方案随后给你。'),
  ]);
  await hub.setPlan(board.id, true);
  await hub.send(board.id, { text: '写个雨夜剧本' });
  const view = await settled(hub, board.id);

  assert.equal(view.plan, true);
  assert.deepEqual(
    toolRows(view).map((e) => e.kind === 'tool' && [e.tool, e.status]),
    [
      ['write_note', 'error'],
      ['read_board', 'done'],
    ],
  );
  assert.equal((await projects.get(board.id))!.items.length, 0, 'nothing written in plan mode');
});

// 防住的回退：任务失败后只写进画布、不再唤醒助手（助手停在「等它跑完」不动了）。
test('a failed task is reported to the assistant, which carries on instead of stopping', async () => {
  const board = await projects.create('eval failure');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('batch_generate_images', { jobs: [{ prompt: '雨夜街角，霓虹倒影', name: 'S01', group: '关键帧' }] })),
    fauxAssistantMessage('三张关键帧在出。'),
    fauxAssistantMessage(fauxToolCall('read_board', {})),
    fauxAssistantMessage('改用户上传的参考图再试。'),
  ]);
  await hub.send(board.id, { text: '出三张雨夜关键帧' });
  await settled(hub, board.id);
  assert.equal(tasks.created.length, 1);
  const taskId = [...tasks.records.keys()][0];

  tasks.fail(taskId, 'ComfyUI 连接断了');
  // The notice goes out on a timer, and the run it wakes must finish before the panel is read.
  const after = await until(
    hub,
    board.id,
    (v) => !v.running && v.entries.some((e) => e.kind === 'event' && e.text.includes('失败')) && toolRows(v).some((e) => e.kind === 'tool' && e.tool === 'read_board' && e.status === 'done'),
    'the assistant did not carry on after the failure',
  );
  const noticeAt = after.entries.findIndex((e) => e.kind === 'event' && e.text.includes('失败'));
  const readAt = after.entries.findIndex((e) => e.kind === 'tool' && e.tool === 'read_board');
  assert.ok(noticeAt >= 0 && noticeAt < readAt, `notice ${noticeAt} before read ${readAt}`);
  assert.equal(after.entries.at(-1)?.kind, 'assistant');
});

// 防住的回退：同参数连续调用拦截失效（模型原地打转，同一张画布被反复写坏）。
test('the third identical call in a row is refused, and the board shows only the first two writes', async () => {
  const board = await projects.create('eval loop');
  // A new call (and call id) each time, as a model would make.
  const write = () => fauxAssistantMessage(fauxToolCall('write_note', { title: '雨夜剧本', content: '- 第一场：便利店门口' }));
  const { hub } = await hubWith(fakeTasks(), [write(), write(), write(), fauxAssistantMessage('剧本已经写好了。')]);
  await hub.send(board.id, { text: '写个雨夜剧本' });
  const view = await settled(hub, board.id);

  const rows = toolRows(view);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((e) => e.kind === 'tool' && [e.status, e.summary]),
    [
      ['done', '「雨夜剧本」'],
      ['done', '「雨夜剧本」'],
      ['done', '重复调用，没有执行'],
    ],
  );
  assert.equal((await projects.get(board.id))!.items.length, 2, 'the refused call changed nothing');
});
