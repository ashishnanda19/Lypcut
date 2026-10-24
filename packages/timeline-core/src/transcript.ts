import type { Timeline, TimelineItem, TimelineOp, Word } from "./types.js";
import {
  captionItems,
  cutFlags,
  itemEnd,
  splitByCoverage,
  trackByKind,
  videoItems,
} from "./queries.js";

/**
 * Turns transcript actions into TimelineOps. The transcript never edits video itself:
 * deleting words just builds a `cutSource` op, and everything else follows from the timeline.
 */

/** Source range that "deleting words i0..i1" removes. Includes the pause after the last word. */
export function wordRange(
  words: Word[],
  i0: number,
  i1: number,
): [number, number] {
  const a = words[i0]!.start;
  const next = words[i1 + 1];
  return [a, next ? next.start : words[i1]!.end];
}

export function cutWords(words: Word[], i0: number, i1: number): TimelineOp {
  const [srcFrom, srcTo] = wordRange(words, i0, i1);
  return { type: "cutSource", srcFrom, srcTo };
}

export function restoreWords(
  tl: Timeline,
  words: Word[],
  i0: number,
  i1: number,
): TimelineOp {
  const [srcFrom, srcTo] = wordRange(words, i0, i1);
  const hasCaptions = captionItems(tl).length > 0;
  return {
    type: "restoreSource",
    srcFrom,
    srcTo,
    ...(hasCaptions
      ? { captions: buildCaptionPhrases(words, srcFrom, srcTo) }
      : {}),
  };
}

/** Runs of consecutive word indices that satisfy `pick`. */
function runs(
  length: number,
  pick: (i: number) => boolean,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i <= length; i++) {
    const on = i < length && pick(i);
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/** Filler words that are still in the edit. */
export function fillerIndices(tl: Timeline, words: Word[]): number[] {
  const flags = cutFlags(tl, words);
  const out: number[] = [];
  for (let i = 0; i < words.length; i++)
    if (words[i]!.filler && !flags[i]) out.push(i);
  return out;
}

export function removeFillersOp(
  tl: Timeline,
  words: Word[],
): { op: TimelineOp; count: number; seconds: number } | null {
  const idx = new Set(fillerIndices(tl, words));
  if (!idx.size) return null;
  const groups = runs(words.length, (i) => idx.has(i));
  const ops = groups.map(([a, b]) => cutWords(words, a, b));
  let seconds = 0;
  for (const [a, b] of groups) {
    const [from, to] = wordRange(words, a, b);
    seconds += to - from;
  }
  return {
    op: { type: "batch", ops, label: "Remove filler words" },
    count: idx.size,
    seconds,
  };
}

/** Pauses longer than `minGap` between two kept words. Shortened to `keep` seconds, not removed. */
export function pauseRanges(
  tl: Timeline,
  words: Word[],
  minGap = 0.7,
  keep = 0.3,
): Array<[number, number]> {
  const flags = cutFlags(tl, words);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (flags[i] || flags[i + 1]) continue;
    const a = words[i]!.end;
    const b = words[i + 1]!.start;
    if (b - a <= minGap) continue;
    // Measure what is still in the edit, so a pause that was already shortened is not found again.
    const remaining = splitByCoverage(tl, a, b).covered.reduce(
      (sum, [x, y]) => sum + (y - x),
      0,
    );
    if (remaining > minGap) out.push([a + keep, b - 0.05]);
  }
  return out;
}

export function trimPausesOp(
  tl: Timeline,
  words: Word[],
): { op: TimelineOp; count: number; seconds: number } | null {
  const ranges = pauseRanges(tl, words);
  if (!ranges.length) return null;
  return {
    op: {
      type: "batch",
      label: "Trim long pauses",
      ops: ranges.map(([srcFrom, srcTo]) => ({
        type: "cutSource",
        srcFrom,
        srcTo,
      })),
    },
    count: ranges.length,
    seconds: ranges.reduce((s, [a, b]) => s + (b - a), 0),
  };
}

/** Keep only [srcFrom, srcTo] of the source: cut everything before and after. */
export function keepRangeOp(
  srcFrom: number,
  srcTo: number,
  sourceDuration: number,
): TimelineOp {
  const ops: TimelineOp[] = [];
  if (srcFrom > 0.05)
    ops.push({ type: "cutSource", srcFrom: 0, srcTo: srcFrom });
  if (srcTo < sourceDuration - 0.05)
    ops.push({ type: "cutSource", srcFrom: srcTo, srcTo: sourceDuration });
  return { type: "batch", ops, label: "Keep selected range" };
}

/* ------------------------------------------------------------------ */
/* Captions                                                             */
/* ------------------------------------------------------------------ */

let captionCounter = 0;
/** Caption ids only need to be unique inside one timeline; the op that adds them carries them from then on. */
const captionId = () =>
  `cap_${(++captionCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const PHRASE_MAX_WORDS = 4;
const PHRASE_MAX_SECONDS = 2.4;
const BREAK = /[.,?!।;:]$/;

/**
 * Groups words into short caption phrases. Returned items carry `srcIn` (source time) and are
 * placed on the timeline by the caller (start is the source time here until it is mapped).
 */
export function buildCaptionPhrases(
  words: Word[],
  srcFrom = 0,
  srcTo = Infinity,
): TimelineItem[] {
  const out: TimelineItem[] = [];
  let i = 0;
  while (i < words.length) {
    const first = words[i]!;
    if (first.start < srcFrom - 0.01 || first.start >= srcTo) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < words.length) {
      const w = words[j]!;
      const n = words[j + 1]!;
      if (BREAK.test(w.text)) break;
      if (j + 1 - i >= PHRASE_MAX_WORDS) break;
      if (n.end - first.start > PHRASE_MAX_SECONDS) break;
      if (n.start >= srcTo) break;
      if (n.start - w.end > 0.5) break;
      j++;
    }
    const last = words[j]!;
    const slice = words.slice(i, j + 1);
    out.push({
      id: captionId(),
      trackId: "",
      kind: "caption",
      label: slice.map((w) => w.text).join(" "),
      start: first.start,
      duration: Math.max(0.3, last.end - first.start),
      srcIn: first.start,
      meta: {
        text: slice.map((w) => w.text).join(" "),
        dev: slice.map((w) => w.dev).join(" "),
        wordFrom: i,
        wordTo: j + 1,
        ai: true,
      },
    });
    i = j + 1;
  }
  return out;
}

/** Captions placed against the current edit: each phrase lands where its words are on the timeline. */
export function captionsForTimeline(
  tl: Timeline,
  words: Word[],
): TimelineItem[] {
  const track = trackByKind(tl, "captions");
  if (!track) return [];
  const out: TimelineItem[] = [];
  for (const v of videoItems(tl)) {
    const lo = v.srcIn;
    const hi = v.srcIn + v.duration;
    for (const phrase of buildCaptionPhrases(words, lo, hi)) {
      const dur = Math.min(phrase.duration, hi - phrase.srcIn);
      if (dur < 0.2) continue;
      out.push({
        ...phrase,
        trackId: track.id,
        start: v.start + (phrase.srcIn - v.srcIn),
        duration: dur,
      });
    }
  }
  // Pieces of one scene can touch; keep captions from overlapping across piece boundaries.
  out.sort((a, b) => a.start - b.start);
  for (let k = 1; k < out.length; k++) {
    const prev = out[k - 1]!;
    const cur = out[k]!;
    if (itemEnd(prev) > cur.start)
      out[k - 1] = { ...prev, duration: Math.max(0.2, cur.start - prev.start) };
  }
  return out;
}
