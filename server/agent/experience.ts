import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { AgentExperience } from '../../shared/types.ts';
import { REVIEW_REASONS } from './review.ts';
import { writeJson } from './write.ts';

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
      outcome: input.outcome, confirmation: 'agent', itemIds: [...new Set(input.itemIds)], at: Date.now(),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.failure ? { failure: input.failure } : {}),
    };
    return this.mutate((entries) => { entries.push(entry); return entry; });
  }

  /** This method is reachable only from the local user's HTTP endpoint, never an agent tool. */
  confirm(projectId: string, id: string, outcome: AgentExperience['outcome']): Promise<AgentExperience> {
    if (!['success', 'failure'].includes(outcome)) throw new Error('经验结果无效');
    return this.mutate((entries) => {
      const entry = entries.find((e) => e.id === id && e.projectId === projectId);
      if (!entry) throw new Error('经验不存在');
      entry.outcome = outcome;
      entry.confirmation = 'user';
      return entry;
    });
  }

  async search(query: string, limit = 5): Promise<AgentExperience[]> {
    const terms = words(query.slice(0, 2000));
    if (!terms.size) return [];
    return (await this.list()).map((entry) => {
      const candidate = words(`${entry.task} ${entry.strategy} ${entry.failure ?? ''}`);
      const overlap = [...terms].filter((w) => candidate.has(w)).length;
      return { entry, score: overlap / Math.sqrt(terms.size * candidate.size || 1) * (entry.confirmation === 'user' ? 1.4 : 1) };
    }).filter((e) => e.score > 0).sort((a, b) => b.score - a.score || b.entry.at - a.entry.at).slice(0, Math.min(10, Math.max(1, limit))).map((e) => e.entry);
  }
}
