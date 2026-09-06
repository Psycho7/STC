// reseatChips: the drag-end re-seat. A node drag keeps the live path anchor
// (ItemEdge re-paths from the live endpoints) but leaves the seating offsets
// stamped for the layout-time geometry, so the chip lands at "live anchor plus
// a stale offset". Re-seating strips every stamp the seating pass wrote and
// runs it again on the moved nodes, so the result is exactly what a fresh pass
// over clean edges would give.
import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  deconflictChipAnchors,
  reseatChips,
} from "../../src/canvas/chipSeating";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  inputProductNode,
  mkEdge,
  mkRecipe,
  recipeNode,
} from "./busRouting.testkit";

// The default plan's ore + water pair into one refinery (see shortLegChips):
// at layout the water chip has no full-scale seat beside the ore chip and
// seats shrunk at cap 1.
const pairFixture = (waterTapY: number) => {
  const recipe = mkRecipe("r", ["ore", "water"], ["out"]);
  const nodes: RFAnyNode[] = [
    recipeNode("r", 560, 29, recipe),
    inputProductNode("tapOre", "ore", 286, 19),
    inputProductNode("tapWater", "water", 286, waterTapY),
  ];
  const edges: Edge[] = [
    mkEdge("e:1:tapOre->r:ore", "tapOre", "r", "ore"),
    mkEdge("e:2:tapWater->r:water", "tapWater", "r", "water"),
  ];
  Object.assign(edges[0]!.data!, { bendX: 486.67, chamferBudget: 5.17 });
  Object.assign(edges[1]!.data!, { bendX: 517.67, chamferBudget: 5.17 });
  return { nodes, edges };
};

const dataOf = (edges: Edge[], id: string) =>
  edges.find((e) => e.id === id)!.data as Record<string, unknown>;

describe("reseatChips", () => {
  it("re-seats from clean edges after a node moves, leaving no stale stamp", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    // Premise: the layout-time seat shrank the water chip.
    expect(dataOf(laid, "e:2:tapWater->r:water").chipScaleCap).toBe(1);

    // The water tap is dragged 300 units down: its leg is now a long dogleg
    // clear of the ore chip, so the shrink (cap 1) must not survive. The
    // window cap stays, because the corridor between the same two cards is
    // as wide as before.
    const moved: RFAnyNode[] = nodes.map((n) =>
      n.id === "tapWater" ? { ...n, position: { x: 286, y: 427 } } : n,
    );
    const reseated = reseatChips(moved, laid);
    const fresh = deconflictChipAnchors(moved, pairFixture(427).edges);
    expect(reseated.map((e) => e.data)).toEqual(fresh.map((e) => e.data));
    const cap = dataOf(reseated, "e:2:tapWater->r:water").chipScaleCap;
    expect(cap).not.toBe(1);
    expect(cap).toBeGreaterThan(1);
  });

  it("is a no-op re-run when nothing moved", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    const again = reseatChips(nodes, laid);
    expect(again.map((e) => e.data)).toEqual(laid.map((e) => e.data));
  });
});
