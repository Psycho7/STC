// Tail-preserving label elision for the recipe-card name surfaces (row
// labels, card title, products subtitle). Distinct item names must stay
// distinct after truncation: "Cuprium Bottle(Jincao Solution)" and
// "Cuprium Bottle(Yazhen Solution)" may never both render as
// "Cuprium Bott...". The helper OWNS the visible string: it keeps a
// distinguishing tail whole, head-truncates the base, and puts the
// ellipsis in front of the preserved tail. When there is no tail, or the
// tail plus a minimum readable head cannot fit, it returns the raw string
// and CSS tail ellipsis stays the fallback.
//
// The helper is pure and layout-free: string in, string out, with width
// supplied by an injectable estimator so unit tests can use a monospace
// stub. The production estimator (textWidth.ts) is an upper bound, so the
// helper elides slightly early rather than ever overflowing -- overflowing
// is what recreates the defect.

import { isWideCodePoint } from "./textWidth";

// Injectable width oracle: px for a string, in the caller's font.
export type WidthFn = (text: string) => number;

const ELLIPSIS = "\u2026";

// Minimum readable head, in code points. Below this the elision would
// leave an unreadable stub, so the raw string goes back to CSS ellipsis.
export const MIN_HEAD_LATIN = 4;
export const MIN_HEAD_CJK = 2;

// Budgets are quantised DOWN to this bucket before memoising, so a cached
// entry is never reused for a wider bucket than it was computed for.
const BUCKET_PX = 8;

// Cache guard rail: the corpus is a few hundred names times a handful of
// budgets and fonts, well under this; a pathological caller just clears
// and refills rather than growing without bound.
const CACHE_MAX_ENTRIES = 4096;
const cache = new Map<string, string>();

function bucketDown(px: number): number {
  return Math.floor(px / BUCKET_PX) * BUCKET_PX;
}

function codePoints(text: string): string[] {
  return [...text];
}

// A base counts as CJK when every code point is a wide one; a Latin or
// Cyrillic base with embedded CJK still reads by its Latin part, so the
// four-code-point minimum applies there.
function minHeadFor(base: string): number {
  const pts = codePoints(base);
  return pts.length > 0 && pts.every((p) => isWideCodePoint(p.codePointAt(0)!))
    ? MIN_HEAD_CJK
    : MIN_HEAD_LATIN;
}

// The distinguishing tail of a name, if it has one, split into base and
// tail. Detection order (final for this feature):
//  1. a trailing balanced ASCII "(...)" or "[...]" group (the solution
//     bottles and the canned-food families); a single space immediately
//     before the group rides with it,
//  2. else the last whitespace-separated word ("Stabilized Carbon" keeps
//     "Carbon"), or, when there is no whitespace at all, a trailing run
//     of Roman-numeral or Latin-letter code points (the ja canned family
//     ends in a Roman-numeral code point with no bracket),
//  3. else nothing: the name has no tail a truncation could preserve.
// The tail must leave a non-empty base behind, or there is no elision.
export function splitTail(name: string): { base: string; tail: string } | null {
  const close = name.codePointAt(name.length - 1);
  if (close === 0x29 /* ) */ || close === 0x5d /* ] */) {
    const open = close === 0x29 ? 0x28 /* ( */ : 0x5b; /* [ */
    let depth = 0;
    let openIdx = -1;
    for (let i = name.length - 1; i >= 0; i--) {
      const cp = name.charCodeAt(i);
      if (cp === close) depth++;
      else if (cp === open) {
        depth--;
        if (depth === 0) {
          openIdx = i;
          break;
        }
      }
    }
    if (openIdx > 0) {
      // A single space before the group is part of how the family writes
      // its tail ("Canned Citrome [C]"), so it rides with the tail.
      const baseEnd =
        openIdx > 1 && name.charCodeAt(openIdx - 1) === 0x20
          ? openIdx - 1
          : openIdx;
      if (baseEnd > 0) {
        return { base: name.slice(0, baseEnd), tail: name.slice(baseEnd) };
      }
      return null;
    }
    return null;
  }
  // Trailing single token.
  const lastSpace = name.lastIndexOf(" ");
  if (lastSpace > 0) {
    return { base: name.slice(0, lastSpace), tail: name.slice(lastSpace + 1) };
  }
  if (lastSpace === 0 || /\s/.test(name)) return null;
  // No whitespace: a trailing run of Roman-numeral or Latin-letter code
  // points is the tail (ja canned family, single-letter item marks).
  const run = /[A-Za-z\u2160-\u2183]+$/.exec(name);
  if (run !== null && run.index > 0) {
    return { base: name.slice(0, run.index), tail: run[0] };
  }
  return null;
}

// Elide `name` to fit `budgetPx`, measured by the injected `estimate`.
// `fontKey` names the estimator (font + metrics) for memoisation: pass a
// distinct key per font context, because the cache trusts it to tell
// estimators apart.
export function elideName(
  name: string,
  budgetPx: number,
  estimate: WidthFn,
  fontKey = "",
): string {
  const bucket = bucketDown(budgetPx);
  if (bucket <= 0) return name;
  const key = `${fontKey}\u0000${bucket}\u0000${name}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  let out = name;
  if (estimate(name) > bucket) {
    const split = splitTail(name);
    if (split !== null) {
      const ellW = estimate(ELLIPSIS);
      const tailW = estimate(split.tail);
      const minHead = minHeadFor(split.base);
      const trimmedBase = split.base.replace(/\s+$/, "");
      const minPts = codePoints(trimmedBase);
      if (minPts.length >= minHead) {
        const minHeadW = estimate(minPts.slice(0, minHead).join(""));
        if (tailW + ellW + minHeadW <= bucket) {
          const headBudget = bucket - tailW - ellW;
          // Greedy longest base prefix that fits, then drop any trailing
          // whitespace the cut left behind (it only wastes budget).
          const keep: string[] = [];
          let used = 0;
          for (const p of codePoints(split.base)) {
            const w = estimate(p);
            if (used + w > headBudget) break;
            used += w;
            keep.push(p);
          }
          const head = keep.join("").replace(/\s+$/, "");
          if (codePoints(head).length >= minHead) {
            out = head + ELLIPSIS + split.tail;
          }
        }
      }
    }
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, out);
  return out;
}
