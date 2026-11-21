import { nanoid } from 'nanoid';
import type { CanvasItem, MediaKind } from '../../shared/types';
import { commit, select, updateItems, useStore } from '../store';
import { placeRow, viewportCenter } from '../../shared/geometry';
import { t } from '../i18n';

const get = useStore.getState;

/** Short label for a media kind, for badges and chips. */
export function kindLabel(kind: MediaKind): string {
  return kind === 'video' ? t('视频') : kind === 'audio' ? t('音频') : kind === 'model3d' ? t('3D') : kind === 'document' ? t('文本') : t('图片');
}

export const IMAGE_LONG_SIDE = 512;
export const VIDEO_LONG_SIDE = 640;

/** Ids of the items an item was made from (handles boards saved before `inputs` existed). */
export function inputIds(item: CanvasItem): string[] {
  return item.inputs ?? (item.sourceId ? [item.sourceId] : []);
}
/** Media items in the current selection, in selection order. */
export function selectedMedia(kind?: MediaKind): CanvasItem[] {
  const { selection, items } = get();
  return selection
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is CanvasItem => Boolean(i?.asset) && (!kind || i!.kind === kind));
}
/** A new text note at the center of the view, open for typing. */
export function addNote() {
  const { items, viewport, screen } = get();
  const c = viewportCenter(viewport, screen.w, screen.h - 160);
  const size = { w: 380, h: 260 };
  const [pos] = placeRow(items, { x: c.x - size.w / 2, y: c.y - size.h / 2 }, [size]);
  const note: CanvasItem = { id: nanoid(10), kind: 'text', x: Math.round(pos.x), y: Math.round(pos.y), ...size, name: '', text: '', createdAt: Date.now() };
  commit([...items, note]);
  select([note.id]);
  useStore.setState({ noteEditing: note.id });
}
/** A new prompt node at the view center (or `at`), open for typing. */
export function addPrompt(at?: { x: number; y: number }) {
  const { items, viewport, screen } = get();
  const size = { w: 340, h: 200 };
  const c = at ?? viewportCenter(viewport, screen.w, screen.h - 160);
  const [pos] = placeRow(items, { x: c.x - size.w / 2, y: c.y - size.h / 2 }, [size]);
  const node: CanvasItem = { id: nanoid(10), kind: 'prompt', x: Math.round(pos.x), y: Math.round(pos.y), ...size, text: '', createdAt: Date.now() };
  commit([...items, node]);
  select([node.id]);
  useStore.setState({ noteEditing: node.id });
}
/** Text-like items: they carry text and have no asset. */
export function isTextual(item: CanvasItem) {
  return item.kind === 'text' || item.kind === 'prompt';
}
export function duplicate(ids: string[]) {
  const { items } = get();
  const copies = cloneItems(items.filter((i) => ids.includes(i.id) && (i.asset || isTextual(i))), 24, 24);
  if (!copies.length) return;
  commit([...items, ...copies]);
  select(copies.map((c) => c.id));
}

/** Copies items with fresh ids; links between copied items point at the copies. */
export function cloneItems(source: CanvasItem[], dx: number, dy: number): CanvasItem[] {
  const ids = new Map(source.map((i) => [i.id, nanoid(10)]));
  const now = Date.now();
  return source.map((i) => {
    const inputs = inputIds(i);
    return {
      ...i,
      id: ids.get(i.id)!,
      x: Math.round(i.x + dx),
      y: Math.round(i.y + dy),
      taskId: undefined,
      sourceId: undefined,
      inputs: inputs.length ? inputs.map((id) => ids.get(id) ?? id) : undefined,
      promptId: i.promptId ? (ids.get(i.promptId) ?? i.promptId) : undefined,
      createdAt: now,
    };
  });
}

export function reorder(ids: string[], where: 'front' | 'back') {
  updateItems((items) => {
    const moving = items.filter((i) => ids.includes(i.id));
    const rest = items.filter((i) => !ids.includes(i.id));
    return where === 'front' ? [...rest, ...moving] : [...moving, ...rest];
  });
}
