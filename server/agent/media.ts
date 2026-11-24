import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { t } from '../i18n.ts';

/** Runs a command; resolves with stdout (or stderr, where ffmpeg filters report), rejects with the tail of stderr. */
function exec(cmd: string, args: string[], signal?: AbortSignal, want: 'stdout' | 'stderr' = 'stdout'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { signal, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => want === 'stdout' && out.push(d));
    p.stderr.on('data', (d: Buffer) => {
      if (want === 'stderr') out.push(d);
      err = (err + d.toString()).slice(-4000);
    });
    p.on('error', (e) => reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(t('找不到 {cmd}：剪辑和看视频需要安装 ffmpeg（macOS：brew install ffmpeg）', { cmd })) : e));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(t('{cmd} 出错：{detail}', { cmd, detail: err.trim().split('\n').slice(-3).join(' ') })))));
  });
}

export interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export async function probe(path: string, signal?: AbortSignal): Promise<VideoInfo> {
  const json = JSON.parse(
    (await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', path], signal)).toString(),
  ) as { streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[]; format: { duration?: string } };
  const video = json.streams.find((s) => s.codec_type === 'video');
  const [num, den] = (video?.r_frame_rate ?? '24/1').split('/').map(Number);
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    duration: Number(json.format.duration) || 0,
    fps: num && den ? num / den : 24,
    hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Stretches where the sound clearly stands out: in generated shots that is mostly dialogue, since the
 * ambience stays far quieter (H3 ambience sits around -40 dB, speech around -20 dB).
 */
export async function soundSpans(path: string, duration: number, threshold = -28): Promise<{ start: number; end: number }[]> {
  const log = (await exec('ffmpeg', ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', `silencedetect=n=${threshold}dB:d=0.25`, '-f', 'null', '-'], undefined, 'stderr')).toString();
  return spansBetweenSilences(log, duration);
}

/** The stretches between the silences ffmpeg's silencedetect reported (shorter than 0.15 s dropped). */
export function spansBetweenSilences(log: string, duration: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let soundFrom = 0;
  let silent = false;
  for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    const t = Math.max(0, Number(m[2]));
    if (m[1] === 'start') {
      if (t - soundFrom >= 0.15) spans.push({ start: soundFrom, end: t });
      silent = true;
    } else {
      soundFrom = t;
      silent = false;
    }
  }
  // Sound runs to the end unless a silence did.
  if (!silent && duration - soundFrom >= 0.15) spans.push({ start: soundFrom, end: duration });
  return spans.map((s) => ({ start: Math.round(s.start * 100) / 100, end: Math.round(Math.min(s.end, duration) * 100) / 100 }));
}

/** One frame of a video as PNG. */
export async function videoFrame(path: string, at: number, signal?: AbortSignal): Promise<Buffer> {
  return exec('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, at)), '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'], signal);
}

/** How far a clip's first frame may sit from its keyframe before the keyframe check fails. */
export const KEYFRAME_TOLERANCE = 0.2;

/** A small grayscale thumbnail of a picture as 0–1 values, for comparing two frames. */
export async function frameSignature(image: Buffer | string, size = 32): Promise<number[]> {
  const { data } = await sharp(image).resize(size, size, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return Array.from(data, (v) => v / 255);
}

/** Mean absolute difference of two frame signatures: 0 is the same picture, 1 is black against white. */
export function frameDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return Math.round((sum / n) * 1000) / 1000;
}

/**
 * The very last frame, as PNG. Seeking close to the end can land past it and give nothing (ffmpeg still
 * succeeds), so the last second is decoded with each frame written over the one before.
 */
export async function lastFrame(path: string, signal?: AbortSignal): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'kynflow-frame-'));
  try {
    const out = join(dir, 'last.png');
    await exec('ffmpeg', ['-v', 'error', '-sseof', '-1', '-i', path, '-update', '1', '-y', out], signal);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface Tile {
  image: Buffer | string;
  /** Drawn in the corner: "3", or "3a" for a frame of a video. */
  label: string;
}

/**
 * Labelled tiles on one JPEG, `cols` to a row across 1920 px, which vision models take without
 * downscaling much. Two columns give tiles about 960 px wide: big enough to see a chair grown into a table.
 */
export async function contactSheet(tiles: Tile[], cols: number): Promise<Buffer> {
  const gap = 8;
  cols = Math.max(1, Math.min(cols, tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const cellW = Math.min(1280, Math.floor((1920 - gap * (cols - 1)) / cols));
  // Cells take the median shape, so a mixed batch wastes the least space.
  const ratios = (await Promise.all(tiles.map((t) => sharp(t.image).metadata()))).map((m) => (m.height ?? 9) / (m.width ?? 16)).sort((a, b) => a - b);
  const cellH = Math.round(Math.min(1.4, Math.max(0.5, ratios[Math.floor(ratios.length / 2)])) * cellW);
  const placed = await Promise.all(
    tiles.map(async (t, i) => {
      const label = Buffer.from(
        `<svg width="${cellW}" height="${cellH}"><rect x="8" y="8" rx="8" width="${t.label.length * 18 + 22}" height="40" fill="rgba(0,0,0,0.72)"/>` +
          `<text x="19" y="37" font-size="28" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="#ffffff">${t.label}</text></svg>`,
      );
      const tile = await sharp(t.image)
        .resize(cellW, cellH, { fit: 'contain', background: '#141518' })
        .composite([{ input: label }])
        .png()
        .toBuffer();
      return { input: tile, left: (i % cols) * (cellW + gap), top: Math.floor(i / cols) * (cellH + gap) };
    }),
  );
  return sharp({ create: { width: cols * cellW + (cols - 1) * gap, height: rows * cellH + (rows - 1) * gap, channels: 3, background: '#0e0f11' } })
    .composite(placed)
    .jpeg({ quality: 82 })
    .toBuffer();
}

/** A line of dialogue in a clip. from / to: seconds into the clip. */
export interface Line {
  text: string;
  from?: number;
  to?: number;
}

export interface Clip {
  path: string;
  /** Seconds into the clip; whole clip when omitted. */
  start?: number;
  end?: number;
  /** What is said in the clip, in order: levelled to one loudness, and burnt in as subtitles. */
  lines?: Line[];
}

export interface CutOptions {
  /** Bring every clip's dialogue to one loudness, then hold the peaks under the limit (default off here, on in the tool). */
  level?: boolean;
  /** Burn the lines in as subtitles. */
  subtitles?: boolean;
}

/** A subtitle on the finished film: seconds from its start. */
export interface Cue {
  text: string;
  start: number;
  end: number;
}

export interface Cut extends VideoInfo {
  cues: Cue[];
  /** dB each clip was raised or lowered by; empty when nothing was levelled. */
  gains: number[];
}

/** Dialogue loudness the clips are brought to: the streaming norm for speech (AES TD1008), platforms adjust from there. */
export const DIALOGUE_LUFS = -16;
/** Peak ceiling after levelling, -1.5 dBFS. */
const PEAK_LIMIT = 0.84;
/** Short fades at each cut: a hard cut through a waveform clicks. */
const CUT_FADE = 0.015;
/** The ideographic space Chinese subtitles put where a comma would be. */
const PAUSE = '\u3000';

/** Integrated loudness (LUFS) of a stretch of a clip, or null for silence. */
export async function loudness(path: string, start: number, end: number, signal?: AbortSignal): Promise<number | null> {
  const log = (
    await exec('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(start), '-t', String(Math.max(0.5, end - start)), '-i', path, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'], signal, 'stderr')
  ).toString();
  const m = /"input_i"\s*:\s*"(-?[\d.]+)"/.exec(log);
  const value = m ? Number(m[1]) : NaN;
  return Number.isFinite(value) && value > -70 ? value : null;
}

/**
 * Gains (dB) that bring each clip's dialogue to DIALOGUE_LUFS. Generated shots come out at whatever level
 * the model chose, so a cut jumps from a mumble to a shout. Clips without dialogue (`null`) take the median
 * gain of the ones with it, so their ambience keeps its place under the speech. Nothing to level by: [].
 */
export function levelGains(measured: (number | null)[]): number[] {
  const clamp = (g: number) => Math.round(Math.max(-12, Math.min(12, g)) * 10) / 10;
  const speech = measured.flatMap((l) => (l === null ? [] : [clamp(DIALOGUE_LUFS - l)])).sort((a, b) => a - b);
  if (!speech.length) return [];
  const median = speech[Math.floor(speech.length / 2)];
  return measured.map((l) => (l === null ? median : clamp(DIALOGUE_LUFS - l)));
}

/** Chinese pause punctuation becomes a space and a closing full stop goes, as Chinese subtitles are set; ？！… stay. */
export function subtitleText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[，、；：。]+/g, PAUSE)
    .replace(/[\s\u3000]+$/u, '')
    .replace(/^[\s\u3000]+/u, '')
    .replace(/[ \u3000]{2,}/gu, PAUSE);
}

/** Screen width of a line in em: CJK one, Latin about half. */
const ems = (s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x2e80 ? 0.55 : 1), 0);

/**
 * Splits a line too wide for one subtitle into lines that fit, each shown in turn: at the pause nearest the
 * middle (a space, or after ？！…), otherwise at the width. Short-drama subtitles stay on one line.
 */
export function splitSubtitle(text: string, max: number): string[] {
  if (ems(text) <= max) return [text];
  const chars = [...text];
  const half = ems(text) / 2;
  let best = -1;
  let bestOff = Infinity;
  let width = 0;
  chars.forEach((ch, i) => {
    width += ems(ch);
    const pause = /[ \u3000？！?!…]/u.test(ch);
    if (pause && i > 0 && i < chars.length - 1 && Math.abs(width - half) < bestOff) {
      best = i;
      bestOff = Math.abs(width - half);
    }
  });
  if (best < 0) {
    let w = 0;
    best = Math.max(0, chars.findIndex((ch) => (w += ems(ch)) > max) - 1);
  }
  const keep = /[ \u3000]/u.test(chars[best]) ? best : best + 1;
  const head = chars.slice(0, keep).join('').trim();
  const tail = chars.slice(best + 1).join('').replace(/^[\s\u3000]+/u, '');
  return [...splitSubtitle(head, max), ...splitSubtitle(tail, max)].filter(Boolean);
}

/** Where subtitles sit: font size, widest line in em, and the strip's top edge. Vertical video keeps clear of the app's captions. */
export function subtitleLayout(W: number, H: number): { size: number; maxEm: number; stripH: number; top: number } {
  const size = Math.max(16, Math.round(Math.min(W, H) * 0.055));
  const stripH = Math.round(size * 1.7);
  const portrait = H > W;
  const maxEm = Math.min(portrait ? 16 : 20, Math.floor((W * 0.88) / size));
  const top = Math.round(H - H * (portrait ? 0.2 : 0.06) - stripH);
  return { size, maxEm, stripH, top };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One subtitle drawn on a transparent strip the width of the video: white, with a dark outline that reads on any shot. */
export async function subtitleStrip(text: string, W: number, size: number, stripH: number): Promise<Buffer> {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${stripH}"><text x="${W / 2}" y="${Math.round(stripH * 0.7)}" text-anchor="middle" ` +
    `font-size="${size}" font-weight="600" font-family="PingFang SC, Hiragino Sans GB, Microsoft YaHei, Noto Sans CJK SC, Source Han Sans SC, WenQuanYi Micro Hei, sans-serif" ` +
    `fill="#ffffff" stroke="#000000" stroke-opacity="0.8" stroke-width="${Math.max(2, Math.round(size * 0.14))}" stroke-linejoin="round" paint-order="stroke">${xml(text)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A subtitle comes up just before the voice and stays a moment after it. */
const LEAD = 0.1;
const LINGER = 0.3;

/**
 * When each line of a clip is said, in seconds into the clip. Lines given from / to keep them. Otherwise
 * they follow where the clip's sound stands out (`spans`): several lines over at least as many separate
 * sounds split at the longest silences between them, one speaker's turn per group; else the lines share
 * the stretch from the first sound to the last by length.
 */
export function lineTimes(lines: Line[], spans: { start: number; end: number }[], range: { start: number; end: number }): { text: string; from: number; to: number }[] {
  const inside = (v: number) => Math.max(range.start, Math.min(range.end, v));
  if (lines.every((l) => l.from !== undefined && l.to !== undefined)) {
    return lines.map((l) => ({ text: l.text, from: inside(l.from!), to: Math.max(inside(l.from!), inside(l.to!)) }));
  }
  const heard = spans.map((s) => ({ start: inside(s.start), end: inside(s.end) })).filter((s) => s.end > s.start);
  const padded = (start: number, end: number) => ({ from: inside(start - LEAD), to: inside(end + LINGER) });
  const untimed = lines.every((l) => l.from === undefined && l.to === undefined);
  if (untimed && lines.length > 1 && heard.length >= lines.length) {
    const cuts = heard
      .slice(1)
      .map((s, i) => ({ at: i + 1, gap: s.start - heard[i].end }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, lines.length - 1)
      .map((c) => c.at)
      .sort((a, b) => a - b);
    const firsts = [0, ...cuts];
    return lines.map((l, k) => ({ text: l.text, ...padded(heard[firsts[k]].start, heard[(firsts[k + 1] ?? heard.length) - 1].end) }));
  }
  const window = padded(lines[0].from ?? heard[0]?.start ?? range.start, lines.at(-1)!.to ?? heard.at(-1)?.end ?? range.end);
  if (lines[0].from !== undefined) window.from = inside(lines[0].from);
  if (lines.at(-1)!.to !== undefined) window.to = Math.max(window.from, inside(lines.at(-1)!.to!));
  if (!heard.length && lines[0].from === undefined) window.from = range.start;
  if (!heard.length && lines.at(-1)!.to === undefined) window.to = range.end;
  const total = lines.reduce((n, l) => n + Math.max(1, ems(l.text)), 0);
  let at = window.from;
  return lines.map((l) => {
    const len = ((window.to - window.from) * Math.max(1, ems(l.text))) / total;
    const out = { text: l.text, from: at, to: at + len };
    at += len;
    return out;
  });
}

/** The subtitles of the cut: each line over its time, split to fit the width, each part timed by its length. */
export function placeCues(clips: { offset: number; start: number; end: number; lines: { text: string; from: number; to: number }[] }[], maxEm: number): Cue[] {
  const cues: Cue[] = [];
  for (const c of clips) {
    for (const line of c.lines) {
      const text = subtitleText(line.text);
      if (!text) continue;
      let { from, to } = line;
      // A line flashed for less than 0.8 s can't be read: widen it inside the clip.
      if (to - from < 0.8) {
        const grow = (0.8 - (to - from)) / 2;
        from = Math.max(c.start, from - grow);
        to = Math.min(c.end, to + grow);
      }
      const parts = splitSubtitle(text, maxEm);
      const total = parts.reduce((n, p) => n + ems(p), 0);
      let at = from;
      for (const p of parts) {
        const len = ((to - from) * ems(p)) / total;
        const round = (v: number) => Math.round((c.offset + v - c.start) * 100) / 100;
        cues.push({ text: p, start: round(at), end: round(at + len) });
        at += len;
      }
    }
  }
  // Neighbours never overlap: one subtitle at a time.
  for (let i = 1; i < cues.length; i++) if (cues[i].start < cues[i - 1].end) cues[i - 1].end = cues[i].start;
  return cues.filter((c) => c.end > c.start);
}

/**
 * Joins clips in order into one H.264/AAC MP4, trimming each, at the first clip's size and frame rate.
 * Clips without sound get silence, so the audio stays in step. Each cut gets a short audio fade. With
 * `level`, the clips with lines are measured where the lines are said and brought to one loudness; with
 * `subtitles`, the lines are burnt in under the picture.
 */
export async function concatClips(clips: Clip[], out: string, signal?: AbortSignal, options: CutOptions = {}): Promise<Cut> {
  const infos = await Promise.all(clips.map((c) => probe(c.path)));
  const W = infos[0].width - (infos[0].width % 2);
  const H = infos[0].height - (infos[0].height % 2);
  const fps = Math.round(infos[0].fps * 1000) / 1000;
  const ranges = clips.map((c, i) => {
    const info = infos[i];
    const start = Math.max(0, Math.min(c.start ?? 0, info.duration));
    const end = Math.min(info.duration, c.end ?? info.duration);
    if (end - start < 0.1) throw new Error(t('第 {n} 段裁剪后没有内容（{start}–{end} 秒，片长 {duration} 秒）', { n: i + 1, start, end, duration: info.duration.toFixed(2) }));
    return { start, end };
  });
  // When each clip's lines are said: given, or where its sound stands out inside the trim. Whether a clip
  // has dialogue comes from its lines, not its sound: rain and footsteps are as loud as speech.
  const said = await Promise.all(
    clips.map(async (c, i) => {
      const lines = (c.lines ?? []).filter((l) => l.text.trim());
      if (!lines.length) return [];
      const { start, end } = ranges[i];
      const spans = infos[i].hasAudio ? (await soundSpans(c.path, infos[i].duration)).filter((s) => Math.min(s.end, end) - Math.max(s.start, start) >= 0.3) : [];
      return lineTimes(lines, spans, ranges[i]);
    }),
  );
  const gains = options.level
    ? levelGains(
        await Promise.all(
          clips.map((c, i) => (said[i].length && infos[i].hasAudio ? loudness(c.path, said[i][0].from, said[i].at(-1)!.to, signal) : null)),
        ),
      )
    : [];
  const layout = subtitleLayout(W, H);
  let offset = 0;
  const cues = placeCues(
    ranges.map((r, i) => {
      const at = { offset, ...r, lines: options.subtitles ? said[i] : [] };
      offset += r.end - r.start;
      return at;
    }),
    layout.maxEm,
  );
  const total = offset;

  const dir = cues.length ? await mkdtemp(join(tmpdir(), 'kynflow-subs-')) : '';
  try {
    const args = ['-v', 'error', '-y'];
    const graph: string[] = [];
    const pairs: string[] = [];
    let input = 0;
    clips.forEach((c, i) => {
      const info = infos[i];
      const { start, end } = ranges[i];
      const v = input++;
      args.push('-i', c.path);
      graph.push(
        `[${v}:v]trim=start=${start}:end=${end},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
          `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
      );
      if (info.hasAudio) {
        const gain = gains[i] ? `,volume=${gains[i]}dB` : '';
        const fades = `,afade=t=in:d=${CUT_FADE},afade=t=out:st=${Math.max(0, end - start - CUT_FADE).toFixed(3)}:d=${CUT_FADE}`;
        graph.push(`[${v}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${gain}${fades}[a${i}]`);
      } else {
        const a = input++;
        args.push('-f', 'lavfi', '-t', String(end - start), '-i', 'anullsrc=r=48000:cl=stereo');
        graph.push(`[${a}:a]asetpts=PTS-STARTPTS[a${i}]`);
      }
      pairs.push(`[v${i}][a${i}]`);
    });
    graph.push(`${pairs.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`);
    let video = '[v]';
    for (const [k, cue] of cues.entries()) {
      const png = join(dir, `cue${k}.png`);
      await writeFile(png, await subtitleStrip(cue.text, W, layout.size, layout.stripH));
      const s = input++;
      args.push('-i', png);
      graph.push(`${video}[${s}:v]overlay=x=0:y=${layout.top}:enable='between(t,${cue.start},${cue.end})'[s${k}]`);
      video = `[s${k}]`;
    }
    if (cues.length) {
      graph.push(`${video}format=yuv420p[vo]`);
      video = '[vo]';
    }
    let audio = '[a]';
    if (gains.length) {
      graph.push(`[a]alimiter=limit=${PEAK_LIMIT}:level=false[ao]`);
      audio = '[ao]';
    }
    args.push('-filter_complex', graph.join(';'), '-map', video, '-map', audio);
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out);
    await exec('ffmpeg', args, signal);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  return { width: W, height: H, duration: total, fps, hasAudio: true, cues, gains };
}

/**
 * Part of an image enlarged back to the image's own size: the framing of a closer shot cut out of a wide
 * scene plate. x, y (top-left) and w are fractions of the width and height; the height is the same fraction
 * as the width, so the frame keeps the plate's shape. w is at least 0.3: closer than that is mush.
 */
export async function cropFrame(image: Buffer | string, frame: { x: number; y: number; w: number }): Promise<{ png: Buffer; width: number; height: number; box: Mark }> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(t('读不出这张图的尺寸'));
  const w = Math.min(1, Math.max(0.3, Number(frame.w) || 1));
  const x = Math.min(1 - w, Math.max(0, Number(frame.x) || 0));
  const y = Math.min(1 - w, Math.max(0, Number(frame.y) || 0));
  const left = Math.round(x * width);
  const top = Math.round(y * height);
  const region = { left, top, width: Math.min(width - left, Math.round(w * width)), height: Math.min(height - top, Math.round(w * height)) };
  const png = await sharp(image).extract(region).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { png, width, height, box: { x: round(x), y: round(y), w: round(w), h: round(w) } };
}

/** Colours of layout boxes, in order: names as prompts call them, and the hex drawn. */
export const MARK_COLORS = [
  { name: '红', en: 'red', hex: '#ff2d2d' },
  { name: '蓝', en: 'blue', hex: '#1f7bff' },
  { name: '绿', en: 'green', hex: '#21c45a' },
  { name: '黄', en: 'yellow', hex: '#ffd21f' },
  { name: '紫', en: 'purple', hex: '#b146ff' },
  { name: '橙', en: 'orange', hex: '#ff8a00' },
] as const;

/** A box over an image, as fractions of its width and height (x, y: the top-left corner). */
export interface Mark {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Layout boxes drawn over a scene: a translucent fill and an outline in each box's colour (MARK_COLORS in
 * order), the bottom edge drawn thicker, since that is where the feet stand. An image model places people
 * where boxes are far more reliably than where words say ("on this side of the wall") they should be.
 */
export async function markBoxes(image: Buffer | string, marks: Mark[]): Promise<{ png: Buffer; width: number; height: number }> {
  const meta = await sharp(image).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(t('读不出这张图的尺寸'));
  const stroke = Math.max(3, Math.round(Math.min(width, height) / 160));
  const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
  const shapes = marks.slice(0, MARK_COLORS.length).map((m, i) => {
    const x = Math.round(clamp(m.x) * width);
    const y = Math.round(clamp(m.y) * height);
    const w = Math.max(stroke * 2, Math.round(Math.min(clamp(m.w), 1 - clamp(m.x)) * width));
    const h = Math.max(stroke * 2, Math.round(Math.min(clamp(m.h), 1 - clamp(m.y)) * height));
    const { hex } = MARK_COLORS[i];
    return (
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${hex}" fill-opacity="0.28" stroke="${hex}" stroke-width="${stroke}"/>` +
      `<line x1="${x}" y1="${y + h}" x2="${x + w}" y2="${y + h}" stroke="${hex}" stroke-width="${stroke * 3}"/>`
    );
  });
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join('')}</svg>`);
  const png = await sharp(image).composite([{ input: svg }]).png().toBuffer();
  return { png, width, height };
}
