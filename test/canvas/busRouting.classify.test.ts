// Bus classification and lane assignment: routeBusEdges (which edges become bus
// members), the two-sided top/bottom lane bands, single-member demotion, the
// direct-corridor gate, and per-trunk rise-chip slotting. Fixtures come from
// ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  routeFanoutEdges,
  laneBands,
  busBandRegions,
  BAND_Y_PAD,
  BAND_X_MARGIN,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearBusColumns,
  directCorridorClear,
  jogForwardLegs,
  entryGutterRects,
  gutterWidth,
  paddedObstacles,
  BUS_SPAN_THRESHOLD,
  FANOUT_SPAN_MAX,
  FANOUT_SPAN_MIN,
  LANE_TOP_OFFSET,
  LANE_SPACING,
} from "../../src/canvas/busRouting";
import { nodeWidth, portOffsetY } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import {
  PORT_STUB,
  CHAMFER,
  busDropBase,
  busRiseBase,
  chamferFanoutPath,
  parsePathPoints,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import type { RFAnyNode } from "../../src/canvas/layout";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
  maxBottom,
  minTop,
  orderedRecipeNode,
} from "./busRouting.testkit";

describe("routeBusEdges", () => {
  it("leaves a short edge untouched", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 400, 0, r), // gap 400 - 300 = 100 < 820
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out).toHaveLength(1);
    expect(out[0]).toBe(edges[0]); // same reference, no bus fields
    expect(out[0]!.type).toBe("item");
    expect(out[0]!.data).not.toHaveProperty("laneY");
  });

  it("retypes a long edge to bus with a lane below every node", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 0 + 300 + (BUS_SPAN_THRESHOLD + 50), 200, r),
      // A card straddling the direct corridor at the target row, so the lone
      // member is NOT demoted to a plain item edge (Task 12) and stays on a lane.
      recipeNode("mid", 600, 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    const data = out[0]!.data as { laneY: number; trunkKey: string };
    expect(data.trunkKey).toBe("b|s");
    // First (only) slot: bandTop with slot 0.
    expect(data.laneY).toBe(maxBottom(nodes) + LANE_TOP_OFFSET);
    // Strictly below every node's bottom.
    for (const n of nodes) {
      const h = measureRecipe(r).height;
      expect(data.laneY).toBeGreaterThan(n.position.y + h);
    }
    // Existing data preserved.
    expect(data).toHaveProperty("item", "b");
  });

  it("shares one trunkKey and laneY across long edges of the same item+source", () => {
    const r = mkRecipe("r", ["a"], ["b"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeBusEdges(nodes, edges);

    const d0 = out[0]!.data as {
      laneY: number;
      trunkKey: string;
      busChipOwner: boolean;
    };
    const d1 = out[1]!.data as {
      laneY: number;
      trunkKey: string;
      busChipOwner: boolean;
    };
    expect(d0.trunkKey).toBe("b|s");
    expect(d1.trunkKey).toBe("b|s");
    expect(d0.laneY).toBe(d1.laneY);
    // The lex-smallest edge id (e0) is the elected owner that draws the aggregate
    // chip; the sibling is a non-owner.
    expect(d0.busChipOwner).toBe(true);
    expect(d1.busChipOwner).toBe(false);
  });

  it("puts different items on lanes LANE_SPACING apart in item-sorted order", () => {
    const rApple = mkRecipe("rApple", ["x"], ["apple"]);
    const rBanana = mkRecipe("rBanana", ["x"], ["banana"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    // Declare the banana source first to prove ordering is by item, not input.
    // Each lone member's corridor is blocked at its own target row so both stay
    // bus members (Task 12) instead of demoting to plain item edges. Both trunks
    // sit in the lower half (an anchor node up top pulls the graph midline above
    // them), so they share the BOTTOM band and this pins within-band slot order;
    // the top/bottom split is exercised by the two-sided-bands suite below.
    const nodes: RFAnyNode[] = [
      recipeNode("anchor", 0, 0, rApple),
      recipeNode("sBanana", 0, 800, rBanana),
      recipeNode("tBanana", far, 800, rBanana),
      recipeNode("midBanana", 600, 800, rBanana),
      recipeNode("sApple", 0, 900, rApple),
      recipeNode("tApple", far, 900, rApple),
      recipeNode("midApple", 600, 900, rApple),
    ];
    const edges = [
      mkEdge("e0", "sBanana", "tBanana", "banana"),
      mkEdge("e1", "sApple", "tApple", "apple"),
    ];

    const out = routeBusEdges(nodes, edges);

    const byId = new Map(
      out.map((e) => [e.id, e.data as { laneY: number; trunkKey: string }]),
    );
    const apple = byId.get("e1")!;
    const banana = byId.get("e0")!;
    // apple sorts before banana -> slot 0, banana slot 1.
    expect(banana.laneY - apple.laneY).toBe(LANE_SPACING);
    const bandTop = maxBottom(nodes) + LANE_TOP_OFFSET;
    expect(apple.laneY).toBe(bandTop);
    expect(banana.laneY).toBe(bandTop + LANE_SPACING);
  });

  it("leaves a short input-product -> input-product feeder as a plain item edge", () => {
    // Aggregate and tap sit one next to the other (span well under threshold).
    // Feeders no longer ride the bus by node kind; span is the only rule, so a
    // short feeder stays a direct item edge.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0), // gap 200 - 148 = 52 < 820
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("item");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBeUndefined();
  });

  it("is deterministic: shuffled input order yields identical output", () => {
    const rApple = mkRecipe("rApple", ["x"], ["apple"]);
    const rBanana = mkRecipe("rBanana", ["x"], ["banana"]);
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    // Corridor blockers keep both lone members on the bus (Task 12) so this
    // exercises deterministic lane assignment, not the demotion path.
    const nodes: RFAnyNode[] = [
      recipeNode("sBanana", 0, 0, rBanana),
      recipeNode("tBanana", far, 0, rBanana),
      recipeNode("midBanana", 600, 0, rBanana),
      recipeNode("sApple", 0, 400, rApple),
      recipeNode("tApple", far, 400, rApple),
      recipeNode("midApple", 600, 400, rApple),
    ];
    const edges = [
      mkEdge("e0", "sBanana", "tBanana", "banana"),
      mkEdge("e1", "sApple", "tApple", "apple"),
    ];
    const shuffledNodes = [...nodes].reverse();
    const shuffledEdges = [edges[1]!, edges[0]!];

    // Project to the deterministic bus fields (the rate Fraction carries a
    // BigInt that JSON can't serialize, and is irrelevant to routing). busBand
    // rides along so band assignment is pinned as part of determinism. Keyed by
    // edge id so the two runs compare per edge regardless of emit order.
    const project = (out: Edge[]) =>
      [...out]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => {
          const d = e.data as {
            laneY?: number;
            trunkKey?: string;
            busBand?: string;
          };
          return {
            id: e.id,
            type: e.type,
            laneY: d.laneY,
            trunkKey: d.trunkKey,
            busBand: d.busBand,
          };
        });

    expect(project(routeBusEdges(nodes, edges))).toEqual(
      project(routeBusEdges(shuffledNodes, shuffledEdges)),
    );
  });
});

describe("routeBusEdges two-sided lane bands (9B)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);

  function bandOf(edges: Edge[], id: string): string | undefined {
    return (edges.find((e) => e.id === id)?.data as { busBand?: string })
      .busBand;
  }
  function laneYOf(edges: Edge[], id: string): number {
    return (edges.find((e) => e.id === id)!.data as { laneY: number }).laneY;
  }

  it("puts an upper-half trunk in the top band, above every node", () => {
    // Two members share one trunk (no demotion). Both endpoints sit near the top
    // while a lone node far below drags the graph midline well beneath the
    // trunk's port Ys, so its mean member port Y lands in the upper half.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 100, r),
      recipeNode("low", 0, 3000, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(bandOf(out, "e0")).toBe("top");
    expect(bandOf(out, "e1")).toBe("top");
    // First top slot sits one LANE_TOP_OFFSET above the highest node top.
    const laneY = laneYOf(out, "e0");
    expect(laneY).toBe(minTop(nodes) - LANE_TOP_OFFSET);
    expect(laneYOf(out, "e1")).toBe(laneY);
    // Strictly above every node's top edge.
    for (const n of nodes) expect(laneY).toBeLessThan(n.position.y);
  });

  it("keeps a lower-half trunk in the bottom band, below every node", () => {
    // Mirror of the top case: the trunk sits low while a lone node up top lifts
    // the midline above nothing -- the trunk's mean port Y stays in the lower
    // half, so it lands in the bottom band exactly as the pre-split pass placed
    // every trunk.
    const nodes: RFAnyNode[] = [
      recipeNode("high", 0, 0, r),
      recipeNode("s", 0, 3000, r),
      recipeNode("t1", far, 3000, r),
      recipeNode("t2", far, 3100, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(bandOf(out, "e0")).toBe("bottom");
    const laneY = laneYOf(out, "e0");
    expect(laneY).toBe(maxBottom(nodes) + LANE_TOP_OFFSET);
    // Strictly below every node's bottom edge.
    for (const n of nodes) {
      const h = measureRecipe(r).height;
      expect(laneY).toBeGreaterThan(n.position.y + h);
    }
  });

  it("emits band extents consistent with the assigned lane Ys", () => {
    // One trunk high (top band) and one low (bottom band), each blocked at its
    // own target row so both stay bus members. laneBands must report each band's
    // extent as the min/max of the lanes routeBusEdges actually stamped.
    const nodes: RFAnyNode[] = [
      recipeNode("sHi", 0, 0, r),
      recipeNode("tHi", far, 0, r),
      recipeNode("midHi", 600, 0, r),
      recipeNode("sLo", 0, 2000, r),
      recipeNode("tLo", far, 2000, r),
      recipeNode("midLo", 600, 2000, r),
    ];
    const edges = [
      mkEdge("e0", "sHi", "tHi", "b"),
      mkEdge("e1", "sLo", "tLo", "b"),
    ];

    const out = routeBusEdges(nodes, edges);
    const bands = laneBands(out);

    // The stamped lanes, grouped by the band routeBusEdges assigned.
    const topYs = out
      .filter((e) => (e.data as { busBand?: string }).busBand === "top")
      .map((e) => (e.data as { laneY: number }).laneY);
    const bottomYs = out
      .filter((e) => (e.data as { busBand?: string }).busBand === "bottom")
      .map((e) => (e.data as { laneY: number }).laneY);
    expect(topYs.length).toBeGreaterThan(0);
    expect(bottomYs.length).toBeGreaterThan(0);

    expect(bands.top).toEqual({
      y0: Math.min(...topYs),
      y1: Math.max(...topYs),
    });
    expect(bands.bottom).toEqual({
      y0: Math.min(...bottomYs),
      y1: Math.max(...bottomYs),
    });
    // Normalized (y0 <= y1) and anchored to the two band tops.
    expect(bands.top!.y0).toBeLessThanOrEqual(bands.top!.y1);
    expect(bands.bottom!.y0).toBeLessThanOrEqual(bands.bottom!.y1);
    expect(bands.top!.y1).toBe(minTop(nodes) - LANE_TOP_OFFSET);
    expect(bands.bottom!.y0).toBe(maxBottom(nodes) + LANE_TOP_OFFSET);
  });

  it("reports a null band when no trunk lands in it", () => {
    // Every trunk here sits in the bottom half, so laneBands has a bottom extent
    // and a null top.
    const nodes: RFAnyNode[] = [
      recipeNode("high", 0, 0, r),
      recipeNode("s", 0, 3000, r),
      recipeNode("t1", far, 3000, r),
      recipeNode("t2", far, 3100, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const bands = laneBands(routeBusEdges(nodes, edges));
    expect(bands.top).toBeNull();
    expect(bands.bottom).not.toBeNull();
  });

  it("sends an exact-midline trunk to the bottom band, deterministically", () => {
    // A lone long-span feeder whose source and target ports share one y: its
    // mean member port Y equals the graph midline exactly (the mid blocker has
    // the same height and y, so it moves neither bound). The blocker keeps the
    // corridor unprovable so the lone member stays on the lane instead of
    // demoting. The tiebreak sends it to the bottom band (the pre-split
    // default), and two runs agree.
    const bothFar = 148 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", bothFar, 0),
      inputProductNode("mid", "ore", 500, 0),
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges(nodes, edges);
    expect(bandOf(a, "e0")).toBe("bottom");
    expect(bandOf(a, "e0")).toBe(bandOf(b, "e0"));
    expect(laneYOf(a, "e0")).toBe(laneYOf(b, "e0"));
  });
});

describe("busBandRegions", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 2000;

  // The band x-extent tracks its trunk RUN (drop column .. rise column), not the
  // node span: the shared column bases (busDropBase / busRiseBase), each padded
  // by BAND_X_MARGIN. sourceRight / targetLeft are absolute here (parent-less).
  const trunkRunX = (sourceRight: number, targetLeft: number) => {
    const dropCol = busDropBase(sourceRight);
    const riseCol = busRiseBase(targetLeft);
    const lo = Math.min(dropCol, riseCol) - BAND_X_MARGIN;
    const hi = Math.max(dropCol, riseCol) + BAND_X_MARGIN;
    return { x: lo, width: hi - lo };
  };

  it("maps each non-null band to its lane extent padded by BAND_Y_PAD", () => {
    // One trunk high (top band) and one low (bottom band), each blocked at its
    // own target row, so both bands hold a trunk -- mirrors the laneBands extent
    // fixture. Every region's y-extent is the band's lane range padded, and its
    // x-extent is the trunk's own drop..rise run padded -- narrower than the node
    // span, which here also spans the two mid blockers and the target's full
    // width.
    const nodes: RFAnyNode[] = [
      recipeNode("sHi", 0, 0, r),
      recipeNode("tHi", far, 0, r),
      recipeNode("midHi", 600, 0, r),
      recipeNode("sLo", 0, 2000, r),
      recipeNode("tLo", far, 2000, r),
      recipeNode("midLo", 600, 2000, r),
    ];
    const edges = [
      mkEdge("e0", "sHi", "tHi", "b"),
      mkEdge("e1", "sLo", "tLo", "b"),
    ];

    const out = routeBusEdges(nodes, edges);
    const bands = laneBands(out);
    const regions = busBandRegions(nodes, out);
    // Both bands' trunks run from the source's right edge (0 + width) to the
    // target's left edge (far).
    const run = trunkRunX(nodeWidth(nodes[0]!), far);

    expect(regions.map((rg) => rg.band).sort()).toEqual(["bottom", "top"]);
    for (const band of ["top", "bottom"] as const) {
      const extent = bands[band]!;
      const region = regions.find((rg) => rg.band === band)!;
      expect(region.y).toBe(extent.y0 - BAND_Y_PAD);
      expect(region.height).toBe(extent.y1 - extent.y0 + 2 * BAND_Y_PAD);
      expect(region.x).toBe(run.x);
      expect(region.width).toBe(run.width);
      // The run is strictly inside the padded node span (right edge at far +
      // width), proving the band hugs its routing rather than the nodes.
      expect(region.x + region.width).toBeLessThan(
        far + nodeWidth(nodes[1]!) + BAND_X_MARGIN,
      );
    }
  });

  it("gives a single-lane band a full 2*BAND_Y_PAD height", () => {
    // One bottom-band trunk: its lane extent is a single y (y0 == y1), so the
    // region has no intrinsic height -- the padding alone makes it visible.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      recipeNode("mid", 600, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);
    const bands = laneBands(out);
    const regions = busBandRegions(nodes, out);

    expect(bands.top).toBeNull();
    expect(regions).toHaveLength(1);
    expect(regions[0]!.band).toBe("bottom");
    expect(regions[0]!.height).toBe(2 * BAND_Y_PAD);
  });

  it("covers a chip lifted a full cascade pitch, touching the padded edge", () => {
    // The pad exists for chips the seating pass lifts off their lane, so pin the
    // worst kept case: a max-scale box centred one cascade pitch (LANE_SPACING)
    // above the lane. Its outer edge lands ON the padded edge -- exact equality,
    // no slack -- which is why every "chip inside its band" check has to count
    // the boundary as inside.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      recipeNode("mid", 600, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);
    const laneY = laneBands(out).bottom!.y0;
    const region = busBandRegions(nodes, out)[0]!;

    const halfBox = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
    const liftedTop = laneY - LANE_SPACING - halfBox;
    const liftedBottom = laneY + LANE_SPACING + halfBox;

    expect(liftedTop).toBe(region.y);
    expect(liftedBottom).toBe(region.y + region.height);
  });

  it("returns no regions when no edge rides a lane", () => {
    // A short forward edge is never a bus member, so laneBands is all-null and
    // there is nothing to shade.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", 400, 0, r),
    ];
    const out = routeBusEdges(nodes, [mkEdge("e0", "s", "t", "b")]);
    expect(laneBands(out)).toEqual({ top: null, bottom: null });
    expect(busBandRegions(nodes, out)).toEqual([]);
  });
});

describe("routeBusEdges single-member demotion (9C)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);

  it("demotes a lone clear-corridor forward trunk to a plain item edge", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    // Stays type "item" and carries no bus scaffolding: no lane, no trunk key,
    // no rise-chip slot leaked on. It does carry the demotion's proven bend
    // column (bendX) -- the binding that keeps the drawn vertical on the column
    // the demotion gate actually proved clear.
    expect(out[0]!.type).toBe("item");
    expect(out[0]!.data).not.toHaveProperty("laneY");
    expect(out[0]!.data).not.toHaveProperty("trunkKey");
    expect(out[0]!.data).not.toHaveProperty("busChipX");
    expect(out[0]!.data).not.toHaveProperty("busTotalRate");
    expect(out[0]!.data).toHaveProperty("bendX");
  });

  it("keeps a lone member on the bus when a card blocks its corridor", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      // Straddles the direct corridor at the target row.
      recipeNode("mid", 600, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBe("b|s");
    // A lone member on a long run gets NO lane slot: with busChipX absent the
    // rise chip falls back to the rise column, so it sits at the consumer end
    // instead of stranding mid-lane (#32).
    expect(out[0]!.data).not.toHaveProperty("busChipX");
  });

  it("leaves a two-member trunk on the bus even when both corridors are clear", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeBusEdges(nodes, edges);

    // Same trunk (two members), so demotion never applies: both ride the lane.
    expect(out[0]!.type).toBe("bus");
    expect(out[1]!.type).toBe("bus");
  });

  it("demotes a lone input-product feeder like any other clear-corridor member", () => {
    // A long aggregate -> tap feeder: a single-member trunk whose corridor is
    // clear. Node kind grants no exemption, so it demotes to a plain item edge
    // exactly like a lone recipe-to-recipe member would.
    const bothFar = 148 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", bothFar, 0),
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("item");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBeUndefined();
  });

  it("demotes deterministically across shuffled node order", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges([...nodes].reverse(), edges);
    expect(a[0]!.type).toBe("item");
    expect(a[0]!.type).toBe(b[0]!.type);
    expect((a[0]!.data as { bendX?: number }).bendX).toBe(
      (b[0]!.data as { bendX?: number }).bendX,
    );
  });

  it("binds a demoted trunk to a proven clear bend column past a span blocker", () => {
    // The direct corridor at ty is clear (nothing at the target row between the
    // endpoints), but a card sits mid-corridor straddling the sy..ty span, so
    // the corridor midpoint -- the drawer's fallback and a fan's likely pick --
    // is a BLOCKED vertical. Demotion must therefore stamp the proven clear
    // column onto the edge (bendX off the blocker), and assignBendColumns must
    // respect the stamp instead of re-fanning it.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 400, r),
      // Straddles the vertical span at the corridor midpoint, below the source
      // row and above the target row, clear of both port ys.
      recipeNode("blocker", (300 + far) / 2 - 150, 200, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = assignBendColumns(nodes, routeBusEdges(nodes, edges));

    const e = out[0]!;
    expect(e.type).toBe("item"); // demoted
    const bendX = (e.data as { bendX?: number }).bendX;
    expect(bendX).toBeDefined();
    // The stamped column clears the blocker's padded band.
    const blocker = paddedObstacles(nodes, edges).find(
      (o) => o.kind === "card" && o.nodeId === "blocker",
    )!;
    expect(
      bendX! <= blocker.left - CHAMFER || bendX! >= blocker.right + CHAMFER,
    ).toBe(true);
  });

  it("keeps the lane when no clear bend column exists across the span", () => {
    // Same shape, but the sy..ty span is tiled with blockers wall to wall, so
    // no candidate column clears: the edge must stay a bus member.
    const blockers: RFAnyNode[] = [];
    for (let x = 300 - 40; x < far; x += 300 + 20) {
      blockers.push(recipeNode(`w${x}`, x, 200, r));
    }
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 400, r),
      ...blockers,
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);
    expect(out[0]!.type).toBe("bus");
  });

  it("routes a demoted member through the whole pipeline as a plain item edge", () => {
    // End to end: a demoted single-member trunk must flow through every
    // downstream pass as an item edge -- picking up bend-column treatment and no
    // bus fields -- exactly like any other forward item edge.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 100, r),
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = deconflictChipAnchors(
      nodes,
      clampBackwardRails(
        nodes,
        jogForwardLegs(
          nodes,
          assignBendColumns(
            nodes,
            clearBusColumns(
              nodes,
              assignEntryColumns(nodes, routeBusEdges(nodes, edges)),
            ),
          ),
        ),
      ),
    );

    const e = out[0]!;
    expect(e.type).toBe("item");
    expect(e.data).not.toHaveProperty("laneY");
    expect(e.data).not.toHaveProperty("busChipX");
    // Got bend-column staggering as a plain forward item edge.
    expect(e.data).toHaveProperty("bendX");
  });
});

describe("routeFanoutEdges (6C)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // One layer over: gap = 410 - 300 = 110, inside FANOUT_SPAN_MAX (410).
  const oneGap = 410;

  const fanData = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      fanout?: boolean;
      trunkKey?: string;
      junctionX?: number;
      laneY?: number;
      busTotalRate?: Fraction;
      busMemberCount?: number;
      busChipOwner?: boolean;
    };

  type Rect = { left: number; top: number; right: number; bottom: number };

  // Liang-Barsky segment clip: does segment a->b cross the rectangle's interior?
  // Boundary-only contact (a run grazing an edge) is not a crossing. Mirrors the
  // helper in busRouting.columns.test.ts.
  const segCrossesRect = (
    a: readonly [number, number],
    b: readonly [number, number],
    rect: Rect,
  ): boolean => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - rect.left, rect.right - a[0], a[1] - rect.top, rect.bottom - a[1]];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i]! < 0) return false;
        continue;
      }
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return t0 < t1;
  };

  const parseD = parsePathPoints;

  // Reconstruct a fan-out member's drawn polyline exactly as BusEdge does (same
  // builder + hints) and assert none of its segments cross the given raw rect.
  const assertMemberClearsRect = (
    out: Edge[],
    nodes: RFAnyNode[],
    id: string,
    rect: Rect,
  ): void => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const e = out.find((x) => x.id === id)!;
    const source = byId.get(e.source)!;
    const target = byId.get(e.target)!;
    const sx = source.position.x + nodeWidth(source);
    const sy = source.position.y + portOffsetY(source, "b", "out");
    const tx = target.position.x;
    const ty = target.position.y + portOffsetY(target, "b", "in");
    const d = chamferFanoutPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      ...routingHintsFromData(e.data),
    }).path;
    const pts = parseD(d);
    for (let i = 1; i < pts.length; i++) {
      expect(segCrossesRect(pts[i - 1]!, pts[i]!, rect)).toBe(false);
    }
  };

  it("groups two same-source-port one-gap edges into a fan-out trunk", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeFanoutEdges(nodes, edges);

    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      const d = fanData(out, id);
      expect(d.fanout).toBe(true);
      expect(d.trunkKey).toBe("b|s");
      // Off-lane: a fan-out never rides a lane band.
      expect(e.data).not.toHaveProperty("laneY");
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

    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
      expect(fanData(out, id).fanout).toBe(true);
    }
    expect(fanData(out, "e0").busMemberCount).toBe(3);
    expect(fanData(out, "e0").busTotalRate!.equals(new Fraction(3))).toBe(true);
    // One shared junction across all three branches.
    const jx = new Set(["e0", "e1", "e2"].map((id) => fanData(out, id).junctionX));
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
    const out = routeFanoutEdges(nodes, edges);
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
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("item");
    }
  });

  it("does NOT fan out a two-layer (multi-gap) pair", () => {
    // gap = 820 - 300 = 520 > FANOUT_SPAN_MAX (410): two layers over.
    const twoGap = 820;
    expect(twoGap - 300).toBeGreaterThan(FANOUT_SPAN_MAX);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", twoGap, 0, r),
      recipeNode("t2", twoGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("does NOT fan out a sub-budget (too-tight) gap", () => {
    // gap = 360 - 300 = 60 <= FANOUT_SPAN_MIN: no room for a distinct junction
    // column, so the pair stays plain item edges (boundary case).
    const tight = 360;
    expect(tight - 300).toBeLessThanOrEqual(FANOUT_SPAN_MIN);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", tight, 0, r),
      recipeNode("t2", tight, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("does NOT fan out backward edges", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", oneGap, 0, r), // source right of the targets
      recipeNode("t1", 0, 0, r),
      recipeNode("t2", 0, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("fans out input-product feeders like any other qualifying pair", () => {
    // Aggregate -> tap feeders get no special treatment: two short-gap edges
    // off one aggregate port group into a fan-out trunk exactly as recipe
    // edges would (gap 152 inside the (FANOUT_SPAN_MIN, FANOUT_SPAN_MAX]
    // window).
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0), // right edge 148
      inputProductNode("t1", "ore", 300, 0),
      inputProductNode("t2", "ore", 300, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1"]) {
      const edge = out.find((e) => e.id === id)!;
      expect(edge.type).toBe("bus");
      expect((edge.data as { fanout?: boolean }).fanout).toBe(true);
    }
  });

  it("does NOT double-capture long-span bus members", () => {
    // A two-member long-span trunk is already a lane bus after routeBusEdges;
    // routeFanoutEdges (running on that output) must leave them on the lane, not
    // reclassify them as a fan-out.
    const far = 300 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeFanoutEdges(nodes, routeBusEdges(nodes, edges));
    for (const id of ["e0", "e1"]) {
      const d = fanData(out, id);
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
      expect(d.fanout).not.toBe(true); // lane member, not fan-out
      expect(typeof d.laneY).toBe("number");
    }
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
    const a = routeFanoutEdges(nodes, edges);
    const b = routeFanoutEdges([...nodes].reverse(), [
      edges[2]!,
      edges[0]!,
      edges[1]!,
    ]);
    expect(project(a)).toEqual(project(b));
  });

  it("routes a fan-out member through the whole pipeline as an off-lane bus edge", () => {
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
            clearBusColumns(
              nodes,
              assignEntryColumns(
                nodes,
                routeFanoutEdges(nodes, routeBusEdges(nodes, edges)),
              ),
            ),
          ),
        ),
      ),
    );
    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      expect((e.data as { fanout?: boolean }).fanout).toBe(true);
      expect(e.data).not.toHaveProperty("laneY");
    }
  });

  it("dodges a foreign card straddling the junction column", () => {
    // The acceptance-gated junction stakes the shared column clear of a
    // mid-corridor obstacle AND keeps the shared trunk leg (source port ->
    // column) and every branch leg (column -> target port) off the card. Give
    // the corridor room (gap 380), read the unobstructed column, then drop a thin
    // foreign card straddling it and spanning the junction's vertical run but
    // sitting BETWEEN the two rows (clear of every port y), so a clean dodge that
    // clears all three horizontals exists.
    const wideGap = 680; // 680 - 300 = 380, inside FANOUT_SPAN_MAX (410)
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", wideGap, 0, r),
      recipeNode("t2", wideGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const clearJx = fanData(routeFanoutEdges(nodes, edges), "e0").junctionX!;

    // Thin card straddling clearJx, vertically between the two node rows so it
    // pierces the junction column but not the trunk / branch horizontals.
    const h = measureRecipe(r).height;
    const block = inputProductNode(
      "block",
      "ore",
      clearJx - 10,
      h + 20,
      20,
      340 - h,
    );
    const withBlock = [...nodes, block];
    const out = routeFanoutEdges(withBlock, edges);
    const jx = fanData(out, "e0").junctionX!;
    // Still one shared junction, still inside the corridor, dodged off the card.
    expect(jx).toBe(fanData(out, "e1").junctionX!);
    expect(jx).not.toBe(clearJx);
    expect(jx < clearJx - 10 || jx > clearJx + 10).toBe(true);
    expect(jx).toBeGreaterThan(300);
    expect(jx).toBeLessThan(wideGap);

    // Strengthened invariant: the drawn trunk AND branch horizontals clear the
    // card's raw box (not just the junction's vertical run).
    const blockRaw: Rect = {
      left: block.position.x,
      top: block.position.y,
      right: block.position.x + (block.width ?? 0),
      bottom: block.position.y + (block.height ?? 0),
    };
    assertMemberClearsRect(out, withBlock, "e0", blockRaw);
    assertMemberClearsRect(out, withBlock, "e1", blockRaw);
  });

  it("keeps members as plain item edges when no shared column clears", () => {
    // A thin card straddling the junction column and spanning the FULL vertical
    // extent (every port y): whichever side the shared column dodges to, either
    // the trunk leg or a branch leg would slice the card, so no acceptable shared
    // column exists. The fan-out does not form; the members stay plain item edges
    // (keeping the item-edge passes' per-leg jog protection a bus retype loses).
    const wideGap = 680;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", wideGap, 0, r),
      recipeNode("t2", wideGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const clearJx = fanData(routeFanoutEdges(nodes, edges), "e0").junctionX!;

    // Full-height straddling block: covers the trunk row and both branch rows.
    const block = inputProductNode("block", "ore", clearJx - 10, -200, 20, 1000);
    const out = routeFanoutEdges([...nodes, block], edges);
    ["e0", "e1"].forEach((id, i) => {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("item");
      expect(e).toBe(edges[i]); // untouched by reference
      expect(e.data).not.toHaveProperty("fanout");
      expect(e.data).not.toHaveProperty("junctionX");
    });
  });
});

describe("directCorridorClear", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);

  it("reads clear through a foreign gutter widened by post-retype bus rises", () => {
    // The demotion gate runs on PRE-retype edges (every gutter at its minimum
    // width) while the census recomputes on POST-retype edges, where bus rises
    // into m widen its gutter band back across e0's corridor. Card obstacles
    // are identical in both views, so the card-only corridor test keeps gate
    // and census in agreement; a gutter-sensitive test would demote e0 at the
    // gate yet read it blocked in the census -- the flake this pins against.
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      // Multi-entry consumer just right of the corridor: its padded card stays
      // outside e0's leg span [sx + stub, tx - stub], but at four post-retype
      // rise columns its gutter band reaches back across the corridor's end.
      orderedRecipeNode("m", far + 30, 0, ["p", "q"]),
      recipeNode("sp", -100, 400, mkRecipe("sp", [], ["p"])),
      recipeNode("sq", -100, 800, mkRecipe("sq", [], ["q"])),
    ];
    const edges = [
      mkEdge("e0", "s", "t", "b"),
      // Two-member trunks (same item + source), so none of these demote: all
      // four retype to bus and rise into m's gutter, widening it.
      mkEdge("bp1", "sp", "m", "p"),
      mkEdge("bp2", "sp", "m", "p"),
      mkEdge("bq1", "sq", "m", "q"),
      mkEdge("bq2", "sq", "m", "q"),
    ];

    const out = routeBusEdges(nodes, edges);
    const e0 = out.find((e) => e.id === "e0")!;

    // The lone clear-corridor trunk demoted at the gate...
    expect(e0.type).toBe("item");
    // ...m's post-retype gutter now spans four rise columns...
    const mRect = entryGutterRects(nodes, out).get("m")!;
    expect(mRect.right - mRect.left).toBe(gutterWidth(4));
    // ...and the census helper, run on that post-retype set, still agrees.
    expect(directCorridorClear(nodes, out, e0)).toBe(true);
  });

  it("reads a card-straddled corridor as blocked on the post-retype set", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      recipeNode("mid", 600, 0, r), // straddles the corridor at the target row
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    const out = routeBusEdges(nodes, edges);
    const e0 = out.find((e) => e.id === "e0")!;

    expect(e0.type).toBe("bus"); // gate agrees: blocked corridor keeps the lane
    expect(directCorridorClear(nodes, out, e0)).toBe(false);
  });
});

function busChipXOf(edges: Edge[], id: string): number | undefined {
  const d = edges.find((e) => e.id === id)?.data as
    | { busChipX?: number }
    | undefined;
  return d?.busChipX;
}

describe("routeBusEdges trunk rise-chip slots", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  const far = 300 + (BUS_SPAN_THRESHOLD + 50);
  const buildThreeMember = (): { nodes: RFAnyNode[]; edges: Edge[] } => ({
    nodes: [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", far, 0, r),
      recipeNode("t2", far, 300, r),
      recipeNode("t3", far, 600, r),
    ],
    edges: [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ],
  });

  it("distributes three members' rise chips across distinct, evenly spaced lane slots", () => {
    const { nodes, edges } = buildThreeMember();
    const out = routeBusEdges(nodes, edges);
    const x0 = busChipXOf(out, "e0")!;
    const x1 = busChipXOf(out, "e1")!;
    const x2 = busChipXOf(out, "e2")!;
    // Lane extent runs from the drop column (sourceRight 300 + stub + chamfer) to
    // the members' shared rise column (targetLeft - stub - chamfer). With n = 3
    // members the extent splits into n + 1 = 4 equal gaps and each slot sits at
    // (i + 1)/4 of it, ordered by edge id.
    const dropX = 300 + PORT_STUB + CHAMFER;
    const maxRiseX = far - PORT_STUB - CHAMFER;
    const step = (maxRiseX - dropX) / 4;
    expect(x0).toBeCloseTo(dropX + step, 6);
    expect(x1).toBeCloseTo(dropX + 2 * step, 6);
    expect(x2).toBeCloseTo(dropX + 3 * step, 6);
    // Distinct, evenly spaced, and strictly inside the extent so no rise chip
    // ever lands on the aggregate drop chip at dropX.
    expect(new Set([x0, x1, x2]).size).toBe(3);
    expect(x1 - x0).toBeCloseTo(x2 - x1, 6);
    for (const x of [x0, x1, x2]) {
      expect(x).toBeGreaterThan(dropX);
      expect(x).toBeLessThan(maxRiseX);
    }
  });

  it("assigns slots deterministically across shuffled input order", () => {
    const { nodes, edges } = buildThreeMember();
    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges([...nodes].reverse(), [
      edges[2]!,
      edges[0]!,
      edges[1]!,
    ]);
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipXOf(a, id)).toBe(busChipXOf(b, id));
    }
  });

  it("keeps the trunk aggregate on the owner while distributing rise slots", () => {
    const { nodes, edges } = buildThreeMember();
    const out = routeBusEdges(nodes, edges);
    // Owner election and totals are untouched by the slot pass.
    const owners = out.filter(
      (e) => (e.data as { busChipOwner?: boolean }).busChipOwner,
    );
    expect(owners).toHaveLength(1);
    expect(owners[0]!.id).toBe("e0");
    const d = owners[0]!.data as {
      busTotalRate?: Fraction;
      busMemberCount?: number;
    };
    expect(d.busTotalRate!.equals(new Fraction(3))).toBe(true);
    expect(d.busMemberCount).toBe(3);
    // Every member still carries its own slot.
    for (const id of ["e0", "e1", "e2"]) {
      expect(busChipXOf(out, id)).toBeGreaterThan(0);
    }
  });

});
