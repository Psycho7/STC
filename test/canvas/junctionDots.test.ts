// Junction-dot coordinates, all three families pinned in one place: the two
// trunk dots (the fan-out's split and the fan-in's merge, both drawn by BusEdge
// from the shared path builders) plus the declined-fan-out divergence dot
// (stamped onto item-edge data by deconflictChipAnchors). chipSeating resolves
// all three up front, before any chip seats, so these are the coordinates that
// cache -- and the render layer that draws the dots -- must keep reproducing.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { routeTrunkEdges } from "../../src/canvas/busRouting";
import {
  drawnPortsOf,
  nodeWidth,
  portOffsetY,
} from "../../src/canvas/nodeGeometry";
import {
  chamferFanoutPath,
  drawnEdge,
  routingHintsFromData,
  type DrawnPorts,
} from "../../src/canvas/edgePath";
import { stampOnOwnPolyline } from "../../src/canvas/crossings";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import { CHIP_BOX_HEIGHT, CHIP_BOX_WIDTH } from "../../src/canvas/dimensions";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

// The chip box the seating pass reserves -- the numbers the dot keep-off's
// observable effects are stated in.
const CHIP_HALF_W = CHIP_BOX_WIDTH / 2;
const CHIP_HALF_H = CHIP_BOX_HEIGHT / 2;

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

// The DRAWN endpoints of a producer -> consumer edge on ITEM, resolved by
// nodeGeometry's one model -> drawn conversion (the same one the seating pass
// reconstructs with, and the same frame React Flow's handle anchoring lands on).
// The path builders below are fed these, so the pinned junctions are the drawn
// ones.
const drawnPortsFor = (src: RFRecipeNode, tgt: RFRecipeNode): DrawnPorts =>
  drawnPortsOf(
    rateEdge("drawn-ports", src.id, tgt.id),
    new Map<string, RFAnyNode>([
      [src.id, src],
      [tgt.id, tgt],
    ]),
  )!;

const dataOf = (edges: Edge[], id: string): Record<string, unknown> =>
  (edges.find((e) => e.id === id)?.data as
    | Record<string, unknown>
    | undefined) ?? {};

describe("junction dots: fan-out trunk (BusEdge split dot)", () => {
  it("draws one shared dot where the trunk splits into its branches", () => {
    const src = producer("src", 0, 100);
    const up = consumer("up", 500, 0);
    const down = consumer("down", 500, 260);
    const nodes: RFAnyNode[] = [src, up, down];
    const routed = routeTrunkEdges(nodes, [
      rateEdge("e:1", "src", "up"),
      rateEdge("e:2", "src", "down"),
    ]);

    // Premise: the trunk really formed, so BusEdge draws the split dot.
    expect(routed.map((e) => e.type)).toEqual(["bus", "bus"]);

    const upJunction = chamferFanoutPath({
      ...drawnPortsFor(src, up),
      ...routingHintsFromData(dataOf(routed, "e:1")),
    }).junction;
    const downJunction = chamferFanoutPath({
      ...drawnPortsFor(src, down),
      ...routingHintsFromData(dataOf(routed, "e:2")),
    }).junction;

    expect(upJunction).toEqual({ x: 392, y: 198 });
    // Every member draws the same dot: the trunk splits once.
    expect(downJunction).toEqual(upJunction);
    // The dot sits on the source row, out along the shared trunk.
    expect(upJunction.y).toBe(drawnPortsFor(src, up).sourceY);

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
        ...drawnPortsFor(src, tgt),
        ...routingHintsFromData(data),
      }).branchAnchor;
      expect(
        Math.abs(branch.x - upJunction.x) >= CHIP_HALF_W ||
          Math.abs(branch.y - upJunction.y) >= CHIP_HALF_H,
      ).toBe(true);
    }
  });
});

describe("junction dots: fan-in trunk (BusEdge merge dot)", () => {
  it("draws one shared dot where the members merge onto the trunk's leg", () => {
    const srcA = producer("srcA", 0, 0);
    const srcB = producer("srcB", 0, 260);
    const tgt = consumer("tgt", 500, 100);
    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const routed = routeTrunkEdges(nodes, [
      rateEdge("e:1", "srcA", "tgt"),
      rateEdge("e:2", "srcB", "tgt"),
    ]);

    // Both members answer the same point: one chamfer past the shared column,
    // on the target port row, which is the first vertex of the leg they share.
    const merge = (id: string, src: RFRecipeNode): { x: number; y: number } => {
      const drawn = drawnEdge(
        drawnPortsFor(src, tgt),
        "bus",
        dataOf(routed, id),
      );
      expect(drawn.shape).toBe("fanin");
      if (drawn.shape !== "fanin") throw new Error("not a fan-in shape");
      return drawn.junction;
    };
    const dot = merge("e:1", srcA);
    expect(merge("e:2", srcB)).toEqual(dot);
    expect(dot.y).toBe(drawnPortsFor(srcA, tgt).targetY);
    const column = routingHintsFromData(dataOf(routed, "e:1")).junctionX!;
    expect(dot.x).toBeGreaterThan(column);
    expect(dot.x).toBeLessThan(drawnPortsFor(srcA, tgt).targetX);
    // It lies on each member's own drawn polyline, which is what lets the
    // render layer draw it without any cross-edge state.
    for (const [id, src] of [
      ["e:1", srcA],
      ["e:2", srcB],
    ] as const) {
      const drawn = drawnEdge(
        drawnPortsFor(src, tgt),
        "bus",
        dataOf(routed, id),
      );
      expect(stampOnOwnPolyline([dot.x, dot.y], drawn.pts)).toBe(true);
    }
  });

  it("keeps every seated fan-in chip off the merge dot", () => {
    // The merge dot joins the seating pass's keep-off set from the routed data
    // (phase 0), so no chip the pass seats may end up painting over it. The
    // corridor here is wide enough for both chips to seat well clear of the
    // dot, so this states the invariant rather than a move.
    const srcA = producer("srcA", 0, 0);
    const srcB = producer("srcB", 0, 260);
    const tgt = consumer("tgt", 1400, 100);
    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const routed = routeTrunkEdges(nodes, [
      rateEdge("e:1", "srcA", "tgt"),
      rateEdge("e:2", "srcB", "tgt"),
    ]);
    const seated = deconflictChipAnchors(nodes, routed);

    for (const [id, src] of [
      ["e:1", srcA],
      ["e:2", srcB],
    ] as const) {
      const data = dataOf(seated, id);
      const drawn = drawnEdge(drawnPortsFor(src, tgt), "bus", data);
      if (drawn.shape !== "fanin") throw new Error("not a fan-in shape");
      const chips = [drawn.trunkAnchor, drawn.branchAnchor];
      for (const chip of chips) {
        expect(
          Math.abs(chip.x - drawn.junction.x) >= CHIP_HALF_W ||
            Math.abs(chip.y - drawn.junction.y) >= CHIP_HALF_H,
          `${id} chip clears the merge dot`,
        ).toBe(true);
      }
    }
  });
});

describe("junction dots: declined fan-out divergence (stamped on the owner)", () => {
  it("stamps the column where the coincident members first split", () => {
    // Two members two layers over: routeTrunkEdges pins both to the trunk's
    // shared column and retypes neither, so they leave one out-port coincident
    // as plain item edges. The filler card makes the layer between.
    const gap = 1000;
    const src = producer("src", 0, 0);
    // Row tops that put a consumer's in-port on the source's out-port row, so
    // "straight" never leaves that row and "bent" peels off 200 units below it.
    const inY = measureRecipe(consumer("probe", 0, 0).data.recipe)
      .inHandleYs[0]!;
    const rowTop = portOffsetY(src, ITEM, "out") - inY;
    const straight = consumer("straight", nodeWidth(src) + gap, rowTop);
    const bent = consumer("bent", nodeWidth(src) + gap, rowTop + 200);
    const mid = consumer("mid", nodeWidth(src) + 300, rowTop + 2800);
    const nodes: RFAnyNode[] = [src, mid, straight, bent];
    const routed = routeTrunkEdges(nodes, [
      rateEdge("e:a", "src", "straight"),
      rateEdge("e:b", "src", "bent"),
    ]);
    expect(routed.map((e) => e.type)).toEqual(["item", "item"]);

    const out = deconflictChipAnchors(nodes, routed);
    const owner = dataOf(out, "e:b"); // smallest id among the BENDING members
    // The shared column (the corridor midpoint, 800) less one chamfer: the last
    // vertex both members still share is where the bent one starts turning.
    expect((routed[1]!.data as { bendX?: number }).bendX).toBe(800);
    expect(owner.fanoutJunctionX).toBe(792);
    expect(owner.fanoutJunctionY).toBe(drawnPortsFor(src, straight).sourceY);
    expect(owner.fanoutJunctionY).toBe(98);
    // One dot per split: the non-owner carries none.
    expect(dataOf(out, "e:a").fanoutJunctionX).toBeUndefined();
  });
});

describe("junction dots: declined fan-out divergence owner election", () => {
  it("elects a bending member, so the stamp lies on the owner's own line", () => {
    // Two item edges off one out-port, hand-built: the shape a pair of members
    // one of which a jog pushed onto its own column draws. The smallest-id
    // member is the STRAIGHT leg and its target stops short of the sibling's
    // peel-off column:
    // stamping the dot on that member would leave it off the line it is drawn
    // from, and ItemEdge's on-own-polyline gate would hide it at rest.
    const src = producer("src", 0, 0);
    const inY = measureRecipe(consumer("probe", 0, 0).data.recipe)
      .inHandleYs[0]!;
    const rowTop = portOffsetY(src, ITEM, "out") - inY;
    const straight = consumer("straight", nodeWidth(src) + 12, rowTop);
    const bent = consumer("bent", nodeWidth(src) + 120, rowTop + 200);
    const nodes: RFAnyNode[] = [src, straight, bent];
    const edges = [
      rateEdge("e:a", "src", "straight"),
      rateEdge("e:b", "src", "bent"),
    ];
    const out = deconflictChipAnchors(nodes, edges);
    const stamped = edges.find(
      (e) => dataOf(out, e.id).fanoutJunctionX !== undefined,
    )!;
    const data = dataOf(out, stamped.id);
    const junctionX = data.fanoutJunctionX as number;
    // Premise: the split column really is right of the straight leg's target.
    expect(junctionX).toBeGreaterThan(drawnPortsFor(src, straight).targetX);

    const tgt = stamped.target === "straight" ? straight : bent;
    const pts = drawnEdge(drawnPortsFor(src, tgt), "item", data).pts;
    expect(
      stampOnOwnPolyline([junctionX, data.fanoutJunctionY as number], pts),
    ).toBe(true);
  });
});
