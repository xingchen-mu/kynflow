import type { AgentTaskGraph, AgentTraceEvent } from '../../shared/types.ts';

export interface AgentEvaluationCase {
  id: string;
  requiredTools?: string[];
  forbiddenTools?: string[];
  expectedTaskStatuses?: Record<string, string>;
  minCompletedTasks?: number;
  minRecoveries?: number;
  budget?: { toolCalls?: number; tokens?: number; cost?: number; gpuMs?: number; retries?: number };
}

/** Operational metrics only. These do not measure visual quality or natural-language understanding. */
export function evaluateAgentTrace(spec: AgentEvaluationCase, events: AgentTraceEvent[], graph?: AgentTaskGraph) {
  const tools = events.filter((e) => e.type === 'tool_start');
  const successTools = new Set(events.filter((e) => e.type === 'tool_end' && e.ok).map((e) => e.tool));
  const completedTasks = graph?.tasks.filter((t) => t.status === 'completed').length ?? 0;
  const metrics = {
    toolCalls: tools.length,
    toolErrors: events.filter((e) => e.type === 'tool_end' && !e.ok).length,
    tokens: events.filter((e) => e.type === 'model').reduce((sum, e) => sum + (e.tokens ?? 0), 0),
    cost: events.filter((e) => e.type === 'model').reduce((sum, e) => sum + (e.cost ?? 0), 0),
    gpuMs: events.filter((e) => e.type === 'generation_end').reduce((sum, e) => sum + (e.gpuMs ?? 0), 0),
    retries: events.filter((e) => e.type === 'generation_queued' && e.retry).reduce((sum, e) => sum + (e.taskIds?.length ?? 0), 0),
    generations: events.filter((e) => e.type === 'generation_end').length,
    generationFailures: events.filter((e) => e.type === 'generation_end' && !e.ok).length,
    completedTasks,
    totalTasks: graph?.tasks.length ?? 0,
    recoveries: events.filter((e) => e.type === 'recovery').length,
  };
  const failures: string[] = [];
  for (const name of spec.requiredTools ?? []) if (!successTools.has(name)) failures.push(`Missing successful tool: ${name}`);
  for (const name of spec.forbiddenTools ?? []) if (tools.some((e) => e.tool === name)) failures.push(`Forbidden tool attempted: ${name}`);
  for (const [id, status] of Object.entries(spec.expectedTaskStatuses ?? {})) if (graph?.tasks.find((t) => t.id === id)?.status !== status) failures.push(`Task ${id} must be ${status}`);
  if (completedTasks < (spec.minCompletedTasks ?? 0)) failures.push('Too few accepted tasks');
  if (metrics.recoveries < (spec.minRecoveries ?? 0)) failures.push('Missing recovery event');
  for (const [key, limit] of Object.entries(spec.budget ?? {})) if (metrics[key as keyof typeof metrics] > limit) failures.push(`Budget exceeded: ${key}`);
  return { id: spec.id, passed: failures.length === 0, failures, metrics };
}
