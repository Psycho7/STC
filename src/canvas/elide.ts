// Head-first label elision for the recipe-card name surfaces (row labels,
// card title, products subtitle). The helper OWNS the visible string: a
// name that fits is returned unchanged, a name that does not keeps the
// longest head prefix that fits beside the ellipsis and drops everything
// after it. No tail, bracket group or window is ever preserved -- the
// reader names a card by its head, and a preserved tail spent the head
// budget on the part that reads last.
//
// The helper is pure and layout-free: string in, string out, with width
// supplied by an injectable estimator so unit tests can use a monospace
// stub. The production estimator (textWidth.ts) is an upper bound, so the
// helper elides slightly early rather than ever overflowing -- overflowing
// is what recreates the defect.

// Injectable width oracle: px for a string, in the caller's font.
export type WidthFn = (text: string) => number;

const ELLIPSIS = "\u2026";

// Budgets are quantised DOWN to this bucket before memoising, so a cached
// entry is never reused for a wider bucket than it was computed for. The
// quantum is 1px, not a coarser step: the measured corpus cases sit within
// 2px of their budgets, and a coarser bucket would forfeit budget the real
// label box still has.
const BUCKET_PX = 1;

// Cache guard rail: the corpus is a few hundred names times a handful of
// budgets and fonts, well under this; a pathological caller just clears
// and refills rather than growing without bound.
const CACHE_MAX_ENTRIES = 4096;
const cache = new Map<string, string>();

// Dropped whenever the resolved font metrics change (measureText.ts): every
// entry was computed against the faces in effect when it was cached, and a
// face arriving late makes all of them answers to a different question.
export function clearElisionCache(): void {
  cache.clear();
}

function bucketDown(px: number): number {
  return Math.floor(px / BUCKET_PX) * BUCKET_PX;
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
    const headBudget = bucket - estimate(ELLIPSIS);
    const points = [...name];
    // Running per-code-point widths, summed left to right so each prefix
    // total is the same float the scan it replaces accumulated. Widths are
    // never negative, so the totals only grow and the longest prefix that
    // fits is found by binary search: keep = the largest k with
    // prefix[k] <= headBudget.
    const prefix = [0];
    for (const p of points) {
      prefix.push(prefix[prefix.length - 1]! + estimate(p));
    }
    let keep = 0;
    let hi = points.length;
    while (keep < hi) {
      const mid = (keep + hi + 1) >> 1;
      if (prefix[mid]! > headBudget) hi = mid - 1;
      else keep = mid;
    }
    // A cut that lands after a space would spend budget on a gap the
    // reader cannot see, so the head gives it back.
    const head = points.slice(0, keep).join("").replace(/\s+$/, "");
    // Nothing fits beside the ellipsis: hand the raw string back and let
    // the CSS clip show whatever the box allows, which beats a lone mark.
    if (head.length > 0) out = head + ELLIPSIS;
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(key, out);
  return out;
}
