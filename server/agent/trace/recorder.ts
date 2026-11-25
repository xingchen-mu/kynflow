import type { AgentRunTrace, AgentTraceEvent } from './types.ts';
import { MAX_RUN_EVENTS } from './types.ts';
import { AgentTraceStore } from './store.ts';
import { redactTraceText, traceValue } from './redact.ts';

export class AgentTraceRecorder {
  constructor(readonly store: AgentTraceStore) {}

  start(input: Omit<AgentRunTrace, 'version' | 'events' | 'droppedEvents' | 'usage' | 'outputs' | 'outcome' | 'feedbackHistory' | 'execution'>) {
    return this.store.create({ ...input, userIntent: redactTraceText(input.userIntent), version: 1, execution: 'running',
      events: [], droppedEvents: 0, outputs: [], feedbackHistory: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, paidTokens: 0, cost: 0, gpuSeconds: 0, toolCalls: 0, modelCalls: 0, generations: 0, retries: 0, toolErrors: 0, userInterventions: 0 },
      outcome: { status: 'partial', basis: 'unconfirmed', agentReview: [] },
    });
  }

  append(projectId: string, event: AgentTraceEvent) {
    const safe = { ...event,
      ...(event.arguments !== undefined ? { arguments: traceValue(event.arguments) } : {}),
      ...(event.result !== undefined ? { result: traceValue(event.result) } : {}),
      ...(event.response ? { response: redactTraceText(event.response) } : {}),
    };
    return this.store.update(projectId, event.runId, (trace) => {
      trace.events.push(safe);
      if (trace.events.length > MAX_RUN_EVENTS) { trace.events.shift(); trace.droppedEvents++; }
      if (event.type === 'tool_start') {
        trace.usage.toolCalls++;
        if (event.tool === 'ask_user') trace.usage.userInterventions++;
      }
      if (event.type === 'tool_end' && !event.ok) trace.usage.toolErrors++;
      if (event.type === 'model') {
        trace.usage.modelCalls++;
        trace.usage.inputTokens += (event.inputTokens ?? 0) + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0);
        trace.usage.outputTokens += event.outputTokens ?? 0;
        trace.usage.cacheReadTokens += event.cacheReadTokens ?? 0;
        trace.usage.cacheWriteTokens += event.cacheWriteTokens ?? 0;
        trace.usage.paidTokens += event.tokens ?? 0;
        trace.usage.cost += event.cost ?? 0;
        if (safe.response) trace.outcome.response = safe.response;
      }
      if (event.type === 'generation_queued') {
        trace.outputs = [...new Set([...trace.outputs, ...(event.items ?? [])])];
        trace.usage.generations += event.taskIds?.length ?? 0;
        if (event.retry) trace.usage.retries += event.taskIds?.length ?? 0;
      }
      if (event.type === 'approval' && event.ok && event.items) trace.outputs = [...new Set([...trace.outputs, ...event.items])];
      if (event.type === 'generation_end') trace.usage.gpuSeconds += (event.gpuMs ?? 0) / 1000;
      if (event.type === 'tool_end' && event.items?.length) trace.outputs = [...new Set([...trace.outputs, ...event.items])];
      if (event.type === 'tool_end' && event.ok && event.tool === 'record_review') {
        const args = trace.events.find((entry) => entry.type === 'tool_start' && entry.callId === event.callId)?.arguments;
        if (args && typeof args === 'object' && !Array.isArray(args) && Array.isArray(args.entries)) {
          for (const entry of args.entries) if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && (entry.verdict === 'pass' || entry.verdict === 'fail')) {
            trace.outcome.agentReview.push({ itemId: entry.id, verdict: entry.verdict, ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}) });
          }
        }
      }
      if (event.type === 'tool_end' && event.result && typeof event.result === 'object' && !Array.isArray(event.result)) {
        if (event.result.approval === 'pending') trace.usage.userInterventions++;
      }
      if (event.type === 'run_end') {
        trace.finishedAt = event.at;
        trace.execution = event.error?.category === 'cancelled' ? 'aborted' : event.ok ? 'completed' : 'failed';
        if (!event.ok && trace.outcome.basis !== 'user') { trace.outcome.status = 'failed'; trace.outcome.basis = 'execution'; }
      }
    });
  }
}
