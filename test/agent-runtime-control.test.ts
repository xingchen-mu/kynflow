import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunController } from '../server/agent/runtime/run-controller.ts';
import { ToolExecutionError, toolFailure } from '../server/agent/tool-errors.ts';
import { AgentSubmissions } from '../server/agent/runtime/submissions.ts';
import type { TaskManager } from '../server/tasks/manager.ts';
import { recoverOwnedOutputs } from '../server/agent/runtime/recovery.ts';
import { changeTaskGraph, emptyTaskGraph, recoverTaskGraph } from '../server/agent/task-graph.ts';
import type { Task } from '../shared/types.ts';

test('run budgets reserve before execution and cannot be reset by dropping trace entries', () => {
  const run = new RunController('run', { modelCalls: 2, toolCalls: 1, generations: 1 });
  run.reserve('modelCalls'); run.reserve('toolCalls'); run.reserve('generations'); run.reserve('modelCalls');
  assert.throws(() => run.reserve('modelCalls'), (error) => error instanceof ToolExecutionError && error.code === 'BUDGET_EXCEEDED');
  assert.equal(run.signal.aborted, true);
  assert.deepEqual(run.usage, { modelCalls: 2, toolCalls: 1, generations: 1, tokens: 0, cost: 0 });
});

test('stopped and completed runs cannot start later work while a separate run has its own budget', () => {
  const interrupted = new RunController('old'); interrupted.stop();
  assert.throws(() => interrupted.reserve('generations'), /已停止/);
  const completed = new RunController('done'); completed.finish();
  assert.throws(() => completed.reserve('toolCalls'), /已停止/);
  const next = new RunController('new'); next.reserve('generations');
  assert.equal(next.usage.generations, 1);
});

test('model consumption and wall-clock limits gate the next operation without inventing billing data', () => {
  const run = new RunController('tokens', { tokens: 100 }); run.observe(110, 0);
  assert.throws(() => run.reserve('modelCalls'), /tokens/);
  assert.throws(() => new RunController('time', { durationMs: 0 }).reserve('toolCalls'), /durationMs/);
  assert.throws(() => new RunController('invalid', { generations: NaN }), /Invalid/);
});

test('tool failures distinguish resource, transport, stale-state and argument failures and redact credentials', () => {
  assert.equal(toolFailure(new Error('CUDA out of memory')).code, 'OUT_OF_MEMORY');
  assert.equal(toolFailure(new Error('connection closed')).recovery, 'wait_for_connection');
  assert.equal(toolFailure(new Error('任务图 revision 已更新')).code, 'STALE_STATE');
  assert.equal(toolFailure(new Error('Invalid arguments')).code, 'INVALID_ARGUMENT');
  const failure = toolFailure(new ToolExecutionError('SUBMISSION_UNCONFIRMED', 'apiKey=private_value'));
  assert.equal(failure.retryable, false);
  assert.equal(failure.recovery, 'check_existing');
  assert.doesNotMatch(JSON.stringify(failure), /private_value/);
});

test('stopping during a durable budget reservation prevents a later GPU submission', async () => {
  const submissions = new AgentSubmissions();
  let submitted = 0;
  const guarded = submissions.guard({ list: () => [], create: async () => { submitted++; } } as unknown as TaskManager);
  let release!: () => void;
  const saved = new Promise<void>((resolve) => { release = resolve; });
  const controller = new RunController('old');
  const work = submissions.within({ controller, callId: 'call', owner: { projectId: 'project', sessionId: 'session', runId: 'old' }, reserveSessionGeneration: () => saved }, () => guarded.create({ op: 'image.generate', model: 'zimage', prompt: 'cup', aspect: '1:1', quality: '1k' }));
  controller.stop(); release();
  await assert.rejects(work, /已停止/);
  assert.equal(submitted, 0);
});

test('recovery reattaches an owned GPU job to the same task attempt without rerunning another session', () => {
  let graph = changeTaskGraph(emptyTaskGraph(), { action: 'plan', revision: 0, plan: { objective: 'image', tasks: [{ id: 'shot', objective: 'a cup', dependencies: [], acceptanceCriteria: [{ id: 'result', description: '有输出' }] }] } }, []);
  graph = changeTaskGraph(graph, { action: 'start', revision: graph.revision, id: 'shot' }, []);
  graph = recoverTaskGraph(graph);
  const job: Task = { id: 'task-recover', request: { op: 'image.generate', model: 'zimage', prompt: 'cup', aspect: '1:1', quality: '1k' }, status: 'queued', progress: 0, expected: { kind: 'image', width: 1024, height: 1024 }, results: [], seed: 42, createdAt: 1, agentOwner: { projectId: 'project', sessionId: 'original', runId: 'run', operationKey: 'operation', graphTaskId: 'shot', attempt: 1 } };
  assert.equal(recoverOwnedOutputs(graph, [], [job], 'project', 'other-session').tracked.length, 0);
  const restored = recoverOwnedOutputs(graph, [], [job], 'project', 'original');
  assert.equal(restored.graph.tasks[0].attempts, 1);
  assert.equal(restored.graph.tasks[0].status, 'reviewing');
  assert.equal(restored.upsert[0].taskId, job.id);
  assert.equal(recoverOwnedOutputs(restored.graph, restored.upsert, [job], 'project', 'original').upsert.length, 0);
});
