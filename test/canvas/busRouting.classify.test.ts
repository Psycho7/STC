// Fan-out classification and the direct-corridor gate. Fixtures come from
// ./busRouting.testkit.
//
// Membership is topological: any (item, source unit) port feeding two or more
// target units is a trunk, whatever the gap widths are. The column comes from
// the gap record the pre-pass produced, so a fixture that wants real columns
// builds its gaps with widenLayerGaps rather than typing them by hand.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeTrunkEdges,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  directCorridorClear,
  jogForwardLegs,
} from "../../src/canvas/busRouting";
import { COLUMN_PITCH, widenLayerGaps } from "../../src/canvas/layerModel";
import { nodeWidth } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
} from "./busRouting.testkit";

describe("routeTrunkEdges (6C)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // One layer over: the targets' left edge, 110 right of the source card.
  const oneGap = 410;

  const fanData = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      fanout?: boolean;
      trunkKey?: string;
      junctionX?: number;
      busTotalRate?: Fraction;
      busMemberCount?: number;
      busChipOwner?: boolean;
    };

  it("groups two same-source-port one-gap edges into a fan-out trunk", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeTrunkEdges(nodes, edges);

    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      const d = fanData(out, id);
      expect(d.fanout).toBe(true);
      expect(d.trunkKey).toBe("b|s");
      // Junction column stamped, inside the corridor.
      expect(typeof d.junctionX).toBe("number");
      expect(d.junctionX!).toBeGreaterThan(300); // right of source
      expect(d.junctionX!).toBeLessThan(oneGap); // left of targets
    }
    // Aggregate = summed member rates (1 + 1), count 2, exactly one owner.
    const owners = out.filter((e) => fanData(out, e.id).busChipOwner);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.id).toBe("e0"); // lex-smallest edge id
    const agg = fanData(out, "e0");
    expect(agg.busTotalRate!.equals(new Fraction(2))).toBe(true);
    expect(agg.busMemberCount).toBe(2);
    // Both members share ONE junction column.
    expect(fanData(out, "e0").junctionX).toBe(fanData(out, "e1").junctionX);
  });

  it("forms an N=3 fan-out where every member reaches its own target", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];

    const out = routeTrunkEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
      expect(fanData(out, id).fanout).toBe(true);
    }
    expect(fanData(out, "e0").busMemberCount).toBe(3);
    expect(fanData(out, "e0").busTotalRate!.equals(new Fraction(3))).toBe(true);
    // One shared junction across all three branches.
    const jx = new Set(
      ["e0", "e1", "e2"].map((id) => fanData(out, id).junctionX),
    );
    expect(jx.size).toBe(1);
    // Exactly the lex-smallest edge (e0) is the elected owner; the branches are
    // non-owners.
    expect(fanData(out, "e0").busChipOwner).toBe(true);
    expect(fanData(out, "e1").busChipOwner).toBe(false);
    expect(fanData(out, "e2").busChipOwner).toBe(false);
  });

  it("does NOT fan out a lone within-gap member (N=1)", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b")];
    const out = routeTrunkEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[0]).toBe(edges[0]); // untouched by reference
  });

  it("does NOT fan out different items, different ports, or different sources", () => {
    const rMulti = mkRecipe("rMulti", ["a"], ["b", "c"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, rMulti),
      recipeNode("s2", 0, 900, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 900, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"), // item b from s
      mkEdge("e1", "s", "t2", "c"), // item c from s -> different port
      mkEdge("e2", "s2", "t3", "b"), // item b from a different source
    ];
    const out = routeTrunkEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("item");
    }
  });

  it("forms a trunk in a gap too tight for the old span floor", () => {
    // Gap 60, below the stub + chamfer budget a junction column used to need:
    // membership is topological now, so the pair is a trunk all the same. The
    // pre-pass widens such a gap before this runs; the pass itself never
    // declines one.
    const tight = 360;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", tight, 0, r),
      recipeNode("t2", tight, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeTrunkEdges(nodes, edges);
    expect(out[0]!.type).toBe("bus");
    expect(out[1]!.type).toBe("bus");
  });

  it("does NOT retype backward members", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", oneGap, 0, r), // source right of the targets
      recipeNode("t1", 0, 0, r),
      recipeNode("t2", 0, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeTrunkEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("splits a trunk's members by layer distance", () => {
    // One port with all three member kinds. Layers left to right: t0 (the
    // backward target), s, t1, t2 -- so t1 is one layer over (near), t2 two
    // (far) and t0 sits behind the source.
    const nodes: RFAnyNode[] = [
      recipeNode("t0", -oneGap, 600, r),
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", 2 * oneGap, 300, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t0", "b"),
    ];
    const out = routeTrunkEdges(nodes, edges);

    // Next layer over: a bus branch carrying the whole trunk aggregate.
    const near = out.find((e) => e.id === "e0")!;
    expect(near.type).toBe("bus");
    const nearData = fanData(out, "e0");
    expect(nearData.fanout).toBe(true);
    expect(nearData.trunkKey).toBe("b|s");
    expect(typeof nearData.junctionX).toBe("number");
    expect(nearData.busChipOwner).toBe(true);
    // The backward member counts in both aggregate fields.
    expect(nearData.busMemberCount).toBe(3);
    expect(nearData.busTotalRate!.equals(new Fraction(3))).toBe(true);

    // Two layers over: still an item edge, pinned to the trunk's column.
    const far = out.find((e) => e.id === "e1")!;
    expect(far.type).toBe("item");
    const farData = far.data as { bendX?: number; fanoutColumn?: boolean };
    expect(farData.bendX).toBe(nearData.junctionX);
    expect(farData.fanoutColumn).toBe(true);

    // Backward: still an item edge drawing its detour rail, but its rail leaves
    // the source on the trunk's own column instead of a default one stub out,
    // so the return joins the line its forward siblings share.
    const backward = out.find((e) => e.id === "e2")!;
    expect(backward.type).toBe("item");
    const backData = backward.data as {
      railXRight?: number;
      fanout?: boolean;
      bendX?: number;
    };
    expect(backData.railXRight).toBe(nearData.junctionX);
    expect(backData.fanout).toBeUndefined();
    expect(backData.bendX).toBeUndefined();
  });

  it("retypes a lone near member beside a far sibling", () => {
    // No two-near minimum: the trunk exists topologically, and its aggregate
    // chip needs a trunk segment to sit on, so the single near member becomes
    // the bus branch that draws it.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", 2 * oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeTrunkEdges(nodes, edges);
    expect(out.find((e) => e.id === "e0")!.type).toBe("bus");
    expect(fanData(out, "e0").busChipOwner).toBe(true);
    expect(out.find((e) => e.id === "e1")!.type).toBe("item");
    expect(
      (out.find((e) => e.id === "e1")!.data as { bendX?: number }).bendX,
    ).toBe(fanData(out, "e0").junctionX);
  });

  it("fans out input-product feeders like any other qualifying pair", () => {
    // Aggregate -> tap feeders get no special treatment: two short-gap edges
    // off one aggregate port group into a fan-out trunk exactly as recipe
    // edges would.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0), // right edge 148
      inputProductNode("t1", "ore", 300, 0),
      inputProductNode("t2", "ore", 300, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = routeTrunkEdges(nodes, edges);
    for (const id of ["e0", "e1"]) {
      const edge = out.find((e) => e.id === id)!;
      expect(edge.type).toBe("bus");
      expect((edge.data as { fanout?: boolean }).fanout).toBe(true);
    }
  });

  it("gives every fan-out trunk of one gap its own column slot", () => {
    // Two trunks fanning out of one layer. The gap record reserved a column
    // apiece, and the slots are handed out top-to-bottom by source-port y, so
    // the two verticals sit one COLUMN_PITCH apart inside the zone instead of
    // drawing as one line.
    const rc = mkRecipe("rc", ["a"], ["c"]);
    const placed: RFAnyNode[] = [
      recipeNode("sA", 0, 0, r),
      recipeNode("sB", 0, 400, rc),
      recipeNode("tA1", oneGap, 0, r),
      recipeNode("tA2", oneGap, 200, r),
      recipeNode("tB1", oneGap, 400, r),
      recipeNode("tB2", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "sA", "tA1", "b"),
      mkEdge("e1", "sA", "tA2", "b"),
      mkEdge("e2", "sB", "tB1", "c"),
      mkEdge("e3", "sB", "tB2", "c"),
    ];
    const { nodes, gaps } = widenLayerGaps(placed, edges);
    // Premise: one gap, reserved for exactly these two columns.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.columns).toBe(2);
    const zone = gaps[0]!.columnZone;

    const out = routeTrunkEdges(nodes, edges, { gaps });
    const jxA = fanData(out, "e0").junctionX!;
    const jxB = fanData(out, "e2").junctionX!;
    expect(jxA).toBe(zone.left + COLUMN_PITCH / 2);
    expect(jxB).toBe(zone.left + COLUMN_PITCH / 2 + COLUMN_PITCH);
    expect(jxB - jxA).toBe(COLUMN_PITCH);
    for (const jx of [jxA, jxB]) {
      expect(jx).toBeGreaterThanOrEqual(zone.left);
      expect(jx).toBeLessThanOrEqual(zone.right);
    }
    // Every member of a trunk rides its trunk's own column.
    expect(fanData(out, "e1").junctionX).toBe(jxA);
    expect(fanData(out, "e3").junctionX).toBe(jxB);
    // Order-independence: shuffled edges resolve the same slots.
    const shuffled = routeTrunkEdges(
      nodes,
      [edges[3]!, edges[1]!, edges[2]!, edges[0]!],
      { gaps },
    );
    expect(fanData(shuffled, "e0").junctionX).toBe(jxA);
    expect(fanData(shuffled, "e2").junctionX).toBe(jxB);
  });

  it("falls back to the corridor midpoint with no gap record to read", () => {
    // A caller that hands no ctx (a hand-built fixture, or a re-run of the
    // passes alone) has no reserved zone: the column is the midpoint of the
    // source-to-nearest-target corridor, the same point chamferFanoutPath
    // would clamp a junction to.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const sx = nodeWidth(nodes[0]!);
    const out = routeTrunkEdges(nodes, edges);
    expect(fanData(out, "e0").junctionX).toBe((sx + oneGap) / 2);
    expect(fanData(out, "e1").junctionX).toBe((sx + oneGap) / 2);
  });

  it("assigns fan-out fields deterministically across shuffled input", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];
    const project = (out: Edge[]) =>
      [...out]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => {
          const d = e.data as {
            fanout?: boolean;
            trunkKey?: string;
            junctionX?: number;
            busChipOwner?: boolean;
          };
          return {
            id: e.id,
            type: e.type,
            fanout: d.fanout,
            trunkKey: d.trunkKey,
            junctionX: d.junctionX,
            owner: d.busChipOwner,
          };
        });
    const a = routeTrunkEdges(nodes, edges);
    const b = routeTrunkEdges([...nodes].reverse(), [
      edges[2]!,
      edges[0]!,
      edges[1]!,
    ]);
    expect(project(a)).toEqual(project(b));
  });

  it("routes a fan-out member through the whole pipeline as a bus edge", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = deconflictChipAnchors(
      nodes,
      clampBackwardRails(
        nodes,
        jogForwardLegs(
          nodes,
          assignBendColumns(
            nodes,
            assignEntryColumns(nodes, routeTrunkEdges(nodes, edges)),
          ),
        ),
      ),
    );
    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      expect((e.data as { fanout?: boolean }).fanout).toBe(true);
    }
  });
});

describe("directCorridorClear", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // Past two full layers (a 300-wide card plus a 410 layer pitch), the reach
  // the census helper is asked about.
  const far = 300 + 2 * 410 + 50;

  it("reads a card-straddled corridor as blocked", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      recipeNode("mid", 600, 0, r), // straddles the corridor at the target row
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    expect(directCorridorClear(nodes, edges, edges[0]!)).toBe(false);
  });
});
