// Bus classification and lane assignment: routeBusEdges (which edges become bus
// members), the two-sided top/bottom lane bands, single-member demotion, the
// direct-corridor gate, and per-trunk rise-chip slotting. Fixtures come from
// ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeBusEdges,
  laneBands,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  clearBusColumns,
  directCorridorClear,
  jogForwardLegs,
  deconflictChipAnchors,
  entryGutterRects,
  gutterWidth,
  paddedObstacles,
  BUS_SPAN_THRESHOLD,
  LANE_TOP_OFFSET,
  LANE_SPACING,
} from "../../src/canvas/busRouting";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import { PORT_STUB, CHAMFER } from "../../src/canvas/edgePath";
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
  busDropDyOf,
  busChipDyOf,
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

    const d0 = out[0]!.data as { laneY: number; trunkKey: string };
    const d1 = out[1]!.data as { laneY: number; trunkKey: string };
    expect(d0.trunkKey).toBe("b|s");
    expect(d1.trunkKey).toBe("b|s");
    expect(d0.laneY).toBe(d1.laneY);
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

  it("classifies an input-product -> input-product feeder as bus even when short", () => {
    // Aggregate and tap sit one next to the other (span well under threshold).
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", 200, 0), // gap 200 - 148 = 52 < 820
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    const data = out[0]!.data as { trunkKey: string };
    expect(data.trunkKey).toBe("ore|agg");
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

  it("cascades a crowded top-band trunk's rise chips UP off its lane", () => {
    // Mirror of the bottom-band cascade: two adjacent input-product feeders in
    // the upper half (a node far below sends the trunk to the top band) collapse
    // the lane extent, so both rise chips stack on the drop column. In the top
    // band the cascade must run UPWARD (negative dy) so the chips move away from
    // the graph below, not toward it.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("t1", "ore", 200, 0),
      inputProductNode("t2", "ore", 200, 200),
      recipeNode("low", 0, 3000, r),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = deconflictChipAnchors(nodes, routeBusEdges(nodes, edges));
    const pitch = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;
    expect(bandOf(out, "e0")).toBe("top");
    // Owner drop chip settles on the lane; the rises pile UPWARD off it.
    expect(busDropDyOf(out, "e0")).toBe(0);
    expect(busChipDyOf(out, "e0")).toBe(-pitch);
    expect(busChipDyOf(out, "e1")).toBe(-2 * pitch);
  });

  it("sends an exact-midline trunk to the bottom band, deterministically", () => {
    // A lone bothInput feeder whose source and target ports share one y: its
    // mean member port Y equals the graph midline exactly. The tiebreak sends it
    // to the bottom band (the pre-split default), and two runs agree.
    const bothFar = 148 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", bothFar, 0),
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const a = routeBusEdges(nodes, edges);
    const b = routeBusEdges(nodes, edges);
    expect(bandOf(a, "e0")).toBe("bottom");
    expect(bandOf(a, "e0")).toBe(bandOf(b, "e0"));
    expect(laneYOf(a, "e0")).toBe(laneYOf(b, "e0"));
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

  it("leaves a lone bothInput feeder on the bus regardless of its corridor", () => {
    // A long aggregate -> tap feeder: a single-member trunk whose corridor is
    // clear, yet excluded from demotion because bothInput trunks ride the bus to
    // cross the whole graph, not for span.
    const bothFar = 148 + (BUS_SPAN_THRESHOLD + 50);
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0),
      inputProductNode("tap", "ore", bothFar, 0),
    ];
    const edges = [mkEdge("e0", "agg", "tap", "ore")];

    const out = routeBusEdges(nodes, edges);

    expect(out[0]!.type).toBe("bus");
    expect((out[0]!.data as { trunkKey?: string }).trunkKey).toBe("ore|agg");
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

  it("stacks rise slots at the drop column when the lane extent is too short", () => {
    // Two input-product feeders sit almost adjacent, so the rise column lands at
    // or left of the drop column and the extent is non-positive. The step
    // collapses to 0 so every member's rise slot falls on the drop column;
    // deconflictChipAnchors then cascades the coincident pile downward off the
    // lane rather than spreading it horizontally past the rise column.
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0), // right edge 148
      inputProductNode("t1", "ore", 200, 0), // bothInput feeder -> bus
      inputProductNode("t2", "ore", 200, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = routeBusEdges(nodes, edges);
    const dropX = 148 + PORT_STUB + CHAMFER; // 180
    expect(busChipXOf(out, "e0")).toBeCloseTo(dropX, 6);
    expect(busChipXOf(out, "e1")).toBeCloseTo(dropX, 6);
  });
});
