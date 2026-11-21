// Shared by the page and the server: board thumbnails.

import type { MediaKind } from './types';

/** Long side of a thumbnail, in pixels: items shown smaller than this on screen use it. */
export const THUMB_PX = 768;

/** Default board size for an output kind when the asset has no pixel size (audio, 3D, documents). */
export const CARD_SIZE: Record<MediaKind, { width: number; height: number }> = {
  image: { width: 512, height: 512 },
  video: { width: 640, height: 360 },
  audio: { width: 360, height: 120 },
  model3d: { width: 360, height: 280 },
  document: { width: 420, height: 300 },
};

const MEDIA_KINDS = Object.keys(CARD_SIZE) as MediaKind[];

/** Whether a stored value is one of the output kinds this app understands. */
export function isMediaKind(value: unknown): value is MediaKind {
  return typeof value === 'string' && (MEDIA_KINDS as string[]).includes(value);
}

/** The thumbnail of a media URL (/files/<file> → /files/thumb/<file>); other URLs are returned as they are. */
export function thumbUrl(url: string): string {
  return url.replace(/^\/files\//, '/files/thumb/');
}

/** File sizes as people read them: 812 MB, 20.4 GB. */
export function formatBytes(n: number): string {
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
