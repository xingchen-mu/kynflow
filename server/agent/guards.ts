// The short-drama guide's advice as gates: pure checks the tools run before work starts.
// Messages are put together in tools.ts (through t) so these stay easy to test.

export type StabilityRisk = 'hands' | 'motion';

export interface StabilityIssue {
  risk: StabilityRisk;
  /** The words in the prompt that made it risky. */
  detail: string;
  /** The camera work found, e.g. "pushes in、pans". */
  camera: string;
}

/** Fine hand work: the guide's 递东西、系扣子、倒水、擦拭、开瓶, and close-ups of hands. */
const HAND_DETAIL: RegExp[] = [
  /\b(?:his|her|their|the) (?:hands?|fingers?|fingertips?|thumb)\b[^.]{0,60}?\b(?:buttons?|buttoning|unbuttons?|ties|tying|untie[sd]?|laces?|lacing|threads?|threading|needle|pours?|pouring|unscrews?|uncorks?|wipes?|wiping|polish(?:es|ing)?|peels?|peeling|knots?|chopsticks?|lighter|keyboard|latches?|buckles?|zippers?|zip|tweezers?|coins?|cards?|dials?|switches?|lids?|caps?|cigarette|opens? (?:the |a )?(?:bottle|jar|envelope|letter|lock))\b/i,
  /\b(?:close[- ]?up|detail) (?:on|of) (?:his|her|their|the) (?:hands?|fingers?|fingertips?)\b/i,
  /\b(?:fine|precise|delicate|dexterous|intricate|careful) (?:hand|finger|handwork|fingerwork|movements?|work)\b/i,
  /\b(?:buttons?|unbuttons?|buttoning|ties|tying|untie[sd]?|lacing|laces|threads?|threading|pours?|pouring|unscrews?|uncorks?|wipes?|wiping|polish(?:es|ing)?|peels?|peeling|lights? (?:a|the) (?:cigarette|candle)|strikes? a match|inserts? (?:the |a )?(?:key|card|needle)|turns? (?:the |a )?(?:key|dial|knob)|opens? (?:the |a )?(?:bottle|jar|envelope|letter|lock)|writes?|types? (?:on|into)|chopsticks?|tweezers?)\b/i,
  /\bhands? (?:him|her|them) (?:the|a|an)\b/i,
  /\b(?:he|she|they) (?:fumbles?|fiddles?|manipulates?)\b[^.]{0,30}\b(?:with|at)\b/i,
];

/** Large movement: the guide's 快速转身、蹲下站起、穿脱衣服、两人换位, and other full-body action. */
const BIG_MOTION: RegExp[] = [
  /\b(?:he|she|they) (?:jumps?|leaps?|lunges?|dodges?|dives?|sprints?|runs?|bolts?|charges?|climbs?|crawls?|falls?|collapses?|staggers?|stumbles?|wrestles?|kicks?|throws?|hurls?|slams?|shoves?|drags?)\b/i,
  /\b(?:turns?|spins?|whirls?|swivels?|snaps?|whips?|swings?) (?:around|round|sharply|quickly|fast)\b/i,
  /\b(?:stands?|gets?|sits?|rises?) (?:up|down) (?:quickly|fast|abruptly|suddenly)\b/i,
  /\b(?:takes?|tears?|rips?|yanks?|pulls?) off (?:his|her|their) (?:coat|jacket|shirt|sweater|hoodie|dress|uniform)\b/i,
  /\b(?:changes?|swaps?) (?:places?|positions?)\b/i,
  /\b(?:large|big|huge|broad|wide) (?:movement|motion|gesture|amplitude)\b/i,
  /\b(?:crosses?|runs? across|hurries? across|storms? across) the room\b/i,
  /\b(?:ducks?|crouches?|squats?|kneels?)\b/i,
  /\b(?:rapid|fast|violent|sudden) (?:movement|motion|action|turn|spin)\b/i,
  /\b(?:grabs?|shoves?|pushes?|pulls?) (?:him|her|them)\b/i,
];

const CAMERA_MOVE =
  /\b(?:push(?:es|ing)? in|pull(?:s|ing)? out|zoom(?:s|ing)?|pan(?:s|ning)?|tilt(?:s|ing)?|track(?:s|ing)?|truck(?:s|ing)?|dolly(?:s|ing)?|arc(?:s|ing)?|orbit(?:s|ing)?|circl(?:e|es|ing) around|crane(?:s|ing)?|boom(?:s|ing)?|pedestal(?:s|ing)?|shake(?:s|ing)?|handheld|hand-held)\b/gi;
/** A move that is complex on its own, even when it is the only one. */
const COMPLEX_MOVE = /\b(?:arc(?:s|ing)?|orbit(?:s|ing)?|circl(?:e|es|ing) around|crane(?:s|ing)?|whip pan|handheld|hand-held)\b/i;
const FAST_CAMERA = /\b(?:whip|fast|quick|rapid|sweeping) (?:pan|push|pull|zoom|tilt|track|truck|dolly|arc|orbit|camera|move)\b/i;

function firstMatch(prompt: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    const m = re.exec(prompt);
    if (m) return m[0].replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  return undefined;
}

/** The camera moves named in a prompt, without repeats. */
export function cameraMoves(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(CAMERA_MOVE)].map((m) => m[0].toLowerCase()))];
}

/**
 * What makes this shot risky enough to stop before submitting: fine hand work or a large movement
 * together with complex camera work (two moves, an arc/orbit/handheld, or a fast one). Empty when it
 * can be generated as written.
 */
export function stabilityIssues(prompt: string): StabilityIssue[] {
  const moves = cameraMoves(prompt);
  const complex = COMPLEX_MOVE.test(prompt) || FAST_CAMERA.test(prompt) || moves.length >= 2;
  if (!complex) return [];
  const camera = moves.length ? moves.join('、') : (firstMatch(prompt, [COMPLEX_MOVE, FAST_CAMERA]) ?? '');
  const issues: StabilityIssue[] = [];
  const hand = firstMatch(prompt, HAND_DETAIL);
  if (hand) issues.push({ risk: 'hands', detail: hand, camera });
  const motion = firstMatch(prompt, BIG_MOTION);
  if (motion) issues.push({ risk: 'motion', detail: motion, camera });
  return issues;
}

/** A clip as assemble_video sees it: its trim, its sound, and whether lines were written. */
export interface EditClipCheck {
  name: string;
  duration: number;
  start: number;
  end: number;
  hasAudio: boolean;
  /** The clip's own obvious sound, in seconds into the clip. */
  spans: { start: number; end: number }[];
  /** Number of lines written for the clip. */
  lines: number;
}

export type EditIssue =
  | { kind: 'missing-lines'; name: string; span: { start: number; end: number } }
  | { kind: 'cut-sound'; name: string; span: { start: number; end: number }; lost: number; keep: { from: number; to: number } };

/** Sound this long at the cut, or lost by it, is not ambience: it is something the viewer hears. */
export const SOUND_KEEP = 0.3;

/** Blocks an edit that would lose obvious sound: a clip with sound but no lines, or a trim that cuts it. */
export function editIssues(clips: EditClipCheck[]): EditIssue[] {
  const issues: EditIssue[] = [];
  for (const c of clips) {
    const from = Math.max(0, Math.min(c.start, c.duration));
    const to = Math.min(c.duration, Math.max(c.end, from));
    if (c.hasAudio && !c.lines) {
      const heard = c.spans
        .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
        .filter((s) => s.end - s.start >= SOUND_KEEP - 1e-9);
      if (heard.length) issues.push({ kind: 'missing-lines', name: c.name, span: heard[0] });
    }
    for (const s of c.spans) {
      const lost = Math.max(0, Math.min(s.end, from) - s.start) + Math.max(0, s.end - Math.max(s.start, to));
      if (lost >= SOUND_KEEP - 1e-9) {
        issues.push({ kind: 'cut-sound', name: c.name, span: s, lost: Math.round(lost * 100) / 100, keep: { from, to } });
      }
    }
  }
  return issues;
}
