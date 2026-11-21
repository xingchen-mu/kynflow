import { Check, Film, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { thumbUrl } from '../../shared/media';
import type { CanvasItem, ReviewReason } from '../../shared/types';
import { revealItems } from '../canvas/view';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { patchItem, useStore } from '../store';

type Filter = 'all' | 'unreviewed' | 'pass' | 'fail';

const REASONS: ReviewReason[] = ['subject_mismatch', 'composition', 'subject_too_small', 'clipping', 'action_missing', 'text_wrong', 'other'];

/** The classes a failed check is sorted into, in words the user can pick from. */
function reasonLabel(reason: ReviewReason | undefined) {
  switch (reason) {
    case 'subject_mismatch':
      return t('主体不一致');
    case 'composition':
      return t('构图错');
    case 'subject_too_small':
      return t('主体过小');
    case 'clipping':
      return t('穿模/粘连');
    case 'action_missing':
      return t('动作没做出来');
    case 'text_wrong':
      return t('文字错');
    default:
      return t('其它');
  }
}

/**
 * Picking through what the board generated: one card per image or video, with the assistant's check
 * beside it. Passing or failing here writes the same `review` field the assistant reads, so the next
 * message sees the user's decision.
 */
export function ReviewModal() {
  const items = useStore((s) => s.items);
  const [filter, setFilter] = useState<Filter>('all');
  const results = items.filter((item) => (item.kind === 'image' || item.kind === 'video') && item.asset).reverse();
  const counts = {
    all: results.length,
    unreviewed: results.filter((item) => !item.review).length,
    pass: results.filter((item) => item.review?.verdict === 'pass').length,
    fail: results.filter((item) => item.review?.verdict === 'fail').length,
  };
  const shown = results.filter((item) =>
    filter === 'all' ? true : filter === 'unreviewed' ? !item.review : item.review?.verdict === filter,
  );

  const close = () => useStore.setState({ modal: null });
  const open = (id: string) => {
    useStore.setState({ selection: [id], modal: null });
    void revealItems([id]);
  };
  const review = (item: CanvasItem, verdict: 'pass' | 'fail', reason?: ReviewReason) => {
    patchItem(item.id, {
      review:
        verdict === 'pass'
          ? { verdict: 'pass', at: Date.now() }
          : {
              verdict: 'fail',
              reason: reason ?? item.review?.reason ?? 'other',
              ...(item.review?.note ? { note: item.review.note } : {}),
              at: Date.now(),
            },
    });
  };
  const note = (item: CanvasItem, value: string) => {
    const text = value.trim().slice(0, 120);
    if (!item.review || (item.review.note ?? '') === text) return;
    patchItem(item.id, { review: { ...item.review, note: text || undefined, at: Date.now() } });
  };
  const clear = (item: CanvasItem) => patchItem(item.id, { review: undefined });

  return (
    <Modal
      wide
      title={
        <span>
          {t('结果挑选')}
          <small className="review-count">{t('{n} 个结果', { n: results.length })}</small>
        </span>
      }
      onClose={close}
      footer={
        <button className="btn ghost" onClick={close}>
          {t('关闭')}
        </button>
      }
    >
      {results.length === 0 ? (
        <div className="review-empty">{t('还没有可挑选的结果。生成图片或视频后会出现在这里。')}</div>
      ) : (
        <>
          <div className="review-filters">
            {(
              [
                ['all', t('全部'), counts.all],
                ['unreviewed', t('未看'), counts.unreviewed],
                ['pass', t('通过'), counts.pass],
                ['fail', t('不通过'), counts.fail],
              ] as [Filter, string, number][]
            ).map(([id, label, n]) => (
              <button key={id} className={`review-filter ${filter === id ? 'on' : ''}`} onClick={() => setFilter(id)}>
                {label} <small>{n}</small>
              </button>
            ))}
          </div>
          {shown.length === 0 ? (
            <div className="review-empty">{t('这个筛选下没有结果。')}</div>
          ) : (
            <div className="review-grid">
              {shown.map((item) => {
                const asset = item.asset!;
                const failed = item.review?.verdict === 'fail';
                return (
                  <div key={item.id} className={`review-card ${item.review?.verdict ?? ''}`}>
                    <button className="review-media" title={t('在画布上查看')} onClick={() => open(item.id)}>
                      {asset.kind === 'video' ? (
                        <video src={asset.url} muted playsInline preload="metadata" />
                      ) : (
                        <img src={thumbUrl(asset.url)} alt="" loading="lazy" />
                      )}
                      {item.review && (
                        <span className={`review-badge ${item.review.verdict}`}>
                          {item.review.verdict === 'pass' ? t('通过') : t('不通过')}
                        </span>
                      )}
                      {asset.kind === 'video' && (
                        <span className="review-kind">
                          <Film />
                        </span>
                      )}
                    </button>
                    <div className="review-body">
                      <span className="review-name" title={item.name ?? item.id}>
                        {item.name ?? item.id}
                      </span>
                      {failed && item.review && (
                        <div className="review-fail">
                          <select
                            value={item.review.reason ?? 'other'}
                            title={t('不通过的原因')}
                            onChange={(e) => review(item, 'fail', e.target.value as ReviewReason)}
                          >
                            {REASONS.map((reason) => (
                              <option key={reason} value={reason}>
                                {reasonLabel(reason)}
                              </option>
                            ))}
                          </select>
                          <input
                            defaultValue={item.review.note ?? ''}
                            placeholder={t('哪里不对（可选）')}
                            onBlur={(e) => note(item, e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                          />
                        </div>
                      )}
                      <div className="review-actions">
                        <button
                          className={`review-action pass ${item.review?.verdict === 'pass' ? 'on' : ''}`}
                          onClick={() => review(item, 'pass')}
                        >
                          <Check /> {t('通过')}
                        </button>
                        <button
                          className={`review-action fail ${failed ? 'on' : ''}`}
                          onClick={() => review(item, 'fail')}
                        >
                          <X /> {t('不通过')}
                        </button>
                        {item.review && (
                          <button className="review-clear" title={t('清除结论')} onClick={() => clear(item)}>
                            <RotateCcw />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
