import { ToolExecutionError } from '../tool-errors.ts';

export interface RunLimits {
  toolCalls?: number; modelCalls?: number; tokens?: number; cost?: number;
  durationMs?: number; maxOutputTokens?: number; generations?: number;
}
export interface RunConsumption { toolCalls: number; modelCalls: number; tokens: number; cost: number; generations: number }
export const DEFAULT_RUN_LIMITS: Required<Omit<RunLimits, 'cost' | 'maxOutputTokens'>> = { toolCalls: 160, modelCalls: 80, tokens: 2000000, durationMs: 1800000, generations: 32 };

export function productionRunLimits(environment: Record<string, string | undefined> = process.env): RunLimits {
  const limits: RunLimits = { ...DEFAULT_RUN_LIMITS };
  for (const [key, name] of Object.entries({ toolCalls: 'AGENT_RUN_MAX_TOOLS', modelCalls: 'AGENT_RUN_MAX_MODELS', tokens: 'AGENT_RUN_MAX_TOKENS', generations: 'AGENT_RUN_MAX_GENERATIONS', durationMs: 'AGENT_RUN_TIMEOUT_MS' })) {
    if (environment[name] === undefined || environment[name] === '') continue;
    const value = Number(environment[name]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
    limits[key as keyof RunLimits] = value;
  }
  return limits;
}

/** Execution counters are independent of bounded traces, context compaction and task completion. */
export class RunController {
  readonly usage: RunConsumption = { toolCalls: 0, modelCalls: 0, tokens: 0, cost: 0, generations: 0 };
  private cancellation = new AbortController();
  private lifecycle: 'running' | 'stopped' | 'completed' | 'failed' = 'running';
  private timer?: NodeJS.Timeout;
  private settled!: () => void;
  readonly done = new Promise<void>((resolve) => { this.settled = resolve; });
  readonly startedAt = Date.now();
  readonly limits: RunLimits;

  constructor(readonly id: string, limits: RunLimits = {}) {
    this.limits = { ...DEFAULT_RUN_LIMITS, ...limits };
    for (const [key, value] of Object.entries(this.limits)) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid run limit: ${key}`);
    if (this.limits.durationMs !== undefined) {
      this.timer = setTimeout(() => this.stop(new ToolExecutionError('BUDGET_EXCEEDED', '运行时间预算已耗尽；保留已有任务并报告结果')), Math.min(2147483647, this.limits.durationMs));
      this.timer.unref();
    }
  }
  get signal() { return this.cancellation.signal; }
  get state() { return this.lifecycle; }
  get active() { return this.lifecycle === 'running' && !this.signal.aborted; }
  check() {
    if (this.signal.aborted) throw this.signal.reason;
    if (!this.active) throw new ToolExecutionError('CANCELLED', '本次运行已停止，不能继续提交；需要明确的新请求或确认');
    if (this.limits.durationMs !== undefined && Date.now() - this.startedAt >= this.limits.durationMs) this.exhaust('durationMs');
    if (this.usage.tokens >= (this.limits.tokens ?? Infinity)) this.exhaust('tokens');
    if (this.usage.cost >= (this.limits.cost ?? Infinity)) this.exhaust('cost');
  }
  reserve(kind: 'toolCalls' | 'modelCalls' | 'generations', amount = 1) {
    this.check();
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid execution reservation');
    if (this.usage[kind] + amount > (this.limits[kind] ?? Infinity)) this.exhaust(kind);
    this.usage[kind] += amount;
  }
  observe(tokens: number, cost: number) {
    this.usage.tokens += Math.max(0, Number.isFinite(tokens) ? tokens : 0);
    this.usage.cost += Math.max(0, Number.isFinite(cost) ? cost : 0);
  }
  stop(reason = new ToolExecutionError('CANCELLED', '本次运行已停止')) { if (this.lifecycle !== 'running') return; clearTimeout(this.timer); this.lifecycle = 'stopped'; this.cancellation.abort(reason); }
  finish(ok = true) { clearTimeout(this.timer); if (this.lifecycle === 'running') this.lifecycle = ok ? 'completed' : 'failed'; this.settled(); }
  private exhaust(resource: string): never {
    const error = new ToolExecutionError('BUDGET_EXCEEDED', `运行资源预算已耗尽：${resource}；保留现有任务，先报告结果并请求用户决定`);
    this.stop(error);
    throw error;
  }
}
