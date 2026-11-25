// The canvas assistant end to end with pi's faux model: no API key, no ComfyUI.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { evaluateAgentTrace, type AgentEvaluationCase } from '../server/agent/evaluation.ts';
import { SkillEngine } from '../server/agent/skills.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'kynflow-agent-test-'));
const testDataRoot = process.env.DATA_DIR;
const { config } = await import('../server/config.ts');
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import('@earendil-works/pi-ai');
const { AssetStore, publicAsset } = await import('../server/assets/store.ts');
const { ProjectStore } = await import('../server/projects/store.ts');
const { AgentHub, clearOldToolUse, compactError, compactThreshold } = await import('../server/agent/runtime.ts');
type Task = import('../shared/types.ts').Task;
type TaskRequest = import('../shared/types.ts').TaskRequest;
type AgentEventData = import('../shared/types.ts').AgentEventData;
type AssistantMessage = ReturnType<typeof fauxAssistantMessage>;
/** A scripted reply, or a function of what the model was sent. */
type Step = Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0][number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A task queue that accepts everything; tests finish tasks by hand. Records can be shared across "restarts". */
function fakeTasks(records = new Map<string, Task>()) {
  let n = 0;
  const events = new EventEmitter();
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
      const task: Task = { id: `task${Date.now()}${++n}`.slice(-14), request, status: 'queued', progress: 0, results: [], seed: 1, createdAt: Date.now(), expected: { kind: video ? 'video' : 'image', width: 1344, height: 768 } };
      records.set(task.id, task);
      return task;
    },
    async cancel(id: string) {
      return records.get(id);
    },
    finish(id: string) {
      const t = records.get(id)!;
      Object.assign(t, { status: 'done', progress: 1, startedAt: Date.now() - 1000, finishedAt: Date.now(), results: [{ id: `a-${id}`, url: `/files/a-${id}.mp4`, kind: t.expected.kind, mime: 'video/mp4', width: 1344, height: 768 }] });
      events.emit('task', t);
    },
  });
}

let projects: InstanceType<typeof ProjectStore>;
let assets: InstanceType<typeof AssetStore>;
beforeEach(async () => {
  // Restored watch notifications must not consume another test's scripted model replies.
  // Hubs restarted inside one test still share that test's directory and task records.
  process.env.DATA_DIR = mkdtempSync(join(testDataRoot, 'case-'));
  config.dataDir = process.env.DATA_DIR;
  projects = new ProjectStore();
  assets = new AssetStore();
  await Promise.all([projects.init(), assets.init()]);
});

async function hubWith(tasks: ReturnType<typeof fakeTasks>, responses: Step[], opts: { compactAt?: number; clearAt?: number; commercial?: boolean; approvalMode?: 'always' | 'prompts'; budget?: NonNullable<ConstructorParameters<typeof AgentHub>[2]>['budget']; sessionGenerationLimit?: number } = {}) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1', input: ['text', 'image'], contextWindow: 200_000 }] });
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
    commercialOnly: () => Boolean(opts.commercial),
  } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = opts.approvalMode
    ? ({ agentConfig: () => ({ model: 'faux/faux-1', vision: true, thinking: 'low', approvalMode: opts.approvalMode }) } as ConstructorParameters<typeof AgentHub>[3])
    : undefined;
  // What the panel was sent, rows that are not saved with the conversation included.
  const emitted: AgentEventData[] = [];
  const hub = new AgentHub(deps, (e) => emitted.push(e), { models, model: 'faux/faux-1', compactAt: opts.compactAt, clearAt: opts.clearAt, budget: opts.budget, sessionGenerationLimit: opts.sessionGenerationLimit }, settings);
  await hub.init();
  assert.equal(hub.status.ready, true, hub.status.reason ?? '');
  return { hub, faux, emitted };
}

async function settled(hub: InstanceType<typeof AgentHub>, projectId: string) {
  for (let i = 0; i < 300; i++) {
    const v = await hub.view(projectId);
    if (!v.running) return v;
    await sleep(20);
  }
  throw new Error('the run did not settle');
}

/** The conversation file once `ready` holds of its text: a run's last save lands just after it reports done. */
async function savedConversation(projectId: string, ready: (text: string) => boolean) {
  const file = join(process.env.DATA_DIR!, 'agent', `${projectId}.json`);
  for (let i = 0; i < 150; i++) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (text && ready(text)) return JSON.parse(text);
    await sleep(20);
  }
  throw new Error('the conversation was not saved');
}

const say = (text: string, input = 100): AssistantMessage => ({
  ...fauxAssistantMessage(text),
  usage: { input, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: input + 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
});

const benchmarkCases = JSON.parse(readFileSync(new URL('./fixtures/agent-benchmarks.json', import.meta.url), 'utf8')).cases as AgentEvaluationCase[];
const benchmarkResults: ReturnType<typeof evaluateAgentTrace>[] = [];
async function recordBenchmark(id: string, hub: InstanceType<typeof AgentHub>, projectId: string) {
  const result = evaluateAgentTrace(benchmarkCases.find((c) => c.id === id)!, (await hub.trace(projectId)).events, await hub.taskGraph(projectId));
  benchmarkResults.push(result);
  assert.deepEqual(result.failures, []);
}
after(() => {
  if (process.env.AGENT_EVAL_REPORT) writeFileSync(process.env.AGENT_EVAL_REPORT, JSON.stringify(benchmarkResults, null, 2));
});

test('a new conversation keeps the old one in history, and opening it brings it back', async () => {
  const board = await projects.create('sessions');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [say('第一段'), say('第二段')]);
  await hub.send(board.id, { text: '画只猫' });
  const first = await settled(hub, board.id);
  const firstId = first.sessionId;

  const afterNew = await hub.newSession(board.id);
  assert.notEqual(afterNew.current, firstId);
  assert.deepEqual(afterNew.sessions.map((s) => s.title), ['画只猫']);
  assert.deepEqual((await hub.view(board.id)).entries, []);

  await hub.send(board.id, { text: '画只狗' });
  await settled(hub, board.id);
  const list = await hub.listSessions(board.id);
  assert.equal(list.sessions.length, 2);
  assert.ok(list.sessions.some((s) => s.title === '画只狗'));

  const reopened = await hub.openSession(board.id, firstId);
  assert.equal(reopened.current, firstId);
  const view = await hub.view(board.id);
  assert.equal(view.sessionId, firstId);
  assert.ok(view.entries.some((e) => e.kind === 'user' && e.text === '画只猫'));
  const back = await hub.listSessions(board.id);
  assert.equal(back.sessions.length, 2, 'the newer conversation stayed in history');
  assert.ok(back.sessions.some((s) => s.title === '画只狗'));
});

test('a conversation can be renamed, keeps its name when it grows, and can be deleted', async () => {
  const board = await projects.create('session-manage');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [say('第一段'), say('第二段'), say('第三段')]);
  await hub.send(board.id, { text: '画只猫' });
  const first = await settled(hub, board.id);
  const id = first.sessionId;

  const renamed = await hub.renameSession(board.id, id, '  猫的定稿  ');
  assert.equal(renamed.sessions[0].title, '猫的定稿');
  await hub.send(board.id, { text: '再画一张' });
  await settled(hub, board.id);
  assert.equal((await hub.listSessions(board.id)).sessions[0].title, '猫的定稿', 'a chosen name survives later saves');

  await hub.newSession(board.id);
  assert.equal((await hub.listSessions(board.id)).sessions[0].title, '猫的定稿');
  const after = await hub.deleteSession(board.id, id);
  assert.deepEqual(after.sessions, []);

  const empty = await hub.view(board.id);
  const next = await hub.deleteSession(board.id, empty.sessionId);
  assert.notEqual(next.current, empty.sessionId, 'deleting the open conversation starts a new one');
});

test('a tool call edits the board, and the conversation survives a restart', async () => {
  const board = await projects.create('notes');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('write_note', { title: '剧本', content: '- 第一场：深夜' })), say('写好了')]);
  await hub.send(board.id, { text: '写个剧本' });
  const view = await settled(hub, board.id);
  const note = (await projects.get(board.id))!.items.find((i) => i.kind === 'text');
  assert.equal(note?.name, '剧本');
  assert.deepEqual(
    view.entries.map((e) => e.kind),
    ['user', 'tool', 'assistant'],
  );
  assert.ok(view.usage.tokens > 0);

  const { hub: again } = await hubWith(tasks, []);
  const reloaded = await again.view(board.id);
  assert.deepEqual(
    reloaded.entries.map((e) => (e.kind === 'assistant' ? e.text : e.kind)),
    ['user', 'tool', '写好了'],
  );
  assert.equal(reloaded.usage.tokens, view.usage.tokens);
});

test('the same call three times in a row is refused, so a looping model cannot keep going', async () => {
  const board = await projects.create('circle');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('read_board', {})),
    fauxAssistantMessage(fauxToolCall('read_board', {})),
    fauxAssistantMessage(fauxToolCall('read_board', {})),
    say('看过了'),
  ]);
  await hub.send(board.id, { text: '看看画布' });
  const view = await settled(hub, board.id);
  const rows = view.entries.filter((e) => e.kind === 'tool');
  assert.equal(rows.length, 3);
  assert.equal(rows[2].summary, '重复调用，没有执行');
});

test('a long tool error reaches the model cut short, and the whole one goes to the log', () => {
  const long = `ffmpeg 出错：${'x'.repeat(900)}`;
  const cut = compactError(long);
  assert.ok(cut.startsWith(long.slice(0, 600)));
  assert.ok(cut.length < long.length);
  assert.match(cut, /后面的内容太长/);
  assert.equal(compactError('找不到这个节点'), '找不到这个节点');
});

test('the assistant can require approval before every canvas write', async () => {
  const board = await projects.create('approval mode');
  const tasks = fakeTasks();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-approval', input: ['text'], contextWindow: 200_000 }] });
  faux.setResponses([fauxAssistantMessage(fauxToolCall('write_note', { title: '待确认', content: '不会未经确认写入' })), say('已等待确认')]);
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
  const settings = { agentConfig: () => ({ model: 'faux/faux-approval', vision: false, thinking: 'low', approvalMode: 'always' as const }) } as ConstructorParameters<typeof AgentHub>[3];
  const hub = new AgentHub(deps, () => {}, { models, model: 'faux/faux-approval' }, settings);
  await hub.init();
  await hub.send(board.id, { text: '写一个备注' });
  const waiting = await settled(hub, board.id);
  const card = waiting.entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card && card.kind === 'tool' && card.approval);
  assert.equal((await projects.get(board.id))!.items.length, 0);
  await hub.approve(board.id, card.id, true);
  assert.equal((await projects.get(board.id))!.items[0]?.name, '待确认');
});

test('a memory write waits for approval when every write does', async () => {
  const board = await projects.create('approval memory');
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-approval', input: ['text'], contextWindow: 200_000 }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('remember', { changes: [{ action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚' }] })),
    say('等你确认'),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const deps = {
    projects,
    tasks: fakeTasks(),
    assets,
    workflows: () => [],
    capabilities: async () => ({ comfyOnline: true, comfyUrl: '', features: {}, models: {} }),
    changed: () => {},
    commercialOnly: () => false,
  } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = { agentConfig: () => ({ model: 'faux/faux-approval', vision: false, thinking: 'low', approvalMode: 'always' as const }) } as ConstructorParameters<typeof AgentHub>[3];
  const hub = new AgentHub(deps, () => {}, { models, model: 'faux/faux-approval' }, settings);
  await hub.init();
  await hub.send(board.id, { text: '记住主角叫林晚' });
  const waiting = await settled(hub, board.id);
  const card = waiting.entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card && card.kind === 'tool' && card.approval);
  assert.equal((await hub.memories(board.id)).board.entries.length, 0);
  await hub.approve(board.id, card.id, true);
  assert.equal((await hub.memories(board.id)).board.entries[0]?.text, '主角叫林晚');
});

test('approved videos are queued, and after a restart the agent still carries on when they finish', async () => {
  const board = await projects.create('videos');
  const frame = { id: 'frame00001', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: 'af', url: '/files/af.png', kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } };
  await projects.patchItems(board.id, { upsert: [frame] });
  const records = new Map<string, Task>();
  const before = fakeTasks(records);
  const { hub } = await hubWith(before, [fauxAssistantMessage(fauxToolCall('batch_generate_videos', { jobs: [{ prompt: '她抬头笑了', first_frame_id: frame.id, name: 'S01' }] })), say('等你确认')]);
  await hub.send(board.id, { text: '做成视频' });
  const waiting = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(waiting && waiting.kind === 'tool' && waiting.approval, 'an approval card');
  await hub.approve(board.id, waiting.id, true);
  assert.equal(before.created.length, 1);
  const video = (await projects.get(board.id))!.items.find((i) => i.kind === 'video')!;
  assert.equal(video.y, frame.y, 'beside its frame');
  assert.ok(existsSync(join(process.env.DATA_DIR!, 'agent', 'watches.json')));

  // A new server process: same task records, a new event stream, the notice read back from disk.
  const after = fakeTasks(records);
  const { hub: restarted } = await hubWith(after, [say('视频好了，接着剪辑')]);
  after.finish(video.taskId!);
  await sleep(700);
  const view = await settled(restarted, board.id);
  const texts = view.entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.ok(texts.some((t) => t.includes('都结束了')), texts.join(' | '));
  assert.equal(texts.at(-1), '视频好了，接着剪辑');
});

test('a video card shows its first frames, submits a keyframe redone after it, and gives way to a newer card', async () => {
  const board = await projects.create('redo');
  const asset = (id: string) => ({ id, url: `/files/${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 });
  const old = { id: 'kf0000old1', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, name: 'S04', group: '关键帧', asset: asset('aold') };
  await projects.patchItems(board.id, { upsert: [old] });
  const tasks = fakeTasks();
  // A new call (and call id) each time, as a model would make.
  const videos = () => fauxAssistantMessage(fauxToolCall('batch_generate_videos', { jobs: [{ prompt: '他站起来', first_frame_id: old.id, name: 'S04' }] }));
  let context = '';
  const { hub } = await hubWith(tasks, [
    (c) => {
      context = JSON.stringify(c.messages);
      return videos();
    },
    say('等你确认'),
    videos(),
    say('又提交了一次'),
    videos(),
    say('再提交一次'),
  ]);
  await hub.send(board.id, { text: '做成视频' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.frames?.[0] === old.id && card.approval.since, JSON.stringify(card));
  assert.match(context, /这台服务器的速度/, 'the measured speeds reach the model');

  // S04 is redone after the card was made, under the same name and group: confirming submits the new one.
  await projects.patchItems(board.id, { upsert: [{ ...old, id: 'kf0000new1', createdAt: Date.now() + 1, asset: asset('anew') }] });
  await hub.approve(board.id, card.id, true);
  const submitted = tasks.created[0];
  assert.deepEqual(submitted.op === 'video.generate' && submitted.images, ['anew']);
  const done = (await hub.view(board.id)).entries.find((e) => e.id === card.id);
  assert.ok(done?.kind === 'tool' && /重做后的首帧/.test(done.summary), JSON.stringify(done));

  // Two more cards: the newer one replaces the older, which can no longer be confirmed.
  await hub.send(board.id, { text: '再做一遍' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '还是再做一遍' });
  const cards = (await settled(hub, board.id)).entries.filter((e) => e.kind === 'tool' && e.tool === 'batch_generate_videos').slice(1);
  assert.deepEqual(
    cards.map((e) => e.kind === 'tool' && [e.status, e.summary]),
    [['done', '已被新的确认卡取代'], ['waiting', '等待确认']],
  );
  await assert.rejects(hub.approve(board.id, cards[0].id, true));
  assert.equal(tasks.created.length, 1);
});

test('deleting finished images waits for its own card, also when every write needs approval, and then the model reads what was done', async () => {
  const board = await projects.create('delete');
  const shot = { id: 'img0000del', kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: 'adel', url: '/files/adel.png', kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } };
  await projects.patchItems(board.id, { upsert: [shot] });
  let context = '';
  const { hub } = await hubWith(
    fakeTasks(),
    [
      fauxAssistantMessage(fauxToolCall('delete_items', { ids: [shot.id] })),
      say('等你确认'),
      (c) => {
        context = JSON.stringify(c.messages);
        return say('删好了');
      },
    ],
    { approvalMode: 'always' },
  );
  await hub.send(board.id, { text: '把这张删了' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.confirm === '删除' && card.approval.frames?.[0] === shot.id, JSON.stringify(card));
  assert.equal((await projects.get(board.id))!.items.length, 1);

  await hub.approve(board.id, card.id, true);
  assert.equal((await projects.get(board.id))!.items.length, 0);
  await hub.send(board.id, { text: '删好了吗' });
  await settled(hub, board.id);
  assert.match(context, /用户已确认。已从画布删掉 1 个节点/);
});

test('the token count leaves out cache reads, also for a conversation saved before the change', async () => {
  const board = await projects.create('tokens');
  const { hub } = await hubWith(fakeTasks(), [say('好的'), say('还在')]);
  for (const text of ['你好', '在吗']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  // The faux model reports its own usage, cache reads included: the count takes all but those.
  const file = join(process.env.DATA_DIR!, 'agent', `${board.id}.json`);
  const saved = await savedConversation(board.id, (text) => text.includes('还在'));
  const usages = saved.messages.filter((m: AssistantMessage) => m.role === 'assistant').map((m: AssistantMessage) => m.usage);
  const paid = usages.reduce((n: number, u: AssistantMessage['usage']) => n + u.input + u.output + u.cacheWrite, 0);
  assert.ok(usages.some((u: AssistantMessage['usage']) => u.cacheRead > 0), 'the second request reads the first from the cache');
  assert.equal(saved.version, 3);
  assert.equal(saved.usage.tokens, paid);
  assert.equal((await hub.view(board.id)).usage.tokens, paid);

  // As saved before: 30 000 tokens with cache reads, 9150 of them in the one reply still there, the rest condensed.
  const reply = saved.messages.find((m: AssistantMessage) => m.role === 'assistant');
  reply.usage = { ...reply.usage, input: 100, output: 50, cacheRead: 9000, cacheWrite: 0, totalTokens: 9150 };
  const messages = saved.messages.slice(0, saved.messages.indexOf(reply) + 1);
  writeFileSync(file, JSON.stringify({ ...saved, version: 2, messages, usage: { tokens: 30_000, cost: 0.01 } }));
  const { hub: restarted } = await hubWith(fakeTasks(), []);
  // 150 counted again, and the condensed 20 850 at the same share of paid tokens (150 of 9150).
  assert.deepEqual((await restarted.view(board.id)).usage, { tokens: 492, cost: 0.01 });
});

test('a board keeps the latest ten snapshots the assistant took on its own; the ones the user saved stay', async () => {
  const board = await projects.create('snapshots');
  await projects.createSnapshot(board.id, '用户存的');
  for (let i = 0; i < 12; i++) {
    await sleep(2);
    await projects.createSnapshot(board.id, `自动 ${i}`, { auto: true });
  }
  const names = (await projects.listSnapshots(board.id)).map((s) => s.name);
  assert.equal(names.length, 11);
  assert.ok(names.includes('用户存的'));
  assert.deepEqual(names.slice(0, 10), Array.from({ length: 10 }, (_, i) => `自动 ${11 - i}`));
});

test('commercial-only mode makes image generation default to Z-Image', async () => {
  const board = await projects.create('commercial');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只猫' })), say('好了')], { commercial: true });
  await hub.send(board.id, { text: '画只猫' });
  await settled(hub, board.id);
  assert.equal(tasks.created[0]?.op === 'image.generate' && tasks.created[0].model, 'zimage');
});

test('a long conversation is condensed into a summary, and the panel keeps the earlier rows', async () => {
  const board = await projects.create('long');
  const tasks = fakeTasks();
  const replies = Array.from({ length: 6 }, (_, i) => say(`回答 ${i + 1}`, 5000));
  const { hub } = await hubWith(tasks, [...replies, say('- 用户在做一部短剧\n- 剧本节点 abc', 300), say('回答 7')], { compactAt: 1000 });
  for (let i = 1; i <= 7; i++) {
    await hub.send(board.id, { text: `第 ${i} 句` });
    await settled(hub, board.id);
  }
  const view = await hub.view(board.id);
  const texts = view.entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.ok(texts.includes('回答 1'), 'old rows stay in the panel');
  assert.ok(texts.some((t) => t.includes('摘要')), texts.join(' | '));
  assert.equal(texts.at(-1), '回答 7');
  const saved = await savedConversation(board.id, (text) => text.includes('回答 7'));
  assert.match(saved.messages[0].content, /^<canvas_summary>/);
  assert.ok(saved.messages.length < 14, `transcript shrank to ${saved.messages.length}`);
});

test('condensing keeps what the user typed word for word, also through a second summary', async () => {
  const board = await projects.create('words');
  let second = '';
  const long = (i: number) => say(`回答 ${i}`, 5000);
  const { hub } = await hubWith(
    fakeTasks(),
    [
      ...[1, 2, 3, 4, 5, 6].map(long),
      say('- 第一次整理', 300),
      long(7),
      long(8),
      (context) => {
        second = JSON.stringify(context.messages);
        return say('- 第二次整理', 300);
      },
      say('回答 9'),
    ],
    { compactAt: 1000 },
  );
  for (let i = 1; i <= 9; i++) {
    await hub.send(board.id, { text: `第 ${i} 句：主角叫林晚` });
    await settled(hub, board.id);
  }
  const saved = await savedConversation(board.id, (text) => text.includes('回答 9'));
  const summary: string = saved.messages[0].content;
  assert.match(summary, /^<canvas_summary>\n- 第二次整理/);
  for (const i of [1, 2, 3, 4]) assert.ok(summary.includes(`<said>第 ${i} 句：主角叫林晚</said>`), summary);
  assert.ok(!summary.includes('canvas_context'), 'without the board context of the time');
  assert.ok(second.includes('【之前的整理】- 第一次整理'), 'the first summary is condensed again');
  assert.ok(!second.includes('<said>'), 'without the words carried in it');
  const texts = (await hub.view(board.id)).entries.map((e) => (e.kind === 'tool' ? e.label : e.text));
  assert.equal(texts.at(-1), '回答 9');
});

type AgentMessage = Parameters<typeof clearOldToolUse>[0][number];

test('clearing old tool use takes results and long arguments of all but the latest calls, never errors, and only once', () => {
  const long = '镜'.repeat(2000);
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
  const result = (id: string, name: string, text: string, isError = false) => ({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: 2 });
  const before = [
    { role: 'user', content: '写分镜表', timestamp: 1 },
    { role: 'assistant', content: [call('c1', 'write_note', { title: '分镜表', content: long }), call('c2', 'read_board', {})], timestamp: 2 },
    result('c1', 'write_note', '已新建文本节点'),
    result('c2', 'read_board', long),
    { role: 'assistant', content: [call('c3', 'read_board', { ids: ['a'] })], timestamp: 3 },
    result('c3', 'read_board', long, true),
    { role: 'assistant', content: [call('c4', 'batch_generate_images', { jobs: [{ prompt: long }] })], timestamp: 4 },
    result('c4', 'batch_generate_images', long),
  ] as unknown as AgentMessage[];
  const copy = JSON.stringify(before);
  const { messages, freed, cleared } = clearOldToolUse(before, 1);
  const json = JSON.stringify(messages);
  assert.equal(cleared, 2, 'the note text in c1, the board read in c2');
  assert.ok(freed > 3900 && freed < 4000, String(freed));
  assert.match(json, /\[已清掉 2000 字，原文在画布上\]/);
  assert.match(json, /\[已清掉较早的 read_board 结果，2000 字，需要时重新调用\]/);
  assert.match(json, /"title":"分镜表"/, 'short arguments stay');
  assert.equal((messages[5] as { content: { text: string }[] }).content[0].text, long, 'an error stays: the panel shows it');
  assert.equal(JSON.stringify(messages.slice(6)), JSON.stringify(before.slice(6)), 'the latest call stays whole');
  assert.equal(JSON.stringify(before), copy, 'the messages given are not changed');
  assert.equal(clearOldToolUse(messages, 1).freed, 0, 'nothing more the second time');
});

test('past the clearing mark, old tool results are cleared before the next request, without a summary', async () => {
  const board = await projects.create('clearing');
  const reads = Array.from({ length: 8 }, (_, i) => fauxToolCall('read_guide', { name: 'short_drama' }, { id: `read${i}` }));
  let second = '';
  const { hub, emitted } = await hubWith(
    fakeTasks(),
    [
      fauxAssistantMessage(reads),
      say('读完了'),
      (context) => {
        second = JSON.stringify(context.messages);
        return say('接着写');
      },
    ],
    { clearAt: 100, compactAt: 10_000_000 },
  );
  await hub.send(board.id, { text: '读一下手册' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  const events = emitted.flatMap((e) => (e.entry?.kind === 'event' ? [e.entry.text] : []));
  assert.equal(events.length, 1, events.join(' | '));
  assert.match(events[0], /^已清掉 2 处较早的工具结果，上下文少了 \d+ 字$/);
  assert.equal((second.match(/\[已清掉较早的 read_guide 结果/g) ?? []).length, 2, 'the two oldest of eight, the latest six stay');
  assert.ok(!second.includes('<canvas_summary>'));
});

test('condensing on request keeps what the user asked for, shows the summary in the panel, and says when there is nothing to condense', async () => {
  const board = await projects.create('condense');
  let asked = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('好的，主角叫林晚'),
    say('分镜表写好了'),
    say('关键帧在出'),
    (context) => {
      asked = JSON.stringify(context.messages);
      return say('## 目标和要求\n- 做一部短剧\n## 定下来的事\n- 主角叫林晚');
    },
  ]);
  for (const text of ['主角叫林晚', '写分镜表', '出关键帧']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  await hub.condense(board.id, '人物设定');
  assert.match(asked, /用户希望这次整理特别保留：人物设定/);
  const view = await hub.view(board.id);
  assert.equal(view.running, false);
  const summary = view.entries.find((e) => e.kind === 'event' && e.detail);
  assert.ok(summary?.kind === 'event' && /^## 目标和要求/.test(summary.detail!), JSON.stringify(summary));
  const texts = view.entries.map((e) => (e.kind === 'event' ? 'event' : e.kind === 'tool' ? e.label : e.text));
  assert.deepEqual(texts.slice(-3), ['event', '出关键帧', '关键帧在出'], 'the last message and its reply stay word for word');
  await assert.rejects(hub.condense(board.id), /对话还很短/);
});

test('switching to prompts shown first applies from the next call, and keeps the conversation going', async () => {
  const board = await projects.create('switch mode');
  const tasks = fakeTasks();
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-switch', input: ['text'], contextWindow: 200_000 }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只猫' })),
    say('画好了'),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只狗' })),
    say('提示词在等你确认'),
  ]);
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
  let mode: 'risky' | 'prompts' = 'risky';
  const settings = { agentConfig: () => ({ model: 'faux/faux-switch', vision: false, thinking: 'low', approvalMode: mode }) } as unknown as ConstructorParameters<typeof AgentHub>[3];
  const hub = new AgentHub(deps, () => {}, { models, model: 'faux/faux-switch' }, settings);
  await hub.init();
  await hub.send(board.id, { text: '画只猫' });
  await settled(hub, board.id);
  assert.equal(tasks.created.length, 1, 'generated straight away');

  mode = 'prompts';
  hub.refreshRuntime();
  await hub.send(board.id, { text: '再画只狗' });
  const view = await settled(hub, board.id);
  assert.equal(tasks.created.length, 1, 'the second waits on its card');
  assert.ok(view.entries.some((e) => e.kind === 'tool' && e.status === 'waiting' && e.approval?.prompts?.[0]?.text === '一只狗'));
  assert.ok(view.entries.some((e) => e.kind === 'user' && e.text === '画只猫'), 'the conversation was not reset');
});

test('with prompts shown first, an image waits on a card with its prompt, and is generated from the edited one', async () => {
  const board = await projects.create('prompts');
  const tasks = fakeTasks();
  let told = '';
  const { hub } = await hubWith(
    tasks,
    [
      fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '一只猫坐在窗台上', name: '猫' })),
      say('提示词在等你确认'),
      (context) => {
        told = JSON.stringify(context.messages);
        return say('好的');
      },
    ],
    { approvalMode: 'prompts' },
  );
  await hub.send(board.id, { text: '画只猫' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.approval?.title === '生成前确认提示词', JSON.stringify(card));
  assert.deepEqual(card.approval?.prompts, [{ label: '猫', text: '一只猫坐在窗台上', refs: [] }]);
  assert.equal(tasks.created.length, 0, 'nothing generated before the user agrees');

  await hub.approve(board.id, card.id, true, ['一只橘猫坐在窗台上，傍晚的光']);
  assert.equal(tasks.created[0]?.op === 'image.generate' && tasks.created[0].prompt, '一只橘猫坐在窗台上，傍晚的光');
  await hub.send(board.id, { text: '好了吗' });
  await settled(hub, board.id);
  assert.match(told, /用户改了 1 条提示词，按改过的生成：.*猫：一只橘猫坐在窗台上，傍晚的光/);
});

test('with prompts shown first, a video batch card lists every prompt, and edits reach the jobs; reading and writing notes need no card', async () => {
  const board = await projects.create('video prompts');
  const frame = (id: string) => ({ id, kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, createdAt: 1, asset: { id: `a${id}`, url: `/files/a${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } });
  await projects.patchItems(board.id, { upsert: [frame('frame0000a1'), frame('frame0000a2')] });
  const tasks = fakeTasks();
  const { hub } = await hubWith(
    tasks,
    [
      fauxAssistantMessage([
        fauxToolCall('write_note', { title: '分镜表', content: 'S01、S02' }),
        fauxToolCall('batch_generate_videos', {
          jobs: [
            { prompt: '她抬头', first_frame_id: 'frame0000a1', name: 'S01' },
            { prompt: '她转身走开', first_frame_id: 'frame0000a2', name: 'S02' },
          ],
        }),
      ]),
      say('等你确认'),
    ],
    { approvalMode: 'prompts' },
  );
  await hub.send(board.id, { text: '做成视频' });
  const view = await settled(hub, board.id);
  assert.ok((await projects.get(board.id))!.items.some((i) => i.name === '分镜表'), 'a note is written without asking');
  const card = view.entries.find((e) => e.kind === 'tool' && e.status === 'waiting');
  assert.ok(card?.kind === 'tool' && card.tool === 'batch_generate_videos', JSON.stringify(card));
  assert.deepEqual(
    card.approval?.prompts?.map((p) => [p.label, p.text, p.refs]),
    [
      ['S01', '她抬头', ['frame0000a1']],
      ['S02', '她转身走开', ['frame0000a2']],
    ],
  );
  await hub.approve(board.id, card.id, true, ['她抬头', '她回头看了一眼，转身走开']);
  assert.deepEqual(
    tasks.created.map((r) => r.op === 'video.generate' && r.prompt),
    ['她抬头', '她回头看了一眼，转身走开'],
  );
});

test('what the assistant remembers is in every new conversation, and refreshes after a write within one', async () => {
  const board = await projects.create('remember');
  let same = '';
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('remember', { changes: [{ action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚，短发' }] })),
    say('记住了'),
    (context) => {
      same = JSON.stringify(context);
      return say('好');
    },
  ]);
  await hub.send(board.id, { text: '主角叫林晚，短发，记住' });
  const row = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.tool === 'remember');
  assert.ok(row?.kind === 'tool' && row.summary === '记住了画布记忆「主角叫林晚，短发」', JSON.stringify(row));
  assert.equal((await hub.memories(board.id)).board.entries[0]?.text, '主角叫林晚，短发');
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.match(same, /\[m[\w-]+ · 设定 · \d{2}-\d{2} · 助手\] 主角叫林晚，短发/, 'the next message carries the fresh memory');

  let fresh = '';
  const { hub: restarted } = await hubWith(fakeTasks(), [
    (context) => {
      fresh = JSON.stringify(context);
      return say('好');
    },
  ]);
  await restarted.send(board.id, { text: '你好' });
  await settled(restarted, board.id);
  assert.match(fresh, /\[m[\w-]+ · 设定 · \d{2}-\d{2} · 助手\] 主角叫林晚，短发/);
});

test('an edit in the memory page reaches the assistant with the next message', async () => {
  const board = await projects.create('memory page');
  let next = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('你好'),
    (context) => {
      next = JSON.stringify(context.messages.at(-1));
      return say('好的');
    },
  ]);
  await hub.send(board.id, { text: '你好' });
  await settled(hub, board.id);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [{ id: '', type: 'preference', text: '不要字幕', at: 0, by: 'user' }] });
  await hub.send(board.id, { text: '出一段视频' });
  await settled(hub, board.id);
  assert.match(next, /记忆有更新（用户在记忆页改过，或助手刚写入），以这一份为准.*不要字幕/);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [] });
});

test('condensing writes down what lasts, notes where the work stands, and the next request reads the new memory', async () => {
  const board = await projects.create('condense memory');
  const image = (id: string, name: string) => ({ id, kind: 'image' as const, x: 0, y: 0, w: 512, h: 288, name, group: '关键帧', createdAt: 1, asset: { id: `a${id}`, url: `/files/a${id}.png`, kind: 'image' as const, mime: 'image/png', width: 1376, height: 768 } });
  await projects.patchItems(board.id, {
    upsert: [{ id: 'note000001', kind: 'text', x: 0, y: 0, w: 400, h: 300, name: '剧本', text: '第一场：深夜便利店', createdAt: 1 }, image('key0000001', 'S01'), image('key0000002', 'S02')],
  });
  let asked = '';
  let after = '';
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('read_guide', { name: 'short_drama', section: 'shots' })),
    say('读完了'),
    fauxAssistantMessage(fauxToolCall('update_todos', { todos: [{ content: '出关键帧', status: 'completed' }, { content: '出视频', status: 'in_progress' }] })),
    say('开始出视频'),
    say('在出了'),
    (context) => {
      asked = JSON.stringify(context.messages);
      return say('## 目标和要求\n- 做一部短剧\n## 下一步\n- 出视频\n<memory_updates>\n[{"action":"add","scope":"board","type":"decision","text":"画风用日系动画","why":"用户否掉了写实"}]\n</memory_updates>');
    },
    (context) => {
      after = JSON.stringify(context);
      return say('好');
    },
  ]);
  for (const text of ['看看分镜手册', '列个待办', '出视频吧，画风就用日系动画']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  await hub.condense(board.id);
  assert.match(asked, /现有记忆/);
  assert.deepEqual((await hub.memories(board.id)).board.entries.map((e) => [e.type, e.text, e.why]), [['decision', '画风用日系动画', '用户否掉了写实']]);

  const summary = (await hub.view(board.id)).entries.find((e) => e.kind === 'event' && e.detail);
  const detail = summary?.kind === 'event' ? summary.detail! : '';
  assert.doesNotMatch(detail, /memory_updates/);
  assert.match(detail, /整理时的状态：/);
  assert.match(detail, /待办：✓ 出关键帧；▶ 出视频/);
  assert.match(detail, /`note000001`「剧本」9 字/);
  assert.match(detail, /关键帧 2 张（S01、S02）/);
  assert.match(detail, /short_drama · shots/);

  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.match(after, /\[m[\w-]+ · 决定 · \d{2}-\d{2} · 助手 · 可信度 0\.6\] 画风用日系动画（用户否掉了写实）/, 'the instructions after condensing carry the new memory');
});

test('deleting a board deletes its memory, and leaves the user\'s', async () => {
  const board = await projects.create('forget');
  const { hub } = await hubWith(fakeTasks(), []);
  await hub.saveMemory(board.id, 'board', { auto: true, entries: [{ id: '', type: 'setting', text: '主角叫林晚', at: 0, by: 'user' }] });
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [{ id: '', type: 'preference', text: '默认 16:9', at: 0, by: 'user' }] });
  await hub.forget(board.id);
  const left = await hub.memories(board.id);
  assert.deepEqual([left.board.entries.length, left.user.entries.length], [0, 1]);
  await hub.saveMemory(board.id, 'user', { auto: true, entries: [] });
});

test('the to-do list shows in the panel without a row of its own, rides along with each message, and survives a restart', async () => {
  const board = await projects.create('todos');
  const steps = [
    { content: '写剧本', status: 'completed' },
    { content: '出关键帧', status: 'in_progress' },
    { content: '出视频', status: 'pending' },
  ];
  let next = '';
  const { hub, emitted } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('update_todos', { todos: steps })),
    say('开始做'),
    (context) => {
      next = JSON.stringify(context.messages.at(-1));
      return say('接着做');
    },
  ]);
  await hub.send(board.id, { text: '做一部短剧' });
  const view = await settled(hub, board.id);
  assert.deepEqual(view.todos, steps);
  assert.ok(emitted.some((e) => e.todos?.length === 3), 'the panel hears of it as it happens');
  assert.ok(!view.entries.some((e) => e.kind === 'tool'), 'no tool row for it');
  await hub.send(board.id, { text: '继续' });
  await settled(hub, board.id);
  assert.match(next, /你的待办（1\/3 完成）：.*- \[x\] 写剧本.*- \[>\] 出关键帧.*- \[ \] 出视频/);

  const { hub: restarted } = await hubWith(fakeTasks(), []);
  assert.deepEqual((await restarted.view(board.id)).todos, steps);
  await restarted.clear(board.id);
  assert.deepEqual((await restarted.view(board.id)).todos, []);
  assert.deepEqual((await restarted.listSessions(board.id)).sessions, [], 'clear deletes the conversation instead of keeping it');
});

test('a question card waits for a click; the answer goes to the assistant as the user message, and writing past it skips it', async () => {
  const board = await projects.create('question');
  const ask = (q: string) => fauxAssistantMessage(fauxToolCall('ask_user', { question: q, options: [{ label: '日系动画' }, { label: '写实', description: '像电影剧照' }] }));
  let answer = '';
  const { hub } = await hubWith(fakeTasks(), [
    ask('画风选哪种？'),
    say('等你选'),
    (context) => {
      answer = JSON.stringify(context.messages.at(-1));
      return ask('比例呢？');
    },
    say('再等你选'),
    say('好的，用 16:9'),
  ]);
  await hub.send(board.id, { text: '做一张海报' });
  const card = (await settled(hub, board.id)).entries.find((e) => e.kind === 'tool' && e.tool === 'ask_user');
  assert.ok(card?.kind === 'tool' && card.status === 'waiting' && card.question?.options[1].description === '像电影剧照', JSON.stringify(card));

  await hub.answer(board.id, card.id, '写实');
  const view = await settled(hub, board.id);
  assert.match(answer, /回答「画风选哪种？」：写实/);
  const first = view.entries.find((e) => e.id === card.id);
  assert.ok(first?.kind === 'tool' && first.status === 'done' && first.question?.state === 'answered' && first.summary === '已回答：写实', JSON.stringify(first));
  await assert.rejects(hub.answer(board.id, card.id, '日系动画'), /已经回答过了/);

  // The second question is left open, and the user writes something else.
  const second = view.entries.findLast((e) => e.kind === 'tool' && e.tool === 'ask_user')!;
  await hub.send(board.id, { text: '就用 16:9 吧' });
  const after = (await settled(hub, board.id)).entries.find((e) => e.id === second.id);
  assert.ok(after?.kind === 'tool' && after.question?.state === 'skipped' && after.summary === '没有回答', JSON.stringify(after));
});

test('plan mode lets the assistant read but not change the board, until the user accepts its plan', async () => {
  const board = await projects.create('plan');
  let told = '';
  let woken = '';
  const { hub, emitted } = await hubWith(fakeTasks(), [
    (context) => {
      told = JSON.stringify(context.messages.at(-1));
      return fauxAssistantMessage([
        fauxToolCall('read_board', {}),
        fauxToolCall('write_note', { title: '剧本', content: '先写了再说' }),
        fauxToolCall('remember', { changes: [{ action: 'add', scope: 'board', type: 'setting', text: '主角叫林晚' }] }),
      ]);
    },
    fauxAssistantMessage(fauxToolCall('present_plan', { plan: '## 方案\n1. 写剧本\n2. 出三张关键帧' })),
    say('方案在等你确认'),
    (context) => {
      woken = JSON.stringify(context.messages.at(-1));
      return say('开始写剧本');
    },
  ]);
  await hub.setPlan(board.id, true);
  assert.ok(emitted.some((e) => e.plan === true));
  await hub.send(board.id, { text: '做一部短剧' });
  const view = await settled(hub, board.id);
  assert.match(told, /现在是计划模式/);
  const tools = view.entries.filter((e) => e.kind === 'tool');
  assert.deepEqual(
    tools.map((e) => e.kind === 'tool' && [e.tool, e.status]),
    [
      ['read_board', 'done'],
      ['write_note', 'error'],
      ['remember', 'error'],
      ['present_plan', 'waiting'],
    ],
  );
  assert.equal((await projects.get(board.id))!.items.length, 0, 'nothing written in plan mode');
  assert.equal((await hub.memories(board.id)).board.entries.length, 0, 'memory is a write too');
  const card = tools[3];
  assert.ok(card.kind === 'tool' && card.approval?.body?.includes('出三张关键帧') && card.approval.confirm === '按这个做' && card.approval.reject === '再改改', JSON.stringify(card));

  await hub.approve(board.id, card.id, true);
  const done = await settled(hub, board.id);
  assert.equal(done.plan, false);
  assert.match(woken, /用户确认了方案，计划模式已关闭/);
});

test('going back to a message restores the board and the conversation, cancels work started since, and can itself be undone', async () => {
  const board = await projects.create('rewind');
  const tasks = fakeTasks();
  const cancelled: string[] = [];
  tasks.cancel = async (id: string) => {
    cancelled.push(id);
    return tasks.records.get(id);
  };
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('write_note', { title: '剧本', content: '第一场' })),
    say('剧本写好了'),
    fauxAssistantMessage([fauxToolCall('write_note', { title: '分镜表', content: 'S01' }), fauxToolCall('generate_image', { prompt: '一只猫' })]),
    say('分镜表写好了，猫在画'),
  ]);
  await hub.send(board.id, { text: '写剧本' });
  await settled(hub, board.id);
  await hub.send(board.id, { text: '写分镜表，再画只猫' });
  const view = await settled(hub, board.id);
  assert.equal((await projects.get(board.id))!.items.length, 3);
  const users = view.entries.filter((e) => e.kind === 'user');
  assert.ok(users.every((e) => e.kind === 'user' && e.rewind));

  const { text } = await hub.rewind(board.id, users[1].id);
  assert.equal(text, '写分镜表，再画只猫');
  assert.deepEqual((await projects.get(board.id))!.items.map((i) => i.name), ['剧本']);
  assert.equal(tasks.created.length, 1);
  assert.deepEqual(cancelled, [...tasks.records.keys()], 'the cat, still queued');
  const back = await hub.view(board.id);
  assert.deepEqual(back.entries.map((e) => (e.kind === 'tool' ? e.tool : e.kind === 'user' || e.kind === 'assistant' ? e.text : e.kind)), ['写剧本', 'write_note', '剧本写好了']);
  assert.ok((await projects.listSnapshots(board.id)).some((s) => s.name === '回退对话之前'), 'the board before going back is kept');
  await assert.rejects(hub.rewind(board.id, users[1].id), /回不到这条消息了/);
});

test('the panel learns how full the context is, unknown again right after condensing', async () => {
  const board = await projects.create('context');
  const { hub } = await hubWith(fakeTasks(), [say('一'), say('二'), say('三'), say('## 目标和要求\n- 无')], { compactAt: 50_000 });
  for (const text of ['第一句', '第二句', '第三句']) {
    await hub.send(board.id, { text });
    await settled(hub, board.id);
  }
  const { context } = await hub.view(board.id);
  assert.ok(context && context.used > 0 && context.limit === 50_000, JSON.stringify(context));
  await hub.condense(board.id);
  assert.equal((await hub.view(board.id)).context, null);
});

test('saved commands keep clear of the built-ins and of each other, and come back as saved', async () => {
  const { hub } = await hubWith(fakeTasks(), []);
  await assert.rejects(hub.saveCommands([{ name: '计划', prompt: 'x' }]), /内置命令/);
  await assert.rejects(hub.saveCommands([{ name: 'Plan', prompt: 'x' }]), /内置命令/);
  await assert.rejects(hub.saveCommands([{ name: '短 剧', prompt: 'x' }]), /不能有空格/);
  await assert.rejects(hub.saveCommands([{ name: '短剧', prompt: 'a' }, { name: '短剧', prompt: 'b' }]), /有两个命令/);
  await assert.rejects(hub.saveCommands([{ name: '短剧', prompt: '  ' }]), /内容是空的/);
  await assert.rejects(hub.saveCommands({ name: '短剧' }), /格式错误/);
  const saved = await hub.saveCommands([{ name: '/短剧', prompt: ' 做一部短剧：{输入} ' }]);
  assert.deepEqual(saved, [{ name: '短剧', prompt: '做一部短剧：{输入}' }]);
  assert.deepEqual(await hub.commands(), saved);
});

test('checkpoints for going back stay out of the snapshot list, and only the latest forty are kept', async () => {
  const board = await projects.create('checkpoints');
  await projects.createSnapshot(board.id, '用户存的');
  for (let i = 0; i < 42; i++) await projects.createSnapshot(board.id, 'checkpoint', { checkpoint: true });
  assert.deepEqual((await projects.listSnapshots(board.id)).map((s) => s.name), ['用户存的']);
  const files = readdirSync(join(process.env.DATA_DIR!, 'snapshots', board.id));
  assert.equal(files.length, 41);
});

test('an OpenAI-compatible endpoint takes its context length and reasoning from the settings', () => {
  assert.equal(compactThreshold(32_000), 19_200, 'condensed well inside a small window');
  assert.equal(compactThreshold(1_000_000), 100_000);
  assert.equal(compactThreshold(undefined), 100_000);
  const deps = { projects, tasks: fakeTasks(), assets, workflows: () => [], capabilities: async () => ({}), changed: () => {} } as unknown as ConstructorParameters<typeof AgentHub>[0];
  const settings = (reasoning: boolean, contextWindow?: number) =>
    ({
      agentConfig: () => ({ model: 'local-chat', baseUrl: 'http://127.0.0.1:9/v1', vision: false, thinking: 'medium', approvalMode: 'risky', contextWindow, reasoning }),
    }) as unknown as ConstructorParameters<typeof AgentHub>[3];
  type Inside = { model: { contextWindow: number; maxTokens: number; reasoning: boolean }; thinking: string; compactAt: number };
  const small = new AgentHub(deps, () => {}, {}, settings(true, 32_000)) as unknown as Inside;
  assert.deepEqual([small.model.contextWindow, small.model.reasoning, small.thinking, small.compactAt], [32_000, true, 'medium', 19_200]);
  const plain = new AgentHub(deps, () => {}, {}, settings(false)) as unknown as Inside;
  assert.deepEqual([plain.model.contextWindow, plain.model.reasoning, plain.thinking, plain.compactAt], [128_000, false, 'off', 76_800]);
});

test('after switching to English, panel rows are in English and the model is told to answer in English', async () => {
  const { setServerLang } = await import('../server/i18n.ts');
  const board = await projects.create('english');
  let seen = '';
  const { hub } = await hubWith(fakeTasks(), [
    say('好的'),
    (context) => {
      seen = JSON.stringify(context);
      return fauxAssistantMessage(fauxToolCall('write_note', { title: 'Script', content: '- Scene 1' }));
    },
    say('Done'),
  ]);
  await hub.send(board.id, { text: '你好' });
  await settled(hub, board.id);
  setServerLang('en');
  try {
    await hub.send(board.id, { text: 'Write a script' });
    const view = await settled(hub, board.id);
    assert.ok(seen.includes("The user's interface is in English"), 'the language rule reaches the model');
    const row = view.entries.find((e) => e.kind === 'tool');
    assert.ok(row?.kind === 'tool' && row.label === 'Write note' && row.summary === '"Script"', JSON.stringify(row));
  } finally {
    setServerLang('zh');
  }
});

// Harness integration: scripted model decisions exercise real persistence and tool execution.
const harnessPlan = {
  objective: '先写剧本，再制作分镜',
  tasks: [
    { id: 'script', objective: '写完整剧本', dependencies: [], acceptanceCriteria: [{ id: 'body', description: '包含完整开头和结尾' }], maxAttempts: 2 },
    { id: 'shots', objective: '制作分镜', dependencies: ['script'], acceptanceCriteria: [{ id: 'shots', description: '分镜覆盖剧本事件' }], maxAttempts: 2 },
  ],
};

test('task graph execution persists acceptance, drives fresh inference context and follows session history', async () => {
  const board = await projects.create('harness-session');
  const skillText = JSON.stringify(await new SkillEngine('/unused').read('storyboard')).slice(1, -1);
  let sawFreshContext = false;
  let sawSkill = false;
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('read_skill', { id: 'storyboard' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan: harnessPlan })),
    (context) => {
      const text = JSON.stringify(context.messages);
      sawFreshContext = text.includes('revision=1') && text.includes('script [ready]');
      sawSkill = text.includes(skillText);
      return fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'script' }));
    },
    fauxAssistantMessage(fauxToolCall('write_note', { title: '完整剧本', content: '开头：雨夜相遇。结尾：共同回家。' })),
    async () => {
      const output = (await projects.get(board.id))!.items.find((i) => i.name === '完整剧本')!;
      return fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'outputs', revision: 2, id: 'script', outputs: [output.id] }));
    },
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'complete', revision: 3, id: 'script', evidence: [{ criterionId: 'body', note: '已读到雨夜开头与共同回家的结尾' }] })),
    say('剧本已完成，分镜已就绪'),
    say('新对话'),
  ]);
  await hub.send(board.id, { text: '按方案写剧本并准备分镜' });
  const first = await settled(hub, board.id);
  assert.equal(sawFreshContext, true);
  assert.equal(sawSkill, true);
  assert.deepEqual(first.taskGraph?.tasks.map((t) => t.status), ['completed', 'ready']);
  assert.ok(first.entries.every((e) => !('text' in e) || !e.text.includes('<harness_context>')), 'ephemeral context stays out of chat history');
  const saved = await savedConversation(board.id, (text) => JSON.parse(text).taskGraph?.revision === 4);
  assert.deepEqual(saved.activeSkills, ['storyboard']);
  assert.equal(saved.taskGraph.tasks[0].evidence[0].criterionId, 'body');
  const trace = await hub.trace(board.id);
  assert.ok(trace.events.some((e) => e.type === 'tool_end' && e.tool === 'update_task_graph' && e.ok));
  assert.ok(trace.events.some((e) => e.type === 'run_end' && e.ok));
  assert.doesNotMatch(JSON.stringify(trace), /开头：雨夜相遇/);
  await recordBenchmark('task-graph-sequence', hub, board.id);
  await hub.newSession(board.id);
  assert.equal((await hub.taskGraph(board.id)).tasks.length, 0);
  await hub.send(board.id, { text: '新对话' });
  await settled(hub, board.id);
  await hub.openSession(board.id, first.sessionId);
  assert.deepEqual((await hub.taskGraph(board.id)).tasks.map((t) => t.status), ['completed', 'ready']);
});

test('a server restart recovers interrupted graph work without submitting a second GPU task', async () => {
  const board = await projects.create('harness-restart');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan: harnessPlan })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'script' })),
    say('任务开始'),
  ]);
  await hub.send(board.id, { text: '执行任务' });
  await settled(hub, board.id);
  const { hub: restarted } = await hubWith(fakeTasks(tasks.records), [say('先检查旧结果，再决定如何恢复')]);
  const restored = await restarted.taskGraph(board.id);
  assert.deepEqual(restored.tasks.map((t) => t.status), ['failed', 'blocked']);
  assert.equal(restored.tasks[0].attempts, 1);
  assert.equal(tasks.created.length, 0);
  assert.ok((await restarted.trace(board.id)).events.some((e) => e.type === 'recovery'));
  const saved = await savedConversation(board.id, (text) => JSON.parse(text).taskGraph?.tasks[0].status === 'failed');
  assert.equal(saved.taskGraph.tasks[0].attempts, 1);
  await recordBenchmark('interrupted-task-recovery', restarted, board.id);
});

test('independent visual critic sees images and criteria without creator dialogue and rejects a hard identity failure', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 80, height: 80, channels: 3, background: '#a0a0a0' } }).png().toBuffer();
  const refAsset = publicAsset(await assets.save(png, { filename: 'reference.png', mime: 'image/png' }));
  const outAsset = publicAsset(await assets.save(png, { filename: 'result.png', mime: 'image/png' }));
  const board = await projects.create('harness-critic');
  await projects.patchItems(board.id, { upsert: [
    { id: 'critic-ref', kind: 'image', asset: refAsset, x: 0, y: 0, w: 80, h: 80, createdAt: 1 },
    { id: 'critic-out', kind: 'image', asset: outAsset, name: 'PRIVATE-CREATOR-NAME', review: { verdict: 'pass', note: 'SELF-REVIEW-PASS', at: 1 }, request: { op: 'image.generate', model: 'qwen', prompt: 'PRIVATE-GENERATION-PROMPT', aspect: '1:1', quality: '1k' }, x: 100, y: 0, w: 80, h: 80, createdAt: 1 },
  ] });
  let isolated = false;
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan: { objective: '人物关键帧', tasks: [
      { id: 'shot', objective: '参考人物在门左侧', inputs: ['critic-ref'], dependencies: [], acceptanceCriteria: [{ id: 'same-face', description: '人物一致', dimension: 'identity', threshold: 80 }] },
    ] } })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'shot' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'outputs', revision: 2, id: 'shot', outputs: ['critic-out'] })),
    // Cross the 3-second startup recovery timer, reproducing the slow-CI scheduling window.
    async () => { await sleep(3200); return fauxAssistantMessage(fauxToolCall('visual_critic', { id: 'critic-out', task_id: 'shot' })); },
    (context) => {
      const text = JSON.stringify(context.messages);
      isolated = !['private-creator-dialogue', 'PRIVATE-CREATOR-NAME', 'SELF-REVIEW-PASS', 'PRIVATE-GENERATION-PROMPT'].some((secret) => text.includes(secret)) && text.includes('参考人物在门左侧') && text.includes('人物一致') && text.includes('image');
      const payload = JSON.parse((context.messages.find((message) => message.role === 'user')!.content as { type: string; text?: string }[]).find((block) => block.type === 'text')!.text!);
      return say(JSON.stringify({ checks: payload.criteria.map((criterion: { id: string; dimension: string }) => ({ criterionId: criterion.id, score: criterion.dimension === 'identity' ? 58 : 99, evidence: criterion.dimension === 'identity' ? '参考短发，输出长发' : '画面清晰，人物在左侧', visibility: 'observed' })), diagnosis: '人物发型改变' }));
    },
    async () => fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'complete', revision: (await hub.taskGraph(board.id)).revision, id: 'shot', evidence: [{ criterionId: 'same-face', note: '自称通过' }] })),
    say('人物不一致，需要保留构图并用参考图修复'),
  ]);
  await hub.send(board.id, { text: 'private-creator-dialogue，请检查人物关键帧' });
  const view = await settled(hub, board.id);
  assert.equal(isolated, true, JSON.stringify(view.entries));
  const item = (await projects.get(board.id))!.items.find((i) => i.id === 'critic-out')!;
  assert.equal(item.critic?.verdict, 'fail', JSON.stringify(view.entries));
  assert.equal(item.critic?.scores.identity?.score, 58);
  assert.match(item.critic!.repair, /参考图/);
  assert.equal(view.taskGraph?.tasks[0].status, 'failed');
  assert.ok(view.entries.some((e) => e.kind === 'tool' && e.tool === 'update_task_graph' && e.status === 'error'));
  const trace = await hub.trace(board.id);
  assert.equal(trace.events.filter((e) => e.type === 'model' && e.tool === 'visual_critic').length, 1);
  await recordBenchmark('independent-identity-rejection', hub, board.id);
});

test('recorded experience cannot self-promote to user confirmation and survives a fresh hub', async () => {
  const board = await projects.create('harness-experience');
  await projects.patchItems(board.id, { upsert: [{ id: 'experience-note', kind: 'text', text: '已核对全部分镜', x: 0, y: 0, w: 100, h: 100, createdAt: 1 }] });
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('record_experience', { task: '双人对话站位', strategy: '场景图加 mark_layout', outcome: 'success', itemIds: ['experience-note'], confirmation: 'user' })),
    say('已记录执行经验'),
  ]);
  await hub.send(board.id, { text: '记下这次站位修复方法' });
  await settled(hub, board.id);
  const entries = await hub.experiences(board.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].confirmation, 'agent');
  await recordBenchmark('procedural-memory-provenance', hub, board.id);
  await hub.confirmExperience(board.id, entries[0].id, 'success');
  const { hub: restarted } = await hubWith(fakeTasks(), [say('使用已确认方法')]);
  assert.equal((await restarted.experiences(board.id))[0].confirmation, 'user');
});

test('generation is bound to a started graph task, links outputs automatically and refuses duplicate submission', async () => {
  const board = await projects.create('harness-binding');
  const tasks = fakeTasks();
  const plan = { objective: '产品主视觉', tasks: [{ id: 'hero', objective: '生成产品主视觉', dependencies: [], acceptanceCriteria: [{ id: 'visible', description: '主体清晰' }] }] };
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '产品主视觉' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '产品主视觉', task_id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '再次生成产品主视觉', task_id: 'hero' })),
    say('主视觉正在生成，等待结果后审查'),
  ]);
  await hub.send(board.id, { text: '先规划，再生成主视觉' });
  const view = await settled(hub, board.id);
  assert.equal(tasks.created.length, 1);
  assert.equal(view.taskGraph?.tasks[0].status, 'reviewing');
  assert.equal(view.taskGraph?.tasks[0].outputs.length, 1);
  const calls = view.entries.filter((e) => e.kind === 'tool' && e.tool === 'generate_image');
  assert.deepEqual(calls.map((e) => e.kind === 'tool' && e.status), ['error', 'done', 'error']);
  const taskId = [...tasks.records.keys()][0];
  tasks.finish(taskId);
  await sleep(30);
  const trace = await hub.trace(board.id);
  assert.equal(trace.events.filter((e) => e.type === 'generation_queued').length, 1);
  assert.equal(trace.events.filter((e) => e.type === 'generation_end' && e.ok && e.gpuMs! > 0).length, 1);
});

test('a confirmation card from an earlier task attempt cannot launch GPU work after replanning', async () => {
  const board = await projects.create('harness-stale-card');
  const tasks = fakeTasks();
  const plan = { objective: '主视觉', tasks: [{ id: 'hero', objective: '主视觉', dependencies: [], acceptanceCriteria: [{ id: 'q', description: '清晰' }] }] };
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '主视觉', task_id: 'hero' })),
    say('等待确认'),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'fail', revision: 2, id: 'hero', error: '用户调整方案' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'retry', revision: 3, id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 4, id: 'hero' })),
    say('已开始第二次尝试'),
  ], { approvalMode: 'prompts' });
  await hub.send(board.id, { text: '生成主视觉' });
  const first = await settled(hub, board.id);
  const card = first.entries.find((e) => e.kind === 'tool' && e.tool === 'generate_image' && e.status === 'waiting');
  assert.ok(card);
  assert.equal(tasks.created.length, 0);
  await hub.send(board.id, { text: '调整方案后重新开始' });
  await settled(hub, board.id);
  await assert.rejects(() => hub.approve(board.id, card.id, true), /较早的任务尝试/);
  assert.equal(tasks.created.length, 0);
});

test('concurrent confirmations for the same graph task reserve one GPU submission', async () => {
  const board = await projects.create('harness-concurrent-cards');
  const tasks = fakeTasks();
  const plan = { objective: '主视觉', tasks: [{ id: 'hero', objective: '主视觉', dependencies: [], acceptanceCriteria: [{ id: 'q', description: '清晰' }] }] };
  const { hub } = await hubWith(tasks, [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '主视觉方案一', task_id: 'hero' })),
    fauxAssistantMessage(fauxToolCall('generate_image', { prompt: '主视觉方案二', task_id: 'hero' })),
    say('等待确认'),
  ], { approvalMode: 'prompts' });
  await hub.send(board.id, { text: '生成主视觉' });
  const view = await settled(hub, board.id);
  const cards = view.entries.filter((e) => e.kind === 'tool' && e.tool === 'generate_image' && e.status === 'waiting');
  assert.equal(cards.length, 2);
  const results = await Promise.allSettled(cards.map((card) => hub.approve(board.id, card.id, true)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(tasks.created.length, 1);
  assert.equal((await hub.taskGraph(board.id)).tasks[0].outputs.length, 1);
});

test('per-run traces preserve observable inputs and outputs and accept scoped human feedback after session switching', async () => {
  const board = await projects.create('observable-run');
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('write_note', { title: '分镜', content: 'S01 窗边，S02 门口。' })),
    say('已整理两镜头分镜，等你确认。'),
  ]);
  await hub.send(board.id, { text: '整理两镜头分镜。api_key=private-value' });
  await settled(hub, board.id);
  const [trace] = await hub.runTraces(board.id);
  assert.ok(trace);
  assert.equal(trace.execution, 'completed');
  assert.equal(trace.outcome.status, 'partial');
  assert.equal(trace.outcome.basis, 'unconfirmed');
  assert.doesNotMatch(trace.userIntent, /private-value/);
  const call = trace.events.find((entry) => entry.type === 'tool_start' && entry.tool === 'write_note');
  assert.deepEqual(call?.arguments, { title: '分镜', content: 'S01 窗边，S02 门口。' });
  assert.ok(trace.usage.inputTokens > 0 && trace.usage.outputTokens > 0);
  assert.match(trace.promptVersion, /^agent-v4-enhanced-targeted-/);
  await hub.newSession(board.id);
  const feedback = await hub.traceFeedback(board.id, trace.runId, { verdict: 'accepted', assetIds: trace.outputs, comment: '分镜符合要求', source: 'agent' });
  assert.equal(feedback.outcome.basis, 'user');
  assert.equal(feedback.outcome.status, 'success');
  assert.equal(feedback.outcome.userFeedback?.source, 'user');
  assert.equal((await hub.runTraces(board.id, trace.sessionId)).length, 1);
  const other = await projects.create('unrelated-run');
  await assert.rejects(() => hub.traceFeedback(other.id, trace.runId, { verdict: 'accepted' }));
});

test('messages accepted while the final trace is saving run before the session becomes idle', async () => {
  const board = await projects.create('trace-finalization');
  const { hub } = await hubWith(fakeTasks(), [say('第一段完成'), say('第二段完成')]);
  await hub.view(board.id);
  const store = (hub as unknown as { traceStore: { flush(): Promise<void> } }).traceStore;
  const original = store.flush.bind(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const saving = new Promise<void>((resolve) => { entered = resolve; });
  let first = true;
  store.flush = async () => {
    await original();
    if (first) { first = false; entered(); await gate; }
  };
  try {
    await hub.send(board.id, { text: '第一段' });
    await saving;
    assert.equal((await hub.view(board.id)).running, true);
    await hub.send(board.id, { text: '第二段' });
  } finally { release(); }
  const view = await settled(hub, board.id);
  assert.deepEqual(view.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.kind === 'assistant' && entry.text), ['第一段完成', '第二段完成']);
  const { hub: restarted } = await hubWith(fakeTasks(), []);
  assert.ok((await restarted.view(board.id)).entries.some((entry) => entry.kind === 'assistant' && entry.text === '第二段完成'));
});

test('production submission budgets count batch members and survive a fresh hub in the same session', async () => {
  const board = await projects.create('session generation budget');
  const tasks = fakeTasks();
  const { hub } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('generate_image', { prompt: 'A cup', count: 2 })), say('报告已提交的部分')], { sessionGenerationLimit: 1 });
  await hub.send(board.id, { text: '生成两张' });
  await settled(hub, board.id);
  assert.equal(tasks.created.length, 1);
  assert.equal((await savedConversation(board.id, (text) => JSON.parse(text).generationReservations === 1)).generationReservations, 1);
  const { hub: resumed } = await hubWith(tasks, [fauxAssistantMessage(fauxToolCall('generate_image', { prompt: 'Another cup' })), say('预算已用完，不再提交')], { sessionGenerationLimit: 1 });
  await resumed.send(board.id, { text: '继续生成' });
  await settled(resumed, board.id);
  assert.equal(tasks.created.length, 1, 'a new run or server process must not reset the session submission budget');
});

test('a run tool budget blocks later writes without preventing a new explicit user run', async () => {
  const board = await projects.create('run boundary');
  const { hub, faux } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('write_note', { title: 'A', content: 'first' })),
    fauxAssistantMessage(fauxToolCall('write_note', { title: 'B', content: 'must not be written' })),
  ], { budget: { toolCalls: 1 } });
  await hub.send(board.id, { text: '写两条' });
  await settled(hub, board.id);
  assert.deepEqual((await projects.get(board.id))!.items.map((item) => item.name), ['A']);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('write_note', { title: 'C', content: 'new user request' })), say('已完成')]);
  await hub.send(board.id, { text: '明确的新请求，只写 C' });
  await settled(hub, board.id);
  assert.deepEqual((await projects.get(board.id))!.items.map((item) => item.name), ['A', 'C']);
  assert.equal((await hub.runTraces(board.id)).length, 2);
});

test('structured tool failures reach model context and trace while panel errors remain readable', async () => {
  const board = await projects.create('typed tool failure');
  let modelSawCode = false;
  const { hub } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('read_board', { ids: ['not-a-node'] })),
    (context) => { modelSawCode = JSON.stringify(context.messages).includes('INVALID_ARGUMENT'); return say('先检查参数'); },
  ]);
  await hub.send(board.id, { text: '读取不存在节点' });
  const view = await settled(hub, board.id);
  assert.equal(modelSawCode, true);
  const error = view.entries.find((entry) => entry.kind === 'tool' && entry.status === 'error');
  assert.ok(error?.kind === 'tool');
  assert.doesNotMatch(error.summary, /toolError/);
  assert.equal((await hub.runTraces(board.id))[0].events.find((event) => event.type === 'tool_end' && !event.ok)?.error?.code, 'INVALID_ARGUMENT');
});

test('formal validation and local user feedback bind to current session and artifact before completion', async () => {
  const board = await projects.create('formal-validation');
  await projects.patchItems(board.id, { upsert: [{ id: 'json-output', kind: 'text', text: '{"title":"雨夜"}', x: 0, y: 0, w: 100, h: 100, createdAt: 1 }] });
  const criteria: { id: string; description: string; validator: import('../server/agent/tools.ts').Json }[] = [
    { id: 'json', description: '有非空标题', validator: { kind: 'schema', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } } } } },
    { id: 'taste', description: '用户认可标题', validator: { kind: 'user' } },
  ];
  const { hub, faux } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan: { objective: '完成标题', tasks: [{ id: 'title', objective: '完成标题', dependencies: [], acceptanceCriteria: criteria }] } })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'title' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'outputs', revision: 2, id: 'title', outputs: ['json-output'] })),
    fauxAssistantMessage(fauxToolCall('validate_task', { task_id: 'title' })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'complete', revision: 3, id: 'title', evidence: criteria.map((criterion) => ({ criterionId: criterion.id, note: '已经检查' })) })),
    say('结构已通过，等待用户认可。'),
  ]);
  await hub.send(board.id, { text: '检查标题并等我认可' });
  const view = await settled(hub, board.id);
  assert.equal((await hub.taskGraph(board.id)).tasks[0].status, 'reviewing');
  const trace = (await hub.runTraces(board.id))[0];
  assert.ok(trace.events.some((event) => event.type === 'validation' && JSON.stringify(event.result).includes('unknown')));
  await assert.rejects(hub.taskFeedback(board.id, 'title', { sessionId: 'wrong-session', revision: 3, criterionId: 'taste', verdict: 'pass', note: '可以' }), /格式/);
  await assert.rejects(hub.taskFeedback(board.id, 'title', { sessionId: view.sessionId, revision: 3, criterionId: 'taste', signature: 'stale', verdict: 'pass', note: '可以' }), /验收对象已改变/);
  await hub.taskFeedback(board.id, 'title', { sessionId: view.sessionId, revision: 3, criterionId: 'taste', signature: (await hub.taskGraph(board.id)).tasks[0].reviewSignatures?.taste, verdict: 'pass', note: '我认可当前标题' });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'complete', revision: 4, id: 'title', evidence: criteria.map((criterion) => ({ criterionId: criterion.id, note: '已核对当前版本' })) })),
    say('完成'),
  ]);
  await hub.send(board.id, { text: '按验收结果完成' });
  await settled(hub, board.id);
  assert.equal((await hub.taskGraph(board.id)).tasks[0].status, 'completed');
  const candidates = await hub.experiences(board.id);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confirmation, 'agent');
  const runs = await hub.runTraces(board.id);
  const completedRun = runs.find((run) => run.events.some((event) => event.type === 'validation' && event.ok))!;
  await hub.traceFeedback(board.id, completedRun.runId, { verdict: 'accepted', comment: '最终结果已确认' });
  assert.equal((await hub.experiences(board.id))[0].trust, 'user-confirmed');
  const graph = await hub.taskGraph(board.id);
  await hub.taskFeedback(board.id, 'title', { sessionId: view.sessionId, revision: graph.revision, criterionId: 'taste', signature: graph.tasks[0].reviewSignatures?.taste, verdict: 'fail', note: '重新看过，标题不符合我的偏好' });
  assert.equal((await hub.taskGraph(board.id)).tasks[0].status, 'failed');
});

test('rewinding restores the skill task scope together with its saved activation', async () => {
  const board = await projects.create('skill-rewind');
  await projects.patchItems(board.id, { upsert: [{ id: 'body', kind: 'text', text: '完整剧本', x: 0, y: 0, w: 100, h: 100, createdAt: 1 }] });
  const steps = ['a', 'b'].map((id) => ({ id, objective: id, dependencies: [], acceptanceCriteria: [{ id: 'body', description: '正文存在' }] }));
  const { hub, faux } = await hubWith(fakeTasks(), [
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'plan', revision: 0, plan: { objective: '两段独立任务', tasks: steps } })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 1, id: 'a' })),
    fauxAssistantMessage(fauxToolCall('read_skill', { id: 'storyboard' })),
    say('任务 A 已加载分镜技能'),
  ]);
  await hub.send(board.id, { text: '准备任务 A' });
  await settled(hub, board.id);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'outputs', revision: 2, id: 'a', outputs: ['body'] })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'complete', revision: 3, id: 'a', evidence: [{ criterionId: 'body', note: '正文存在' }] })),
    fauxAssistantMessage(fauxToolCall('update_task_graph', { action: 'start', revision: 4, id: 'b' })),
    fauxAssistantMessage(fauxToolCall('read_skill', { id: 'product-photography' })),
    say('任务 B 已加载产品摄影技能'),
  ]);
  await hub.send(board.id, { text: '完成 A 并切换到 B' });
  const view = await settled(hub, board.id);
  await savedConversation(board.id, (text) => JSON.parse(text).activeSkillsScope === 'b');
  await hub.rewind(board.id, view.entries.filter((entry) => entry.kind === 'user')[1].id);
  const saved = await savedConversation(board.id, (text) => JSON.parse(text).activeSkillsScope === 'a');
  assert.deepEqual(saved.activeSkills, ['storyboard']);
  assert.equal(saved.taskGraph.tasks.find((task: { id: string }) => task.id === 'b').attempts, 0);
});
