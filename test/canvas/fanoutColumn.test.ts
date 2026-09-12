// One shared column per source port. routeFanoutEdges used to form a trunk only
// out of the members whose target sits one layer over; everything further took
// its own staggered bend column, so an input card feeding N consumers drew N
// parallel verticals beside the card. Now every member of one (item, source
// port) group rides ONE column: the near ones as retyped bus fan-out branches
// (a straight leg and the junction dot), the far ones as plain item edges pinned
// to the same column with { bendX, fanoutColumn } -- keeping jogForwardLegs and
// the rest of the item-edge passes, which a bus-typed member would lose.
//
// These suites pin the split between the two member kinds, the single column,
// the chip anchor that moves off that column onto each member's own leg, and the
// column's leg floor.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { ROUTING_PASSES } from "../../src/canvas/layout";
import { routeFanoutEdges } from "../../src/canvas/busRouting";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { drawnPortsOf, nodeWidth } from "../../src/canvas/nodeGeometry";
import {
  CHAMFER,
  PORT_STUB,
  chamferFanoutPath,
  chamferStepPath,
  parsePathPoints,
  routingHintsFromData,
  type DrawnPorts,
} from "../../src/canvas/edgePath";
import { DOT_KEEPOFF } from "../../src/canvas/dimensions";
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

// One layer is a column gap plus a recipe card, the pitch routeFanoutEdges'
// near / far bound is derived from.
const LAYER_PITCH = 410;

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
// pass on top of it). Bus lanes are off, the app's default: layoutRenderPlan
// then drops the lane pass, and the long-span members reach routeFanoutEdges
// instead of being claimed as lane members (with lanes ON, anything past
// BUS_SPAN_THRESHOLD is still the lane pass's, unchanged by this feature).
const routeAll = (
  nodes: RFAnyNode[],
  edges: Edge[],
  busLanesEnabled = false,
): Edge[] =>
  ROUTING_PASSES.filter(
    (pass) => busLanesEnabled || pass.name !== "routeBusEdges",
  ).reduce((acc, pass) => pass.run(nodes, acc), edges);

describe("routeFanoutEdges: one shared column for near and far members", () => {
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
    const anchorX = labelX + ((data.labelDx as number | undefined) ?? 0);
    const anchorY = labelY + ((data.labelDy as number | undefined) ?? 0);

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
    // The leg is far wider than the chip, so the chip stays numeric.
    expect(data.chipIconOnly).toBeUndefined();
  });
});

describe("routeFanoutEdges: a trunk of far members only", () => {
  it("shares one column and elects one owner to draw the split dot", () => {
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
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
    const ends = drawnPortsFor(src, nodes[2] as RFRecipeNode);
    expect(owner.fanoutJunctionY).toBe(ends.sourceY);
    expect(owner.fanoutJunctionX).toBeGreaterThan(ends.sourceX);
    expect(owner.fanoutJunctionX).toBeLessThan(ends.targetX);
  });
});

describe("routeFanoutEdges: the column's chip leg floor", () => {
  // Two members off one port whose nearest target sits `gap` away, plus one far
  // member so the shape is the mixed one the floor governs. With only ONE near
  // member the trunk retypes nothing: both members ride the column as item
  // edges (a lone near branch has no sibling branch to share a junction render
  // with, and the bus form would cost it its plain rate chip).
  const floorFixture = (
    gap: number,
  ): { nodes: RFAnyNode[]; routed: Edge[]; nearTx: number } => {
    const src = producer("src", 0, 0);
    const near = consumer("near", nodeWidth(src) + gap, 260);
    const far1 = consumer("far1", 3 * LAYER_PITCH, 620);
    const far2 = consumer("far2", 3 * LAYER_PITCH, 980);
    const nodes: RFAnyNode[] = [src, near, far1, far2];
    const routed = routeFanoutEdges(nodes, [
      edge("e:1", "src", "near"),
      edge("e:2", "src", "far1"),
      edge("e:3", "src", "far2"),
    ]);
    return { nodes, routed, nearTx: drawnPortsFor(src, near).targetX };
  };

  it("shifts the column left when the nearest leg cannot hold a chip", () => {
    // A 260-unit corridor: the midpoint would leave the near member ~100 units
    // of leg, less than a wide chip, so the column moves left toward corLo.
    const gap = 260;
    const { nodes, routed } = floorFixture(gap);
    const src = nodes[0] as RFRecipeNode;
    const sx = src.position.x + nodeWidth(src);
    const tx = (nodes[1] as RFRecipeNode).position.x;
    const column = dataOf(routed, "e:1").bendX as number;

    expect(typeOf(routed, "e:1")).toBe("item");
    expect(dataOf(routed, "e:1").fanoutColumn).toBe(true);
    expect(column).toBeLessThan((sx + tx) / 2);
    // Still inside the corridor, and still left of the floor it was shifted to.
    expect(column).toBeGreaterThanOrEqual(sx + PORT_STUB + CHAMFER);
    expect(column).toBeLessThanOrEqual(tx - PORT_STUB - CHAMFER - DOT_KEEPOFF);
  });

  it("leaves out a near member no column can give a chip leg", () => {
    // A corridor too narrow for even corLo to leave a chip-wide leg. Joining
    // this member would cost it the rate chip it reads today (the leg cannot
    // hold the box, so the seat would collapse it to icon-only), so it stays a
    // plain edge with its own bend column while the far pair still forms.
    const gap = 100;
    const { routed } = floorFixture(gap);
    const near = dataOf(routed, "e:1");
    expect(near.fanoutColumn).toBeUndefined();
    expect(near.bendX).toBeUndefined();
    expect(typeOf(routed, "e:1")).toBe("item");

    const column = dataOf(routed, "e:2").bendX as number;
    expect(typeof column).toBe("number");
    expect(dataOf(routed, "e:3").bendX).toBe(column);
  });

  it("keeps the stagger of other edges off the shared column", () => {
    // assignBendColumns cannot re-place a pinned member, but it must not fan
    // ANOTHER edge's vertical onto the column either: a staggered column half a
    // stub away braids the line every member of the trunk draws on.
    const src = producer("src", 0, 0);
    const other = producer("other", 0, 1400);
    const nodes: RFAnyNode[] = [
      src,
      other,
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
    // The unpinned edge shares the band (both sources are one layer) and takes
    // its staggered column a full stub clear of the claimed one.
    expect(dataOf(routed, "e:3").fanoutColumn).toBeUndefined();
    expect(dataOf(routed, "e:3").bendX as number).toBeGreaterThanOrEqual(
      column + PORT_STUB,
    );
  });

  it("keeps the bus retype where TWO near members share the junction", () => {
    // The control for the lone-near rule above: a second near member restores
    // the branch-and-junction render, so the retype is about the near GROUP,
    // not about the presence of far siblings.
    const src = producer("src", 0, 0);
    const nodes: RFAnyNode[] = [
      src,
      consumer("near1", nodeWidth(src) + 260, 260),
      consumer("near2", nodeWidth(src) + 260, 560),
      consumer("far", 3 * LAYER_PITCH, 900),
    ];
    const routed = routeFanoutEdges(nodes, [
      edge("e:1", "src", "near1"),
      edge("e:2", "src", "near2"),
      edge("e:3", "src", "far"),
    ]);
    expect(typeOf(routed, "e:1")).toBe("bus");
    expect(typeOf(routed, "e:2")).toBe("bus");
    expect(typeOf(routed, "e:3")).toBe("item");
    expect(dataOf(routed, "e:3").bendX).toBe(dataOf(routed, "e:1").junctionX);
  });
});

describe("chamferStepPath: where a pinned member's label anchor lands", () => {
  // The path builder's own answer, with no seating pass involved. The seat can
  // slide a chip back onto its leg, so a seated assertion alone would still
  // pass if the builder anchored on the shared column -- these two pin the
  // builder itself.
  const ends = {
    sourceX: 100,
    sourceY: 200,
    targetX: 1000,
    targetY: 600,
  } as const;
  const BEND_X = 160;

  it("anchors the straight step on the final horizontal leg", () => {
    const [, labelX, labelY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      fanoutColumn: true,
    });
    expect(labelY).toBe(ends.targetY);
    expect(labelX).toBeGreaterThan(BEND_X + DOT_KEEPOFF);
    expect(labelX).toBeLessThan(ends.targetX);
    // Without the pin the same step anchors on the bend column, mid-vertical.
    const [, plainX, plainY] = chamferStepPath({ ...ends, bendX: BEND_X });
    expect(plainX).toBe(BEND_X);
    expect(plainY).toBe((ends.sourceY + ends.targetY) / 2);
  });

  it("anchors a jogged step on the jog's clear horizontal", () => {
    const legY = 320;
    const jogDescentX = 900;
    const [, labelX, labelY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      legY,
      jogDescentX,
      fanoutColumn: true,
    });
    expect(labelY).toBe(legY);
    expect(labelX).toBeGreaterThan(BEND_X + DOT_KEEPOFF);
    expect(labelX).toBeLessThan(jogDescentX);
    // Without the pin the same jog anchors on the descent vertical.
    const [, plainX, plainY] = chamferStepPath({
      ...ends,
      bendX: BEND_X,
      legY,
      jogDescentX,
    });
    expect(plainX).toBe(jogDescentX);
    expect(plainY).toBe((legY + ends.targetY) / 2);
  });
});

describe("chip seating: a pinned member's chip stays off the shared column", () => {
  it("seats a JOGGED member's chip on the jog's clear horizontal", () => {
    // A card in the first layer straddling the far member's approach row, so
    // jogForwardLegs bends that member's leg to a clear y. Its chip must follow
    // the jog, not fall back onto the column its six siblings draw.
    const src = producer("src", 0, 0);
    const blocker = recipeNode(
      "blk",
      LAYER_PITCH,
      560,
      mkRecipe("blk", ["z"], ["z"]),
    );
    const nodes: RFAnyNode[] = [
      src,
      blocker,
      consumer("far1", 3 * LAYER_PITCH, 600),
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

    const [, labelX, labelY] = chamferStepPath({
      ...drawnPortsFor(src, nodes[2] as RFRecipeNode),
      ...routingHintsFromData(data),
    });
    const anchorX = labelX + ((data.labelDx as number | undefined) ?? 0);
    const anchorY = labelY + ((data.labelDy as number | undefined) ?? 0);
    expect(anchorY).toBe(legY);
    expect(anchorX).toBeGreaterThan((data.bendX as number) + DOT_KEEPOFF);
  });

  it("collapses a pinned member whose own leg is narrower than its chip", () => {
    // The stamps a formed trunk leaves, applied to a member whose column sits
    // late in its corridor: the whole polyline is roomy, but the run the chip
    // may use -- past the column's keep-off, on the member's own leg -- is not.
    // The window has to be measured on that run, or the chip keeps a full box
    // it has nowhere to draw.
    const src = producer("src", 0, 0);
    const tgt = consumer("tgt", nodeWidth(src) + 300, 300);
    const nodes: RFAnyNode[] = [src, tgt];
    const ends = drawnPortsFor(src, tgt);
    const bendX = ends.targetX - 70;
    const pinned: Edge[] = [
      {
        ...edge("e:1", "src", "tgt"),
        data: {
          item: ITEM,
          rate: new Fraction(1),
          bendX,
          fanoutColumn: true,
        },
      },
    ];

    const seated = deconflictChipAnchors(nodes, pinned);
    expect(dataOf(seated, "e:1").chipIconOnly).toBe(true);

    // Control: the same geometry without the pin keeps the full chip -- the
    // collapse is the shared column's rule, not the corridor's.
    const unpinned: Edge[] = [
      {
        ...edge("e:1", "src", "tgt"),
        data: { item: ITEM, rate: new Fraction(1), bendX },
      },
    ];
    expect(
      dataOf(deconflictChipAnchors(nodes, unpinned), "e:1").chipIconOnly,
    ).toBeUndefined();
  });
});

describe("the gas_xiranite fan-out of equip_script_4_3", () => {
  // The plan this feature came from: one imported gas_xiranite card feeding
  // seven consumers spread over several layers. Before the shared column each
  // of those edges took its own staggered bend column and the card sat behind a
  // bundle of parallel verticals.
  it("leaves the input card on one column", async () => {
    const targets: ItemTarget[] = [
      {
        itemId: pack.recipes.find((r) => r.id === "equip_script_4_3")!.out[0]!
          .item,
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const solved = solveForRender({ targets, pack });
    const { nodes, edges } = await layoutSolved(solved, {
      // The app's default: with lanes on, the long members would be the lane
      // pass's and never reach the fan-out grouping.
      busLanesEnabled: false,
    });

    const sourceId = "u:in:gas_xiranite";
    const members = edges.filter((e) => e.source === sourceId);
    // Premise: this really is the wide fan-out, over more than one layer.
    expect(members.length).toBeGreaterThanOrEqual(7);

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
    // Measured census on this plan: 7 members, all of them FAR (the nearest
    // consumer is more than one layer over), one column at x 244, none of them
    // re-columned by a jog (four ARE leg-jogged, which keeps the column).
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
      const seatedX = labelX + ((data.labelDx as number | undefined) ?? 0);
      expect(seatedX).toBeGreaterThan(column + DOT_KEEPOFF);
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

  const layOutGasWeb = async (
    busLanesEnabled: boolean,
  ): Promise<{ nodes: RFAnyNode[]; edges: Edge[] }> => {
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets: GAS_WEB_TARGETS, pack }),
      { busLanesEnabled },
    );
    return { nodes: nodes as RFAnyNode[], edges };
  };

  // The member's OWN horizontal leg: the jog's cleared run when jogForwardLegs
  // bent the approach, otherwise the final run into the target port.
  const ownLeg = (
    pts: ReadonlyArray<readonly [number, number]>,
    legY: number | undefined,
  ): readonly [readonly [number, number], readonly [number, number]] => {
    if (legY !== undefined) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!;
        const b = pts[i]!;
        if (Math.abs(a[1] - legY) <= 1 && Math.abs(b[1] - legY) <= 1) {
          return [a, b];
        }
      }
    }
    return [pts[pts.length - 2]!, pts[pts.length - 1]!];
  };

  for (const busLanesEnabled of [false, true]) {
    it(`seats every member's chip on its own leg (lanes ${busLanesEnabled ? "on" : "off"})`, async () => {
      const { nodes, edges } = await layOutGasWeb(busLanesEnabled);
      const byId = new Map(nodes.map((n) => [n.id, n]));
      let checked = 0;

      for (const e of edges) {
        const data = e.data as EdgeData;
        const branch = e.type === "bus" && data.fanout === true;
        const pinned = e.type === "item" && data.fanoutColumn === true;
        if (!branch && !pinned) continue;
        // A hidden branch chip draws nothing, so it has no seat to check.
        if (data.fanoutBranchHidden === true) continue;

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
          chipX = fan.branchAnchor.x + ((data.fanoutBranchDx as number) ?? 0);
          chipY = fan.branchAnchor.y + ((data.fanoutBranchDy as number) ?? 0);
        } else {
          const [path, lx, ly] = chamferStepPath({ ...ends, ...hints });
          pts = parsePathPoints(path);
          column = hints.srcColX ?? (data.bendX as number);
          chipX = lx + ((data.labelDx as number) ?? 0);
          chipY = ly + ((data.labelDy as number) ?? 0);
        }

        const leg = ownLeg(pts, data.legY as number | undefined);
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
  }
});
