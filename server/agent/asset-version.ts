import { createHash } from 'node:crypto';
import type { CanvasItem } from '../../shared/types.ts';

/** Content identity excludes cosmetic canvas moves and names. */
export function assetVersion(item: CanvasItem): string {
  return createHash('sha256').update(JSON.stringify({ kind: item.kind, asset: item.asset?.id ?? null, text: ['text', 'prompt'].includes(item.kind) ? item.text ?? '' : undefined, pendingTask: item.asset ? undefined : item.taskId })).digest('hex');
}
export function assetVersions(ids: string[], items: Map<string, CanvasItem>): Record<string, string> {
  return Object.fromEntries(ids.flatMap((id) => { const item = items.get(id); return item ? [[id, assetVersion(item)]] : []; }));
}
export function changedAssets(versions: Record<string, string> | undefined, items: Map<string, CanvasItem>): string[] {
  return Object.entries(versions ?? {}).filter(([id, version]) => !items.has(id) || assetVersion(items.get(id)!) !== version).map(([id]) => id);
}
