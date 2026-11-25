import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentExperience, AgentTaskGraph, CanvasItem, Task, WorkflowLike } from '../shared/types.ts';
import { changeTaskGraph, emptyTaskGraph, reconcileTaskGraph, recoverTaskGraph, type TaskGraphAction, type TaskGraphPlan } from '../server/agent/task-graph.ts';
import { SkillEngine } from '../server/agent/skills.ts';
import { ExperienceStore } from '../server/agent/experience.ts';
import { parseCritique, parseStructuredCritique } from '../server/agent/visual-critic.ts';
import { rankWorkflows } from '../server/agent/router.ts';
import { buildTaskContext } from '../server/agent/context.ts';
import { evaluateAgentTrace } from '../server/agent/evaluation.ts';

const note = (id: string): CanvasItem => ({ id, kind: 'text', text: `完成的 ${id}`, x: 0, y: 0, w: 100, h: 100, createdAt: 1 });
const image = (id: string): CanvasItem => ({ ...note(id), kind: 'image', asset: { id: `asset-${id}`, kind: 'image', url: '', width: 64, height: 64, mime: 'image/png' } });
const step = (id: string, dependencies: string[] = []) => ({ id, objective: `${id} 目标`, dependencies, acceptanceCriteria: [{ id: 'content', description: '内容完整' }], maxAttempts: 2 });
const plan: TaskGraphPlan = { objective: '多镜头创作', tasks: [step('script'), step('shot-a', ['script']), step('cut', ['shot-a']), step('independent')] };
const create = () => changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan }, []);
const change = (graph: AgentTaskGraph, action: { action: 'start' | 'retry'; id: string }, items: CanvasItem[] = []) => changeTaskGraph(graph, { ...action, revision: graph.revision }, items);

function finish(graph: AgentTaskGraph, id: string): AgentTaskGraph {
  graph = change(graph, { action: 'start', id });
  graph = changeTaskGraph(graph, { action: 'outputs', revision: graph.revision, id, outputs: [id] }, [note(id)]);
  return changeTaskGraph(graph, { action: 'complete', revision: graph.revision, id, evidence: [{ criterionId: 'content', note: '已读取并核对内容' }] }, [note(id)]);
}

test('a DAG rejects cycles, missing dependencies and stale revisions without changing progress', () => {
  const graph = create();
  assert.deepEqual(graph.tasks.map((t) => t.status), ['ready', 'pending', 'pending', 'ready']);
  assert.throws(() => changeTaskGraph(graph, { action: 'start', revision: 0, id: 'script' }, []), /revision/);
  assert.throws(() => change(graph, { action: 'start', id: 'cut' }), /ready/);
  assert.throws(() => changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan: { objective: 'cycle', tasks: [step('a', ['b']), step('b', ['a'])] } }, []), /环/);
  assert.throws(() => changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan: { objective: 'missing', tasks: [step('a', ['absent'])] } }, []), /不存在依赖/);
  assert.equal(graph.revision, 1);
  assert.equal(graph.tasks[0].attempts, 0);
});

test('retry invalidates only the affected descendants and cannot reset the attempt budget', () => {
  let graph = finish(finish(finish(finish(create(), 'script'), 'shot-a'), 'cut'), 'independent');
  graph = change(graph, { action: 'retry', id: 'shot-a' });
  assert.deepEqual(graph.tasks.map((t) => t.status), ['completed', 'ready', 'pending', 'completed']);
  assert.deepEqual(graph.tasks.find((t) => t.id === 'cut')!.outputs, []);
  assert.deepEqual(graph.tasks.find((t) => t.id === 'shot-a')!.previousOutputs, ['shot-a']);
  assert.equal(graph.tasks.find((t) => t.id === 'shot-a')!.attempts, 1);
  graph = change(graph, { action: 'start', id: 'shot-a' });
  graph = changeTaskGraph(graph, { action: 'fail', revision: graph.revision, id: 'shot-a', error: '人物不一致' }, []);
  assert.throws(() => change(graph, { action: 'retry', id: 'shot-a' }), /预算/);
  assert.equal(graph.tasks.find((t) => t.id === 'cut')!.status, 'blocked');
  assert.throws(() => changeTaskGraph(graph, { action: 'plan', revision: graph.revision, plan: { ...plan, tasks: plan.tasks.map((t) => ({ ...t, maxAttempts: 5 })) } }, []), /预算/);
});

test('completion needs actual outputs, evidence and every visual hard constraint', () => {
  const ref = image('ref');
  let output = image('result');
  const visualPlan: TaskGraphPlan = { objective: '保持人物', tasks: [{ ...step('shot'), inputs: ['ref'], acceptanceCriteria: [{ id: 'face', description: '人物一致', dimension: 'identity', threshold: 80 }] }] };
  let graph = changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan: visualPlan }, [ref]);
  graph = change(graph, { action: 'start', id: 'shot' });
  graph = changeTaskGraph(graph, { action: 'outputs', revision: graph.revision, id: 'shot', outputs: ['result'] }, [output, ref]);
  const complete: TaskGraphAction = { action: 'complete', revision: graph.revision, id: 'shot', evidence: [{ criterionId: 'face', note: '脸型与参考一致' }] };
  assert.throws(() => changeTaskGraph(graph, complete, []), /输出/);
  assert.throws(() => changeTaskGraph(graph, complete, [output, ref]), /独立审查/);
  const critique = (score: number, referenceIds = ['ref'], objective = 'shot 目标') => ({ ...parseStructuredCritique(JSON.stringify({ checks: [{ criterionId: 'face', score, evidence: '比较脸型、发型和服装', visibility: 'observed' }], diagnosis: '脸型对照' }), { criteria: [{ id: 'face', description: '人物一致', dimension: 'identity', threshold: 80 }], referenceIds, objective, model: 'faux' }), assetId: output.asset!.id, referenceAssets: { ref: ref.asset!.id } });
  output = { ...output, critic: critique(58) };
  assert.throws(() => changeTaskGraph(graph, complete, [output, ref]), /输出/);
  output.critic = critique(95, [], '另一个任务');
  assert.throws(() => changeTaskGraph(graph, complete, [output, ref]), /独立审查/);
  output.critic = critique(95, []);
  assert.throws(() => changeTaskGraph(graph, complete, [output, ref]), /独立审查/);
  output.critic = critique(95);
  const passed = changeTaskGraph(graph, complete, [output, ref]);
  assert.equal(passed.tasks[0].status, 'completed');
  output.critic.checks![0].description = '另一个要求';
  assert.throws(() => changeTaskGraph(graph, complete, [output, ref]), /独立审查/);
});

test('restart retains attempts, blocks failed descendants and never claims interrupted work succeeded', () => {
  const running = change(create(), { action: 'start', id: 'script' });
  const recovered = recoverTaskGraph(running);
  assert.deepEqual(recovered.tasks.map((t) => t.status), ['failed', 'blocked', 'blocked', 'ready']);
  assert.equal(recovered.tasks[0].attempts, 1);
  assert.match(recovered.tasks[0].error!, /避免重复提交/);
  assert.equal(recoverTaskGraph(recovered).revision, recovered.revision, 'recovery is idempotent');
  assert.equal(running.tasks[0].status, 'running', 'recovery does not mutate the old snapshot');
});

test('deleting a completed output invalidates its downstream acceptance', () => {
  const completed = finish(finish(finish(create(), 'script'), 'shot-a'), 'cut');
  const reconciled = reconcileTaskGraph(completed, [note('script'), note('cut')]);
  assert.deepEqual(reconciled.tasks.map((t) => t.status), ['completed', 'failed', 'blocked', 'ready']);
  assert.deepEqual(reconciled.tasks[2].evidence, []);
  assert.equal(reconcileTaskGraph(reconciled, [note('script'), note('cut')]), reconciled);
});

test('editing completed content invalidates only affected descendants while canvas moves remain cosmetic', () => {
  const completed = finish(finish(finish(create(), 'script'), 'shot-a'), 'independent');
  const original = [note('script'), note('shot-a'), note('independent')];
  assert.equal(reconcileTaskGraph(completed, original.map((item) => ({ ...item, x: 500, name: 'renamed' }))), completed);
  const changed = original.map((item) => item.id === 'script' ? { ...item, text: '新的剧本内容' } : item);
  const invalid = reconcileTaskGraph(completed, changed);
  assert.equal(invalid.tasks.find((task) => task.id === 'script')!.status, 'failed');
  assert.equal(invalid.tasks.find((task) => task.id === 'shot-a')!.status, 'blocked');
  assert.equal(invalid.tasks.find((task) => task.id === 'independent')!.status, 'completed');
  assert.equal(reconcileTaskGraph(invalid, changed), invalid);
});

test('a running task whose reference changed cannot be accepted when its old GPU result arrives', () => {
  const ref = image('ref');
  let graph = changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan: { objective: 'edit', tasks: [{ ...step('edit'), inputs: ['ref'] }] } }, [ref]);
  graph = change(graph, { action: 'start', id: 'edit' }, [ref]);
  const replaced = { ...ref, asset: { ...ref.asset!, id: 'replacement-asset' } };
  graph = reconcileTaskGraph(graph, [replaced]);
  assert.equal(graph.tasks[0].status, 'running', 'a remote job remains visible until explicitly cancelled');
  assert.equal(graph.tasks[0].invalidated, true);
  graph = changeTaskGraph(graph, { action: 'outputs', revision: graph.revision, id: 'edit', outputs: ['old-result'] }, [replaced, note('old-result')]);
  assert.equal(graph.tasks[0].status, 'failed');
  assert.deepEqual(graph.tasks[0].outputs, ['old-result']);
});

test('critic hard thresholds cannot be hidden by high scores elsewhere, or by malformed JSON', () => {
  const opts = { thresholds: { instruction: 80, identity: 80, quality: 75 }, referenceIds: ['ref'], objective: 'same character', model: 'faux' };
  const result = parseCritique(JSON.stringify({ scores: { instruction: { score: 99, evidence: '动作正确' }, identity: { score: 58, evidence: '参考短发，结果长发' }, quality: { score: 99, evidence: '清晰' } }, reason: 'subject_mismatch', diagnosis: '头发不一致' }), opts);
  assert.equal(result.verdict, 'fail');
  assert.match(result.repair, /参考图/);
  for (const text of ['not JSON', '{}', '{"scores":{"identity":{"score":100}},"diagnosis":"pass"}']) assert.throws(() => parseCritique(text, opts));
});

test('skills discover user extensions and confine references including symlinks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kynflow-skills-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'skills');
  await mkdir(join(root, 'custom', 'references'), { recursive: true });
  const markdown = '---\nname: 自定义摄影\ndescription: 水下产品拍摄\ntools: view_images, visual_critic\n---\n先检查水下折射。';
  await writeFile(join(root, 'custom', 'SKILL.md'), markdown);
  await writeFile(join(root, 'custom', 'references', 'lighting.md'), '检查边缘光');
  await writeFile(join(dir, 'secret.txt'), 'must not escape');
  await symlink(join(dir, 'secret.txt'), join(root, 'custom', 'references', 'escape.txt'));
  const engine = new SkillEngine(root);
  const catalog = await engine.list();
  assert.equal(catalog.filter((s) => s.source === 'builtin').length, 8);
  assert.equal(catalog.find((s) => s.id === 'custom')?.description, '水下产品拍摄');
  assert.match(await engine.read('custom'), /折射/);
  assert.equal(await engine.read('custom', 'references/lighting.md'), '检查边缘光');
  assert.ok(JSON.parse(await engine.read('storyboard', 'schemas/shot.json')).required.includes('continuity'));
  for (const resource of ['../secret.txt', 'references/../../../secret.txt', 'references/escape.txt']) await assert.rejects(() => engine.read('custom', resource));
  await assert.rejects(() => engine.read('../custom'));
  await mkdir(join(root, 'product-photography'), { recursive: true });
  await writeFile(join(root, 'product-photography', 'SKILL.md'), markdown);
  assert.equal((await engine.list()).find((s) => s.id === 'product-photography')?.source, 'builtin', 'built-ins cannot be shadowed');
});

async function skillReadFixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-skill-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'skills');
  const references = join(root, 'custom', 'references');
  await mkdir(references, { recursive: true });
  await writeFile(join(root, 'custom', 'SKILL.md'), '---\nname: Test\ndescription: File reading regression\n---\nRead the reference.');
  await writeFile(join(references, 'lighting.md'), 'original reference');
  const path = await fs.realpath(join(references, 'lighting.md'));
  return { directory, root, references, path, engine: new SkillEngine(root, join(directory, 'no-builtins')) };
}

test('skill metadata and content use one descriptor when the pathname is replaced after inspection', async (t) => {
  const { engine, path } = await skillReadFixture(t);
  const open = fs.open;
  let replaced = false;
  let descriptor: FileHandle | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === path) {
      descriptor = handle;
      const metadata = await handle.stat();
      t.mock.method(handle, 'stat', async () => {
        await fs.rename(path, `${path}.old`);
        await writeFile(path, 'replacement content');
        replaced = true;
        return metadata;
      });
    }
    return handle;
  });
  assert.equal(await engine.read('custom', 'references/lighting.md'), 'original reference');
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(path, 'utf8'), 'replacement content');
  await assert.rejects(() => descriptor!.read(Buffer.alloc(1), 0, 1, null), { code: 'EBADF' });
});

test('skill reads stay bounded when a file grows after fstat and close the descriptor on rejection', async (t) => {
  const { engine, path } = await skillReadFixture(t);
  const open = fs.open;
  let totalRead = 0;
  let descriptor: FileHandle | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === path) {
      descriptor = handle;
      const metadata = await handle.stat();
      t.mock.method(handle, 'stat', async () => {
        await fs.appendFile(path, Buffer.alloc(100_000, 'x'));
        return metadata;
      });
      const read = handle.read.bind(handle);
      t.mock.method(handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        const result = await read(buffer, offset, length, position);
        totalRead += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  await assert.rejects(() => engine.read('custom', 'references/lighting.md'), /过大/);
  assert.equal(totalRead, 48_001);
  await assert.rejects(() => descriptor!.read(Buffer.alloc(1), 0, 1, null), { code: 'EBADF' });
});

test('a skill file swapped for an outside symlink before opening is refused', async (t) => {
  if (!constants.O_NOFOLLOW) return t.skip('O_NOFOLLOW is unavailable on this platform');
  const { engine, directory, path } = await skillReadFixture(t);
  const secret = join(directory, 'outside.txt');
  await writeFile(secret, 'outside contents');
  const open = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === path) {
      assert.ok(Number(args[1]) & constants.O_NOFOLLOW);
      await fs.rename(path, `${path}.old`);
      await symlink(secret, path);
    }
    return open(...args);
  });
  await assert.rejects(() => engine.read('custom', 'references/lighting.md'), { code: 'ELOOP' });
});

test('a skill parent directory redirected before opening is refused and the opened file is closed', async (t) => {
  const { engine, directory, references, path } = await skillReadFixture(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'lighting.md'), 'outside contents');
  const open = fs.open;
  let descriptor: FileHandle | undefined;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === path) {
      await fs.rename(references, `${references}.old`);
      await symlink(outside, references);
      descriptor = await open(...args);
      return descriptor;
    }
    return open(...args);
  });
  await assert.rejects(() => engine.read('custom', 'references/lighting.md'), /路径已改变/);
  await assert.rejects(() => descriptor!.read(Buffer.alloc(1), 0, 1, null), { code: 'EBADF' });
});

test('experience writes survive concurrency and restart, and confirmation is scoped to the owner board', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kynflow-experience-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperienceStore(dir);
  const entries = await Promise.all(Array.from({ length: 12 }, (_, n) => store.record('board', 'session', { task: `双人对话 ${n}`, strategy: '场景参考图加 mark_layout 纠正左右站位', outcome: 'success', itemIds: [`shot-${n}`] })));
  assert.equal((await new ExperienceStore(dir).list()).length, 12);
  assert.ok(entries.every((e) => e.confirmation === 'agent'));
  await assert.rejects(() => store.confirm('other-board', entries[0].id, 'success'), /不存在/);
  await store.confirm('board', entries[0].id, 'success');
  const matches = await store.search('双人对话站位');
  assert.equal(matches[0].id, entries[0].id);
  assert.equal(matches[0].confirmation, 'user');
  assert.deepEqual(await store.search(''), []);
});

test('routing uses real completion rates, gives no quality credit to self-assessment, and respects weights', () => {
  const workflows: WorkflowLike[] = ['slow', 'fast'].map((id) => ({ id, name: id, kind: 'image', inputs: [], outputs: [], createdAt: 0, updatedAt: 0 }));
  const tasks: Task[] = workflows.flatMap((w) => Array.from({ length: 6 }, (_, n) => ({ id: `${w.id}-${n}`, request: { op: 'custom' as const, workflow: w.id }, status: 'done' as const, progress: 1, results: [], seed: 1, createdAt: 0, startedAt: 10, finishedAt: w.id === 'fast' ? 1010 : 10010, expected: { kind: 'image' as const, width: 64, height: 64 } })));
  const experiences: AgentExperience[] = Array.from({ length: 8 }, (_, n) => ({ id: `e${n}`, projectId: 'p', sessionId: 's', task: 'portrait', strategy: 'reference image', workflowId: 'slow', confirmation: 'agent', outcome: 'success', itemIds: [`shot${n}`], at: n }));
  const unconfirmed = rankWorkflows(workflows, tasks, experiences);
  assert.equal(unconfirmed[0].id, 'fast');
  assert.ok(unconfirmed.every((r) => r.quality === null && r.qualitySamples === 0));
  experiences.forEach((e) => e.confirmation = 'user');
  assert.equal(rankWorkflows(workflows, tasks, experiences, { quality: 1, reliability: 0, speed: 0, cost: 0 })[0].id, 'slow');
  assert.equal(rankWorkflows(workflows, tasks, experiences, { quality: 0, reliability: 0, speed: 1, cost: 0 })[0].id, 'fast');
  assert.equal(rankWorkflows([workflows[1]], tasks, experiences)[0].id, 'fast', 'ranking never reintroduces an excluded candidate');
  assert.equal(rankWorkflows(workflows, [], [])[0].quality, null);
  assert.throws(() => rankWorkflows(workflows, tasks, experiences, { quality: -1, reliability: 0, speed: 0, cost: 0 }));
});

test('context includes the active task and direct dependencies while respecting a fixed budget', () => {
  const graph = finish(create(), 'script');
  const context = buildTaskContext(graph, [note('script'), note('unrelated-secret')], [{ id: 'storyboard', text: '先标记站位' }], [], (i) => i.text!);
  assert.match(context, /shot-a/);
  assert.match(context, /完成的 script/);
  assert.match(context, /先标记站位/);
  assert.doesNotMatch(context, /unrelated-secret/);
  assert.ok(buildTaskContext(graph, [], [{ id: 'huge', text: 'x'.repeat(50000) }], [], () => '', 500).length <= 500);
});

test('evaluation reports actual tool failures, model cost, GPU time and retries instead of inferring success from narration', () => {
  const base = { id: 'e', runId: 'r', at: 1 };
  const result = evaluateAgentTrace({ id: 'limits', requiredTools: ['visual_critic'], forbiddenTools: ['delete_items'], minCompletedTasks: 1, budget: { tokens: 100, gpuMs: 2000, retries: 0 } }, [
    { ...base, type: 'tool_start', tool: 'visual_critic' },
    { ...base, type: 'tool_end', tool: 'visual_critic', ok: false },
    { ...base, type: 'tool_start', tool: 'delete_items' },
    { ...base, type: 'model', tokens: 150, cost: 0.01 },
    { ...base, type: 'generation_queued', retry: true, taskIds: ['gpu-task'] },
    { ...base, type: 'generation_end', taskId: 'gpu-task', gpuMs: 3000, ok: false },
  ], emptyTaskGraph());
  assert.equal(result.passed, false);
  assert.equal(result.metrics.toolErrors, 1);
  assert.equal(result.metrics.tokens, 150);
  assert.equal(result.metrics.gpuMs, 3000);
  assert.equal(result.metrics.retries, 1);
  assert.equal(result.metrics.generationFailures, 1);
  assert.equal(result.failures.length, 6);
});
