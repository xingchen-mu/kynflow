import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { AgentTraceEvent } from '../shared/types.ts';
import { AgentTraceStore } from '../server/agent/trace/store.ts';
import { AgentTraceRecorder } from '../server/agent/trace/recorder.ts';
import { redactTraceText, traceError, traceValue } from '../server/agent/trace/redact.ts';
import { CORE_BENCHMARK_CASES } from '../server/agent/evaluation/fixtures/core.ts';
import { CAPABILITY_DIMENSIONS } from '../server/agent/evaluation/types.ts';
import { benchmarkSummary, compareBenchmark, evaluateBenchmark } from '../server/agent/evaluation/metrics.ts';

const metadata = { projectId: 'project-one', sessionId: 'session-one', runId: 'run-original', userIntent: '把原图放大，不要重画', model: 'test/model', profile: 'enhanced' as const, source: 'user' as const, generationEnvironment: 'mock' as const, promptVersion: 'test-v1', startedAt: 1 };
const event = (type: AgentTraceEvent['type'], extra: Partial<AgentTraceEvent> = {}): AgentTraceEvent => ({ id: `event-${type}`, runId: metadata.runId, at: 2, type, ...extra });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'kynflow-trace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new AgentTraceStore(directory);
  const recorder = new AgentTraceRecorder(store);
  await recorder.start(metadata);
  return { store, recorder, directory };
}

test('run traces preserve tool arguments, exact token categories and model/prompt identity across restart', async (t) => {
  const { store, recorder, directory } = await fixture(t);
  await recorder.append(metadata.projectId, event('tool_start', { tool: 'run_workflow', callId: 'call-one', arguments: { workflow_id: 'upscale', image_ids: ['image-a'] } }));
  await recorder.append(metadata.projectId, event('tool_end', { tool: 'run_workflow', callId: 'call-one', ok: true, items: ['output-one'], result: { text: '已提交' } }));
  await recorder.append(metadata.projectId, event('model', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10, tokens: 130, cost: 0.01, response: '已提交，等待检查。' }));
  await recorder.append(metadata.projectId, event('run_end', { ok: true }));
  const saved = (await new AgentTraceStore(directory).get(metadata.projectId, metadata.runId))!;
  assert.equal(saved.promptVersion, 'test-v1');
  assert.equal(saved.model, 'test/model');
  assert.equal(saved.usage.inputTokens, 160);
  assert.equal(saved.usage.outputTokens, 20);
  assert.equal(saved.usage.paidTokens, 130);
  assert.deepEqual(saved.events[0].arguments, { workflow_id: 'upscale', image_ids: ['image-a'] });
  assert.deepEqual(saved.outputs, ['output-one']);
  assert.equal(saved.outcome.status, 'partial', 'normal execution is not proof of creative success');
  assert.equal(saved.outcome.basis, 'unconfirmed');
  assert.equal((await store.list(metadata.projectId)).length, 1);
});

test('late GPU completions and user feedback serialize without overwriting human confirmation', async (t) => {
  const { store, recorder } = await fixture(t);
  await recorder.append(metadata.projectId, event('tool_end', { tool: 'generate_image', ok: true, items: ['image-result'] }));
  await recorder.append(metadata.projectId, event('generation_queued', { taskIds: ['task-one'], retry: true }));
  await recorder.append(metadata.projectId, event('run_end', { ok: true }));
  await Promise.all([
    store.feedback(metadata.projectId, metadata.runId, { verdict: 'rejected', assetIds: ['image-result'], comment: '人物不一致', source: 'agent' }),
    recorder.append(metadata.projectId, event('generation_end', { taskId: 'task-one', gpuMs: 2500, ok: true })),
  ]);
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  assert.equal(trace.outcome.basis, 'user');
  assert.equal(trace.outcome.status, 'failed');
  assert.equal(trace.outcome.userFeedback?.source, 'user');
  assert.equal(trace.usage.gpuSeconds, 2.5);
  assert.equal(trace.usage.generations, 1);
  assert.equal(trace.usage.retries, 1);
  await assert.rejects(() => store.feedback('different-board', metadata.runId, { verdict: 'accepted' }), /not found/);
  await assert.rejects(() => store.feedback(metadata.projectId, metadata.runId, { verdict: 'accepted', assetIds: ['unrelated'] }), /belong/);
});

test('agent reviews remain distinct from human feedback and never confirm their own success', async (t) => {
  const { store, recorder } = await fixture(t);
  await recorder.append(metadata.projectId, event('tool_start', { tool: 'record_review', callId: 'review-call', arguments: { entries: [{ id: 'image-one', verdict: 'pass' }] } }));
  await recorder.append(metadata.projectId, event('tool_end', { tool: 'record_review', callId: 'review-call', ok: true }));
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  assert.equal(trace.outcome.agentReview[0].verdict, 'pass');
  assert.equal(trace.outcome.userFeedback, undefined);
  assert.equal(trace.outcome.status, 'partial');
});

test('run recovery preserves interrupted evidence without asserting completion', async (t) => {
  const { store, recorder, directory } = await fixture(t);
  await recorder.append(metadata.projectId, event('tool_start', { tool: 'generate_image', arguments: { prompt: 'A cup' } }));
  const restarted = new AgentTraceStore(directory);
  await restarted.recover(metadata.projectId, metadata.sessionId);
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  assert.equal(trace.execution, 'interrupted');
  assert.equal(trace.outcome.status, 'partial');
  assert.equal(trace.events.length, 1);
  await assert.rejects(() => store.get('../escape', metadata.runId), /Invalid/);
});

test('trace redaction removes credentials, image payloads and thinking while retaining observable parameters', () => {
  const value = traceValue({ prompt: 'A red cup', apiKey: 'secret-key', authorization: 'Bearer token', content: 'password="sensitive"', nested: { thinking: 'private chain', data: 'base64-data', width: 512 } });
  const serialized = JSON.stringify(value);
  for (const secret of ['secret-key', 'Bearer token', 'sensitive', 'private chain', 'base64-data']) assert.ok(!serialized.includes(secret));
  assert.match(serialized, /A red cup/);
  assert.match(serialized, /512/);
  assert.doesNotMatch(redactTraceText('{"apiKey":"confidential"} Bearer abcd1234 https://user:pass@example.com/?token=secret-value'), /confidential|abcd1234|user:pass|secret-value/);
  assert.equal(traceError('No API key configured').category, 'configuration');
  assert.equal(traceError('Provider is not configured: custom').category, 'configuration');
  assert.equal(traceError('CUDA out of memory').category, 'out_of_memory');
});

test('the first benchmark has 20 independent cases covering all ten dimensions', () => {
  assert.equal(CORE_BENCHMARK_CASES.length, 20);
  assert.equal(new Set(CORE_BENCHMARK_CASES.map((spec) => spec.id)).size, 20);
  for (const dimension of CAPABILITY_DIMENSIONS) assert.equal(CORE_BENCHMARK_CASES.filter((spec) => spec.dimension === dimension).length, 2);
  assert.ok(CORE_BENCHMARK_CASES.every((spec) => spec.checks.length && spec.script.length && spec.budget.tokens > 0));
});

test('a selected workflow does not pass parameter checks when it used the wrong input', async (t) => {
  const { store, recorder } = await fixture(t);
  await recorder.append(metadata.projectId, event('tool_start', { tool: 'run_workflow', callId: 'wrong-input', arguments: { workflow_id: 'eval-upscale', image_ids: ['wrong-image'] } }));
  await recorder.append(metadata.projectId, event('tool_end', { tool: 'run_workflow', callId: 'wrong-input', ok: true }));
  await recorder.append(metadata.projectId, event('run_end', { ok: true }));
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  const result = evaluateBenchmark(CORE_BENCHMARK_CASES[0], { traces: [trace], before: [], after: [], tasks: [] }, 'enhanced', 'live');
  assert.equal(result.passed, false);
  assert.equal(result.checks[0].passed, false);
});

test('authentication failures are blocked measurements and excluded from capability rates and comparisons', async (t) => {
  const { store, recorder } = await fixture(t);
  await recorder.append(metadata.projectId, event('model', { ok: false, error: traceError('No API key configured') }));
  await recorder.append(metadata.projectId, event('run_end', { ok: false }));
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  const result = evaluateBenchmark(CORE_BENCHMARK_CASES[0], { traces: [trace], before: [], after: [], tasks: [] }, 'baseline', 'live');
  assert.equal(result.status, 'blocked');
  assert.equal(benchmarkSummary([result]).passRate, null);
  assert.equal(benchmarkSummary([result]).blocked, 1);
  assert.equal(compareBenchmark([result, { ...result, profile: 'enhanced' }]).pairedCases, 0);
});

test('run trace truncation is explicit and cannot be scored as complete execution', async (t) => {
  const { store, recorder } = await fixture(t);
  await store.update(metadata.projectId, metadata.runId, (trace) => {
    trace.events = Array.from({ length: 2000 }, (_, index) => event('model', { id: String(index) }));
  });
  await recorder.append(metadata.projectId, event('run_end', { ok: true }));
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  assert.equal(trace.events.length, 2000);
  assert.equal(trace.droppedEvents, 1);
  assert.ok(evaluateBenchmark(CORE_BENCHMARK_CASES[0], { traces: [trace], before: [], after: [], tasks: [] }, 'enhanced', 'scripted').failures.some((failure) => failure.includes('truncated')));
});

test('planning accepts a complete ordered note while rejecting missing or reversed stages', async (t) => {
  const { store, recorder } = await fixture(t);
  const spec = { ...CORE_BENCHMARK_CASES[0], checks: [{ kind: 'plan' as const, orderedTerms: ['剧本', '分镜', '关键帧', '视频'] }] };
  await recorder.append(metadata.projectId, event('tool_start', { tool: 'write_note', callId: 'plan-note', arguments: { text: '1. 剧本；2. 分镜；3. 关键帧；4. 视频。' } }));
  await recorder.append(metadata.projectId, event('tool_end', { tool: 'write_note', callId: 'plan-note', ok: true }));
  await recorder.append(metadata.projectId, event('run_end', { ok: true }));
  const trace = (await store.get(metadata.projectId, metadata.runId))!;
  const assess = () => evaluateBenchmark(spec, { traces: [trace], before: [], after: [], tasks: [] }, 'baseline', 'live').checks[0].passed;
  assert.equal(assess(), true);
  trace.events[0].arguments = { text: '视频、关键帧、分镜、剧本' };
  assert.equal(assess(), false);
  trace.events[0].arguments = { text: '剧本、分镜、视频' };
  assert.equal(assess(), false);
  trace.events[0].arguments = { text: '剧本、分镜、关键帧、视频' };
  trace.events[1].ok = false;
  assert.equal(assess(), false, 'a failed write is not a delivered plan');
});
