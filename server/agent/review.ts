import type { CanvasItem, Project, ReviewReason } from '../../shared/types.ts';

/** How many times one result may be retried before the assistant has to ask the user. */
export const RETRY_LIMIT = 2;

/** The classes a failed check is sorted into; each one points at a different retry. */
export const REVIEW_REASONS: ReviewReason[] = ['subject_mismatch', 'composition', 'subject_too_small', 'clipping', 'action_missing', 'text_wrong', 'other'];

export const REASON_LABEL: Record<ReviewReason, string> = {
  subject_mismatch: '主体不一致',
  composition: '构图错',
  subject_too_small: '主体过小',
  clipping: '穿模/粘连',
  action_missing: '动作没做出来',
  text_wrong: '文字错',
  other: '其它',
};

/** The retry each class calls for. Parameters and inputs only; the workflow graph is never touched. */
export const REASON_FIX: Record<ReviewReason, string> = {
  subject_mismatch: '带上参考图重写提示词（照着图里的人物和道具写），或换一个图生图/编辑类工作流（list_workflows 的 image_edit）',
  composition: '改提示词写清景别和站位；有两个人以上或人与门、墙、栏杆有前后关系时，先用 mark_layout 在底图上标出位置',
  subject_too_small: '先用 crop_image 把场景图裁到这一镜的取景，再拿裁好的图当参考重做',
  clipping: '改提示词把人、家具、道具分开写，或标出站位；还不行就换能力匹配的工作流',
  action_missing: '改提示词写明看得见的身体动作（首帧之后才开始），或换种子',
  text_wrong: '改提示词写清文字原文（qwen 能写中文）；仍错就换种子',
  other: '改提示词或换种子；还不行就换能力匹配的工作流',
};

/** How many retries this result's chain has already used (each retry points back with `retryOf`). */
export function retryDepth(project: Project, item: CanvasItem): number {
  const seen = new Set<string>();
  let n = 0;
  let cur: CanvasItem | undefined = item;
  while (cur?.retryOf && !seen.has(cur.id) && n < 20) {
    seen.add(cur.id);
    cur = project.items.find((i) => i.id === cur!.retryOf);
    n++;
  }
  return n;
}

/** Retries this result may still get before the assistant has to ask the user. */
export function retriesLeft(project: Project, item: CanvasItem): number {
  return Math.max(0, RETRY_LIMIT - retryDepth(project, item));
}

/** The verdict recorded on an item, one line for the model; empty when it was never checked. */
export function reviewLine(item: CanvasItem): string {
  const r = item.review;
  if (!r) return '';
  if (r.verdict === 'pass') return '检查通过';
  return `检查不通过（${r.reason ? REASON_LABEL[r.reason] : '原因没写'}）${r.note ? `：${r.note}` : ''}`;
}
