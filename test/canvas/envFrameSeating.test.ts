// The chip-seating side of the environment plate. The plate is a row of the
// card (ruling I9), so the seating pass needs no per-node growth at all: the
// card rect an environment recipe gets is the plain drawn border box, and
// keeping chips off that box keeps them off the plate. The real-plan
// assertions run the full solve -> layout -> seating chain with the same
// raw-pack recipeById the app passes (layoutSolved), on the two corpus
// scenarios that draw environment cards next to dense chip traffic.

import { describe, it, expect } from "vitest";

import {
  CARD_BORDER,
  cardRectsFor,
  chipEntersOwnCardBody,
  seatedChipBoxes,
} from "../../src/canvas/chipSeating";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
import { ENV_ROW_HEIGHT } from "../../src/canvas/envBanner";
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

describe("cardRectsFor leaves an environment card at its drawn border box", () => {
  it("adds no frame term, and the plate rides inside the box through nodeHeight", () => {
    const node = recipeNode("r", 1000, 400, envRecipe);
    const nodes: RFAnyNode[] = [node];
    const byId = new Map(nodes.map((n) => [n.id, n]));

    const [rect] = cardRectsFor(nodes, byId);

    expect(rect).toEqual({
      id: "r",
      left: 1000,
      top: 400,
      right: 1000 + RECIPE_WIDTH + 2 * CARD_BORDER,
      bottom: 400 + nodeHeight(node) + 2 * CARD_BORDER,
      border: CARD_BORDER,
    });
    // The rect is taller than the same recipe without an environment by
    // exactly the plate: that growth is the card's, not a frame's.
    const bare = recipeNode("r", 1000, 400, mkRecipe("r", ["a"], ["b"]));
    expect(nodeHeight(node) - nodeHeight(bare)).toBe(ENV_ROW_HEIGHT);
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

// The seating-pass clearance around an environment card, stated the way the
// e2e chip/card audit states its card clearance: a chip box must not enter the
// card box (plate row included), with the one ratified exemption -- a chip on
// its OWN endpoint card's port strip (its centre within the strip the port
// furniture occupies) is the normal on-line state, not a defect.
async function plateViolations(
  targets: ItemTarget[],
): Promise<{ envCards: number; chips: number; violations: string[] }> {
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
  );
  const byId = nodeIndexOf(nodes);
  const envCards = cardRectsFor(nodes, byId).filter(
    (r): boolean =>
      byId.get(r.id)?.type === "recipe" &&
      (byId.get(r.id)?.data as { recipe?: { environment?: string } }).recipe
        ?.environment !== undefined,
  );
  const chips = seatedChipBoxes(nodes, edges);
  const overlaps = (chip: ChipRect, card: ChipRect): boolean =>
    chip.left < card.right - 0.5 &&
    card.left < chip.right - 0.5 &&
    chip.top < card.bottom - 0.5 &&
    card.top < chip.bottom - 0.5;

  const violations: string[] = [];
  for (const chip of chips) {
    const rect: ChipRect = {
      left: chip.x - chip.halfW,
      top: chip.y - chip.halfH,
      right: chip.x + chip.halfW,
      bottom: chip.y + chip.halfH,
    };
    for (const card of envCards) {
      if (!overlaps(rect, card)) continue;
      const own =
        chip.source === card.id
          ? ("source" as const)
          : chip.target === card.id
            ? ("target" as const)
            : undefined;
      if (own !== undefined && !chipEntersOwnCardBody(rect, card, own)) {
        continue;
      }
      violations.push(
        `${chip.family} chip of ${chip.edgeId} enters the card box of ${card.id}`,
      );
    }
  }
  return { envCards: envCards.length, chips: chips.length, violations };
}

describe("no seated chip enters an environment card's box", () => {
  it("gas-web keeps every chip off the plate rows", async () => {
    const { envCards, chips, violations } = await plateViolations(GAS_WEB);
    // Premise: the plan draws environment cards and seated chips; without
    // them the clearance above is vacuous.
    expect(envCards).toBe(3);
    expect(chips).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);

  it("battery5-xiranite keeps every chip off the plate rows", async () => {
    const { envCards, chips, violations } =
      await plateViolations(BATTERY5_XIRANITE);
    expect(envCards).toBeGreaterThanOrEqual(1);
    expect(chips).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 60_000);
});
