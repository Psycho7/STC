import { expect, test } from "vitest";
import { clearRailY, chamferStepPath, type ObstacleRect } from "./edgePath";
import { cssBlock } from "./cssContract.testkit";

const CARD: ObstacleRect = { left: 100, right: 400, top: 90, bottom: 210 };

test("clearRailY returns the preferred y when no card is spanned", () => {
  // The rail's x-span is left of the card, so nothing to avoid.
  expect(clearRailY(150, 0, 80, [CARD])).toBe(150);
});

test("clearRailY moves the rail clear of every spanned card's y-extent", () => {
  // preferredY sits inside the card, and the rail spans it horizontally.
  const y = clearRailY(150, 120, 380, [CARD]);
  expect(y < CARD.top || y > CARD.bottom).toBe(true);
});

test("clearRailY clears all spanned cards at once", () => {
  const cards: ObstacleRect[] = [
    { left: 100, right: 300, top: 80, bottom: 160 },
    { left: 250, right: 500, top: 140, bottom: 260 },
  ];
  const y = clearRailY(150, 120, 480, cards);
  for (const c of cards) {
    expect(y < c.top || y > c.bottom).toBe(true);
  }
});

test("clearRailY pushes a moat-preferred rail out to the full container band", () => {
  // A rail whose preferred y misses the container's padded rect but lands in
  // the moat between the border and the wide clearance band would otherwise be
  // left hugging the slab; the widened container strike band pushes it out.
  const slab: ObstacleRect = {
    left: 100,
    right: 400,
    top: 100,
    bottom: 200,
    container: true,
  };
  const y = clearRailY(91, 120, 380, [slab], 8, 48);
  expect(y).toBe(slab.top - 48);
});

test("clearRailY leaves a moat-preferred rail alone off a plain card", () => {
  // Same geometry without the container flag: 91 is outside the card's rect,
  // so a plain obstacle keeps the narrow strike band and the rail stays put.
  const card: ObstacleRect = { left: 100, right: 400, top: 100, bottom: 200 };
  expect(clearRailY(91, 120, 380, [card], 8, 48)).toBe(91);
});

test("clearRailY re-escapes when the nearer landing parks inside a foreign card's gap clearance", () => {
  // The band escape pads its own members by the full gap (aboveY/belowY), but
  // the landing used to be tested against the RAW rects of obstacles outside
  // the band, so a rail could park 1..gap units off a spanned card the old
  // whole-graph min/max always cleared. Here the band around A (top 100,
  // bottom 200) escapes upward to A.top - gap = 92, only 1 past B's bottom 91:
  // B's gap-padded interval [0 - 8, 91 + 8] must catch the landing, merge B
  // into the band, and recompute to the below escape, A.bottom + gap = 208.
  const a: ObstacleRect = { left: 100, right: 400, top: 100, bottom: 200 };
  const b: ObstacleRect = { left: 120, right: 380, top: 0, bottom: 91 };
  expect(clearRailY(150, 120, 380, [a, b], 8, 48)).toBe(208);
});

test("chamferStepPath honors a railY override in its backward branch", () => {
  const [path] = chamferStepPath({
    sourceX: 400,
    sourceY: 100,
    targetX: 0,
    targetY: 100,
    railY: 500,
  });
  // The overridden rail level appears as a vertex y in the emitted polyline.
  expect(path).toContain(",500");
});

test("the chip label layer is lifted above node cards via z-index", () => {
  expect(cssBlock(".ak-canvas-theme .react-flow__edgelabel-renderer")).toMatch(
    /z-index:\s*\d+/,
  );
});
