import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentExperience } from '../../shared/types.ts';
import { REVIEW_REASONS } from './review.ts';
import { writeJson } from './write.ts';
import { createHash } from 'node:crypto';
import type { AgentTask, AgentTraceFeedback, CanvasItem } from '../../shared/types.ts';
import { redactTraceText } from './trace/redact.ts';

export type ExperienceInput = Pick<AgentExperience, 'task' | 'workflowId' | 'failure' | 'strategy' | 'outcome' | 'itemIds'>;
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]/gu) ?? []);

/** Bounded procedural memory, separate from user preferences and fictional world facts. */
export class ExperienceStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  async list(): Promise<AgentExperience[]> {
    await this.queue;
    return this.read();
  }

  private async read(): Promise<AgentExperience[]> {
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'experiences.json'), 'utf8'));
      if (!Array.isArray(saved)) throw new Error('Invalid experience store');
      return saved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private mutate<T>(update: (entries: AgentExperience[]) => T): Promise<T> {
    const next = this.queue.then(async () => {
      const entries = await this.read();
      const result = update(entries);
      await mkdir(this.directory, { recursive: true });
      await writeJson(join(this.directory, 'experiences.json'), () => entries.slice(-1000));
      return result;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async record(projectId: string, sessionId: string, input: ExperienceInput): Promise<AgentExperience> {
    if (!input || typeof input.task !== 'string' || !input.task.trim() || input.task.length > 1000 || typeof input.strategy !== 'string' || !input.strategy.trim() || input.strategy.length > 2000 || !['success', 'failure'].includes(input.outcome)) throw new Error('经验需要任务、策略和成功/失败结果');
    if (!Array.isArray(input.itemIds) || !input.itemIds.length || input.itemIds.length > 100 || input.itemIds.some((id) => typeof id !== 'string')) throw new Error('经验需要实际输出节点');
    if (input.failure !== undefined && !REVIEW_REASONS.includes(input.failure)) throw new Error('经验的失败原因无效');
    if (input.workflowId !== undefined && (typeof input.workflowId !== 'string' || input.workflowId.length > 100)) throw new Error('工作流 id 无效');
    const entry: AgentExperience = {
      id: nanoid(12), projectId, sessionId, task: input.task.trim(), strategy: input.strategy.trim(),
      outcome: input.outcome, confirmation: 'agent', trust: 'agent-inferred', itemIds: [...new Set(input.itemIds)], at: Date.now(),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.failure ? { failure: input.failure } : {}),
    };
    return this.mutate((entries) => { entries.push(entry); return entry; });
  }

  /** Mechanical candidate extraction: observed execution is evidence, not a human preference. */
  async candidate(projectId: string, sessionId: string, task: AgentTask, items: CanvasItem[], runId: string | undefined, model: string, tools: string[], workflowVersion?: string) {
    if (!task.outputs.length) return;
    const artifacts = items.filter((item) => task.outputs.includes(item.id));
    const validation = task.validation ?? [];
    const deterministic = task.acceptanceCriteria.every((criterion) => criterion.validator && criterion.validator.kind !== 'user') && validation.length === task.acceptanceCriteria.length && validation.every((result) => result.verdict === 'pass');
    const requests = artifacts.map((item) => item.request).filter(Boolean);
    const entry: AgentExperience = {
      id: createHash('sha256').update(`${projectId}/${sessionId}/${task.id}/${task.attempts}`).digest('hex').slice(0, 16), projectId, sessionId,
      task: redactTraceText(task.objective, 1000), strategy: redactTraceText(`已观测工具：${[...new Set(tools)].slice(-12).join(', ')}；${task.error ?? '按任务验收提交输出'}`, 2000),
      outcome: task.status === 'completed' ? 'success' : 'failure', confirmation: 'agent', trust: deterministic ? 'machine-verified' : 'agent-inferred',
      itemIds: task.outputs, at: Date.now(),
      ...(requests.length === 1 && requests[0]?.op === 'custom' ? { workflowId: requests[0].workflow } : {}),
      provenance: { runId, taskId: task.id, attempt: task.attempts, model, assetIds: artifacts.flatMap((item) => item.asset ? [item.asset.id] : []), workflowVersion, validation, conditions: redactTraceText(JSON.stringify(task.acceptanceCriteria), 4000) },
    };
    return this.mutate((entries) => {
      const existing = entries.findIndex((candidate) => candidate.id === entry.id);
      if (existing < 0) entries.push(entry);
      else if (entries[existing].confirmation !== 'user') entries[existing] = entry;
      return entry;
    });
  }

  confirmRun(projectId: string, runId: string, feedback: AgentTraceFeedback) {
    return this.mutate((entries) => {
      if (feedback.verdict === 'mixed') return;
      // Trace's historical assetIds field contains canvas output ids, not stored file ids.
      for (const entry of entries) if (entry.projectId === projectId && entry.provenance?.runId === runId && (!feedback.assetIds.length || entry.itemIds.every((id) => feedback.assetIds.includes(id)))) {
        entry.confirmation = 'user'; entry.trust = 'user-confirmed';
        entry.outcome = feedback.verdict === 'accepted' ? 'success' : 'failure';
      }
    });
  }

  /** This method is reachable only from the local user's HTTP endpoint, never an agent tool. */
  confirm(projectId: string, id: string, outcome: AgentExperience['outcome']): Promise<AgentExperience> {
    if (!['success', 'failure'].includes(outcome)) throw new Error('经验结果无效');
    return this.mutate((entries) => {
      const entry = entries.find((e) => e.id === id && e.projectId === projectId);
      if (!entry) throw new Error('经验不存在');
      entry.outcome = outcome;
      entry.confirmation = 'user';
      entry.trust = 'user-confirmed';
      return entry;
    });
  }

  async search(query: string, limit = 5, scope?: { model?: string; workflowVersion?: string }): Promise<AgentExperience[]> {
    const terms = words(query.slice(0, 2000));
    if (!terms.size) return [];
    return (await this.list()).filter((entry) => (!scope?.model || !entry.provenance?.model || entry.provenance.model === scope.model) && (!scope?.workflowVersion || !entry.provenance?.workflowVersion || entry.provenance.workflowVersion === scope.workflowVersion)).map((entry) => {
      const candidate = words(`${entry.task} ${entry.strategy} ${entry.failure ?? ''}`);
      const overlap = [...terms].filter((w) => candidate.has(w)).length;
      return { entry, score: overlap / Math.sqrt(terms.size * candidate.size || 1) * (entry.confirmation === 'user' ? 1.4 : 1) };
    }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || b.entry.at - a.entry.at).slice(0, Math.min(10, Math.max(1, limit))).map((e) => e.entry);
  }
}
