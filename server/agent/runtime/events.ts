import { randomUUID } from 'node:crypto';
import type { Task } from '../../../shared/types.ts';
import type { AgentTraceRecorder } from '../trace/recorder.ts';

/** Durable task ownership routes late events without waking an unrelated session. */
export class AgentTaskEvents {
  private delivered = new Set<string>();
  constructor(private recorder: AgentTraceRecorder) {}

  async observe(task: Task) {
    const owner = task.agentOwner;
    if (!owner || !task.promptId || !(['accepted', 'uncertain'].includes(task.submissionState ?? '') || task.status === 'running' || task.status === 'done')) return;
    const queuedKey = `${owner.runId}/${task.id}/queued`;
    const mark = (key: string) => {
      this.delivered.add(key);
      while (this.delivered.size > 1024) this.delivered.delete(this.delivered.values().next().value!);
    };
    if (!this.delivered.has(queuedKey)) {
      mark(queuedKey);
      try { await this.recorder.append(owner.projectId, { id: randomUUID(), runId: owner.runId, at: Date.now(), type: 'generation_queued', taskIds: [task.id], retry: (owner.attempt ?? 1) > 1 }); }
      catch (error) { this.delivered.delete(queuedKey); throw error; }
    }
    if (task.status !== 'done' && task.status !== 'error' && task.status !== 'cancelled') return;
    const finishedKey = `${owner.runId}/${task.id}/finished`;
    if (this.delivered.has(finishedKey)) return;
    mark(finishedKey);
    try {
      await this.recorder.append(owner.projectId, { id: randomUUID(), runId: owner.runId, at: Date.now(), type: 'generation_end', taskId: task.id, ok: task.status === 'done', gpuMs: task.startedAt && task.finishedAt ? Math.max(0, task.finishedAt - task.startedAt) : 0 });
    } catch (error) { this.delivered.delete(finishedKey); throw error; }
  }
}
