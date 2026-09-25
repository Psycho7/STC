// The loop paint's rules on hand-built plans: membership is the cycle of the
// drawn edges, the caption names the loop by its members' primary outputs, and
// two members are joined only where the join covers no other card.

import { describe, expect, it } from "vitest";

import {
  LOOP_CAPTION_HEIGHT,
  LOOP_PAINT_PAD,
  loopCaption,
  loopMemberSets,
  loopPaints,
} from "../../src/canvas/loopPaint";
import { mkEdge, mkRecipe, recipeNode } from "./busRouting.testkit";

const plant = mkRecipe("r:a", ["aseed"], ["a"]);
const seed = mkRecipe("r:aseed", ["a"], ["aseed"]);
const sink = mkRecipe("r:sink", ["a"], ["z"]);

describe("loop paint", () => {
  it("paints the cycle, not the cards it feeds, and dedupes the caption items", () => {
    // Two Planting units of one recipe on the cycle, a tail fed by it.
    const nodes = [
      recipeNode("u:a1", 0, 0, plant),
      recipeNode("u:a2", 0, 300, plant),
      recipeNode("u:seed", 600, 150, seed),
      recipeNode("u:tail", 1200, 150, sink),
    ];
    const edges = [
      mkEdge("e:0", "u:a1", "u:seed", "a"),
      mkEdge("e:1", "u:a2", "u:seed", "a"),
      mkEdge("e:2", "u:seed", "u:a1", "aseed"),
      mkEdge("e:3", "u:seed", "u:a2", "aseed"),
      mkEdge("e:4", "u:seed", "u:tail", "a"),
    ];

    expect(loopMemberSets(nodes, edges)).toEqual([["u:a1", "u:a2", "u:seed"]]);
    const [paint] = loopPaints(nodes, edges);
    expect(paint!.titleItems).toEqual(["a", "aseed"]);
  });

  it("joins two members only where the join covers no other card", () => {
    const pair = [
      recipeNode("u:a", 0, 0, plant),
      recipeNode("u:seed", 800, 0, seed),
    ];
    const edges = [
      mkEdge("e:0", "u:a", "u:seed", "a"),
      mkEdge("e:1", "u:seed", "u:a", "aseed"),
    ];

    // Open corridor: the two padded cards, one join, one caption band.
    const open = loopPaints(pair, edges)[0]!;
    expect(open.rects).toHaveLength(4);

    // A foreign card in the corridor: the join would cover it, so none.
    const blocked = loopPaints(
      [...pair, recipeNode("u:other", 400, 0, sink)],
      edges,
    )[0]!;
    expect(blocked.rects).toHaveLength(3);
  });

  it("seats the caption on a member's top, below it when the top is taken", () => {
    const pair = [
      recipeNode("u:a", 0, 200, plant),
      recipeNode("u:seed", 400, 200, seed),
    ];
    const edges = [
      mkEdge("e:0", "u:a", "u:seed", "a"),
      mkEdge("e:1", "u:seed", "u:a", "aseed"),
    ];

    const free = loopPaints(pair, edges)[0]!;
    expect(free.caption!.bottom).toBe(200 - LOOP_PAINT_PAD);
    expect(free.caption!.top).toBe(200 - LOOP_PAINT_PAD - LOOP_CAPTION_HEIGHT);

    // A card sitting on both members' top bands pushes the caption under.
    const lid = recipeNode("u:lid", 0, 140, mkRecipe("r:lid", [], ["q"]));
    const lid2 = recipeNode("u:lid2", 400, 140, mkRecipe("r:lid2", [], ["q"]));
    const pushed = loopPaints([...pair, lid, lid2], edges)[0]!;
    expect(pushed.caption!.top).toBeGreaterThan(200);
  });
});

describe("loop caption", () => {
  it("names the loop by its items, resolved through the display-name lookup", () => {
    expect(loopCaption(["a", "b"], (id) => id.toUpperCase())).toBe(
      "LOOP · A · B",
    );
  });

  // Two loops of the same size must not caption identically; the member items
  // are what tells them apart.
  it("distinguishes two loops of the same size", () => {
    expect(loopCaption(["plant_moss_3", "plant_moss_seed_3"])).not.toBe(
      loopCaption(["liquid_xiranite_poly", "xiranite_poly"]),
    );
  });

  it("is empty when no member item resolves", () => {
    expect(loopCaption([])).toBe("");
  });
});
