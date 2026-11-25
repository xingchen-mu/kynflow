import type { AgentHarnessProfile, AgentTraceEvent, TraceValue } from '../../../shared/types.ts';
import type { AgentBenchmarkCase, BenchmarkObservation, BenchmarkResult, BenchmarkCheck } from './types.ts';
import { CAPABILITY_DIMENSIONS } from './types.ts';

function field(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => current && typeof current === 'object' ? (current as Record<string, unknown>)[part] : undefined, value);
}
function matches(actual: unknown, expected: TraceValue): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (typeof expected.pattern === 'string') return typeof actual === 'string' && new RegExp(expected.pattern, 'i').test(actual);
    if (expected.includes !== undefined) return Array.isArray(actual) && actual.some((item) => matches(item, expected.includes));
    return Object.entries(expected).every(([key, value]) => matches(field(actual, key), value));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function checkCase(check: BenchmarkCheck, observation: BenchmarkObservation, events: AgentTraceEvent[], response: string) {
  if (check.kind === 'tool') {
    const calls = events.filter((event) => event.type === 'tool_start' && check.tools.includes(event.tool ?? ''));
    const successes = calls.filter((event) => events.some((end) => end.type === 'tool_end' && end.callId === event.callId && (check.outcome === 'error' ? end.ok === false : end.ok === true)) && Object.entries(check.where ?? {}).every(([path, expected]) => matches(field(event.arguments, path), expected)));
    return { passed: successes.length >= (check.min ?? 0) && calls.length <= (check.max ?? Infinity), detail: `${successes.length} matching ${check.outcome ?? 'success'} calls; ${calls.length} total attempts` };
  }
  if (check.kind === 'response') return { passed: new RegExp(check.pattern, 'i').test(response), detail: `Response must match ${check.pattern}` };
  if (check.kind === 'plan') {
    const candidates = [response, ...events.filter((event) => event.type === 'tool_start' && ['update_todos', 'update_task_graph', 'present_plan', 'write_note'].includes(event.tool ?? '') && events.some((end) => end.type === 'tool_end' && end.callId === event.callId && end.ok === true)).map((event) => JSON.stringify(event.arguments))];
    const passed = candidates.some((text) => {
      let at = 0;
      for (const term of check.orderedTerms) { const next = text.indexOf(term, at); if (next < 0) return false; at = next + term.length; }
      return true;
    });
    return { passed, detail: `Plan must cover the requested stages in order: ${check.orderedTerms.join(' → ')}` };
  }
  if (check.kind === 'preserve') {
    const content = (item: typeof observation.before[number] | undefined) => {
      if (!item) return undefined;
      const { review: _review, critic: _critic, ...rest } = item;
      return rest;
    };
    const altered = check.ids.filter((id) => JSON.stringify(content(observation.before.find((item) => item.id === id))) !== JSON.stringify(content(observation.after.find((item) => item.id === id))));
    return { passed: altered.length === 0, detail: altered.length ? `Unexpected changes: ${altered.join(', ')}` : 'Protected items unchanged' };
  }
  if (check.kind === 'rename') {
    const wrong = Object.entries(check.names).filter(([id, name]) => observation.after.find((item) => item.id === id)?.name !== name);
    return { passed: wrong.length === 0, detail: wrong.length ? `Names do not match: ${wrong.map(([id]) => id).join(', ')}` : 'Requested names match' };
  }
  if (check.kind === 'recovery') {
    const first = observation.tasks[0];
    const next = observation.tasks[1];
    return { passed: first?.request.op === 'image.generate' && first.request.model === check.firstModel && first.status === 'error' && next?.request.op === 'image.generate' && next.request.model === check.nextModel && next.status === 'done', detail: 'Failed model must be replaced with the requested fallback, once' };
  }
  const count = observation.tasks.length;
  const input = check.reference ? observation.before.find((item) => item.id === check.reference)?.asset?.id : undefined;
  const references = !check.reference || (Boolean(input) && observation.tasks.every((task) => 'images' in task.request && task.request.images?.includes(input!)));
  const complete = check.allowFailures || observation.tasks.every((task) => task.status === 'done' && task.results.length > 0);
  return { passed: count >= check.min && count <= check.max && references && Boolean(complete), detail: `${count} submissions; required reference ${check.reference ?? 'none'}; outputs ${complete ? 'ready or expected failure' : 'incomplete'}` };
}

export function evaluateBenchmark(spec: AgentBenchmarkCase, observation: BenchmarkObservation, profile: AgentHarnessProfile, mode: 'scripted' | 'live'): BenchmarkResult {
  const traces = [...observation.traces].sort((a, b) => a.startedAt - b.startedAt);
  const events = traces.flatMap((trace) => trace.events);
  const response = traces.map((trace) => trace.outcome.response ?? '').join('\n');
  const checks = spec.checks.map((check, index) => ({ index, kind: check.kind, ...checkCase(check, observation, events, response) }));
  const metrics: BenchmarkResult['metrics'] = { inputTokens: 0, outputTokens: 0, paidTokens: 0, cost: 0, toolCalls: 0, toolErrors: 0, modelCalls: 0, generations: observation.tasks.length, retries: 0, gpuSeconds: 0, userInterventions: 0, durationMs: 0 };
  for (const trace of traces) {
    for (const key of ['inputTokens', 'outputTokens', 'paidTokens', 'cost', 'toolCalls', 'toolErrors', 'modelCalls', 'retries', 'gpuSeconds', 'userInterventions'] as const) metrics[key] += trace.usage[key];
    metrics.durationMs += Math.max(0, (trace.finishedAt ?? Date.now()) - trace.startedAt);
  }
  const failures = checks.filter((check) => !check.passed).map((check) => `${check.kind}: ${check.detail}`);
  if (observation.error) failures.push(observation.error);
  if (!traces.length) failures.push('No recorded run');
  if (traces.some((trace) => trace.droppedEvents)) failures.push('Trace truncated: cannot assess complete behavior');
  if (traces.some((trace) => trace.execution !== 'completed')) failures.push(`Run did not finish normally${events.find((event) => event.type === 'model' && event.error)?.error?.message ? `: ${events.find((event) => event.type === 'model' && event.error)!.error!.message}` : ''}`);
  for (const [key, value] of Object.entries(spec.budget)) {
    const used = key === 'tokens' ? metrics.inputTokens + metrics.outputTokens : metrics[key as keyof typeof metrics];
    if (used > value) failures.push(`Budget exceeded: ${key} (${used} > ${value})`);
  }
  const configuration = events.find((event) => event.error?.category === 'configuration' || (event.type === 'model' && event.error?.category === 'connection'))?.error?.message
    ?? (observation.error && /api.?key|unauthorized|401|模型.*配置|密钥/i.test(observation.error) ? observation.error : undefined);
  return { id: spec.id, dimension: spec.dimension, profile, mode, passed: failures.length === 0 && !configuration,
    status: configuration ? 'blocked' : failures.length ? 'failed' : 'passed', ...(configuration ? { blockReason: configuration } : {}), failures, checks, metrics, runIds: traces.map((trace) => trace.runId), promptVersions: [...new Set(traces.map((trace) => trace.promptVersion))], model: traces[0]?.model ?? 'unavailable' };
}

export function benchmarkSummary(results: BenchmarkResult[]) {
  const assessed = results.filter((result) => result.status !== 'blocked');
  return { cases: results.length, assessed: assessed.length, blocked: results.length - assessed.length, passed: assessed.filter((result) => result.passed).length,
    passRate: assessed.length ? assessed.filter((result) => result.passed).length / assessed.length : null,
    dimensions: Object.fromEntries(CAPABILITY_DIMENSIONS.map((dimension) => {
      const cases = results.filter((result) => result.dimension === dimension);
      const measured = cases.filter((result) => result.status !== 'blocked');
      return [dimension, { cases: cases.length, assessed: measured.length, blocked: cases.length - measured.length, passed: measured.filter((result) => result.passed).length, passRate: measured.length ? measured.filter((result) => result.passed).length / measured.length : null }];
    })),
    usage: { inputTokens: results.reduce((n, r) => n + r.metrics.inputTokens, 0), outputTokens: results.reduce((n, r) => n + r.metrics.outputTokens, 0), toolCalls: results.reduce((n, r) => n + r.metrics.toolCalls, 0), userInterventions: results.reduce((n, r) => n + r.metrics.userInterventions, 0), retries: results.reduce((n, r) => n + r.metrics.retries, 0), cost: results.reduce((n, r) => n + r.metrics.cost, 0) },
  };
}

/** Compare only paired cases; never count an omitted case as an improvement. */
export function compareBenchmark(results: BenchmarkResult[]) {
  const baseline = results.filter((result) => result.profile === 'baseline');
  const enhanced = results.filter((result) => result.profile === 'enhanced');
  const pairs = baseline.flatMap((before) => {
    const after = before.status !== 'blocked' ? enhanced.find((result) => result.status !== 'blocked' && result.id === before.id && result.mode === before.mode && result.model === before.model) : undefined;
    return after ? [{ id: before.id, before: before.passed, after: after.passed, toolCallsDelta: after.metrics.toolCalls - before.metrics.toolCalls, tokensDelta: after.metrics.inputTokens + after.metrics.outputTokens - before.metrics.inputTokens - before.metrics.outputTokens }] : [];
  });
  return { pairedCases: pairs.length, improved: pairs.filter((pair) => !pair.before && pair.after).length, regressed: pairs.filter((pair) => pair.before && !pair.after).length, unchanged: pairs.filter((pair) => pair.before === pair.after).length, pairs };
}
