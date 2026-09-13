// reseatChips equals a fresh bookkeeping pass over stamp-free edges.
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

// Two taps into one refinery, wired to CROSS: the ore tap sits below the water
// tap while the recipe's ore row sits above its water row, so the two legs
// swap places in the corridor and the pass stamps a crossing cue. The cue is
// the stamp a re-run has to recompute rather than carry over.
const pairFixture = (oreTapY: number) => {
  const recipe = mkRecipe("r", ["ore", "water"], ["out"]);
  const nodes: RFAnyNode[] = [
    recipeNode("r", 560, 29, recipe),
    inputProductNode("tapOre", "ore", 286, oreTapY),
    inputProductNode("tapWater", "water", 286, 19),
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
  it("re-runs from clean edges after a node moves, leaving no stale stamp", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    // Premise: the crossed pair really did stamp a cue, so there is a stamp
    // that can go stale.
    expect(dataOf(laid, "e:1:tapOre->r:ore").crossingCues).not.toBeUndefined();

    // The ore tap is dragged back above the water tap: the two legs no longer
    // cross, so the cue must be recomputed from the moved geometry rather than
    // carried over.
    const moved: RFAnyNode[] = nodes.map((n) =>
      n.id === "tapOre" ? { ...n, position: { x: 286, y: -60 } } : n,
    );
    const reseated = reseatChips(moved, laid);
    const fresh = deconflictChipAnchors(moved, pairFixture(-60).edges);
    expect(reseated.map((e) => e.data)).toEqual(fresh.map((e) => e.data));
    // And it really was recomputed: the moved geometry crosses somewhere else
    // than the stamp taken before the drag.
    expect(dataOf(reseated, "e:1:tapOre->r:ore").crossingCues).not.toEqual(
      dataOf(laid, "e:1:tapOre->r:ore").crossingCues,
    );
  });

  it("is a no-op re-run when nothing moved", () => {
    const { nodes, edges } = pairFixture(127);
    const laid = deconflictChipAnchors(nodes, edges);
    const again = reseatChips(nodes, laid);
    expect(again.map((e) => e.data)).toEqual(laid.map((e) => e.data));
  });
});
