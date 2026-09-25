// The designated unit control for the drawn-vs-model port drift. The table
// below is a hand-written copy of nodeGeometry's private PORT_DRIFT: this suite
// rebuilds every drawn endpoint from the model side and asserts drawnPortsOf
// lands on the same coordinates, so the module cannot quietly agree with
// itself. Perturb a number in either place and these cases go red.
//
// The other control is test/e2e/geometry.ts, which mirrors the same table
// against the rendered DOM and never touches src. Every other unit suite calls
// drawnPortsOf instead of copying the numbers.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import {
  absoluteLeft,
  absoluteTop,
  drawnPortsOf,
  nodeWidth,
  portOffsetY,
} from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  orderedRecipeNode,
  productNode,
} from "./busRouting.testkit";

// nodeGeometry's PORT_DRIFT, per node kind: React Flow anchors a path at the
// OUTER edge of the handle box, so the drawn port sits a few units off the
// model port the routing passes compute.
const DRIFT = {
  recipe: { sourceDx: 5, targetDx: -3, dy: 1 },
  product: { sourceDx: 4, targetDx: -4, dy: 0 },
};

const ITEM = "s";

const itemEdge = (source: string, target: string, item = ITEM): Edge => ({
  id: `e:${source}->${target}:${item}`,
  type: "item",
  source,
  target,
  data: { item },
});

const byIdOf = (nodes: ReadonlyArray<RFAnyNode>): Map<string, RFAnyNode> =>
  new Map(nodes.map((n) => [n.id, n]));

describe("drawnPortsOf: the drawn port drift", () => {
  it("puts a recipe source's out handle past its right edge, a row below", () => {
    const src = recipeNode("src", 40, 60, mkRecipe("src", [], [ITEM]));
    const tgt = orderedRecipeNode("tgt", 900, 120, [ITEM]);
    const byId = byIdOf([src, tgt]);

    const ports = drawnPortsOf(itemEdge("src", "tgt"), byId);

    expect(ports).not.toBeNull();
    expect(ports!.sourceX).toBe(
      absoluteLeft(src) + nodeWidth(src) + DRIFT.recipe.sourceDx,
    );
    expect(ports!.sourceY).toBe(
      absoluteTop(src) + portOffsetY(src, ITEM, "out") + DRIFT.recipe.dy,
    );
  });

  it("puts a recipe target's in handle left of its left edge, a row below", () => {
    const src = recipeNode("src", 40, 60, mkRecipe("src", [], [ITEM]));
    const tgt = orderedRecipeNode("tgt", 900, 120, [ITEM]);
    const byId = byIdOf([src, tgt]);

    const ports = drawnPortsOf(itemEdge("src", "tgt"), byId)!;

    expect(ports.targetX).toBe(absoluteLeft(tgt) + DRIFT.recipe.targetDx);
    expect(ports.targetY).toBe(
      absoluteTop(tgt) + portOffsetY(tgt, ITEM, "in") + DRIFT.recipe.dy,
    );
  });

  it("puts a product node's handles symmetrically outside its box, undrifted in y", () => {
    const src = productNode("src", 0, 200, 148, 78);
    const tgt = productNode("tgt", 800, 400, 148, 78);
    const byId = byIdOf([src, tgt]);

    const ports = drawnPortsOf(itemEdge("src", "tgt"), byId)!;

    expect(ports.sourceX).toBe(
      absoluteLeft(src) + nodeWidth(src) + DRIFT.product.sourceDx,
    );
    expect(ports.sourceY).toBe(
      absoluteTop(src) + portOffsetY(src, ITEM, "out") + DRIFT.product.dy,
    );
    expect(ports.targetX).toBe(absoluteLeft(tgt) + DRIFT.product.targetDx);
    expect(ports.targetY).toBe(
      absoluteTop(tgt) + portOffsetY(tgt, ITEM, "in") + DRIFT.product.dy,
    );
  });

  it("lands a catalyst edge on the cat: row, not the in: row of the same item", () => {
    // A phase transmuter cycles an item it also consumes, so one card carries
    // that item on an in: row AND on a catalyst row. Only `toPortKind` on the
    // edge data tells the two apart -- resolving by item alone would draw the
    // supply edge into the wrong row -- and the catalyst rows continue below
    // every in: row, so the two are a whole row pitch apart.
    const src = recipeNode("src", 40, 60, mkRecipe("src", [], [ITEM]));
    const base = orderedRecipeNode("tgt", 900, 120, [ITEM]);
    const tgt: RFAnyNode = {
      ...base,
      data: {
        ...base.data,
        recipe: { ...base.data.recipe, catalyst: [{ item: ITEM, qty: 1 }] },
      },
    };
    const byId = byIdOf([src, tgt]);

    const inRow = portOffsetY(tgt, ITEM, "in");
    const catRow = portOffsetY(tgt, ITEM, "cat");
    // Premise: the card really does carry the item twice, on two rows.
    expect(catRow).toBeGreaterThan(inRow);

    const supply: Edge = {
      ...itemEdge("src", "tgt"),
      data: { item: ITEM, toPortKind: "catalyst" },
    };
    const ports = drawnPortsOf(supply, byId)!;

    expect(ports.targetY).toBe(absoluteTop(tgt) + catRow + DRIFT.recipe.dy);
    // The in: row reading of the very same card and item, which this edge must
    // NOT have taken.
    expect(ports.targetY).not.toBe(
      drawnPortsOf(itemEdge("src", "tgt"), byId)!.targetY,
    );
  });

  it("leaves a centre-fallback row undrifted", () => {
    // The target consumes "s" but the edge carries "other", so portOffsetY
    // cannot resolve a row and falls back to the card's vertical centre. That
    // fallback approximates an unknown row, not a row shifted by the card
    // border, so the recipe dy must not be added to it.
    const src = recipeNode("src", 40, 60, mkRecipe("src", [], [ITEM]));
    const tgt = orderedRecipeNode("tgt", 900, 120, [ITEM]);
    const byId = byIdOf([src, tgt]);

    const ports = drawnPortsOf(itemEdge("src", "tgt", "other"), byId)!;

    const centre = portOffsetY(tgt, "other", "in");
    expect(centre).toBe(
      portOffsetY(tgt, undefined, "in"), // the fallback, not a row
    );
    expect(ports.targetY).toBe(absoluteTop(tgt) + centre);
  });
});
