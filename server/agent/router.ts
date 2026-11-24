import type { AgentExperience, Task, WorkflowLike } from '../../shared/types.ts';

export interface RouteWeights { quality: number; reliability: number; speed: number; cost: number }
export interface WorkflowRank {
  id: string;
  score: number;
  samples: number;
  qualitySamples: number;
  successRate: number;
  quality: number | null;
  durationMs: number | null;
  /** Relative observed GPU time, not currency or VRAM. */
  relativeCost: number | null;
}

/** Input pool has already passed capability, license, media count and aspect constraints. */
export function rankWorkflows(pool: WorkflowLike[], tasks: Task[], experiences: AgentExperience[], weights: RouteWeights = { quality: 0.45, reliability: 0.3, speed: 0.15, cost: 0.1 }): WorkflowRank[] {
  if (Object.values(weights).some((v) => !Number.isFinite(v) || v < 0) || !Object.values(weights).some((v) => v > 0)) throw new Error('路由权重必须非负且至少一项大于零');
  const measured = pool.map((workflow) => {
    const history = tasks.filter((t) => t.request.op === 'custom' && t.request.workflow === workflow.id && ['done', 'error'].includes(t.status));
    const durations = history.filter((t) => t.status === 'done' && t.startedAt && t.finishedAt && t.finishedAt > t.startedAt).map((t) => t.finishedAt! - t.startedAt!);
    durations.sort((a, b) => a - b);
    // Agent-judged successes are deliberately excluded from the quality estimate.
    const confirmed = experiences.filter((e) => e.workflowId === workflow.id && e.confirmation === 'user');
    return { id: workflow.id, samples: history.length, qualitySamples: confirmed.length,
      successRate: (history.filter((t) => t.status === 'done').length + 1) / (history.length + 2),
      quality: confirmed.length ? (confirmed.filter((e) => e.outcome === 'success').length + 1) / (confirmed.length + 2) : null,
      durationMs: durations.length ? durations[Math.floor(durations.length / 2)] : null };
  });
  const maxTime = Math.max(1, ...measured.map((m) => m.durationMs ?? 0));
  const total = weights.quality + weights.reliability + weights.speed + weights.cost;
  return measured.map((m) => {
    const relativeCost = m.durationMs === null ? null : m.durationMs / maxTime;
    const efficiency = relativeCost === null ? 0.5 : 1 - relativeCost;
    return { ...m, relativeCost, score: Math.round(10000 * (weights.quality * (m.quality ?? 0.5) + weights.reliability * m.successRate + (weights.speed + weights.cost) * efficiency) / total) / 100 };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
