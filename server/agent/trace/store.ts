import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRunTrace, AgentTraceFeedback } from './types.ts';
import { writeJson } from '../write.ts';
import { redactTraceText } from './redact.ts';

const ID = /^[\w-]{4,64}$/;

export class AgentTraceStore {
  private queues = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}

  private file(projectId: string, runId: string) {
    if (!ID.test(projectId) || !ID.test(runId)) throw new Error('Invalid trace identifier');
    return join(this.directory, projectId, `${runId}.json`);
  }

  private async read(projectId: string, runId: string): Promise<AgentRunTrace | undefined> {
    try { return JSON.parse(await readFile(this.file(projectId, runId), 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private queued<T>(projectId: string, runId: string, operation: () => Promise<T>): Promise<T> {
    const file = this.file(projectId, runId);
    const next = (this.queues.get(file) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => {});
    this.queues.set(file, settled);
    void settled.then(() => { if (this.queues.get(file) === settled) this.queues.delete(file); });
    return next;
  }

  create(trace: AgentRunTrace): Promise<void> {
    return this.queued(trace.projectId, trace.runId, async () => {
      if (await this.read(trace.projectId, trace.runId)) throw new Error('Trace already exists');
      await mkdir(join(this.directory, trace.projectId), { recursive: true });
      await writeJson(this.file(trace.projectId, trace.runId), () => trace);
    });
  }

  update(projectId: string, runId: string, change: (trace: AgentRunTrace) => void): Promise<boolean> {
    return this.queued(projectId, runId, async () => {
      const trace = await this.read(projectId, runId);
      if (!trace) return false; // Older flat traces have no run document to update.
      change(trace);
      await writeJson(this.file(projectId, runId), () => trace);
      return true;
    });
  }

  async get(projectId: string, runId: string): Promise<AgentRunTrace | undefined> {
    await this.queues.get(this.file(projectId, runId));
    return this.read(projectId, runId);
  }

  async list(projectId: string, sessionId?: string): Promise<AgentRunTrace[]> {
    if (!ID.test(projectId)) throw new Error('Invalid trace identifier');
    await this.flush();
    const files = await readdir(join(this.directory, projectId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const traces = await Promise.all(files.filter((file) => /^[\w-]{4,64}\.json$/.test(file)).map((file) => this.read(projectId, file.slice(0, -5))));
    return traces.filter((trace): trace is AgentRunTrace => Boolean(trace) && (!sessionId || trace!.sessionId === sessionId)).sort((a, b) => b.startedAt - a.startedAt);
  }

  async feedback(projectId: string, runId: string, input: unknown): Promise<AgentRunTrace> {
    const data = input as Partial<AgentTraceFeedback> | null;
    if (!data || !['accepted', 'rejected', 'mixed'].includes(data.verdict ?? '') || (data.comment !== undefined && typeof data.comment !== 'string') || (data.assetIds !== undefined && (!Array.isArray(data.assetIds) || data.assetIds.length > 100 || data.assetIds.some((id) => typeof id !== 'string')))) throw new Error('Invalid trace feedback');
    const updated = await this.update(projectId, runId, (trace) => {
      const assetIds = [...new Set(data.assetIds ?? [])];
      if (assetIds.some((id) => !trace.outputs.includes(id))) throw new Error('Feedback assets must belong to this run');
      const feedback: AgentTraceFeedback = { verdict: data.verdict!, comment: redactTraceText(data.comment ?? '', 2000), assetIds, at: Date.now(), source: 'user' };
      trace.feedbackHistory = [...trace.feedbackHistory, feedback].slice(-20);
      trace.outcome.userFeedback = feedback;
      trace.outcome.status = feedback.verdict === 'accepted' ? 'success' : feedback.verdict === 'rejected' ? 'failed' : 'partial';
      trace.outcome.basis = 'user';
    });
    if (!updated) throw new Error('Trace not found');
    return (await this.get(projectId, runId))!;
  }

  async recover(projectId: string, sessionId: string) {
    const interrupted = (await this.list(projectId, sessionId)).filter((trace) => trace.execution === 'running');
    for (const trace of interrupted) await this.update(projectId, trace.runId, (current) => {
      current.execution = 'interrupted';
      current.finishedAt = Date.now();
      if (current.outcome.basis !== 'user') current.outcome = { ...current.outcome, status: 'partial', basis: 'execution' };
    });
  }

  async flush() { await Promise.all([...this.queues.values()]); }
}
