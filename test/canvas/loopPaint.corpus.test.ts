// The loop paint marks each directed cycle of the DRAWN graph. It is painted
// after routing and nothing lays out or routes around it, so the one thing that
// keeps it honest is what it covers:
//
// - no card outside the cycle lies inside any painted shape, on any corpus
//   plan (a tinted foreign card would read as a loop member);
// - membership is the cycle of the rendered edges, so battery5-xiranite's
//   Refining card, which closes its cycle only through the recaptured water
//   edge, is a member, while a planter loop's tail Planting Unit (fed by the
//   cycle, not on it) is not;
// - every loop carries its caption, and the caption covers no card and no chip.

import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import type { RFAnyNode } from "../../src/canvas/layout";
import { loopPaints, type LoopPaint } from "../../src/canvas/loopPaint";
import { seatedChipBoxes } from "../../src/canvas/chipSeating";
import { nodeRectOf, type Rect } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { SCENARIOS } from "../e2e/scenarios";

// Plans whose solve closes at least one recipe cycle.
const LOOP_PLANS = [
  "battery5",
  "battery5-xiranite",
  "crystal",
  "equip4",
  "multi6",
  "rot-bottled_food_3",
  "rot-bottled_food_4",
];

async function layOut(
  id: string,
): Promise<{ nodes: RFAnyNode[]; edges: Edge[] }> {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  const { nodes, edges } = await layoutSolved(
    solveForRender({
      targets: scenario.targets.map((t) => ({
        itemId: t.itemId,
        ratePerSec: t.ratePerSec,
      })),
      pack,
    }),
  );
  return { nodes, edges };
}

// Interior overlap; two rects sharing only an edge do not overlap.
const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const memberSet = (paint: LoopPaint): string[] => [...paint.members].sort();

describe("loop paint", () => {
  it("covers no card outside its cycle and captions every loop clear of cards and chips", async () => {
    const foreign: string[] = [];
    const captionHits: string[] = [];
    const painted: string[] = [];
    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const cards = nodes.filter(
        (n) => n.type === "recipe" || n.type === "product",
      );
      const chips = seatedChipBoxes(nodes, edges).map((c) => ({
        id: `${c.edgeId} ${c.family}`,
        rect: {
          left: c.x - c.halfW,
          right: c.x + c.halfW,
          top: c.y - c.halfH,
          bottom: c.y + c.halfH,
        },
      }));
      const paints = loopPaints(nodes, edges);
      if (paints.length > 0) painted.push(scenario.id);
      for (const paint of paints) {
        const members = new Set(paint.members);
        for (const card of cards) {
          if (members.has(card.id)) continue;
          const rect = nodeRectOf(card);
          if (paint.rects.some((r) => overlaps(r, rect))) {
            foreign.push(`${scenario.id}: ${card.id} in ${paint.members[0]}`);
          }
        }
        const caption = paint.caption;
        if (caption === undefined) {
          captionHits.push(`${scenario.id}: ${paint.members[0]} uncaptioned`);
          continue;
        }
        for (const card of cards) {
          if (overlaps(caption, nodeRectOf(card))) {
            captionHits.push(`${scenario.id}: caption on card ${card.id}`);
          }
        }
        for (const chip of chips) {
          if (overlaps(caption, chip.rect)) {
            captionHits.push(`${scenario.id}: caption on chip ${chip.id}`);
          }
        }
        // The caption sits on the paint, not beside it.
        expect(
          paint.rects.some(
            (r) =>
              r.left <= caption.left &&
              caption.right <= r.right &&
              r.top <= caption.top &&
              caption.bottom <= r.bottom,
          ),
          `${scenario.id}: caption off the paint`,
        ).toBe(true);
      }
    }
    expect(painted.sort()).toEqual([...LOOP_PLANS].sort());
    expect(foreign).toEqual([]);
    expect(captionHits).toEqual([]);
  }, 1_200_000);

  it("paints the cycles of the rendered edges, not the old loop boxes", async () => {
    const bx = await layOut("battery5-xiranite");
    const bxSets = loopPaints(bx.nodes, bx.edges).map(memberSet);
    // Refining closes its cycle through the recaptured liquid_water edge.
    expect(bxSets.some((set) => set.includes("u:class:q:9"))).toBe(true);
    // The planter loop's tail Planting Unit is fed by the cycle, not on it.
    expect(bxSets.flat()).not.toContain("u:class:q:25");

    const m6 = await layOut("multi6");
    const m6Members = loopPaints(m6.nodes, m6.edges).flatMap(memberSet);
    for (const tail of ["u:class:q:52", "u:class:q:54", "u:class:q:58"]) {
      expect(m6Members).not.toContain(tail);
    }
    expect(m6Members).toEqual(
      expect.arrayContaining(["u:class:q:51", "u:class:q:55"]),
    );
  }, 300_000);
});
