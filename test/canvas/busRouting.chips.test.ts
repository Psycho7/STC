// Chip placement over routed trunks: which member draws a trunk's aggregate
// chip and where the two trunk chips stand on the drawn shape. Fixtures come
// from ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { routeTrunkEdges } from "../../src/canvas/busRouting";
import { drawnEdge, PORT_STUB } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { branchChipText, chipSeatHalfW } from "../../src/canvas/chipMetrics";
import {
  BETWEEN_LAYERS_SPACING,
  DOT_KEEPOFF,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  mkEdge,
  orderedRecipeNode,
} from "./busRouting.testkit";

describe("chip placement: fan-out trunk chips", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // One layer over: a card plus the 110-unit gap right of the source.
  const oneGap = RECIPE_WIDTH + BETWEEN_LAYERS_SPACING;

  const dataOf = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      busChipOwner?: boolean;
    };

  // The two-member fan-out both cases below run on.
  const fixture = (): { nodes: RFAnyNode[]; edges: Edge[] } => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    return { nodes, edges: routeTrunkEdges(nodes, edges) };
  };

  it("marks one owner, and the bookkeeping pass leaves both members alone", () => {
    // Every trunk draws one aggregate chip, on its owner. Where that chip
    // stands is the path builder's rule, so the pass stamps neither member with
    // anything about it -- an untouched edge comes back by reference.
    const { nodes, edges } = fixture();
    expect(dataOf(edges, "e0").busChipOwner).toBe(true);
    expect(dataOf(edges, "e1").busChipOwner).toBe(false);

    const out = deconflictChipAnchors(nodes, edges);
    expect(out[0]).toBe(edges[0]);
    expect(out[1]).toBe(edges[1]);
  });

  it("stands both trunk chips on their own run, off the split dot", () => {
    // The aggregate on the shared trunk run, its box a port stub out of the
    // source port; the member's own chip on its last horizontal leg, its box a
    // port stub back from the target port. This fixture's gap is narrower than
    // one chip box -- the reserve pre-pass is not run here -- so the aggregate
    // takes the end of its short run rather than both pads; the whole-corpus
    // suite pins the pads on gaps the pre-pass widened.
    const { nodes, edges } = fixture();
    const byId = nodeIndexOf(nodes);
    const owner = edges.find((e) => e.id === "e0")!;
    const ends = drawnPortsOf(owner, byId)!;
    const drawn = drawnEdge(ends, "bus", owner.data);
    expect(drawn.shape).toBe("fanout");
    if (drawn.shape !== "fanout") return;

    const memberHalfW = chipSeatHalfW(branchChipText(owner), false);
    expect(drawn.trunkAnchor.y).toBe(ends.sourceY);
    expect(drawn.branchAnchor.y).toBe(ends.targetY);
    // Both anchors stay ON their own run: the aggregate between the source port
    // and the dot, the member between the branch chamfer and the target port.
    expect(drawn.trunkAnchor.x).toBeGreaterThanOrEqual(ends.sourceX);
    expect(drawn.trunkAnchor.x).toBeLessThanOrEqual(drawn.junction.x);
    expect(drawn.branchAnchor.x).toBeLessThanOrEqual(ends.targetX);
    // The member's chip is measured from the target port: one stub back, or the
    // dot keep-off when the leg is shorter than that.
    expect(drawn.branchAnchor.x + memberHalfW).toBeLessThanOrEqual(
      ends.targetX - PORT_STUB + 2 * memberHalfW,
    );
    // The member's leg is a row below the trunk, so its chip clears the split
    // dot in y whatever the corridor does.
    expect(Math.abs(drawn.branchAnchor.y - drawn.junction.y)).toBeGreaterThan(
      DOT_KEEPOFF,
    );
  });
});

// Which member carries the trunk's total, tier by tier. A near member draws the
// trunk segment and takes it whenever one exists; with none, the election falls
// through to the far members, preferring one that BENDS so the total and the
// split dot ride one line. Near / far is layer distance, so a far fixture parks
// a filler card in the layer between.
describe("chip placement: which member draws the trunk's total", () => {
  const ITEM = "s";
  const LAYER_PITCH = BETWEEN_LAYERS_SPACING + RECIPE_WIDTH;

  const producer = (id: string, x: number, y: number): RFAnyNode =>
    recipeNode(id, x, y, mkRecipe(id, [], [ITEM]));
  const consumer = (id: string, x: number, y: number): RFAnyNode =>
    orderedRecipeNode(id, x, y, [ITEM]);
  // Far below the trunk's rows: it makes the layer the near / far split needs
  // without standing in any member's way.
  const filler = (id: string, x: number): RFAnyNode => consumer(id, x, 2800);
  const link = (id: string, target: string): Edge =>
    mkEdge(id, "src", target, ITEM);

  const ownerOf = (edges: Edge[]): string | undefined =>
    edges.find(
      (edge) => (edge.data as { busChipOwner?: boolean }).busChipOwner === true,
    )?.id;

  it("elects the lex-smallest NEAR member while one exists", () => {
    // e:1 reaches three layers over and e:2 the next one: the near member takes
    // the aggregate even though it is not the lex-smallest of the two.
    const nodes: RFAnyNode[] = [
      producer("src", 0, 0),
      consumer("near", LAYER_PITCH, 260),
      filler("mid", LAYER_PITCH),
      consumer("far", 3 * LAYER_PITCH, 620),
    ];
    const routed = routeTrunkEdges(nodes, [
      link("e:1", "far"),
      link("e:2", "near"),
    ]);
    expect(ownerOf(routed)).toBe("e:2");
    expect(routed.find((e) => e.id === "e:2")!.type).toBe("bus");
    // The far member carries the column alone, with no aggregate of its own.
    const far = routed.find((e) => e.id === "e:1")!.data as {
      fanoutColumn?: boolean;
      trunkKey?: string;
    };
    expect(far.fanoutColumn).toBe(true);
    expect(far.trunkKey).toBeUndefined();
  });

  it("elects the lex-smallest BENDING far member when no member is near", () => {
    // e:1 leaves the port and runs straight to its target, so it never peels off
    // and carries no split of its own; e:2 bends, and takes the total.
    const nodes: RFAnyNode[] = [
      producer("src", 0, 0),
      filler("mid", LAYER_PITCH),
      consumer("far1", 3 * LAYER_PITCH, 0),
      consumer("far2", 3 * LAYER_PITCH, 420),
    ];
    const routed = routeTrunkEdges(nodes, [
      link("e:1", "far1"),
      link("e:2", "far2"),
    ]);
    expect(routed.every((edge) => edge.type === "item")).toBe(true);
    expect(ownerOf(routed)).toBe("e:2");
    // The owner seats the total on its own source stub, out of the item shape.
    const owner = routed.find((edge) => edge.id === "e:2")!;
    const ends = drawnPortsOf(owner, nodeIndexOf(nodes))!;
    const drawn = drawnEdge(ends, owner.type, owner.data);
    expect(drawn.shape).toBe("item");
    if (drawn.shape !== "item") return;
    expect(drawn.trunkAnchor).toBeDefined();
    expect(drawn.trunkAnchor!.y).toBe(ends.sourceY);
    expect(drawn.trunkAnchor!.x).toBeGreaterThan(ends.sourceX);
  });

  it("elects the lex-smallest far member when none of them bends", () => {
    // Both targets stand on the source's own row, two and three layers over, so
    // neither member bends and the plain lex order decides.
    const nodes: RFAnyNode[] = [
      producer("src", 0, 0),
      filler("mid", LAYER_PITCH),
      consumer("far1", 2 * LAYER_PITCH, 0),
      consumer("far2", 3 * LAYER_PITCH, 0),
    ];
    const routed = routeTrunkEdges(nodes, [
      link("e:1", "far2"),
      link("e:2", "far1"),
    ]);
    expect(routed.every((edge) => edge.type === "item")).toBe(true);
    expect(ownerOf(routed)).toBe("e:1");
  });
});
