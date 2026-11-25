import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentTask, CanvasItem } from '../shared/types.ts';
import { ContextBuilder, contextBlock } from '../server/agent/context-builder.ts';
import { SkillEngine } from '../server/agent/skills.ts';
import { defaultValidators, schemaVerdict, validationSignature } from '../server/agent/verification.ts';
import { changeTaskGraph, emptyTaskGraph, reconcileTaskGraph, visualCriterionPass } from '../server/agent/task-graph.ts';
import { ExperienceStore } from '../server/agent/experience.ts';
import { RunController } from '../server/agent/runtime/run-controller.ts';

const item: CanvasItem = { id: 'output', kind: 'text', text: '{"title":"雨夜"}', x: 0, y: 0, w: 100, h: 100, createdAt: 1 };
const task = (): AgentTask => ({ id: 'script', objective: '输出标题', dependencies: [], inputs: [], outputs: [item.id], acceptanceCriteria: [{ id: 'json', description: '标题为非空字符串', validator: { kind: 'schema', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1 } }, additionalProperties: false } } }], evidence: [], status: 'reviewing', attempts: 1, maxAttempts: 2 });

test('context reserves all request components, deduplicates sources and never drops a required constraint', async () => {
  const required = contextBlock('task', '必须保留瓶盖与标签', true);
  const builder = new ContextBuilder([
    { id: 'tasks', priority: 100, retrieve: async () => [required, required] },
    { id: 'board', priority: 1, retrieve: async () => [contextBlock('large-board', '其它资料'.repeat(200))] },
  ]);
  const request = { query: '瓶子', contextWindow: 1000, reserves: { system: 100, tools: 100, history: 100, images: 200, output: 200 } };
  const result = await builder.build(request);
  assert.equal(result.budget, 300);
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.omitted, ['large-board']);
  assert.ok(result.text.includes('瓶盖'));
  await assert.rejects(builder.build({ ...request, contextWindow: 720 }), /硬性约束/);
  await assert.rejects(new ContextBuilder([{ id: 'bad', priority: 1, retrieve: async () => [{ ...required, tokenCount: -1 }] }]).build(request), /Invalid/);
});

test('skills compose by task intent and capability and report content version changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kynflow-skill-compose-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'story'));
  const file = join(root, 'story', 'SKILL.md');
  const text = '---\nname: 分镜规划\ndescription: 视频故事与镜头脚本\ntools: read_board\n---\n逐镜头列出角色动作。';
  await writeFile(file, text);
  const skills = new SkillEngine(root, join(root, 'none'));
  assert.deepEqual(await skills.match('视频脚本', []), []);
  assert.equal((await skills.match('视频脚本', ['read_board']))[0].id, 'story');
  await assert.rejects(skills.compose(['story'], []), /缺少必要工具/);
  const before = await skills.compose(['story', 'story'], ['read_board']);
  assert.equal(before.length, 1);
  await writeFile(file, text + '\n先保留用户硬约束。');
  assert.notEqual((await skills.compose(['story'], ['read_board']))[0].version, before[0].version);
});

test('schema subset does not turn unsupported or malformed constraints into a pass', () => {
  assert.equal(schemaVerdict({ title: '雨夜' }, task().acceptanceCriteria[0].validator!.kind === 'schema' ? (task().acceptanceCriteria[0].validator as { schema: Record<string, unknown> }).schema : {}), 'pass');
  assert.equal(schemaVerdict({}, { type: 'object', required: ['title'] }), 'fail');
  assert.equal(schemaVerdict('wrong', { type: 'integer' }), 'fail');
  assert.equal(schemaVerdict('abc', { pattern: '^b' }), 'unknown');
  assert.equal(schemaVerdict({ n: 1 }, { properties: { n: { type: 'number', maximum: 0 } } }), 'fail');
  assert.equal(schemaVerdict(JSON.parse('{"__proto__":{"title":"unexpected"}}'), { type: 'object', properties: { title: { type: 'string' } }, additionalProperties: false }), 'fail');
});

test('validation gates completion and becomes stale after an output or criterion changes', async () => {
  const current = task();
  const registry = defaultValidators(visualCriterionPass);
  const results = await registry.validate(current, [item], async () => true);
  assert.equal(results[0].verdict, 'pass');
  const graph = { ...emptyTaskGraph(), tasks: [current] };
  const complete = { action: 'complete' as const, revision: 0, id: current.id, evidence: [{ criterionId: 'json', note: '检查当前 JSON' }] };
  assert.throws(() => changeTaskGraph(graph, complete, [item]), /验收未通过/);
  const finished = changeTaskGraph(graph, complete, [item], false, results);
  assert.equal(finished.tasks[0].status, 'completed');
  assert.equal(reconcileTaskGraph(finished, [{ ...item, text: '{}' }]).tasks[0].status, 'failed');
  const changed = structuredClone(graph);
  changed.tasks[0].acceptanceCriteria[0].description = '更严格的验收';
  assert.throws(() => changeTaskGraph(changed, complete, [item], false, results), /验收未通过/);
  assert.equal((await registry.validate(current, [item], async () => false))[0].verdict, 'fail');
  assert.equal((await registry.validate(current, [item], async () => { throw new Error('unreadable'); }))[0].verdict, 'unknown');
});

test('unknown visual and user judgments preserve the attempt and require current evidence', async () => {
  const current = task();
  current.acceptanceCriteria = [{ id: 'taste', description: '用户认可风格', validator: { kind: 'user' } }, { id: 'identity', description: '身份一致', dimension: 'identity' }];
  const registry = defaultValidators(visualCriterionPass);
  assert.deepEqual((await registry.validate(current, [item], async () => true)).map((result) => result.verdict), ['unknown', 'unknown']);
  current.userValidation = [{ criterionId: 'taste', validator: 'user', version: 'harness-v1', signature: validationSignature(current, current.acceptanceCriteria[0], new Map([[item.id, item]])), verdict: 'pass', evidence: ['用户明确确认当前版本'], at: 1 }];
  assert.equal((await registry.validate(current, [item], async () => true))[0].verdict, 'pass');
  assert.equal((await registry.validate(current, [{ ...item, text: '改版' }], async () => true))[0].verdict, 'unknown');
  assert.equal(current.attempts, 1);
});

test('machine candidates deduplicate, preserve provenance and only scoped user feedback promotes trust', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-experience-candidates-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExperienceStore(directory);
  const current = task();
  current.status = 'completed';
  current.validation = await defaultValidators(visualCriterionPass).validate(current, [item], async () => true);
  for (let i = 0; i < 2; i++) await store.candidate('board', 'session', current, [item], 'run', 'test/model-v1', ['write_note', 'validate_task']);
  let entries = await new ExperienceStore(directory).list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].trust, 'machine-verified');
  assert.equal(entries[0].confirmation, 'agent');
  assert.equal(entries[0].provenance?.model, 'test/model-v1');
  await store.confirmRun('other-board', 'run', { source: 'user', verdict: 'accepted', comment: '', assetIds: [], at: 2 });
  assert.equal((await store.list())[0].trust, 'machine-verified');
  await store.confirmRun('board', 'run', { source: 'user', verdict: 'rejected', comment: '', assetIds: [], at: 3 });
  entries = await store.list();
  assert.equal(entries[0].trust, 'user-confirmed');
  assert.equal(entries[0].outcome, 'failure');
  await store.candidate('board', 'session', current, [item], 'run', 'test/model-v1', []);
  assert.equal((await store.list())[0].outcome, 'failure');
});

test('a wall-clock budget aborts a stalled model without waiting for the next tool', async () => {
  const controller = new RunController('timeout', { durationMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.code, 'BUDGET_EXCEEDED');
  controller.finish(false);
  await controller.done;
});
