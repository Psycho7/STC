// One shared column per source port. routeTrunkEdges used to form a trunk only
// out of the members whose target sits one layer over; everything further took
// its own staggered bend column, so an input card feeding N consumers drew N
// parallel verticals beside the card. Now every member of one (item, source
// port) group rides ONE column: the ones ending in the NEXT layer as retyped
// bus fan-out branches (a straight leg and the junction dot), the ones further
// right as plain item edges pinned to the same column with { bendX,
// fanoutColumn } -- keeping jogForwardLegs and the rest of the item-edge
// passes, which a bus-typed member would lose.
//
// These suites pin the split between the two member kinds, the single column,
// and the chip anchor that moves off that column onto each member's own leg.
// Near / far is LAYER distance, so a fixture that wants a far member puts a
// card in the layer between.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { ROUTING_PASSES } from "../../src/canvas/layout";
import { edgePortsModel, routeTrunkEdges } from "../../src/canvas/busRouting";
import { FORWARD_LEVEL_FLOOR } from "../../src/canvas/levelOccupancy";
import { widenLayerGaps } from "../../src/canvas/layerModel";
import {
  drawnPortsOf,
  nodeWidth,
  portOffsetY,
} from "../../src/canvas/nodeGeometry";
import {
  CHAMFER,
  PORT_STUB,
  chamferFanoutPath,
  chamferStepPath,
  parsePathPoints,
  routingHintsFromData,
  type DrawnPorts,
} from "../../src/canvas/edgePath";
import {
  BETWEEN_LAYERS_SPACING,
  DOT_KEEPOFF,
  RECIPE_WIDTH,
} from "../../src/canvas/dimensions";
import type { RFAnyNode, RFRecipeNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";

// How many of the card's members jogForwardLegs re-columns (srcColX): a member
// whose source horizontal is blocked leaves the shared line at a cleared column
// of its own rather than draw through a card. Measured at 0 on this plan --
// stated as a number, not as "none", so a routing change that starts breaking
// members off the column shows up here.
const JOG_RECOLUMNED_MEMBERS = 0;

const ITEM = "s";

// One layer is a column gap plus a recipe card.
const LAYER_PITCH = BETWEEN_LAYERS_SPACING + RECIPE_WIDTH;

// A card parked in the layer between, far below the trunk's own rows: it makes
// the layer the near / far split needs without obstructing any leg.
const layerFiller = (id: string, x: number): RFRecipeNode =>
  consumer(id, x, 2800);

const producer = (id: string, x: number, y: number): RFRecipeNode =>
  recipeNode(id, x, y, mkRecipe(id, [], [ITEM]));
const consumer = (id: string, x: number, y: number): RFRecipeNode =>
  orderedRecipeNode(id, x, y, [ITEM]);

const edge = (id: string, source: string, target: string): Edge => ({
  id,
  type: "item",
  source,
  target,
  data: { item: ITEM, rate: new Fraction(1) },
});

// The DRAWN endpoints of a producer -> consumer edge, resolved by nodeGeometry's
// one model -> drawn conversion -- the frame chipSeating reconstructs in and
// React Flow's handle anchoring lands on.
const drawnPortsFor = (
  src: RFRecipeNode,
  tgt: RFRecipeNode,
): { sourceX: number; sourceY: number; targetX: number; targetY: number } =>
  drawnPortsOfEdge(
    edge("drawn-ports", src.id, tgt.id),
    new Map<string, RFAnyNode>([
      [src.id, src],
      [tgt.id, tgt],
    ]),
  );

type EdgeData = Record<string, unknown>;

// One edge's drawn endpoints in the shape the path builders take. Works on a
// laid-out plan's nested nodes too: the conversion resolves the parent hop
// itself.
const drawnPortsOfEdge = (
  e: Edge,
  byId: ReadonlyMap<string, RFAnyNode>,
): DrawnPorts => drawnPortsOf(e, byId)!;

const dataOf = (edges: Edge[], id: string): EdgeData =>
  (edges.find((e) => e.id === id)?.data as EdgeData | undefined) ?? {};

const typeOf = (edges: Edge[], id: string): string | undefined =>
  edges.find((e) => e.id === id)?.type;

// The whole post-layout routing chain in its pinned order, the way
// layoutRenderPlan runs it -- so these fixtures see the same stamps a real plan
// does (the fan-out pin, then assignBendColumns, jogForwardLegs and the seating
// pass on top of it).
const routeAll = (nodes: RFAnyNode[], edges: Edge[]): Edge[] =>
  ROUTING_PASSES.reduce((acc, pass) => pass.run(nodes, acc), edges);

describe("routeTrunkEdges: one shared column for near and far members", () => {
  // Two consumers one layer over and two consumers three layers over, all off
  // one out-port. The far rows sit below the near cards, so no far leg crosses
  // one and jogForwardLegs leaves every column alone.
  const fixture = (): { nodes: RFAnyNode[]; edges: Edge[] } => {
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
      consumer("near1", LAYER_PITCH, 0),
      consumer("near2", LAYER_PITCH, 260),
      consumer("far1", 3 * LAYER_PITCH, 620),
      consumer("far2", 3 * LAYER_PITCH, 880),
    ];
    const edges = [
      edge("e:1", "src", "near1"),
      edge("e:2", "src", "near2"),
      edge("e:3", "src", "far1"),
      edge("e:4", "src", "far2"),
    ];
    return { nodes, edges };
  };

  it("retypes the near members and pins the far ones to the same column", () => {
    const { nodes, edges } = fixture();
    const routed = routeAll(nodes, edges);

    // The near members are the bus fan-out branches, sharing one junction.
    expect(typeOf(routed, "e:1")).toBe("bus");
    expect(typeOf(routed, "e:2")).toBe("bus");
    const junctionX = dataOf(routed, "e:1").junctionX as number;
    expect(typeof junctionX).toBe("number");
    expect(dataOf(routed, "e:2").junctionX).toBe(junctionX);
    expect(dataOf(routed, "e:1").fanout).toBe(true);

    // The far members stay item edges -- every item-edge pass still applies to
    // them -- and carry the trunk's column plus the flag.
    for (const id of ["e:3", "e:4"]) {
      expect(typeOf(routed, id)).toBe("item");
      const data = dataOf(routed, id);
      expect(data.fanoutColumn).toBe(true);
      expect(data.bendX).toBe(junctionX);
      expect(data.fanout).toBeUndefined();
    }

    // assignBendColumns runs after the pin and must not re-fan a pinned member:
    // the four members leave on ONE line.
    expect(dataOf(routed, "e:3").srcColX).toBeUndefined();
    expect(dataOf(routed, "e:4").srcColX).toBeUndefined();
    const columns = new Set(
      ["e:1", "e:2", "e:3", "e:4"].map((id) => {
        const data = dataOf(routed, id);
        return (data.junctionX ?? data.bendX) as number;
      }),
    );
    expect(columns).toEqual(new Set([junctionX]));
  });

  it("anchors a far member's rate chip on its own final leg", () => {
    const { nodes, edges } = fixture();
    const routed = routeAll(nodes, edges);
    const far = nodes[3] as RFRecipeNode;
    const data = dataOf(routed, "e:3");
    const ends = drawnPortsFor(nodes[0] as RFRecipeNode, far);
    const [, labelX, labelY] = chamferStepPath({
      ...ends,
      ...routingHintsFromData(data),
    });
    const anchorX = labelX;
    const anchorY = labelY;

    // Premise: this member really is pinned and really was not jogged, so the
    // anchor below is about the shared column's own rule.
    expect(data.fanoutColumn).toBe(true);
    expect(data.legY).toBeUndefined();

    // On the final horizontal leg, past the split dot's keep-off, short of the
    // target port -- never on the shared vertical, where every member's chip
    // would stack.
    expect(anchorY).toBe(ends.targetY);
    const bendX = data.bendX as number;
    expect(anchorX).toBeGreaterThan(bendX + DOT_KEEPOFF);
    expect(anchorX).toBeLessThan(ends.targetX);
  });
});

describe("routeTrunkEdges: a trunk of far members only", () => {
  it("shares one column and elects one owner to draw the split dot", () => {
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
      layerFiller("mid", LAYER_PITCH),
      consumer("far1", 3 * LAYER_PITCH, 0),
      consumer("far2", 3 * LAYER_PITCH, 420),
      consumer("far3", 3 * LAYER_PITCH, 840),
    ];
    const ids = ["e:1", "e:2", "e:3"];
    const routed = routeAll(nodes, [
      edge("e:1", "src", "far1"),
      edge("e:2", "src", "far2"),
      edge("e:3", "src", "far3"),
    ]);

    // No member is retyped: with no near member there is no bus branch at all.
    for (const id of ids) {
      expect(typeOf(routed, id)).toBe("item");
      expect(dataOf(routed, id).fanoutColumn).toBe(true);
    }
    const columns = new Set(
      ids.map((id) => dataOf(routed, id).bendX as number),
    );
    expect(columns.size).toBe(1);

    // Exactly one member carries the split dot, at the source row on the shared
    // column (ItemEdge draws it from these two fields).
    const owners = ids.filter(
      (id) => dataOf(routed, id).fanoutJunctionX !== undefined,
    );
    // The smallest id among the BENDING members owns it: "e:1" runs straight
    // out of the port and never peels off, so it carries no split of its own.
    expect(owners).toEqual(["e:2"]);
    const owner = dataOf(routed, "e:2");
    const ends = drawnPortsFor(src, nodes[3] as RFRecipeNode);
    expect(owner.fanoutJunctionY).toBe(ends.sourceY);
    expect(owner.fanoutJunctionX).toBeGreaterThan(ends.sourceX);
    expect(owner.fanoutJunctionX).toBeLessThan(ends.targetX);
  });
});

describe("routeTrunkEdges: the shared column and its neighbours", () => {
  it("keeps the stagger of other edges off the shared column", () => {
    // assignBendColumns cannot re-place a pinned member, but it must not fan
    // ANOTHER edge's vertical onto the column either: a staggered column half a
    // stub away braids the line every member of the trunk draws on.
    const src = producer("src", 0, 0);
    const other = producer("other", 0, 1400);
    const nodes: RFAnyNode[] = [
      src,
      other,
      layerFiller("mid", LAYER_PITCH),
      consumer("far1", 3 * LAYER_PITCH, 0),
      consumer("far2", 3 * LAYER_PITCH, 420),
      consumer("plain", 3 * LAYER_PITCH, 1400),
    ];
    const routed = routeAll(nodes, [
      edge("e:1", "src", "far1"),
      edge("e:2", "src", "far2"),
      edge("e:3", "other", "plain"),
    ]);
    const column = dataOf(routed, "e:1").bendX as number;
    expect(dataOf(routed, "e:2").bendX).toBe(column);
    // The unpinned edge shares the band (both sources are one layer) and keeps
    // its staggered column a full stub clear of the claimed one, either side.
    expect(dataOf(routed, "e:3").fanoutColumn).toBeUndefined();
    expect(
      Math.abs((dataOf(routed, "e:3").bendX as number) - column),
    ).toBeGreaterThanOrEqual(PORT_STUB);
  });

  it("retypes both near members and pins the far one beside them", () => {
    // A mixed trunk: the two members ending one layer over draw the
    // branch-and-junction render, the third borrows their column as an item
    // edge.
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
      consumer("near1", nodeWidth(src) + 260, 260),
      consumer("near2", nodeWidth(src) + 260, 560),
      layerFiller("mid", 2 * LAYER_PITCH),
      consumer("far", 3 * LAYER_PITCH, 900),
    ];
    const routed = routeTrunkEdges(nodes, [
      edge("e:1", "src", "near1"),
      edge("e:2", "src", "near2"),
      edge("e:3", "src", "far"),
    ]);
    expect(typeOf(routed, "e:1")).toBe("bus");
    expect(typeOf(routed, "e:2")).toBe("bus");
    expect(typeOf(routed, "e:3")).toBe("item");
    expect(dataOf(routed, "e:3").bendX).toBe(dataOf(routed, "e:1").junctionX);
  });

  it("elects the aggregate owner among the NEAR members only", () => {
    // The same mixed trunk with the FAR member lex-smallest. The aggregate chip
    // rides the trunk segment of the fan-out shape, which only a near member
    // draws, so electing over all members would hand the trunk's total to an
    // edge that draws no trunk and the total would never appear.
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
      consumer("near1", nodeWidth(src) + 260, 260),
      consumer("near2", nodeWidth(src) + 260, 560),
      layerFiller("mid", 2 * LAYER_PITCH),
      consumer("far", 3 * LAYER_PITCH, 900),
    ];
    const routed = routeTrunkEdges(nodes, [
      edge("e:1", "src", "far"),
      edge("e:2", "src", "near1"),
      edge("e:3", "src", "near2"),
    ]);
    // Premise: the lex-smallest member really is the far one.
    expect(typeOf(routed, "e:1")).toBe("item");
    const owners = ["e:1", "e:2", "e:3"].filter(
      (id) => dataOf(routed, id).busChipOwner === true,
    );
    expect(owners).toEqual(["e:2"]);
  });
});

describe("routeTrunkEdges: the slot order of two trunks in one gap", () => {
  // Two producers of one item in the source layer, each fanning out to its own
  // pair of consumers one layer over, so both trunks take a column in the same
  // gap. A leaves ABOVE B, so the plain port-row order puts A's column left.
  //
  // `alignedRows` is the whole fixture: it puts one of A's target rows on B's
  // own out-port row, so A's leg and B's stub share that row. Left of B, A's leg
  // runs right across B's stub and B's split dot lands on it; right of B there
  // is no shared stretch at all.
  const SRC_A_Y = 0;
  const SRC_B_Y = 300;
  const OFF_ROW_1 = 900;
  const OFF_ROW_2 = 1200;

  // The card y that puts a consumer's IN-port row on `row`.
  const targetYFor = (row: number): number =>
    row - portOffsetY(consumer("probe", 0, 0), ITEM, "in");
  // The out-port row of a producer card placed at y.
  const sourceRowOf = (y: number): number =>
    y + portOffsetY(producer("probe", 0, 0), ITEM, "out");

  // Both trunks' columns come from the gap record, so the fixture routes with a
  // ctx: without one every trunk falls back to its own corridor midpoint and
  // the slot order has nothing to hand out.
  const columnsOf = (
    nodes: RFAnyNode[],
    edges: Edge[],
  ): { a: number; b: number } => {
    const widened = widenLayerGaps(nodes, edges);
    const routed = routeTrunkEdges(widened.nodes, edges, {
      gaps: widened.gaps,
    });
    const columnOf = (id: string): number => {
      const data = dataOf(routed, id);
      return (data.junctionX ?? data.bendX) as number;
    };
    // Premise: every member is a NEAR member, drawn as the trunk shape, so both
    // trunks really did take a slot in the gap.
    for (const id of ["a:1", "a:2", "b:1", "b:2"]) {
      expect(typeOf(routed, id), id).toBe("bus");
    }
    expect(columnOf("a:1")).toBe(columnOf("a:2"));
    expect(columnOf("b:1")).toBe(columnOf("b:2"));
    return { a: columnOf("a:1"), b: columnOf("b:1") };
  };

  it("stands the trunk whose leg leaves right of the one whose stub arrives", () => {
    const nodes: RFAnyNode[] = [
      producer("srcA", 0, SRC_A_Y),
      producer("srcB", 0, SRC_B_Y),
      // A's coincident target: its in-port row IS srcB's out-port row.
      consumer("a1", LAYER_PITCH, targetYFor(sourceRowOf(SRC_B_Y))),
      consumer("a2", LAYER_PITCH, targetYFor(OFF_ROW_1)),
      consumer("b1", LAYER_PITCH, targetYFor(OFF_ROW_2)),
      consumer("b2", LAYER_PITCH, targetYFor(OFF_ROW_2 + 300)),
    ];
    const edges = [
      edge("a:1", "srcA", "a1"),
      edge("a:2", "srcA", "a2"),
      edge("b:1", "srcB", "b1"),
      edge("b:2", "srcB", "b2"),
    ];
    const byId = new Map<string, RFAnyNode>(nodes.map((n) => [n.id, n]));

    // Premise: A hangs off the HIGHER port row, so the plain slot order puts it
    // left, and its leg really does land within the forward level floor of B's
    // port row -- the coincidence the rule is about.
    const portsA = edgePortsModel(edges[0]!, byId)!;
    const portsB = edgePortsModel(edges[2]!, byId)!;
    expect(portsA.sy).toBeLessThan(portsB.sy);
    expect(Math.abs(portsA.ty - portsB.sy)).toBeLessThan(FORWARD_LEVEL_FLOOR);

    const { a, b } = columnsOf(nodes, edges);
    expect(b).toBeLessThan(a);
  });

  it("restores the plain port order when the constraints form a cycle", () => {
    // The mirror added: B also has a target on A's out-port row, so each trunk
    // leaves on the other's arriving row. No order satisfies both, and the sort
    // falls back to the plain one -- A's higher port row takes the left column.
    const nodes: RFAnyNode[] = [
      producer("srcA", 0, SRC_A_Y),
      producer("srcB", 0, SRC_B_Y),
      consumer("a1", LAYER_PITCH, targetYFor(sourceRowOf(SRC_B_Y))),
      consumer("a2", LAYER_PITCH, targetYFor(OFF_ROW_1)),
      consumer("b1", LAYER_PITCH, targetYFor(sourceRowOf(SRC_A_Y))),
      consumer("b2", LAYER_PITCH, targetYFor(OFF_ROW_2)),
    ];
    const edges = [
      edge("a:1", "srcA", "a1"),
      edge("a:2", "srcA", "a2"),
      edge("b:1", "srcB", "b1"),
      edge("b:2", "srcB", "b2"),
    ];
    const byId = new Map<string, RFAnyNode>(nodes.map((n) => [n.id, n]));

    // Premise: the cycle really is there -- each trunk's leg lands on the
    // other's port row.
    const portsA = edgePortsModel(edges[0]!, byId)!;
    const portsB = edgePortsModel(edges[2]!, byId)!;
    expect(Math.abs(portsA.ty - portsB.sy)).toBeLessThan(FORWARD_LEVEL_FLOOR);
    expect(Math.abs(portsB.ty - portsA.sy)).toBeLessThan(FORWARD_LEVEL_FLOOR);

    const { a, b } = columnsOf(nodes, edges);
    expect(a).toBeLessThan(b);
  });
});

describe("chamferStepPath: where a pinned member's label anchor lands", () => {
  // The path builder's own answer. A far member pinned to a trunk's shared
  // column takes the LAST horizontal run of its polyline -- its own leg into
  // the target, the same leg a retyped near member's chip rides -- seated one
  // port stub back from the target port. Everything left of that leg is the
  // column every sibling draws on, where their chips would stack.
  const ends = {
    sourceX: 100,
    sourceY: 200,
    targetX: 1000,
    targetY: 600,
  } as const;
  const BEND_X = 160;
  const FANIN_BEND_X = 900;
  // The default reserve when a caller hands in no chip box: CHIP_BOX_WIDTH / 2.
  const HALF_W = 60;

  it("anchors the straight step on the final horizontal leg", () => {
    const [, labelX, labelY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      fanoutColumn: true,
    });
    expect(labelY).toBe(ends.targetY);
    expect(labelX).toBe(ends.targetX - PORT_STUB - HALF_W);
    expect(labelX).toBeGreaterThan(BEND_X + DOT_KEEPOFF);
    // The pin is what moves it: without it the same polyline anchors on the
    // centre of its longest run, which here is that same final leg.
    const [, plainX, plainY] = chamferStepPath({ ...ends, bendX: BEND_X });
    expect(plainY).toBe(labelY);
    expect(plainX).toBeLessThan(labelX);
  });

  it("anchors a jogged step on its final leg, not the jog's long run", () => {
    // The jog's cleared horizontal at legY is the LONGEST run of this
    // polyline, and the pinned member does not take it: that run is the one
    // its siblings share the column with, so the rule sends the chip to the
    // last run, the stub from the descent column into the port.
    const legY = 320;
    const jogDescentX = 900;
    const [, labelX, labelY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      legY,
      jogDescentX,
      fanoutColumn: true,
    });
    expect(labelY).toBe(ends.targetY);
    expect(labelX).toBe(ends.targetX - PORT_STUB - HALF_W);
    expect(labelX).toBeGreaterThan(jogDescentX);
    // Unpinned, the same polyline takes the long cleared run instead.
    const [, plainX, plainY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      legY,
      jogDescentX,
    });
    expect(plainY).toBe(legY);
    expect(plainX).toBeLessThan(jogDescentX);
  });

  it("anchors a far FAN-IN member on its own source stub", () => {
    // The mirror: a far fan-in member shares the final leg into the target
    // port with every sibling (that is the trunk's aggregate leg), so its own
    // stretch is the FIRST run -- the stub out of its source port -- and its
    // chip seats one port stub out of that port.
    // A fan-in column stands in the gap before the TARGET, so the member's own
    // stub is the long run here.
    const [path, labelX, labelY] = chamferStepPath({
      ...ends,
      bendX: FANIN_BEND_X,
      faninColumn: true,
    });
    expect(labelY).toBe(ends.sourceY);
    expect(labelX).toBe(ends.sourceX + PORT_STUB + HALF_W);
    // Premise: the first run really is the source stub of the drawn shape.
    expect(path.startsWith(`M ${ends.sourceX},${ends.sourceY}`)).toBe(true);
  });

  it("reads a dual far member -- both flags -- as the fan-out member it is", () => {
    const [, dualX, dualY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      fanoutColumn: true,
      faninColumn: true,
    });
    const [, outX, outY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      fanoutColumn: true,
    });
    expect([dualX, dualY]).toEqual([outX, outY]);
  });

  it("seats both far members by the box they actually draw", () => {
    const narrow = { memberHalfW: 20 };
    const [, outX] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      fanoutColumn: true,
      ...narrow,
    });
    const [, inX] = chamferStepPath({
      ...ends,
      bendX: FANIN_BEND_X,
      faninColumn: true,
      ...narrow,
    });
    expect(outX).toBe(ends.targetX - PORT_STUB - 20);
    expect(inX).toBe(ends.sourceX + PORT_STUB + 20);
  });
});

describe("chip placement: a pinned member's chip stays off the shared column", () => {
  it("puts a JOGGED member's chip on a horizontal run, off the column", () => {
    // A card in the first layer straddling the far member's approach row, so
    // jogForwardLegs bends that member's leg to a clear y. Whichever run the
    // rule picks, the chip stands on a HORIZONTAL one -- never on the vertical
    // column its siblings share, where every one of their chips would stack.
    const src = producer("src", 0, 0);
    const far1 = consumer("far1", 3 * LAYER_PITCH, 600);
    // The blocker's body has to straddle far1's approach ROW, so its top is
    // derived from that row rather than typed: the row's offset inside the card
    // moves with the card chrome.
    const blocker = recipeNode(
      "blk",
      2 * LAYER_PITCH,
      600 + portOffsetY(far1, ITEM, "in") - 20,
      mkRecipe("blk", ["z"], ["z"]),
    );
    const nodes: RFAnyNode[] = [
      src,
      layerFiller("mid", LAYER_PITCH),
      blocker,
      far1,
      consumer("far2", 3 * LAYER_PITCH, 900),
    ];
    const routed = routeAll(nodes, [
      edge("e:1", "src", "far1"),
      edge("e:2", "src", "far2"),
    ]);
    const data = dataOf(routed, "e:1");

    // Premise: this member really was jogged, and really is still pinned.
    expect(data.fanoutColumn).toBe(true);
    const legY = data.legY as number;
    expect(typeof legY).toBe("number");

    const [path, anchorX, anchorY] = chamferStepPath({
      ...drawnPortsFor(src, nodes[3] as RFRecipeNode),
      ...routingHintsFromData(data),
    });
    // The jogged shape draws three horizontals -- the source run, the cleared
    // run at legY, and the final stub -- and the anchor sits on one of them.
    const pts = parsePathPoints(path);
    const onHorizontal = pts.some(
      ([x0, y0], i) =>
        i > 0 &&
        pts[i - 1]![1] === y0 &&
        anchorY === y0 &&
        anchorX >= Math.min(pts[i - 1]![0], x0) &&
        anchorX <= Math.max(pts[i - 1]![0], x0),
    );
    expect(onHorizontal).toBe(true);
    expect(Math.abs(anchorX - (data.bendX as number))).toBeGreaterThan(
      DOT_KEEPOFF,
    );
  });
});

describe("the gas_xiranite fan-out of equip_script_4_3", () => {
  // The plan this feature came from: one imported gas_xiranite card feeding
  // consumers spread over several layers. Before the shared column each of
  // those edges took its own staggered bend column and the card sat behind a
  // bundle of parallel verticals. The catalyst split (2026-09-07) moved the
  // transmuters' xiranite feeds into cycled catalyst rows, which draw no edge,
  // so the card feeds four members now, down from seven.
  it("leaves the input card on one column", async () => {
    const targets: ItemTarget[] = [
      {
        itemId: pack.recipes.find((r) => r.id === "equip_script_4_3")!.out[0]!
          .item,
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const solved = solveForRender({ targets, pack });
    const { nodes, edges } = await layoutSolved(solved);

    const sourceId = "u:in:gas_xiranite";
    const members = edges.filter((e) => e.source === sourceId);
    // Premise: this really is the wide fan-out, over more than one layer.
    expect(members.length).toBeGreaterThanOrEqual(4);

    // A jogged member leaves the shared line by design: jogForwardLegs replaces
    // the column with a cleared one when the source horizontal is blocked.
    const columnOf = (e: (typeof members)[number]): number | undefined => {
      const data = e.data as EdgeData | undefined;
      return (data?.junctionX ?? data?.bendX) as number | undefined;
    };
    const jogged = members.filter(
      (e) => (e.data as EdgeData | undefined)?.srcColX !== undefined,
    );
    const onColumn = members.filter(
      (e) => (e.data as EdgeData | undefined)?.srcColX === undefined,
    );
    expect(jogged.length).toBe(JOG_RECOLUMNED_MEMBERS);
    const columns = onColumn.map(columnOf);
    for (const x of columns) expect(typeof x).toBe("number");
    expect(new Set(columns).size).toBe(1);
    // Measured census on this plan after the catalyst split: 4 members, one
    // column at x 254, none of them re-columned by a jog (one IS leg-jogged,
    // which keeps the column).
    expect(
      members.filter((e) => (e.data as EdgeData).fanoutColumn === true).length,
    ).toBe(members.length);
    expect(
      members.filter((e) => (e.data as EdgeData).legY !== undefined).length,
    ).toBeGreaterThan(0);

    // No member's rate chip stands on the shared column: every seated anchor is
    // clear of the split dot's keep-off around it. This is the defect the
    // visual check caught -- a jogged member's chip seated on the column, with
    // six sibling strokes running through it.
    const column = [...new Set(columns)][0] as number;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const e of members) {
      const data = e.data as EdgeData;
      const [, labelX] = chamferStepPath({
        ...drawnPortsOfEdge(e, byId),
        ...routingHintsFromData(data),
      });
      expect(labelX).toBeGreaterThan(column + DOT_KEEPOFF);
    }
    // Every non-jogged member is a trunk member, not an unclaimed plain edge.
    for (const e of onColumn) {
      const data = e.data as EdgeData;
      expect(data.fanout === true || data.fanoutColumn === true).toBe(true);
    }
  });
});

describe("the gas-web copper_nugget fan-out", () => {
  // The exam plan (test/e2e/scenarios.ts, "gas-web"): the Refining Unit's
  // copper_nugget output fans out to three consumers sitting three rows apart,
  // so each member's descent down the SHARED column is longer than its own
  // horizontal leg. The chip belongs on the leg; on the column three chips
  // stack on one line and none of them names the flow it labels (all three are
  // icon-only, so position is the only cue left).
  const GAS_WEB_TARGETS: ItemTarget[] = [
    { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "gas_copper_enr2", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "gas_inert", ratePerSec: { num: "1", denom: "4" } },
  ];

  const layOutGasWeb = async (): Promise<{
    nodes: RFAnyNode[];
    edges: Edge[];
  }> => {
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets: GAS_WEB_TARGETS, pack }),
    );
    return { nodes: nodes as RFAnyNode[], edges };
  };

  // The member's OWN horizontal leg: the LAST run of its polyline, the leg into
  // the target port. A jogged member's cleared run at legY is longer, and the
  // rule still does not put the chip there -- that run belongs to the shared
  // column's side of the shape.
  const ownLeg = (
    pts: ReadonlyArray<readonly [number, number]>,
  ): readonly [readonly [number, number], readonly [number, number]] => [
    pts[pts.length - 2]!,
    pts[pts.length - 1]!,
  ];

  it("seats every member's chip on its own leg", async () => {
    const { nodes, edges } = await layOutGasWeb();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let checked = 0;

    for (const e of edges) {
      const data = e.data as EdgeData;
      const branch = e.type === "bus" && data.fanout === true;
      const pinned = e.type === "item" && data.fanoutColumn === true;
      if (!branch && !pinned) continue;
      const ends = drawnPortsOfEdge(e, byId);
      const hints = routingHintsFromData(data);
      let column: number;
      let pts: ReadonlyArray<readonly [number, number]>;
      let chipX: number;
      let chipY: number;
      if (branch) {
        const fan = chamferFanoutPath({ ...ends, ...hints });
        pts = parsePathPoints(fan.path);
        // The drawn column: the junction dot sits one chamfer before it.
        column = fan.junction.x + CHAMFER;
        chipX = fan.branchAnchor.x;
        chipY = fan.branchAnchor.y;
      } else {
        const [path, lx, ly] = chamferStepPath({ ...ends, ...hints });
        pts = parsePathPoints(path);
        column = hints.srcColX ?? (data.bendX as number);
        chipX = lx;
        chipY = ly;
      }

      const leg = ownLeg(pts);
      expect(chipY, `${e.id} chip row`).toBe(leg[1][1]);
      expect(chipX, `${e.id} chip off the column`).toBeGreaterThan(
        column + DOT_KEEPOFF,
      );
      expect(chipX, `${e.id} chip within its leg`).toBeLessThanOrEqual(
        Math.max(leg[0][0], leg[1][0]),
      );
      checked++;
    }

    // Premise: the plan really does carry the fan-outs this pins -- the three
    // copper_nugget branches plus the gas_xiranite / gas_inert pinned members.
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
