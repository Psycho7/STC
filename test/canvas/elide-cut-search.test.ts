// The elision cut search must land on the same head as the original
// per-character scan: walk the code points, charge each one's own width,
// stop at the first that does not fit beside the ellipsis. The reference
// below is that scan, kept verbatim, and the long names are run through both
// under the production char-class estimator and a fractional-width stub whose
// float accumulation would expose any change in summation order.
import { describe, expect, it } from "vitest";
import {
  clearElisionCache,
  elideName,
  type WidthFn,
} from "../../src/canvas/elide";
import { estimateTextWidth } from "../../src/canvas/textWidth";

const ELLIPSIS = "\u2026";

function referenceElide(
  name: string,
  bucket: number,
  estimate: WidthFn,
): string {
  if (bucket <= 0) return name;
  if (!(estimate(name) > bucket)) return name;
  const headBudget = bucket - estimate(ELLIPSIS);
  const keep: string[] = [];
  let used = 0;
  for (const p of [...name]) {
    const w = estimate(p);
    if (used + w > headBudget) break;
    used += w;
    keep.push(p);
  }
  const head = keep.join("").replace(/\s+$/, "");
  return head.length > 0 ? head + ELLIPSIS : name;
}

const LONG_NAMES: readonly string[] = [
  "Cuprium Bottle(Jincao Solution)",
  "Solid-Gas Transfer Unit",
  "Dense Originium Powder Refinement Assembly Line",
  "Canned Citrome [C] With An Unreasonably Long Suffix",
  "\u041a\u0443\u043f\u0440\u0438\u0435\u0432\u0430\u044f \u0431\u0443\u0442\u044b\u043b\u043a\u0430(\u0420\u0430\u0441\u0442\u0432\u043e\u0440 \u0446\u0437\u0438\u043d\u044c\u0446\u0430\u043e)",
  "\u041c\u043e\u0434\u0443\u043b\u044c \u0443\u043f\u0430\u043a\u043e\u0432\u043a\u0438",
  "\u30b7\u30c8\u30ed\u30fc\u30e0\u306e\u7f36\u8a70\u2160 \u30b5\u30f3\u30c9\u30ea\u30fc\u30d5\u7c89\u672b",
  "\u8d64\u94dc\u74f6(\u9526\u8349\u6eb6\u6db2)\u51c0\u6c34\u8282\u70b9(\u6c61\u6c34\u63a5\u5165\u53e3)",
  "A     B     C     D     E     F     G     H",
  "\ud83d\ude00 Emoji \ud83d\ude00 surrogate \ud83d\ude00 pairs \ud83d\ude00",
  "WWWWWWWWWWMMMMMMMMMMiiiiiiiiiillllllllll",
];

// Irrational-ish per-code-point advances so the running sum carries real
// float error rather than exact binary fractions.
function fractionalStub(text: string): number {
  let w = 0;
  for (const ch of text) w += 3.1 + ((ch.codePointAt(0)! % 7) * Math.PI) / 3;
  return w;
}

const ESTIMATORS: ReadonlyArray<readonly [string, WidthFn]> = [
  ["row-12", (t) => estimateTextWidth(t, { fontSize: 12, weight: 400 })],
  ["title-17", (t) => estimateTextWidth(t, { fontSize: 17, weight: 600 })],
  ["frac", fractionalStub],
];

describe("canvas/elide cut search", () => {
  it("matches the per-character scan over long names and every budget", () => {
    let compared = 0;
    for (const [key, estimate] of ESTIMATORS) {
      for (const name of LONG_NAMES) {
        const full = Math.ceil(estimate(name)) + 2;
        for (let budget = -1; budget <= full; budget++) {
          clearElisionCache();
          expect(
            elideName(name, budget, estimate, key),
            `${key} ${name} @${budget}`,
          ).toBe(referenceElide(name, budget, estimate));
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
