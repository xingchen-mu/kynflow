import type { CanvasItem } from '../../shared/types';
import { GAP, boundsOf, placeRow, toWorld } from '../../shared/geometry';
import { ensureVisible } from '../canvas/view';
import { slotRect } from '../canvas/Links';
import { select, setComposer, useStore } from '../store';

/**
 * Opens the generation card. With a source it sits at the end of the wire and uses that node;
 * without one it opens at the middle of the view (used by workflow menus).
 */
export function openGenerator(from?: CanvasItem, at?: { x: number; y: number }) {
  const st = useStore.getState();
  // Z-Image cannot take a reference image.
  if (st.composer.mode === 'image' && st.composer.imageModel === 'zimage') setComposer({ imageModel: 'qwen' });
  if (from) select([from.id]);
  else select([]);
  let point = at;
  if (from && !point) {
    const probe = slotRect(from, { x: 0, y: 0 });
    const others = st.items.filter((i) => i.id !== from.id);
    const [pos] = placeRow(others, { x: from.x + from.w + GAP * 3, y: from.y + (from.h - probe.h) / 2 }, [probe]);
    point = { x: pos.x, y: pos.y + probe.h / 2 };
  }
  if (!point) point = toWorld(st.viewport, st.screen.w / 2, st.screen.h / 2);
  useStore.setState({ pendingOutput: { from: from?.id, at: point } });
  if (from) ensureVisible(boundsOf([from, slotRect(from, point)])!);
  requestAnimationFrame(() => document.getElementById('composer-input')?.focus());
}
