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
  edgeTargetSide,
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
async function offPathChips(targets: ItemTarget[]): Promise<OffPathHit[]> {
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
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
      // The target row is read by side, exactly as the drawn-frame reader
      // does: a catalyst edge lands on the card's `cat:` row, which for an
      // item the same card also consumes is a different row from its `in:`
      // one.
      targetY:
        absoluteTop(target, byId) +
        portOffsetY(target, item, edgeTargetSide(edge)) +
        td.dy,
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

  it("seats every rate chip on its polyline", async () => {
    const hits = await offPathChips(targets);
    expect(named(hits)).toEqual([]);
  }, 60_000);
});

describe("rot-bottled_food_4 keeps its bend-column chips on their lines", () => {
  // Two more of the same shape on a wider plan: e:4 (iron_cmpt) and e:11
  // (plant_grass_powder_1) used to step 16px / 8.5px off their bend columns
  // against crossings on the leg the graze tier had a seat on, which the gate
  // closed. Since the card trim moved the input rows, one bounded sidestep is
  // back and ratified: e:11's corridor to q:6 is exactly one window-capped
  // box wide (the two port bands leave 106 between them, and its "150/min"
  // chip caps at exactly that), so the box fits only FLUSH -- and the anchor,
  // the midpoint of the chamfer, still laps the source out-band by 16.5,
  // while the water line's descent and the target in-band pin the run's
  // right end. With no fully-clear on-line seat anywhere, the ungated step
  // takes one slot pitch (+16) and seats clear, the own run 4.5 under the
  // centre -- inside the painted box, the battery5 lists' class. e:4 keeps
  // its on-line seat at both lane arms.
  const targets: ItemTarget[] = [
    { itemId: "bottled_food_4", ratePerSec: { num: "1", denom: "2" } },
  ];

  // MERGE 2026-09-13 (chips graph objects on the develop merge): the e:11
  // sidestep above is RETIRED. Its cause was the 48-tall max-scale box; the
  // graph-object chip is its natural box at height 20, which fits the 106-wide
  // window on the line, so the walk never leaves it. Tightened back to none.
  it("seats every rate chip on its polyline", async () => {
    const hits = await offPathChips(targets);
    expect(named(hits)).toEqual([]);
  }, 60_000);
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

  // Transversal strokes closer together than one box height down the whole leg,
  // so every seatable box straddles one and NO point on the line is fully clear
  // -- the state that reaches the sidestep tiers. Each one stops 40 units LEFT of
  // the own line, so a step out to the reach (half of the 60 half-width) does
  // clear them all: the old ungated tier took exactly that step and carried the
  // chip 30 units off its own vertical. Every one of them crosses the box side to
  // side; none runs alongside the own line, so none is a stroke a step is for.
  const CROSS_PITCH = 19;
  const CROSS_RIGHT_END = -40;
  const crossings = (): EdgeSegments[] =>
    Array.from({ length: 54 }, (_, i) => i * CROSS_PITCH).map((y, i) => ({
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
  // e:1 (Originium Powder) reaches its target on ONE ~300-unit approach leg and
  // has nowhere else to put its chip. e:12 (Sandleaf Powder) reaches the same
  // card and has a wide run of its own to fall back on, but sorted by edge id it
  // seated FIRST, parked its box across e:1's leg, and left e:1 with no on-line
  // seat at all -- so e:1 stepped off its line. Seating the scarcest supply
  // first still settles the pair: e:12 keeps a seat on its own line at the
  // shrink reserve (cap 1) while e:1 holds a full-reserve seat over the middle
  // of its leg (its bounded step below), so the scarcity order this describe
  // exists for still holds at the trimmed card's geometry.
  const targets: ItemTarget[] = [
    { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
  ];

  // The one off-path seat this plan now carries, the bounded-sidestep class
  // this suite's old e:14 entry was ratified under: a step under the
  // max-scale painted half-height, so the chip's own line still runs inside
  // its box. The card's header/footer trim moved every input row up 20 units
  // and shortened the cards; at the rows' pitch against the 48-tall
  // max-scale box this corridor no longer offers one fully-clear ON-LINE
  // seat, so the sidestep walk -- ungated on e:1, whose anchor sits on a
  // horizontal-dominant chamfer -- seats the chip beside its line instead:
  // its own source out-band pins the corridor's left end, and e:12's drawn
  // line runs 22 below the approach leg at the adjacent input row, so every
  // max-scale box centred ON the leg straddles one or the other. The leg
  // passes 4.5 under the seated centre.
  // The same trim RETIRED the previous ratified seat: e:14 "Sewage" stepped
  // 16 off its corridor vertical against a parallel foreign stroke, but its
  // window-capped box can no longer step past that stroke (the reach is half
  // the 141-wide reserve, the stroke sits 30 past the line) and the stroke
  // is too far away to braid, so the chip now grazes ON its own line and
  // drops out of this list.
  // MERGE 2026-09-13 (chips graph objects on the develop merge): the e:1
  // sidestep above is RETIRED for the same reason as the rot-bottled_food_4
  // one. Every box the walk tries is now 20 tall, not 48, so a seat centred ON
  // the approach leg clears e:12's line and the chip never steps beside it.
  it("seats every rate chip on its polyline", async () => {
    const hits = await offPathChips(targets);
    expect(named(hits)).toEqual([]);
  }, 60_000);
});
