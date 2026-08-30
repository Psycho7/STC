// Junction-dot coordinates, all four families pinned in one place: the lane bus
// member's branch dot and the fan-out trunk's split dot (both drawn by BusEdge
// from the shared path builders), plus the fan-in merge dot and the
// declined-fan-out divergence dot (both stamped onto item-edge data by
// deconflictChipAnchors). chipSeating resolves all four up front, before any
// chip seats, so these are the coordinates that cache -- and the render layer
// that draws the dots -- must keep reproducing.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import {
  routeBusEdges,
  routeFanoutEdges,
  BUS_SPAN_THRESHOLD,
  FANOUT_SPAN_MIN,
} from "../../src/canvas/busRouting";
import { nodeWidth, portOffsetY } from "../../src/canvas/nodeGeometry";
import {
  chamferBusPath,
  chamferFanoutPath,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  MAX_CHIP_SCALE,
} from "../../src/canvas/dimensions";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

// chipSeating's own PORT_DRIFT.recipe, mirrored here (the module does not
// export it): a recipe's drawn out handle sits 5 units right of the model right
// edge, its in handle 3 units left of the model left edge, and both a unit
// below the model row y.
const SRC_DX = 5;
const TGT_DX = -3;
const PORT_DY = 1;

// The chip box the seating pass reserves at max counter-scale, and the vertical
// pitch a crowded chip is bumped by -- the two numbers the dot keep-off's
// observable effects are stated in.
const CHIP_HALF_W = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;
const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
const CHIP_PITCH = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;

const ITEM = "s";

const rateEdge = (id: string, source: string, target: string): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item: ITEM, rate: new Fraction(1) },
});

// A producer of ITEM and a consumer of ITEM, the two card shapes every fixture
// below is built from.
const producer = (id: string, x: number, y: number): RFRecipeNode =>
  recipeNode(id, x, y, mkRecipe(id, [], [ITEM]));
const consumer = (id: string, x: number, y: number): RFRecipeNode =>
  orderedRecipeNode(id, x, y, [ITEM]);

// The DRAWN endpoints of a producer -> consumer edge on ITEM: the model ports
// shifted onto the handle coordinates, exactly as chipSeating's edgeEndpoints
// and React Flow's own handle anchoring resolve them. The path builders below
// are fed these, so the pinned junctions are the drawn ones.
const drawnEnds = (
  src: RFRecipeNode,
  tgt: RFRecipeNode,
): { sourceX: number; sourceY: number; targetX: number; targetY: number } => ({
  sourceX: src.position.x + nodeWidth(src) + SRC_DX,
  sourceY: src.position.y + portOffsetY(src, ITEM, "out") + PORT_DY,
  targetX: tgt.position.x + TGT_DX,
  targetY: tgt.position.y + portOffsetY(tgt, ITEM, "in") + PORT_DY,
});

const dataOf = (edges: Edge[], id: string): Record<string, unknown> =>
  (edges.find((e) => e.id === id)?.data as Record<string, unknown> | undefined) ??
  {};

describe("junction dots: lane bus member (BusEdge branch dot)", () => {
  it("draws its dot on the trunk lane, just left of the member's rise column", () => {
    const src = producer("src", 0, 0);
    const tgt = consumer("tgt", 300 + BUS_SPAN_THRESHOLD + 50, 200);
    // A card straddling the direct corridor at the target row, so the lone
    // member is not demoted to a plain item edge and stays on a lane.
    const mid = recipeNode("mid", 600, 200, mkRecipe("mid", ["z"], ["z"]));
    const nodes: RFAnyNode[] = [src, tgt, mid];
    const routed = routeBusEdges(nodes, [rateEdge("e:1", "src", "tgt")]);

    // Premise: the edge really is a lane bus member, so BusEdge draws its dot
    // from chamferBusPath.
    expect(routed[0]!.type).toBe("bus");
    const laneY = dataOf(routed, "e:1").laneY as number;
    expect(laneY).toBe(420);

    const junction = chamferBusPath({
      ...drawnEnds(src, tgt),
      laneY,
      ...routingHintsFromData(routed[0]!.data),
    }).junction;
    expect(junction).toEqual({ x: 1127, y: 420 });
    // The dot sits ON the lane it marks the branch off.
    expect(junction.y).toBe(laneY);

    // Seating moves chips, never the lane the dot is drawn on.
    const seated = deconflictChipAnchors(nodes, routed);
    expect(dataOf(seated, "e:1").laneY).toBe(laneY);

    // A LONE member draws no dot (nothing branches at its corner, #83), so the
    // keep-off never fires and its rise chip stays seated ON the lane.
    expect(dataOf(seated, "e:1").busChipDy).toBeUndefined();

    // Stamped multi-member, the dot returns -- and the cached dot is READ, not
    // merely cached (#50): the member's rise chip anchors on the lane a
    // chamfer right of this junction, so its box would swallow the dot at
    // dy 0. The keep-off lifts it exactly one lane pitch (bottom band, so
    // downward), the same distance the rise loop already accepts as "beside
    // the lane". This is the pin that fails if the cached lane dot ever stops
    // matching the drawn one above.
    const multi = routed.map((e) =>
      e.id === "e:1"
        ? { ...e, data: { ...e.data, busMemberCount: 2 } }
        : e,
    );
    const seatedMulti = deconflictChipAnchors(nodes, multi);
    expect(dataOf(seatedMulti, "e:1").busChipDy).toBe(CHIP_PITCH);
    expect(Math.abs(CHIP_PITCH)).toBeGreaterThan(CHIP_HALF_H);
  });
});

describe("junction dots: fan-out trunk (BusEdge split dot)", () => {
  it("draws one shared dot where the trunk splits into its branches", () => {
    const src = producer("src", 0, 100);
    const up = consumer("up", 500, 0);
    const down = consumer("down", 500, 260);
    const nodes: RFAnyNode[] = [src, up, down];
    const routed = routeFanoutEdges(nodes, [
      rateEdge("e:1", "src", "up"),
      rateEdge("e:2", "src", "down"),
    ]);

    // Premise: the trunk really formed, so BusEdge draws the split dot.
    expect(routed.map((e) => e.type)).toEqual(["bus", "bus"]);

    const upJunction = chamferFanoutPath({
      ...drawnEnds(src, up),
      ...routingHintsFromData(dataOf(routed, "e:1")),
    }).junction;
    const downJunction = chamferFanoutPath({
      ...drawnEnds(src, down),
      ...routingHintsFromData(dataOf(routed, "e:2")),
    }).junction;

    expect(upJunction).toEqual({ x: 392, y: 198 });
    // Every member draws the same dot: the trunk splits once.
    expect(downJunction).toEqual(upJunction);
    // The dot sits on the source row, out along the shared trunk.
    expect(upJunction.y).toBe(drawnEnds(src, up).sourceY);

    // The split dot is in the seating pass's keep-off set too (#50), so no
    // seated branch chip may end up painting over it. Both branch chips here
    // anchor well down their own legs, so this states the invariant rather than
    // a move -- it is the guard that fires if a later seating change walks a
    // branch chip back up onto the split.
    const seated = deconflictChipAnchors(nodes, routed);
    for (const [id, tgt] of [
      ["e:1", up],
      ["e:2", down],
    ] as const) {
      const data = dataOf(seated, id);
      const branch = chamferFanoutPath({
        ...drawnEnds(src, tgt),
        ...routingHintsFromData(data),
      }).branchAnchor;
      const cx = branch.x + ((data.fanoutBranchDx as number | undefined) ?? 0);
      const cy = branch.y + ((data.fanoutBranchDy as number | undefined) ?? 0);
      expect(
        Math.abs(cx - upJunction.x) >= CHIP_HALF_W ||
          Math.abs(cy - upJunction.y) >= CHIP_HALF_H,
      ).toBe(true);
    }
  });
});

describe("junction dots: fan-in merge (stamped on the owner item edge)", () => {
  it("stamps the merge point where the last member joins the shared run", () => {
    const tgtRecipe = mkRecipe("tgt", [ITEM], []);
    const tgt = consumer("tgt", 1000, 100);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
    // A bent feeder and a straight feeder: the straight one joins the port run
    // at its own drawn out-port, which is where the merge dot goes.
    const srcA = producer("srcA", 0, 0);
    const srcBRecipe = mkRecipe("srcB", [], [ITEM]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = producer("srcB", 600, ty - srcBOutY0);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const out = deconflictChipAnchors(nodes, [
      rateEdge("e:1:srcA->tgt", "srcA", "tgt"),
      rateEdge("e:2:srcB->tgt", "srcB", "tgt"),
    ]);

    const owner = dataOf(out, "e:1:srcA->tgt"); // smallest id of the group
    expect(owner.faninJunctionX).toBe(905);
    // On the DRAWN port row, so the dot sits on the run it marks: the model row
    // y plus the recipe handle drift, which is what the members are drawn along.
    expect(owner.faninJunctionY).toBe(drawnEnds(srcA, tgt).targetY);
    expect(owner.faninJunctionY).toBe(ty + PORT_DY);
    expect(ty).toBe(197);
    // One dot per merge: the non-owner carries none.
    expect(dataOf(out, "e:2:srcB->tgt").faninJunctionX).toBeUndefined();
  });
});

describe("junction dots: declined fan-out divergence (stamped on the owner)", () => {
  it("stamps the column where the coincident members first split", () => {
    // A gap below FANOUT_SPAN_MIN: routeFanoutEdges declines the group, so both
    // members stay plain item edges leaving one out-port coincident.
    const gap = 28;
    expect(gap).toBeLessThanOrEqual(FANOUT_SPAN_MIN);
    const src = producer("src", 0, 0);
    // Row tops that put a consumer's in-port on the source's out-port row, so
    // "straight" never leaves that row and "bent" peels off 200 units below it.
    const inY = measureRecipe(consumer("probe", 0, 0).data.recipe).inHandleYs[0]!;
    const rowTop = portOffsetY(src, ITEM, "out") - inY;
    const straight = consumer("straight", nodeWidth(src) + gap, rowTop);
    const bent = consumer("bent", nodeWidth(src) + gap, rowTop + 200);
    const nodes: RFAnyNode[] = [src, straight, bent];
    const edges = [
      rateEdge("e:a", "src", "straight"),
      rateEdge("e:b", "src", "bent"),
    ];
    expect(routeFanoutEdges(nodes, edges).map((e) => e.type)).toEqual([
      "item",
      "item",
    ]);

    const out = deconflictChipAnchors(nodes, edges);
    const owner = dataOf(out, "e:a"); // smallest id of the group
    expect(owner.fanoutJunctionX).toBe(312.5);
    expect(owner.fanoutJunctionY).toBe(drawnEnds(src, straight).sourceY);
    expect(owner.fanoutJunctionY).toBe(98);
    // One dot per split: the non-owner carries none.
    expect(dataOf(out, "e:b").fanoutJunctionX).toBeUndefined();
  });
});
