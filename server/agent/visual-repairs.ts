import type { ReviewReason, VisualCriterionCheck, VisualDefect, VisualDefectCategory, VisualRepairStep } from '../../shared/types.ts';

export const DEFECT_CATEGORIES: VisualDefectCategory[] = ['identity_drift', 'layout_mismatch', 'spatial_conflict', 'subject_scale', 'object_clipping', 'action_missing', 'text_error', 'style_drift', 'color_mismatch', 'render_artifact', 'temporal_discontinuity', 'insufficient_evidence', 'instruction_mismatch'];
type Strategy = Pick<VisualRepairStep, 'action' | 'capability' | 'requiresReference' | 'instruction'>;
export const REPAIR_STRATEGIES: Record<VisualDefectCategory, Strategy> = {
  identity_drift: { action: 'reference_edit', capability: 'image_edit', requiresReference: true, instruction: '沿用原始主体参考图做编辑，明确列出须保留的形状、服装、配色与道具；不要把失败结果当成新的身份标准' },
  layout_mismatch: { action: 'layout_guide', capability: 'image_edit', requiresReference: true, instruction: '先用 mark_layout 在底图标出景别、左右站位和前后关系，再将布局图与原始参考共同传入编辑工作流' },
  spatial_conflict: { action: 'layout_guide', capability: 'image_edit', requiresReference: true, instruction: '用 mark_layout 区分物体边界、遮挡和接触点，保留其它已通过部分后定向编辑' },
  subject_scale: { action: 'crop_reference', capability: 'image_edit', requiresReference: true, instruction: '先用 crop_image 得到所需景别，再以裁图和原始参考编辑主体比例，不能用超分冒充重新取景' },
  object_clipping: { action: 'localized_edit', capability: 'inpaint', requiresReference: true, instruction: '定位粘连或缺失的局部；只有存在匹配的蒙版与局部编辑能力时使用 inpaint，否则查询参考编辑工作流，不臆造蒙版' },
  action_missing: { action: 'prompt_revision', requiresReference: true, instruction: '用可观察的起始姿势、动作过程与结束姿势重写动作要求，检查首尾帧和视频能力；不要仅换 seed' },
  text_error: { action: 'reference_edit', capability: 'image_edit', requiresReference: true, instruction: '传入原图，把要求的文字原文逐字写入编辑指令，只改文字区域；重做后再逐字核对，不只换 seed' },
  style_drift: { action: 'reference_edit', capability: 'image_edit', requiresReference: true, instruction: '固定原始风格参考、材质与光线，仅修改失败的风格属性，保留已通过的身份和构图' },
  color_mismatch: { action: 'reference_edit', capability: 'image_edit', requiresReference: true, instruction: '明确被修改区域、色相、明度和饱和度；有用户指定色值时原样传递，使用原始图做参考编辑，仅调整失败区域颜色' },
  render_artifact: { action: 'localized_edit', capability: 'inpaint', requiresReference: true, instruction: '定位可见伪影并查询局部编辑能力；没有可用蒙版时先检查或选择参考编辑，保留其它区域' },
  temporal_discontinuity: { action: 'inspect_more', requiresReference: false, instruction: '先增加缺陷附近抽帧与动作证据，定位不连续区间；当前抽样不足时不能声称整段视频通过，也不立即重做整段' },
  insufficient_evidence: { action: 'inspect_more', requiresReference: false, instruction: '先取得缺失参考、清晰局部或更多视频帧，必要时询问用户；不能把看不清误判成生成缺陷并直接重试' },
  instruction_mismatch: { action: 'prompt_revision', requiresReference: false, instruction: '对照失败验收条目重写具体可见要求，查询匹配能力；保留已通过条目，不重复同一提示词与参数' },
};

export function defectReason(category: VisualDefectCategory): ReviewReason {
  return ({ identity_drift: 'subject_mismatch', layout_mismatch: 'composition', spatial_conflict: 'composition', subject_scale: 'subject_too_small', object_clipping: 'clipping', action_missing: 'action_missing', text_error: 'text_wrong' } as Partial<Record<VisualDefectCategory, ReviewReason>>)[category] ?? 'other';
}

export function repairPlan(checks: VisualCriterionCheck[], defects: VisualDefect[]): VisualRepairStep[] {
  const preserve = checks.filter((check) => check.verdict === 'pass').map((check) => check.description);
  // Missing evidence must be resolved before any generation proposal.
  const categories = [...new Set(defects.map((defect) => defect.category))].sort((a, b) => Number(b === 'insufficient_evidence') - Number(a === 'insufficient_evidence'));
  return categories.map((category) => ({ category, ...REPAIR_STRATEGIES[category], preserve, verify: defects.filter((defect) => defect.category === category).map((defect) => defect.criterionId), seedOnlyAllowed: false }));
}
