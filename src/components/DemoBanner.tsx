import { Clapperboard, Loader2, Play, Scan } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { boundsOf, fitViewport } from '../../shared/geometry';
import { fitAll } from '../canvas/view';
import { launch } from '../generation/tasks';
import { demoHeroId, demoMeta } from '../lib/demo';
import { setViewport, toast, useStore } from '../store';
import { t } from '../i18n';

/** Shown only in the static demo build: says what is preloaded, and lets a visitor try the flow. */
export function DemoBanner() {
  const items = useStore((s) => s.items);
  const [busy, setBusy] = useState(false);
  const focused = useRef(false);

  const hero = demoHeroId(items);

  // First view frames the whole media chain (minus the text note) at a readable zoom.
  useEffect(() => {
    if (focused.current) return;
    const media = items.filter((i) => i.kind !== 'text');
    const b = boundsOf(media.length ? media : items);
    if (!b) return;
    focused.current = true;
    const { screen } = useStore.getState();
    setViewport(fitViewport(b, screen.w, screen.h - 160, 60, 0.3));
  }, [items]);

  const watch = () => {
    if (hero) useStore.setState({ lightboxId: hero });
  };

  const tryIt = async () => {
    const info = await demoMeta();
    const reference = info.demo.reference ? items.find((i) => i.id === info.demo.reference) : undefined;
    setBusy(true);
    try {
      await launch({
        // Replay the request the fixture's image was actually made with; Z-Image is the safe default.
        request: info.demo.request ?? { op: 'image.generate', model: 'zimage', prompt: info.demo.prompt, aspect: 'auto', quality: '1k' },
        kind: 'image',
        size: { w: 512, h: 387 },
        inputs: reference ? [reference] : [],
      });
      toast(t('演示模式：结果是预置素材，不会真的生成'), 'info');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="demo-bar">
      <span className="demo-tag">{t('演示模式')}</span>
      <span className="demo-lead">{t('AI 短剧制片台')}</span>
      <span className="demo-note">{t('预置作品，不连 GPU · 每个结果都连回它的来源')}</span>
      <button className="demo-btn primary" onClick={watch} disabled={!hero}>
        <Clapperboard />
        {t('看成片')}
      </button>
      <button className="demo-btn" onClick={fitAll} title={t('看整张画布：每个结果是从哪一步来的')}>
        <Scan />
        {t('看全链路')}
      </button>
      <button className="demo-btn" onClick={() => void tryIt()} disabled={busy}>
        {busy ? <Loader2 className="spin" /> : <Play />}
        {t('试一下')}
      </button>
    </div>
  );
}
