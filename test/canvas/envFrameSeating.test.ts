// The chip-seating side of the environment frame: the frame rectangle is an
// obstacle, so no chip seats on a plate or inside the haze. The obstacle growth
// is per-node (only recipes that carry an environment); cardGrowth itself stays
// the neutral border growth it always was. The real-plan assertions run the
// full solve -> layout -> seating chain with the same raw-pack recipeById the
// app passes (layoutSolved), on the two corpus scenarios that draw environment
// cards next to dense chip traffic.

import { describe, it, expect } from "vitest";

import {
  CARD_BORDER,
  cardRectsFor,
  chipEntersOwnCardBody,
  seatedChipBoxes,
} from "../../src/canvas/chipSeating";
import { ENV_FRAME_EXTENTS, RECIPE_WIDTH } from "../../src/canvas/dimensions";
import { nodeHeight, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode } from "./busRouting.testkit";

const envRecipe = {
  ...mkRecipe("r", ["a"], ["b"]),
  environment: "stable" as const,
};

describe("cardRectsFor grows an environment card by the frame extents", () => {
  it("adds the frame rectangle around the drawn border box", () => {
    const node = recipeNode("r", 1000, 400, envRecipe);
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const [rect] = cardRectsFor(nodes, byId);

    expect(rect).toEqual({
      id: "r",
      left: 1000 - ENV_FRAME_EXTENTS.left,
      top: 400 - ENV_FRAME_EXTENTS.top,
      right: 1000 + RECIPE_WIDTH + 2 * CARD_BORDER + ENV_FRAME_EXTENTS.right,
      bottom:
        400 + nodeHeight(node) + 2 * CARD_BORDER + ENV_FRAME_EXTENTS.bottom,
      // The port-zone strip is measured from the rect edge inward by `border`,
      // so the frame rect carries the side extent with it and the strip still
      // starts at the card's own row edge, not 8px early.
      border: CARD_BORDER + ENV_FRAME_EXTENTS.left,
    });
  });

  it("leaves a plain recipe card at the drawn border box", () => {
    const node = recipeNode("r", 1000, 400, mkRecipe("r", ["a"], ["b"]));
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const [rect] = cardRectsFor(nodes, byId);
    expect(rect?.left).toBe(1000);
    expect(rect?.top).toBe(400);
    expect(rect?.right).toBe(1000 + RECIPE_WIDTH + 2 * CARD_BORDER);
    expect(rect?.border).toBe(CARD_BORDER);
  });
});

// The two corpus scenarios that draw environment cards.
const GAS_WEB: ItemTarget[] = [
  { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_copper_enr2", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_inert", ratePerSec: { num: "1", denom: "4" } },
];
const BATTERY5_XIRANITE: ItemTarget[] = [
  { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } },
];

type ChipRect = { left: number; top: number; right: number; bottom: number };

// The seating-pass frame clearance, stated the way the e2e chip/card audit
// states its card clearance: a chip box must not enter ANY environment frame
// rectangle, with the one ratified exemption -- a chip on its OWN endpoint
// card's port strip (its centre within the strip the port furniture occupies)
// is the normal on-line state, not a defect.
async function frameViolations(
  targets: ItemTarget[],
): Promise<{ frames: number; chips: number; violations: string[] }> {
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
  );
  const byId = nodeIndexOf(nodes);
  const frames = cardRectsFor(nodes, byId).filter(
    (r): boolean =>
      byId.get(r.id)?.type === "recipe" &&
      (byId.get(r.id)?.data as { recipe?: { environment?: string } }).recipe
        ?.environment !== undefined,
  );
  const chips = seatedChipBoxes(nodes, edges);
  const overlaps = (chip: ChipRect, frame: ChipRect): boolean =>
    chip.left < frame.right - 0.5 &&
    frame.left < chip.right - 0.5 &&
    chip.top < frame.bottom - 0.5 &&
    frame.top < chip.bottom - 0.5;

  const violations: string[] = [];
  for (const chip of chips) {
    const rect: ChipRect = {
      left: chip.x - chip.halfW,
      top: chip.y - chip.halfH,
      right: chip.x + chip.halfW,
      bottom: chip.y + chip.halfH,
    };
    for (const frame of frames) {
      if (!overlaps(rect, frame)) continue;
      const own =
        chip.source === frame.id
          ? ("source" as const)
          : chip.target === frame.id
            ? ("target" as const)
            : undefined;
      if (own !== undefined && !chipEntersOwnCardBody(rect, frame, own)) {
        continue;
      }
      violations.push(
        `${chip.family} chip of ${chip.edgeId} enters frame of ${frame.id}`,
      );
    }
  }
  return { frames: frames.length, chips: chips.length, violations };
}

describe("no seated chip enters an environment card's frame", () => {
  it("gas-web keeps every chip off the plates and haze", async () => {
    const { frames, chips, violations } = await frameViolations(GAS_WEB);
    // Premise: the plan draws environment cards and seated chips; without
    // them the clearance above is vacuous.
    expect(frames).toBe(3);
    expect(chips).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);

  it("battery5-xiranite keeps every chip off the plates and haze", async () => {
    const { frames, chips, violations } =
      await frameViolations(BATTERY5_XIRANITE);
    expect(frames).toBeGreaterThanOrEqual(1);
    expect(chips).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);
});
