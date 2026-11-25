import type { AgentTaskGraph, CanvasItem, Task } from '../../../shared/types.ts';
import { changedAssets } from '../asset-version.ts';

/** Reattach durable owned jobs after a crash between remote acceptance and canvas output binding. */
export function recoverOwnedOutputs(graph: AgentTaskGraph, items: CanvasItem[], tasks: Task[], projectId: string, sessionId: string) {
  const next = structuredClone(graph);
  const upsert: CanvasItem[] = [];
  const tracked: CanvasItem[] = [];
  let right = Math.max(0, ...items.map((item) => item.x + item.w)) + 80;
  for (const task of next.tasks) {
    if (task.outputs.length || task.status !== 'failed' || !task.error?.startsWith('执行中断') || task.invalidated) continue;
    const owned = tasks.filter((job) => job.agentOwner?.projectId === projectId && job.agentOwner.sessionId === sessionId && job.agentOwner.graphTaskId === task.id && job.agentOwner.attempt === task.attempts);
    if (!owned.length) continue;
    const outputs: CanvasItem[] = [];
    for (const job of owned) {
      const existing = items.filter((item) => item.taskId === job.id);
      if (existing.length) { outputs.push(...existing); continue; }
      const asset = job.status === 'done' ? job.results[0] : undefined;
      const width = asset?.width || job.expected.width || 512;
      const height = asset?.height || job.expected.height || 512;
      const item: CanvasItem = { id: `recovered-${job.id}`, name: task.objective.slice(0, 80), kind: job.expected.kind, taskId: job.id, request: job.request, inputs: [...task.inputs], x: right, y: 0, w: 512, h: Math.max(64, Math.round(height / width * 512)), createdAt: job.createdAt,
        ...(asset ? { asset } : {}), ...(['error', 'cancelled'].includes(job.status) ? { error: job.error ?? '生成任务已终止' } : {}) };
      right += item.w + 80;
      outputs.push(item); upsert.push(item);
    }
    task.outputs = outputs.map((item) => item.id);
    const stale = changedAssets(task.inputVersions, new Map(items.map((item) => [item.id, item]))).length > 0;
    task.invalidated = stale;
    task.status = stale || outputs.some((item) => item.error) ? 'failed' : 'reviewing';
    task.error = stale ? '恢复时发现输入已改变；保留已有结果，局部重规划后再验收' : outputs.some((item) => item.error) ? '已有生成失败，保留记录后决定是否重试' : undefined;
    tracked.push(...outputs);
  }
  if (tracked.length) next.revision++;
  return { graph: tracked.length ? next : graph, upsert, tracked };
}
