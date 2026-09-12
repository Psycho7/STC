// The stamp-liveness rule, pinned where it is stated rather than at the four
// render sites that ask it. Both functions answer "does this stamp still
// describe the live geometry?", and the case that is easiest to get wrong at a
// call site -- an ABSENT stamp -- is the first thing asserted here: no stamp
// means nothing contradicts the seating decision, so the decision stands.
// Precedent: isTrunkOwner and test/canvas/trunkOwner.test.ts.

import { describe, it, expect } from "vitest";
import {
  HIDE_STALE_EPS,
  anchorStampLive,
  faninHideLive,
} from "../../src/canvas/dimensions";

describe("canvas/dimensions faninHideLive", () => {
  it("keeps the decision when nothing was stamped", () => {
    expect(faninHideLive(undefined, 400)).toBe(true);
  });

  it("keeps the decision when the stamp sits on the live row", () => {
    expect(faninHideLive(120, 120)).toBe(true);
  });

  it("drops the decision at exactly the threshold, either way", () => {
    expect(faninHideLive(120, 120 + HIDE_STALE_EPS)).toBe(false);
    expect(faninHideLive(120, 120 - HIDE_STALE_EPS)).toBe(false);
  });

  it("keeps the decision one unit inside the threshold", () => {
    expect(faninHideLive(120, 120 + HIDE_STALE_EPS - 1)).toBe(true);
    expect(faninHideLive(120, 120 - HIDE_STALE_EPS + 1)).toBe(true);
  });
});

describe("canvas/dimensions anchorStampLive", () => {
  const live = { x: 300, y: 120 };

  it("keeps the decision when nothing was stamped", () => {
    expect(anchorStampLive(undefined, live)).toBe(true);
  });

  it("keeps the decision when the stamp sits on the live anchor", () => {
    expect(anchorStampLive({ x: 300, y: 120 }, live)).toBe(true);
  });

  it("drops the decision on x drift alone at the threshold", () => {
    expect(anchorStampLive({ x: 300 + HIDE_STALE_EPS, y: 120 }, live)).toBe(
      false,
    );
  });

  it("drops the decision on y drift alone at the threshold", () => {
    expect(anchorStampLive({ x: 300, y: 120 + HIDE_STALE_EPS }, live)).toBe(
      false,
    );
  });

  it("keeps a diagonal drift that stays inside the threshold on both axes", () => {
    // Per-axis, not Euclidean: this stamp is further away than the threshold as
    // the crow flies and still live, because neither axis reached it.
    const inside = HIDE_STALE_EPS - 1;
    expect(Math.hypot(inside, inside)).toBeGreaterThan(HIDE_STALE_EPS);
    expect(anchorStampLive({ x: 300 + inside, y: 120 + inside }, live)).toBe(
      true,
    );
  });
});
