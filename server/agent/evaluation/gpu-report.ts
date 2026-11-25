import { extname, resolve } from 'node:path';

/** A report is JSON telemetry, never an executable downloaded from the GPU host. */
export function gpuReportPath(value: string) {
  const path = resolve(value);
  if (extname(path) !== '.json') throw new Error('GPU evaluation reports must use a .json filename');
  return path;
}

export function gpuReportLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[^A-Za-z0-9 ._()+/:\-]/.test(value)) {
    throw new Error('Invalid ComfyUI device/version label');
  }
  return value;
}
