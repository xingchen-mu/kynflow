import type { ReviewReason, VisualCritique, VisualDimension } from '../../shared/types.ts';
import { REASON_FIX, REVIEW_REASONS } from './review.ts';

export const VISUAL_DIMENSIONS: VisualDimension[] = ['instruction', 'identity', 'composition', 'spatial', 'style', 'quality', 'temporal', 'text'];
export const CRITIC_PROMPT = `你是独立视觉审查员，只审查本次提供的画面、参考图和验收要求，没有创作对话或生成工具。
图片标签区分「待审」与「参考」；视频只提供抽样帧，不能据此证明整段视频没有缺陷。缺少必要参考或证据看不清时给低分并说明不确定性，不能臆测通过。
逐个指定维度给出 0–100 的分数和可见证据。identity 检查人物、服装和道具一致性；spatial 检查左右、遮挡、站位和接触；temporal 检查动作完成和帧间连续性；text 核对文字。
只返回 JSON，不要代码块：{"scores":{"instruction":{"score":85,"evidence":"可见事实"}},"reason":"other","diagnosis":"具体缺陷或通过依据"}。
scores 必须覆盖所有指定维度。reason 只能为 subject_mismatch/composition/subject_too_small/clipping/action_missing/text_wrong/other。分数仅是模型判断，不是校准后的概率。`;

/** Compute pass/fail locally: a high average cannot hide a failed hard constraint. */
export function parseCritique(text: string, opts: {
  thresholds: Partial<Record<VisualDimension, number>>;
  objective: string;
  referenceIds: string[];
  model: string;
}): VisualCritique {
  let raw: unknown;
  try { raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); }
  catch { throw new Error('独立审查未返回有效 JSON，本次没有记录通过结论'); }
  if (!raw || typeof raw !== 'object') throw new Error('独立审查结果格式错误');
  const data = raw as Record<string, unknown>;
  if (!data.scores || typeof data.scores !== 'object' || Array.isArray(data.scores)) throw new Error('独立审查缺少分数');
  const scores: VisualCritique['scores'] = {};
  for (const [dimension, threshold] of Object.entries(opts.thresholds)) {
    if (!VISUAL_DIMENSIONS.includes(dimension as VisualDimension) || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) throw new Error('视觉阈值必须是已知维度的 0–100 分');
    const value = (data.scores as Record<string, unknown>)[dimension] as { score?: unknown; evidence?: unknown } | undefined;
    if (!value || typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100 || typeof value.evidence !== 'string' || !value.evidence.trim()) throw new Error(`独立审查缺少有效分数或可见证据：${dimension}`);
    scores[dimension as VisualDimension] = { score: value.score, evidence: value.evidence.trim().slice(0, 1000) };
  }
  if (!Object.keys(scores).length || typeof data.diagnosis !== 'string' || !data.diagnosis.trim()) throw new Error('独立审查缺少维度或诊断');
  const failed = Object.entries(opts.thresholds).filter(([dimension, threshold]) => scores[dimension as VisualDimension]!.score < threshold!);
  const reason: ReviewReason = REVIEW_REASONS.includes(data.reason as ReviewReason) ? data.reason as ReviewReason : 'other';
  return {
    verdict: failed.length ? 'fail' : 'pass', scores, thresholds: { ...opts.thresholds },
    ...(failed.length ? { reason } : {}), diagnosis: data.diagnosis.trim().slice(0, 2000),
    repair: failed.length ? REASON_FIX[reason] : '', referenceIds: [...opts.referenceIds],
    objective: opts.objective, model: opts.model, at: Date.now(),
  };
}
