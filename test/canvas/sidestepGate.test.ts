// The sidestep tiers step a chip HORIZONTALLY off its anchor. On a horizontal
// leg that is a slide along the own line and costs nothing; on a VERTICAL leg it
// is perpendicular to the line, so the chip leaves the line it labels. Both
// tiers used to take that step against blockage they could not act on -- tier 1c
// ungated entirely, tier 1b' gated on a braid measured at the least-bad ON-LINE
// seat, which can sit on a different leg hundreds of units away. A chip anchored
// on a short bend-column vertical whose long clear leg merely happened to be
// CROSSED a lot was stepped flush to the containment bound and read as an orphan
// beside its line.
//
// These suites pin the gate: on a vertical leg a step is taken only against a
// foreign stroke running PARALLEL to the own line INSIDE THE ANCHOR'S OWN BOX --
// the only box a step from here can move -- and otherwise the chip keeps the
// graze seat on its own line.

import { describe, it, expect } from "vitest";

import {
  makeClearanceField,
  seatRateChip,
  type CardExemption,
  type EdgeSegments,
  type EntryBand,
} from "../../src/canvas/chipSeating";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  chamferStepPath,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import {
  absoluteLeft,
  absoluteTop,
  nodeWidth,
  portOffsetY,
} from "../../src/canvas/nodeGeometry";
import { pointToPolylineDistance } from "../../src/canvas/crossings";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import type { RFAnyNode } from "../../src/canvas/layout";

// chipSeating's PORT_DRIFT table (the module does not export it), mirrored the
// way the other real-plan suites mirror it: React Flow anchors a path at the
// OUTER edge of the handle box, a few units off the model port the routing
// passes compute, so the drawn frame is the model frame plus these offsets.
const PLAN_DRIFT: Record<
  string,
  { sourceDx: number; targetDx: number; dy: number }
> = {
  recipe: { sourceDx: 5, targetDx: -3, dy: 1 },
  product: { sourceDx: 4, targetDx: -4, dy: 0 },
};
const driftOf = (
  node: RFAnyNode,
): { sourceDx: number; targetDx: number; dy: number } =>
  PLAN_DRIFT[node.type ?? ""] ?? { sourceDx: 0, targetDx: 0, dy: 0 };

// The audit's off-path tolerance (test/e2e/geometry-audit.spec.ts reads
// auditChipsOnOwnPath at its default): a seated centre farther than this from
// its own polyline is a chip the reader no longer reads as bound to its line.
const OFF_PATH_TOL = 1;

// chipSeating's CHIP_HALF_H, mirrored (the module does not export it): half the
// box a chip paints at max counter-scale. A bus chip lifted this far off its
// lane has the lane stroke on its box edge, not inside it.
const CHIP_HALF_H = (2 * 24) / 2;

// No card exemption and an INVERTED entry band no point can fall inside, so the
// unit fixtures below see only the strokes they declare.
const NO_EXEMPT: CardExemption = { whole: new Set(), zones: new Map() };
const NO_BAND: EntryBand = {
  left: Infinity,
  right: -Infinity,
  top: Infinity,
  bottom: -Infinity,
};

type EdgeData = Record<string, unknown>;

// The polyline chamferStepPath emits, as the vertex list the distance measure
// needs. The builder only ever writes M / L commands.
const parsePath = (d: string): Array<[number, number]> =>
  [...d.matchAll(/[ML]\s*(-?[\d.]+)[ ,]\s*(-?[\d.]+)/g)].map((m) => [
    Number(m[1]),
    Number(m[2]),
  ]);

type OffPathHit = { id: string; distance: number };

// Solve, render and lay out a scenario, then measure every item edge's SEATED
// rate-chip centre against its own drawn polyline -- the node-land twin of the
// e2e off-path audit, on the same plans.
async function offPathChips(
  targets: ItemTarget[],
  busLanesEnabled: boolean,
): Promise<OffPathHit[]> {
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
    { busLanesEnabled },
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hits: OffPathHit[] = [];
  for (const edge of edges) {
    if (edge.type !== "item") continue;
    const data = (edge.data ?? {}) as EdgeData;
    const item = data.item as string;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const sd = driftOf(source);
    const td = driftOf(target);
    const [d, labelX, labelY] = chamferStepPath({
      sourceX: absoluteLeft(source, byId) + nodeWidth(source) + sd.sourceDx,
      sourceY:
        absoluteTop(source, byId) + portOffsetY(source, item, "out") + sd.dy,
      targetX: absoluteLeft(target, byId) + td.targetDx,
      targetY:
        absoluteTop(target, byId) + portOffsetY(target, item, "in") + td.dy,
      ...routingHintsFromData(data),
    });
    const distance = pointToPolylineDistance(
      [
        labelX + ((data.labelDx as number | undefined) ?? 0),
        labelY + ((data.labelDy as number | undefined) ?? 0),
      ],
      parsePath(d),
    );
    if (distance > OFF_PATH_TOL) hits.push({ id: edge.id, distance });
  }
  return hits;
}

const named = (hits: OffPathHit[]): string[] =>
  hits.map((h) => `${h.id} ${h.distance.toFixed(2)}px`);

describe("the landing plan's sewage chip stays on its own line", () => {
  // The default scenario -- the plan the app opens on. Its surplus-sewage edge
  // e:3 leaves its source on a 63-unit bend-column vertical and then runs a
  // 480-unit horizontal to the surplus card. The horizontal is crossed often
  // enough that no point on it is FULLY clear, which used to send the chip to
  // tier 1b': a step flush to the containment bound, 36.5px off its polyline,
  // with the own line tangent to the box it paints.
  const targets: ItemTarget[] = [
    { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
    { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
  ];

  for (const busLanesEnabled of [true, false]) {
    it(`seats every rate chip on its polyline with lanes ${busLanesEnabled ? "on" : "off"}`, async () => {
      const hits = await offPathChips(targets, busLanesEnabled);
      expect(named(hits)).toEqual([]);
    }, 60_000);
  }
});

describe("rot-bottled_food_4 keeps its bend-column chips on their lines", () => {
  // Two more of the same shape on a wider plan: e:4 (iron_cmpt) stepped 16px off
  // a 138-unit vertical and e:11 (plant_grass_powder_1) 8.5px off a 1.5-unit
  // one, both against crossings on the leg the graze tier had a seat on.
  const targets: ItemTarget[] = [
    { itemId: "bottled_food_4", ratePerSec: { num: "1", denom: "2" } },
  ];

  for (const busLanesEnabled of [true, false]) {
    it(`seats every rate chip on its polyline with lanes ${busLanesEnabled ? "on" : "off"}`, async () => {
      const hits = await offPathChips(targets, busLanesEnabled);
      expect(named(hits)).toEqual([]);
    }, 60_000);
  }
});

describe("seatRateChip: the vertical leg's sidestep gate", () => {
  // A tall own vertical at x=0 with a long clear run, crossed transversally by
  // foreign horizontals dense enough that no point on it is fully clear. Nothing
  // here runs alongside the own line, so no step can shed anything the reader is
  // confused by, and the chip belongs on its line.
  const ownVertical = {
    pts: [
      [0, 0],
      [0, 1000],
    ] as ReadonlyArray<readonly [number, number]>,
    anchorX: 0,
    anchorY: 500,
  };

  // Transversal strokes every box-height down the whole leg, so a box of any
  // seatable height always straddles one and NO point on the line is fully clear
  // -- the state that reaches the sidestep tiers. Each one stops 65 units LEFT of
  // the own line, so a step out to the reach (half of the 120 half-width) does
  // clear them all: the old ungated tier took exactly that step and carried the
  // chip 60 units off its own vertical. Every one of them crosses the box side to
  // side; none runs alongside the own line, so none is a stroke a step is for.
  const CROSS_PITCH = 48;
  const CROSS_RIGHT_END = -65;
  const crossings = (): EdgeSegments[] =>
    Array.from({ length: 21 }, (_, i) => i * CROSS_PITCH).map((y, i) => ({
      id: `cross${i}`,
      flowKey: `cross${i}`,
      target: "elsewhere",
      segs: [[-400, y, CROSS_RIGHT_END, y] as [number, number, number, number]],
    }));

  it("keeps the chip on the line when only crossings block it", () => {
    const field = makeClearanceField(crossings(), []);
    const seat = seatRateChip({
      field,
      path: ownVertical,
      flowKey: "own",
      target: "t",
      exempt: NO_EXEMPT,
      entryBand: NO_BAND,
    });
    expect(seat.tier).toBe("graze");
    expect(seat.dx).toBe(0);
  });

  // The POSITIVE side of the tier -- a parallel neighbour still earning the step
  // -- is pinned where it already was, by the issue-#28 twin-corridor fixtures
  // and the Z2 braid suite in chipSeating.seat.test.ts. The gate added here only
  // ever CLOSES tier 1c and 1b'; it changes none of the seats those pin, and they
  // fail if it ever closes on a case it should not.
});

describe("battery5: no chip takes the only line another edge has", () => {
  // e:1 (Originium Powder) reaches its target on ONE 345-unit approach leg and
  // has nowhere else to put its chip. e:12 (Sandleaf Powder) reaches the same
  // card and has a wide run of its own to fall back on, but sorted by edge id it
  // seated FIRST, parked its box across e:1's leg, and left e:1 with no on-line
  // seat at all -- so e:1 stepped off its line. Seating the scarcest supply
  // first gives e:1 the leg and still leaves e:12 a seat on its own line.
  const targets: ItemTarget[] = [
    { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
  ];

  // With lanes on this plan also carries the one seat the browser off-path
  // audit ratified for it (CHIP_OFFPATH_BASELINE_ON.battery5 = 1): e:14
  // "Sewage" anchors on a corridor vertical with a foreign stroke running
  // PARALLEL to it inside the chip's box, so no motion along the line sheds the
  // neighbour and the sidestep tier steps the box a bounded 16 units off -- less
  // than the painted half-width, so the chip's own line still runs inside its
  // box. This suite only started seeing it once it stopped laying the plan out
  // against the solver's netted recipe map, which drops the self-consumed rows
  // of the two phase_trans recipes and moves every port below them.
  const RATIFIED_OFF_PATH = [
    "e:14:u:class:q:5->u:class:q:9:liquid_sewage 16.00px",
  ];

  for (const busLanesEnabled of [true, false]) {
    it(`seats every rate chip on its polyline with lanes ${busLanesEnabled ? "on" : "off"}`, async () => {
      const hits = await offPathChips(targets, busLanesEnabled);
      expect(named(hits)).toEqual(busLanesEnabled ? RATIFIED_OFF_PATH : []);
    }, 60_000);
  }
});

describe("multi6: a bus rise chip keeps the lane stroke inside its box", () => {
  // e:80's rise chip sits a chamfer from its own trunk's junction dot, and it
  // stays seated on its lane: a bite is the most a lane chip lifts for a thin
  // obstacle, and a bite is under a max-scale half-height, so the lane stroke
  // still runs inside the box the chip paints. A neighbouring chip is what costs
  // a full CHIP_PITCH_Y lift, and a dot costs nothing. At a pitch -- exactly two
  // max-scale half-heights -- the stroke lands ON the box edge, which is why a
  // rise needing more than one pitch is hidden rather than cast adrift (the e2e
  // seat-validity census reported such a chip 48.0 off its own line). Covering
  // the dot is the accepted cost of keeping the chip on its lane.
  const targets: ItemTarget[] = [
    { itemId: "bottled_food_5", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "bottled_rec_hp_5", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "proc_battery_3", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "equip_script_2", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "glass_enr_cmpt", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "copper_enr_cmpt", ratePerSec: { num: "1", denom: "2" } },
  ];

  it("lifts no rise chip past the depth its own box covers", async () => {
    const { edges } = await layoutSolved(solveForRender({ targets, pack }), {
      busLanesEnabled: true,
    });

    // Premise: this plan really does draw lane bus chips, the last
    // liquid_water rise among them (e:79 since the catalyst split removed the
    // plan's catalyst feed edges and renumbered the lot).
    const rises = edges.filter(
      (e) => e.type === "bus" && (e.data as EdgeData).laneY !== undefined,
    );
    expect(rises.length).toBeGreaterThan(0);
    expect(rises.some((e) => e.id.startsWith("e:79:"))).toBe(true);

    // Every stamped lift is strictly inside the half-height the chip's box
    // covers, so the lane stroke it is anchored to runs through that box.
    const lifted = rises
      .map((e) => ({
        id: e.id,
        dy: ((e.data as EdgeData).busChipDy as number | undefined) ?? 0,
      }))
      .filter((r) => Math.abs(r.dy) >= CHIP_HALF_H);
    expect(lifted).toEqual([]);
  }, 60_000);
});
