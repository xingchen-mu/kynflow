import { rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const writes = new Map<string, Promise<void>>();

/** Serialize snapshots per pathname and atomically replace the file. Failed writes do not poison the queue. */
export function writeJson(path: string, value: () => unknown): Promise<void> {
  const next = (writes.get(path) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value()));
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
  writes.set(path, next);
  void next.then(() => { if (writes.get(path) === next) writes.delete(path); }, () => { if (writes.get(path) === next) writes.delete(path); });
  return next;
}
