// The post-ELK layer model, the topological trunk classifier and the
// gap-widening pre-pass, on hand-built placements.
//
// Every fixture here is laid out by hand rather than by ELK, so the gap
// arithmetic is checked against numbers the reader can recompute: recipe cards
// are RECIPE_WIDTH wide, a layer pitch of 410 leaves ELK's own
// BETWEEN_LAYERS_SPACING of 110 between two layers, and the reserves come out of
// the real chip metrics.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  COLUMN_PITCH,
  RESERVE_CARD_PAD,
  RESERVE_COLUMN_PAD,
  buildLayerModel,
  classifyTrunks,
  gapRequirements,
  gapSpansOf,
  widenLayerGaps,
} from "../../src/canvas/layerModel";
import { chipNaturalWidth } from "../../src/canvas/chipMetrics";
import { FORWARD_STEP_BUDGET } from "../../src/canvas/edgePath";
import { PRODUCT_WIDTH, RECIPE_WIDTH } from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  containerNode,
  inContainer,
  inputProductNode,
  mkEdge,
  mkRecipe,
  orderedRecipeNode,
  recipeNode,
} from "./busRouting.testkit";

// One layer of this fixture: a RECIPE_WIDTH card plus ELK's between-layer gap.
const ELK_GAP = 110;
const LAYER_PITCH = RECIPE_WIDTH + ELK_GAP;

// The reserve one chip box takes, as the module charges it.
const reserve = (body: string): number =>
  RESERVE_CARD_PAD +
  chipNaturalWidth({ body, unit: true }) +
  RESERVE_COLUMN_PAD;

// Every fixture edge carries a rate of 1/s, which the display formatter prints
// as 60/min; a two-member trunk totals 120/min.
const OWN_CHIP = reserve("60");
const TRUNK_CHIP = reserve("120");

const producer = (id: string, y: number, item: string): RFAnyNode =>
  recipeNode(id, 0, y, mkRecipe(id, [], [item]));

describe("buildLayerModel", () => {
  it("clusters leaf nodes by overlapping x-interval and skips containers", () => {
    const group = containerNode("g", 390, 0, 340, 400);
    const nodes: RFAnyNode[] = [
      producer("p", 0, "s"),
      group,
      inContainer(orderedRecipeNode("c1", 20, 0, ["s"]), "g"),
      inContainer(orderedRecipeNode("c2", 20, 200, ["s"]), "g"),
    ];

    const model = buildLayerModel(nodes);

    expect(model.layers.map((l) => [l.left, l.right])).toEqual([
      [0, RECIPE_WIDTH],
      [410, 410 + RECIPE_WIDTH],
    ]);
    expect(model.layerByNodeId.get("p")).toBe(0);
    expect(model.layerByNodeId.get("c1")).toBe(1);
    expect(model.layerByNodeId.get("c2")).toBe(1);
    expect(model.layerByNodeId.has("g")).toBe(false);
  });

  it("keeps a narrow card centred in a wide card's extent in one layer", () => {
    // ELK sizes a layer by its widest member and centres the narrower ones
    // inside it, so a 148-wide product card in a layer of 300-wide recipes has a
    // left edge of its own. Splitting on the left edge would invent a layer
    // whose "gap" to its neighbour is negative.
    const inset = (RECIPE_WIDTH - PRODUCT_WIDTH) / 2;
    const nodes: RFAnyNode[] = [
      producer("wide", 0, "s"),
      inputProductNode("narrow", "s", inset, 200),
    ];

    const model = buildLayerModel(nodes);

    expect(model.layers).toHaveLength(1);
    expect([model.layers[0]!.left, model.layers[0]!.right]).toEqual([
      0,
      RECIPE_WIDTH,
    ]);
    expect(model.layerByNodeId.get("narrow")).toBe(0);
    expect(gapSpansOf(model)).toEqual([]);
  });
});

// Three layers. Gap 0 carries a fan-out (p -> c1, c2) and a fan-in (q1, q2 -> d)
// of two different items; layer 2 holds one unconnected card, so gap 1 owes
// nothing.
function threeLayerFixture(): { nodes: RFAnyNode[]; edges: Edge[] } {
  const nodes: RFAnyNode[] = [
    producer("p", 0, "s"),
    producer("q1", 200, "t"),
    producer("q2", 400, "t"),
    orderedRecipeNode("c1", LAYER_PITCH, 0, ["s"]),
    orderedRecipeNode("c2", LAYER_PITCH, 200, ["s"]),
    orderedRecipeNode("d", LAYER_PITCH, 400, ["t"]),
    orderedRecipeNode("z", 2 * LAYER_PITCH, 0, ["u"]),
  ];
  const edges: Edge[] = [
    mkEdge("e:0", "p", "c1", "s"),
    mkEdge("e:1", "p", "c2", "s"),
    mkEdge("e:2", "q1", "d", "t"),
    mkEdge("e:3", "q2", "d", "t"),
  ];
  return { nodes, edges };
}

describe("gap widening on three layers", () => {
  it("widens the gap to its source, column and target zones", () => {
    const { nodes, edges } = threeLayerFixture();

    const [gap0, gap1] = gapRequirements(nodes, edges);
    // Two trunk columns in gap 0: the fan-out's, and the fan-in's (which sits
    // in the gap LEFT of its target layer).
    expect(gap0).toEqual({
      index: 0,
      sourceZone: TRUNK_CHIP,
      columnZone: FORWARD_STEP_BUDGET + 2 * COLUMN_PITCH,
      targetZone: TRUNK_CHIP,
      columns: 2,
      required:
        TRUNK_CHIP + FORWARD_STEP_BUDGET + 2 * COLUMN_PITCH + TRUNK_CHIP,
    });
    // The numbers behind those names, so a drift in the chip metrics is visible
    // here rather than only in the census.
    expect(gap0?.required).toBe(397);
    // No edge crosses gap 1, so it owes nothing and keeps ELK's width.
    expect(gap1?.required).toBe(0);

    const widened = widenLayerGaps(nodes, edges);
    const gap = widened.gaps[0]!;
    expect(gap.right - gap.left).toBe(gap0!.required);
    expect(gap.sourceZone).toEqual({
      left: gap.left,
      right: gap.left + TRUNK_CHIP,
    });
    expect(gap.targetZone).toEqual({
      left: gap.right - TRUNK_CHIP,
      right: gap.right,
    });
    expect(gap.columnZone).toEqual({
      left: gap.sourceZone.right,
      right: gap.targetZone.left,
    });
    expect(widened.gaps[1]!.right - widened.gaps[1]!.left).toBe(ELK_GAP);
  });

  it("shifts every node right of the gap by exactly the delta", () => {
    const { nodes, edges } = threeLayerFixture();
    const delta = gapRequirements(nodes, edges)[0]!.required - ELK_GAP;
    expect(delta).toBe(287);

    const widened = widenLayerGaps(nodes, edges);
    const xOf = (id: string): number =>
      widened.nodes.find((n) => n.id === id)!.position.x;

    expect(xOf("p")).toBe(0);
    expect(xOf("q1")).toBe(0);
    expect(xOf("c1")).toBe(LAYER_PITCH + delta);
    expect(xOf("c2")).toBe(LAYER_PITCH + delta);
    expect(xOf("d")).toBe(LAYER_PITCH + delta);
    expect(xOf("z")).toBe(2 * LAYER_PITCH + delta);
  });

  it("moves nothing when the gap already meets its requirement", () => {
    const nodes: RFAnyNode[] = [
      producer("p", 0, "s"),
      orderedRecipeNode("c", 700, 0, ["s"]),
    ];
    const edges = [mkEdge("e:0", "p", "c", "s")];
    const required = gapRequirements(nodes, edges)[0]!.required;
    expect(required).toBeLessThan(700 - RECIPE_WIDTH);

    const widened = widenLayerGaps(nodes, edges);
    expect(widened.nodes.map((n) => n.position)).toEqual([
      { x: 0, y: 0 },
      { x: 700, y: 0 },
    ]);
    expect(widened.gaps[0]!.right - widened.gaps[0]!.left).toBe(
      700 - RECIPE_WIDTH,
    );
  });

  it("shifts a layer that sits on a fractional x", () => {
    // ELK hands back fractional lefts. Membership, not an x comparison, decides
    // who moves, so a layer on x.5 travels with its gap instead of being
    // stranded while the layers right of it move.
    const FRACTIONAL = 573.5;
    const nodes: RFAnyNode[] = [
      producer("p", 0, "s"),
      orderedRecipeNode("c", FRACTIONAL, 0, ["s"]),
      orderedRecipeNode("z", 1200, 0, ["u"]),
    ];
    const edges = [mkEdge("e:0", "p", "c", "s")];
    const required = gapRequirements(nodes, edges)[0]!.required;
    const delta = required - (FRACTIONAL - RECIPE_WIDTH);
    expect(delta).toBeGreaterThan(0);

    const widened = widenLayerGaps(nodes, edges);
    const xOf = (id: string): number =>
      widened.nodes.find((n) => n.id === id)!.position.x;

    expect(xOf("p")).toBe(0);
    expect(xOf("c")).toBeCloseTo(FRACTIONAL + delta, 6);
    expect(xOf("z")).toBeCloseTo(1200 + delta, 6);
    const gap = widened.gaps[0]!;
    expect(gap.right - gap.left).toBeCloseTo(required, 6);
  });

  it("returns new node objects and never mutates the input", () => {
    const { nodes, edges } = threeLayerFixture();
    const before = nodes.map((n) => ({
      id: n.id,
      position: n.position,
      x: n.position.x,
      y: n.position.y,
    }));

    const widened = widenLayerGaps(nodes, edges);

    for (const row of before) {
      const input = nodes.find((n) => n.id === row.id)!;
      // Same position OBJECT, same numbers: the pre-pass cloned rather than
      // reached into the array it was handed.
      expect(input.position).toBe(row.position);
      expect(input.position.x).toBe(row.x);
      expect(input.position.y).toBe(row.y);
      const output = widened.nodes.find((n) => n.id === row.id)!;
      expect(output).not.toBe(input);
      expect(output.position).not.toBe(input.position);
    }
  });
});

describe("gap widening with containers", () => {
  it("shifts a container fully right of the gap as a unit", () => {
    const nodes: RFAnyNode[] = [
      producer("p", 0, "s"),
      containerNode("g", 390, 0, 340, 400),
      inContainer(orderedRecipeNode("c1", 20, 0, ["s"]), "g"),
      inContainer(orderedRecipeNode("c2", 20, 200, ["s"]), "g"),
    ];
    const edges = [
      mkEdge("e:0", "p", "c1", "s"),
      mkEdge("e:1", "p", "c2", "s"),
    ];
    const delta = gapRequirements(nodes, edges)[0]!.required - ELK_GAP;
    expect(delta).toBeGreaterThan(0);

    const widened = widenLayerGaps(nodes, edges);
    const byId = new Map(widened.nodes.map((n) => [n.id, n]));

    expect(byId.get("g")!.position.x).toBe(390 + delta);
    expect(byId.get("g")!.width).toBe(340);
    // Children are parent-relative, so they follow the container untouched.
    expect(byId.get("c1")!.position.x).toBe(20);
    expect(byId.get("c2")!.position.x).toBe(20);
  });

  it("moves only the right-side children of a straddling container and grows it", () => {
    const nodes: RFAnyNode[] = [
      containerNode("g", 0, 0, 1000, 400),
      inContainer(recipeNode("l", 0, 0, mkRecipe("l", [], ["s"])), "g"),
      inContainer(orderedRecipeNode("r", LAYER_PITCH, 0, ["s"]), "g"),
    ];
    const edges = [mkEdge("e:0", "l", "r", "s")];
    const required = gapRequirements(nodes, edges)[0]!.required;
    expect(required).toBe(OWN_CHIP + FORWARD_STEP_BUDGET + OWN_CHIP);
    const delta = required - ELK_GAP;

    const widened = widenLayerGaps(nodes, edges);
    const byId = new Map(widened.nodes.map((n) => [n.id, n]));

    expect(byId.get("g")!.position.x).toBe(0);
    expect(byId.get("g")!.width).toBe(1000 + delta);
    expect(byId.get("g")!.style?.width).toBe(1000 + delta);
    expect(byId.get("l")!.position.x).toBe(0);
    expect(byId.get("r")!.position.x).toBe(LAYER_PITCH + delta);
  });
});

describe("a backward edge's reserves", () => {
  it("land in the gaps beside its endpoints, not in the gap it spans", () => {
    // Four layers, one backward edge c -> b (ELK reverses cycles, so its source
    // sits right of its target). Its source reserve belongs to gap 2, the gap
    // right of c; its target reserve to gap 0, the gap left of b.
    const nodes: RFAnyNode[] = [
      orderedRecipeNode("a", 0, 0, ["s"]),
      orderedRecipeNode("b", LAYER_PITCH, 0, ["s"]),
      recipeNode("c", 2 * LAYER_PITCH, 0, mkRecipe("c", [], ["s"])),
      orderedRecipeNode("d", 3 * LAYER_PITCH, 0, ["s"]),
    ];
    const edges = [mkEdge("e:0", "c", "b", "s")];

    const gaps = gapRequirements(nodes, edges);
    expect(gaps.map((g) => [g.sourceZone, g.targetZone])).toEqual([
      [0, OWN_CHIP],
      [0, 0],
      [OWN_CHIP, 0],
    ]);
    expect(gaps[1]!.required).toBe(0);
  });
});

describe("web classification", () => {
  const webNodes = (): RFAnyNode[] => [
    producer("s1", 0, "s"),
    producer("s2", 200, "s"),
    orderedRecipeNode("t1", LAYER_PITCH, 0, ["s"]),
    orderedRecipeNode("t2", LAYER_PITCH, 200, ["s"]),
  ];
  const webEdges = (): Edge[] => [
    mkEdge("e:0", "s1", "t1", "s"),
    mkEdge("e:1", "s1", "t2", "s"),
    mkEdge("e:2", "s2", "t1", "s"),
    mkEdge("e:3", "s2", "t2", "s"),
  ];

  it("reads a 2x2 complete bipartite component as one web", () => {
    const { webs } = classifyTrunks(webNodes(), webEdges());
    expect(webs).toHaveLength(1);
    expect(webs[0]!.item).toBe("s");
    expect([...webs[0]!.sources].sort()).toEqual(["s1", "s2"]);
    expect([...webs[0]!.targets].sort()).toEqual(["t1", "t2"]);
    expect(webs[0]!.members).toHaveLength(4);
  });

  it("reads the same component minus one edge as one fan-out plus one fan-in", () => {
    const { webs, trunks } = classifyTrunks(
      webNodes(),
      webEdges().filter((e) => e.id !== "e:3"),
    );
    expect(webs).toEqual([]);
    expect(
      trunks.map((t) => [t.kind, t.unit, t.members.length]).sort(),
    ).toEqual([
      ["fanIn", "t1", 2],
      ["fanOut", "s1", 2],
    ]);
  });

  it("totals a trunk's member rates and elects the lex-smallest owner", () => {
    const { trunks } = classifyTrunks(
      webNodes(),
      webEdges().filter((e) => e.id === "e:0" || e.id === "e:1"),
    );
    expect(trunks).toHaveLength(1);
    expect(trunks[0]!.owner).toBe("e:0");
    expect(trunks[0]!.total.equals(new Fraction(2))).toBe(true);
  });
});
