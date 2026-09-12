// Tail-preserving label elision for the recipe-card name surfaces (row
// labels, card title, products subtitle). Distinct item names must stay
// distinct after truncation: "Cuprium Bottle(Jincao Solution)" and
// "Cuprium Bottle(Yazhen Solution)" may never both render as
// "Cuprium Bott...". The helper OWNS the visible string: it keeps a
// distinguishing tail whole, head-truncates the base, and puts the
// ellipsis in front of the preserved tail. When the whole tail plus a
// minimum readable head cannot fit, a PARTIAL tail is preserved instead
// (ruling R5): a window into the tail, sized to the budget, with the same
// minimum-grapheme floors as the head. The window opens from the tail's
// distinguishing side, measured per tail kind and script (see the tier
// (b) comment). When there is no tail, or no floor-respecting window
// fits, the raw string goes back and CSS tail ellipsis stays the
// fallback.
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
// entry is never reused for a wider bucket than it was computed for. The
// quantum is 1px, not a coarser step: the partial-tail window floors are
// decided at pixel granularity, and the measured corpus cases sit within
// 2px of their budgets -- a coarser bucket would forfeit budget the real
// label box still has. A 1px floor keeps the quantise-down guarantee with
// at most sub-pixel reuse slop.
const BUCKET_PX = 1;

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

// Which detection rule produced a tail; the partial-window tier (below)
// decides eligibility from it.
export type TailKind = "bracket" | "token" | "run" | "cjk";

function isHanCodePoint(cp: number): boolean {
  return cp >= 0x4e00 && cp <= 0x9fff;
}

function isKanaCodePoint(cp: number): boolean {
  return cp >= 0x3040 && cp <= 0x30ff; // hiragana + katakana incl. prolonged mark
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
//  3. else, when every code point of the name is a CJK ideograph or kana,
//     the LAST kana/ideograph script boundary splits base from tail (the
//     ja sandleaf family writes a kana stem plus an ideograph suffix; an
//     all-ideograph name has no boundary and no tail -- its distinguishing
//     content sits in the middle, where only the raw CSS clip reaches),
//  4. else nothing: the name has no tail a truncation could preserve.
// The tail must leave a non-empty base behind, or there is no elision.
export function splitTail(
  name: string,
): { base: string; tail: string; kind: TailKind } | null {
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
        return {
          base: name.slice(0, baseEnd),
          tail: name.slice(baseEnd),
          kind: "bracket",
        };
      }
      return null;
    }
    return null;
  }
  // Trailing single token.
  const lastSpace = name.lastIndexOf(" ");
  if (lastSpace > 0) {
    return {
      base: name.slice(0, lastSpace),
      tail: name.slice(lastSpace + 1),
      kind: "token",
    };
  }
  if (lastSpace === 0 || /\s/.test(name)) return null;
  // No whitespace: a trailing run of Roman-numeral or Latin-letter code
  // points is the tail (ja canned family, single-letter item marks).
  const run = /[A-Za-z\u2160-\u2183]+$/.exec(name);
  if (run !== null && run.index > 0) {
    return { base: name.slice(0, run.index), tail: run[0], kind: "run" };
  }
  // Pure CJK-block name: split at the last kana/ideograph boundary.
  const pts = codePoints(name);
  if (
    pts.length >= 4 &&
    pts.every((p) => {
      const cp = p.codePointAt(0)!;
      return isWideCodePoint(cp) && (isHanCodePoint(cp) || isKanaCodePoint(cp));
    })
  ) {
    for (let i = pts.length - 1; i > 0; i--) {
      const a = pts[i - 1]!.codePointAt(0)!;
      const b = pts[i]!.codePointAt(0)!;
      if (isHanCodePoint(a) !== isHanCodePoint(b)) {
        const tail = pts.slice(i).join("");
        if (codePoints(tail).length >= 2) {
          return { base: pts.slice(0, i).join(""), tail, kind: "cjk" };
        }
        return null;
      }
    }
  }
  return null;
}

// Which tails may open a partial window: bracket groups and CJK-boundary
// tails always; a bare word/run tail only when its base is a SINGLE word.
// Measured against the corpus: a multi-word base whose last word is the
// shared generic noun ("Dense Originium Powder" vs "Dense Crystal Powder")
// is distinguished by its middle, which only the raw CSS clip reaches --
// windowing the generic word would collapse such a pair onto one
// head-plus-window string. A single-word base ("Kuprievaya detal" keeps
// "detal") has the distinguishing word AS the tail, so it windows.
function canWindowTail(
  split: { tail: string; kind: TailKind },
  trimmedBase: string,
): boolean {
  if (split.kind === "bracket" || split.kind === "cjk") return true;
  return !/\s/.test(trimmedBase);
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
      const minHead = minHeadFor(split.base);
      const trimmedBase = split.base.replace(/\s+$/, "");
      const minPts = codePoints(trimmedBase);
      if (minPts.length >= minHead) {
        const headStr = minPts.slice(0, minHead).join("");
        const minHeadW = estimate(headStr);
        const tailW = estimate(split.tail);
        if (tailW + ellW + minHeadW <= bucket) {
          // Tier (a): the whole tail fits. Greedy longest base prefix,
          // then drop any trailing whitespace the cut left behind (it only
          // wastes budget).
          const headBudget = bucket - tailW - ellW;
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
        } else if (canWindowTail(split, trimmedBase)) {
          // Tier (b) (ruling R5): the whole tail cannot fit, so a PARTIAL
          // tail is preserved: the minimum head, the ellipsis, and the
          // longest window into the tail that the budget still allows.
          // The window direction is measured against the corpus families
          // (refinement round 2): Latin and CJK bracket groups put the
          // distinguishing species token at the tail's START ("(Jincao
          // ..." vs "(Yazhen ...", "(kinso ..." vs "(gashin ..."), while
          // the Cyrillic transliterations invert the word order ("(Rastvor
          // dzintsao)": species last) and Russian morphology distinguishes
          // word endings ("oridzheoda" vs "oridzhinij" differ only from
          // the sixth code point) -- so a Cyrillic tail keeps its
          // TRAILING window and every other tail its LEADING one, with
          // one measured exception directly below. The window must clear
          // the same minimum-grapheme floor as the head (four
          // Latin/Cyrillic, two CJK), else the raw string goes back.
          if (bucket - ellW - minHeadW > 0) {
            // The exception: a BARE word/run tail whose whole base
            // survives beside the ellipsis at this budget windows from
            // the tail's START whatever the script. A single-word tail
            // carries its lexeme in the stem and inflects at the end, so
            // sibling names diverge at the tail's head -- the ru module
            // titles (Modul upakovki / formovki / shtampovki) collapse
            // onto the shared "-ovki" ending under a trailing window
            // while the stems upak-/form-/shtamp- differ from their first
            // letters. When the base does NOT fit whole, the raw CSS clip
            // would eat the base onto the sibling-shared prefix and every
            // measured family of that shape puts the distinction in the
            // tail's ending (oridzheoda/oridzhinij, detal/ruda,
            // detal/komponent), so the script rule stands there.
            const stemFirst =
              (split.kind === "token" || split.kind === "run") &&
              estimate(trimmedBase + ELLIPSIS) <= bucket;
            const fromEnd = !stemFirst && /[\u0400-\u04ff]/.test(split.tail);
            const minWin = minHeadFor(split.tail);
            const tailPts = codePoints(split.tail);
            const seq = fromEnd ? [...tailPts].reverse() : tailPts;
            // Head and window GROW TOGETHER from their two floors rather
            // than the window taking every spare pixel. Handing the
            // remainder to the window alone pinned the head at its floor
            // and produced two stubs ("Cupr...Bott"), which reads as
            // neither name; the distinguishing power of the window is
            // already spent at its first few code points (the species
            // token, or the inflected ending under a trailing window), so
            // the pixels past that buy far more as head. Alternating one
            // code point at a time keeps the split even at every budget
            // and stays deterministic: the head takes the odd steps, so a
            // budget that affords exactly one more glyph spends it on the
            // side the reader names the row by.
            const basePts = codePoints(trimmedBase);
            let headLen = minHead;
            let winLen = minWin;
            if (basePts.length < headLen || seq.length < winLen) {
              winLen = -1;
            } else {
              const widthOf = (hLen: number, wLen: number): number =>
                estimate(basePts.slice(0, hLen).join("")) +
                ellW +
                estimate(seq.slice(0, wLen).join(""));
              if (widthOf(headLen, winLen) > bucket) {
                winLen = -1;
              } else {
                for (let grewHead = true, grewWin = true; grewHead || grewWin; ) {
                  grewHead =
                    headLen < basePts.length &&
                    widthOf(headLen + 1, winLen) <= bucket;
                  if (grewHead) headLen++;
                  grewWin =
                    winLen < seq.length && widthOf(headLen, winLen + 1) <= bucket;
                  if (grewWin) winLen++;
                }
              }
            }
            if (winLen >= minWin) {
              const win = seq.slice(0, winLen);
              const windowStr = (fromEnd ? [...win].reverse() : win).join("");
              const head = basePts.slice(0, headLen).join("").replace(/\s+$/, "");
              if (codePoints(head).length >= minHead) {
                out = head + ELLIPSIS + windowStr;
              }
            }
          }
        }
      }
    }
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, out);
  return out;
}
