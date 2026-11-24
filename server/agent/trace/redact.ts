import type { TraceValue } from './types.ts';
import { MAX_TRACE_VALUE_CHARS } from './types.ts';

const PRIVATE_KEY = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie|data|base64|thinking|reasoning|chain[_-]?of[_-]?thought)$/i;

export function redactTraceText(value: string, limit = 4000): string {
  return value.slice(0, Math.max(0, limit))
    .replace(/\b(?:sk-|hf_)[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]')
    .replace(/["']?\b(api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?[^\s,;"'}]+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&#\s]+/gi, '$1[redacted]')
    .slice(0, limit);
}

/** Bounded JSON evidence, with sensitive fields and non-observable reasoning excluded. */
export function traceValue(value: unknown): TraceValue {
  let remaining = MAX_TRACE_VALUE_CHARS;
  const seen = new Set<object>();
  function visit(input: unknown, depth: number): TraceValue {
    if (remaining <= 0 || depth > 6) return '[truncated]';
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'string') {
      const text = redactTraceText(input, Math.min(2000, remaining));
      remaining -= text.length;
      return text;
    }
    if (!input || typeof input !== 'object') return null;
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    if (Array.isArray(input)) return input.slice(0, 100).map((entry) => visit(entry, depth + 1));
    return Object.fromEntries(Object.entries(input).slice(0, 50).map(([key, entry]) => {
      remaining -= key.length;
      return [key, PRIVATE_KEY.test(key) ? '[redacted]' : visit(entry, depth + 1)];
    }));
  }
  return visit(value, 0);
}

export function traceError(message: string) {
  const category = /api.?key|unauthorized|401|provider.*not configured|unconfigured|认证|密钥/i.test(message) ? 'configuration'
    : /out of memory|显存不足|OutOfMemory/i.test(message) ? 'out_of_memory'
    : /missing|not found|不存在|找不到|缺少/i.test(message) ? 'missing_dependency'
    : /connect|offline|连接|连不上|离线|ECONN/i.test(message) ? 'connection'
    : /abort|cancel|取消/i.test(message) ? 'cancelled'
    : /budget|预算|上限/i.test(message) ? 'budget' : 'other';
  return { category, message: redactTraceText(message, 600) };
}
