import type { AgentAcceptanceCriterion, VisualCriterion, VisualDimension } from '../../shared/types.ts';

export const VISUAL_DIMENSIONS: VisualDimension[] = ['instruction', 'identity', 'composition', 'spatial', 'style', 'quality', 'temporal', 'text'];
const DEFAULT_DESCRIPTION: Record<VisualDimension, string> = {
  instruction: '逐项核对目标中的主体、数量、颜色与改动范围，未要求改变的部分保持原样',
  identity: '与参考对照人物、产品、服装和道具的外观、形状与细节',
  composition: '核对景别、主体比例、朝向、取景和构图',
  spatial: '核对左右位置、前后遮挡、站位和物体接触',
  style: '核对要求的材质、色调、光线与画风',
  quality: '检查可见的伪影、破损、模糊、融合和边缘异常',
  temporal: '只报告提供帧之间可观察的变化，不把抽样帧当作完整动作证据',
  text: '逐字核对要求的文字原文、顺序与可读性',
};

/** Task descriptions survive as individual hard checks, even within the same dimension. */
export function visualCriteria(thresholds: Partial<Record<VisualDimension, number>>, supplied: AgentAcceptanceCriterion[] = []): VisualCriterion[] {
  if (!Array.isArray(supplied) || supplied.length > 16) throw new Error('视觉验收最多 16 项自定义条件');
  const ids = new Set<string>();
  const result: VisualCriterion[] = [];
  for (const criterion of supplied) {
    if (!criterion.dimension) continue;
    if (!/^[\w-]{1,64}$/.test(criterion.id) || ids.has(criterion.id) || typeof criterion.description !== 'string' || !criterion.description.trim() || criterion.description.length > 500) throw new Error('视觉验收条件需要唯一 id 和明确描述');
    if (!VISUAL_DIMENSIONS.includes(criterion.dimension)) throw new Error('未知视觉验收维度');
    if (criterion.scope !== undefined && (!['whole_media', 'sampled_frames'].includes(criterion.scope) || (criterion.scope === 'sampled_frames' && criterion.dimension !== 'temporal'))) throw new Error('抽样验收范围只适用于时序条件');
    ids.add(criterion.id);
    const threshold = Math.max(thresholds[criterion.dimension] ?? 0, criterion.threshold ?? 80);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('视觉阈值必须是 0–100');
    result.push({ id: criterion.id, dimension: criterion.dimension, description: criterion.description.trim(), threshold, ...(criterion.scope ? { scope: criterion.scope } : {}) });
  }
  for (const [key, threshold] of Object.entries(thresholds)) {
    const dimension = key as VisualDimension;
    if (!VISUAL_DIMENSIONS.includes(dimension) || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('视觉阈值必须是已知维度的 0–100 分');
    if (result.some((criterion) => criterion.dimension === dimension)) continue;
    let id = `check-${dimension}`;
    while (ids.has(id)) id = `_${id}`;
    ids.add(id);
    result.push({ id, dimension, description: DEFAULT_DESCRIPTION[dimension], threshold });
  }
  if (!result.length) throw new Error('至少需要一个视觉验收条件');
  return result;
}
