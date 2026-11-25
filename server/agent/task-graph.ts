import type { AgentAcceptanceCriterion, AgentTask, AgentTaskGraph, CanvasItem } from '../../shared/types.ts';
import { VISUAL_DIMENSIONS } from './visual-critic.ts';
import { assetVersions, changedAssets } from './asset-version.ts';
import { currentValidation } from './verification.ts';
import type { AgentValidationResult } from '../../shared/types.ts';

const TASK_ID = /^[\w-]{1,64}$/;
export const emptyTaskGraph = (): AgentTaskGraph => ({ version: 1, revision: 0, objective: '', tasks: [] });

export interface TaskGraphPlan {
  objective: string;
  tasks: { id: string; objective: string; dependencies: string[]; inputs?: string[]; acceptanceCriteria: AgentAcceptanceCriterion[]; maxAttempts?: number }[];
}
export type TaskGraphAction =
  | { action: 'plan'; revision: number; plan: TaskGraphPlan }
  | { action: 'start' | 'retry' | 'fail'; revision: number; id: string; error?: string }
  | { action: 'outputs'; revision: number; id: string; outputs: string[] }
  | { action: 'complete'; revision: number; id: string; evidence: AgentTask['evidence'] };

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function visualCriterionPass(task: AgentTask, criterion: AgentAcceptanceCriterion, items: Map<string, CanvasItem>, legacy = false): boolean {
  if (!criterion.dimension) return true;
  return task.outputs.every((id) => {
    const item = items.get(id);
    const critique = item?.critic;
    const references = task.inputs.filter((input) => ['image', 'video'].includes(items.get(input)?.kind ?? ''));
    const check = critique?.checks?.find((check) => check.id === criterion.id);
    const score = critique?.assessmentVersion === 'criteria-v2' ? check?.score : critique?.scores[criterion.dimension!]?.score;
    if (!legacy && (critique?.assessmentVersion !== 'criteria-v2' || !check || check.dimension !== criterion.dimension || check.description !== criterion.description.trim() || (check.scope ?? 'whole_media') !== (criterion.scope ?? 'whole_media') || check.verdict !== 'pass' || check.visibility !== 'observed' || check.score < (criterion.threshold ?? 80))) return false;
    return critique?.verdict === 'pass' && critique.assetId === item?.asset?.id && critique.objective === task.objective
      && (criterion.dimension !== 'identity' || critique.referenceIds.length > 0)
      && references.every((ref) => critique.referenceIds.includes(ref) && critique.referenceAssets?.[ref] === items.get(ref)?.asset?.id)
      && score !== undefined && score >= (criterion.threshold ?? 80);
  });
}

/** Pure validation and transition logic: rejected updates never mutate the saved graph. */
export function changeTaskGraph(current: AgentTaskGraph, action: TaskGraphAction, items: CanvasItem[], legacyVisualAcceptance = false, validation?: AgentValidationResult[]): AgentTaskGraph {
  check(action && ['plan', 'start', 'retry', 'fail', 'outputs', 'complete'].includes(action.action), '未知任务图操作');
  check(action.revision === current.revision, '任务图已更新，请先用 read_task_graph 读取最新 revision');
  const graph = structuredClone(current);
  const knownItems = new Map(items.map((i) => [i.id, i]));
  if (action.action === 'plan') {
    const plan = action.plan;
    check(plan && typeof plan.objective === 'string' && plan.objective.trim() && plan.objective.length <= 2000, '任务图需要明确目标（最多 2000 字）');
    check(Array.isArray(plan.tasks) && plan.tasks.length > 0 && plan.tasks.length <= 100, '任务图需要 1–100 个任务');
    const seen = new Set<string>();
    graph.objective = plan.objective.trim();
    graph.tasks = plan.tasks.map((t) => {
      check(t && TASK_ID.test(t.id) && !seen.has(t.id), '任务 id 无效或重复');
      seen.add(t.id);
      check(typeof t.objective === 'string' && t.objective.trim() && t.objective.length <= 1000, '任务需要明确目标（最多 1000 字）');
      check(Array.isArray(t.dependencies) && t.dependencies.length <= 100 && t.dependencies.every((id) => typeof id === 'string'), '依赖必须是任务 id 数组');
      const inputs = t.inputs ?? [];
      check(Array.isArray(inputs) && inputs.length <= 100 && inputs.every((id) => knownItems.has(id)), '输入必须是当前画布的节点 id');
      check(Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length > 0 && t.acceptanceCriteria.length <= 16, '每个任务需要 1–16 个验收条件');
      const criteria = new Set<string>();
      for (const c of t.acceptanceCriteria) {
        check(c && TASK_ID.test(c.id) && !criteria.has(c.id) && typeof c.description === 'string' && c.description.trim() && c.description.length <= 500, '验收条件需要唯一 id 和描述（最多 500 字）');
        criteria.add(c.id);
        if (c.dimension !== undefined) check(VISUAL_DIMENSIONS.includes(c.dimension), '未知视觉验收维度');
        if (c.threshold !== undefined) check(c.dimension && Number.isFinite(c.threshold) && c.threshold >= 0 && c.threshold <= 100, '视觉阈值必须是 0–100');
        if (c.scope !== undefined) check(['whole_media', 'sampled_frames'].includes(c.scope) && (c.scope !== 'sampled_frames' || c.dimension === 'temporal'), '抽样验收范围只适用于时序条件');
        if (c.validator !== undefined) {
          check(c.validator && ['asset', 'schema', 'media', 'user'].includes(c.validator.kind), '未知验证器');
          check(!c.dimension, '视觉条件与规格验证应分为独立验收项');
          if (c.validator.kind === 'schema') check(c.validator.schema && typeof c.validator.schema === 'object' && !Array.isArray(c.validator.schema) && JSON.stringify(c.validator.schema).length <= 8000, '结构验证需要有界 Schema');
          if (c.validator.kind === 'media') {
            const { kind: _kind, ...limits } = c.validator;
            check(Object.keys(limits).length > 0 && Object.entries(limits).every(([key, value]) => ['minWidth', 'minHeight', 'aspect', 'minDuration', 'maxDuration'].includes(key) && typeof value === 'number' && Number.isFinite(value) && value > 0), '媒体验收需要有效规格');
          }
        }
      }
      const maxAttempts = t.maxAttempts ?? 3;
      check(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= 5, '任务尝试上限必须是 1–5');
      const old = current.tasks.find((x) => x.id === t.id);
      const next = { id: t.id, objective: t.objective.trim(), dependencies: [...new Set(t.dependencies)], inputs: [...inputs], acceptanceCriteria: structuredClone(t.acceptanceCriteria), maxAttempts };
      if (old) {
        check(old.maxAttempts === maxAttempts, '已有任务不能增加尝试预算；需要用户调整目标后另建任务');
        const unchanged = JSON.stringify({ ...next, maxAttempts: undefined }) === JSON.stringify({ id: old.id, objective: old.objective, dependencies: old.dependencies, inputs: old.inputs, acceptanceCriteria: old.acceptanceCriteria, maxAttempts: undefined });
        check(unchanged || !['running', 'reviewing', 'completed'].includes(old.status), '修改已执行任务前先 retry，使受影响的下游失效');
        return { ...old, ...next };
      }
      return { ...next, outputs: [], evidence: [], status: 'pending', attempts: 0 } satisfies AgentTask;
    });
    const byId = new Map(graph.tasks.map((t) => [t.id, t]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    function visit(id: string) {
      check(!visiting.has(id), '任务依赖不能形成环');
      if (visited.has(id)) return;
      const task = byId.get(id);
      check(task, `不存在依赖任务 ${id}`);
      visiting.add(id);
      task.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    }
    graph.tasks.forEach((t) => visit(t.id));
  } else {
    const task = graph.tasks.find((t) => t.id === action.id);
    check(task, '任务不存在');
    if (action.action === 'start') {
      check(task.status === 'ready', '只能启动依赖已完成的 ready 任务');
      check(task.attempts < task.maxAttempts, '尝试预算已用完，请用 ask_user 请求用户决定');
      task.status = 'running';
      task.invalidated = false;
      task.inputVersions = assetVersions(task.inputs, knownItems);
      task.attempts++;
      task.error = undefined;
    } else if (action.action === 'retry') {
      check(['failed', 'blocked', 'reviewing', 'completed'].includes(task.status), '只能重试失败、受阻或已交付的任务');
      check(task.attempts < task.maxAttempts, '尝试预算已用完，请用 ask_user 请求用户决定');
      const affected = new Set([task.id]);
      let added = true;
      while (added) {
        added = false;
        for (const t of graph.tasks) if (!affected.has(t.id) && t.dependencies.some((id) => affected.has(id))) { affected.add(t.id); added = true; }
      }
      check(!graph.tasks.some((t) => affected.has(t.id) && t.status === 'running'), '先取消受影响的运行任务，再重试');
      for (const t of graph.tasks.filter((t) => affected.has(t.id))) {
        t.status = 'pending';
        t.previousOutputs = [...new Set([...(t.previousOutputs ?? []), ...t.outputs])].slice(-100);
        t.outputs = [];
        t.evidence = [];
        t.error = undefined;
        t.invalidated = false;
        t.inputVersions = undefined;
        t.outputVersions = undefined;
        t.validation = undefined;
        t.userValidation = undefined;
      }
    } else if (action.action === 'fail') {
      check(['running', 'reviewing'].includes(task.status), '只有执行中或审查中的任务可以记为失败');
      check(typeof action.error === 'string' && action.error.trim() && action.error.length <= 1000, '失败需要原因');
      task.status = 'failed';
      task.error = action.error;
    } else if (action.action === 'outputs') {
      check(task.status === 'running', '先 start 任务，再提交输出');
      check(Array.isArray(action.outputs) && action.outputs.length > 0 && action.outputs.length <= 100 && action.outputs.every((id) => knownItems.has(id)), '输出必须是当前画布的节点 id');
      task.outputs = [...new Set(action.outputs)];
      task.status = task.invalidated ? 'failed' : 'reviewing';
    } else if (action.action === 'complete') {
      check(task.status === 'reviewing', '先提交 outputs，再验收');
      check(task.outputs.length && task.outputs.every((id) => {
        const item = knownItems.get(id);
        return item && !item.error && item.critic?.verdict !== 'fail' && item.review?.verdict !== 'fail' && ((item.kind === 'text' || item.kind === 'prompt') ? Boolean(item.text?.trim()) : Boolean(item.asset));
      }), '输出未完成、已丢失或生成失败，不能验收');
      check(Array.isArray(action.evidence) && action.evidence.length <= 16, '需要逐项验收证据');
      for (const c of task.acceptanceCriteria) {
        check(action.evidence.some((e) => e.criterionId === c.id && typeof e.note === 'string' && e.note.trim() && e.note.length <= 1000), `缺少验收证据：${c.id}`);
        if (c.dimension) {
          check(visualCriterionPass(task, c, knownItems, legacyVisualAcceptance), `视觉硬性约束未通过独立审查：${c.id}`);
        }
        if (c.validator) check(currentValidation(task, c, knownItems, validation)?.verdict === 'pass', `验收未通过或证据未知：${c.id}；请 validate_task 或请求用户验收`);
      }
      task.validation = validation ? structuredClone(validation) : undefined;
      task.evidence = structuredClone(action.evidence);
      task.outputVersions = assetVersions(task.outputs, knownItems);
      task.status = 'completed';
    }
  }
  refreshTaskReadiness(graph);
  graph.revision++;
  return graph;
}

function refreshTaskReadiness(graph: AgentTaskGraph) {
  const byId = new Map(graph.tasks.map((t) => [t.id, t]));
  // Iterate to propagate a failure through any number of dependency layers.
  for (let n = 0; n <= graph.tasks.length; n++) {
    let changed = false;
    for (const task of graph.tasks) {
      if (!['pending', 'ready', 'blocked'].includes(task.status)) continue;
      const dependencies = task.dependencies.map((id) => byId.get(id));
      const status = task.attempts >= task.maxAttempts || dependencies.some((t) => !t || t.status === 'failed' || t.status === 'blocked')
        ? 'blocked' : dependencies.every((t) => t?.status === 'completed') ? 'ready' : 'pending';
      if (status !== task.status) { task.status = status; changed = true; }
    }
    if (!changed) break;
  }
}

/** A restart never silently launches GPU work or resets attempts. */
export function recoverTaskGraph(saved?: AgentTaskGraph): AgentTaskGraph {
  const graph = structuredClone(saved ?? emptyTaskGraph());
  let changed = false;
  for (const task of graph.tasks) if (task.status === 'running') {
    task.status = 'failed';
    task.error = '执行中断：先 read_board / wait_for_items 确认已有结果，再决定重试，避免重复提交';
    changed = true;
  }
  refreshTaskReadiness(graph);
  if (changed) graph.revision++;
  return graph;
}

/** External generation failures and deleted/rejected outputs cannot leave a task looking complete. */
export function reconcileTaskGraph(current: AgentTaskGraph, items: CanvasItem[], legacyVisualAcceptance = false): AgentTaskGraph {
  const graph = structuredClone(current);
  const byId = new Map(items.map((i) => [i.id, i]));
  let changed = false;
  const invalid = new Set<string>();
  for (const task of graph.tasks.filter((t) => ['running', 'reviewing', 'completed'].includes(t.status))) {
    const changedVersions = [...changedAssets(task.inputVersions, byId), ...(task.status === 'completed' ? changedAssets(task.outputVersions, byId) : [])];
    if (changedVersions.length && !task.invalidated) {
      task.invalidated = true;
      task.error = `素材内容已改变（${changedVersions.join(', ')}），旧执行或验收失效；检查已有 GPU 任务后局部重规划`;
      if (task.status !== 'running') task.status = 'failed';
      invalid.add(task.id);
    }
    if (task.status === 'running' || task.status === 'failed') continue;
    const bad = task.outputs.find((id) => {
      const item = byId.get(id);
      return !item || item.error || item.critic?.verdict === 'fail' || item.review?.verdict === 'fail' || (task.status === 'completed' && !item.asset && !item.text?.trim());
    }) ?? (task.status === 'completed' && task.acceptanceCriteria.some((c) => !visualCriterionPass(task, c, byId, legacyVisualAcceptance) || (c.validator && currentValidation(task, c, byId)?.verdict !== 'pass')) ? task.outputs[0] : undefined);
    if (bad) {
      task.status = 'failed';
      task.error = `输出 ${bad} 已丢失、失败或未通过审查；检查后 retry，保留已有生成结果以免重复提交`;
      invalid.add(task.id);
      changed = true;
    }
  }
  if (!changed && !invalid.size) return current;
  for (let n = 0; n < graph.tasks.length; n++) for (const task of graph.tasks) {
    if (invalid.has(task.id) || !task.dependencies.some((id) => invalid.has(id))) continue;
    invalid.add(task.id);
    task.invalidated = true;
    // Running GPU work stays visible until the orchestrator cancels it.
    if (task.status !== 'running') {
      task.status = 'pending';
      task.evidence = [];
    }
  }
  refreshTaskReadiness(graph);
  graph.revision++;
  return graph;
}

export function taskGraphContext(graph: AgentTaskGraph): string {
  if (!graph.tasks.length) return '';
  const active = graph.tasks.filter((t) => t.status !== 'completed');
  const order = { running: 0, reviewing: 1, failed: 2, ready: 3, blocked: 4, pending: 5, completed: 6 };
  active.sort((a, b) => order[a.status] - order[b.status]);
  return `任务图 revision=${graph.revision}，目标：${graph.objective}\n完成 ${graph.tasks.length - active.length}/${graph.tasks.length}；依赖和预算由运行时检查。\n${active.slice(0, 12).map((t) =>
    `- ${t.id} [${t.status}] ${t.objective}；依赖=${t.dependencies.join(',')}；尝试=${t.attempts}/${t.maxAttempts}；输入=${t.inputs.join(',')}；输出=${t.outputs.join(',')}；旧输出=${t.previousOutputs?.join(',') ?? ''}；验收=${JSON.stringify(t.acceptanceCriteria)}${t.error ? `；原因=${t.error}` : ''}`).join('\n')}`;
}
