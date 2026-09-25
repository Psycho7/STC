// Every fan-out trunk draws its total, including the ones whose members all
// reach two or more layers away.
//
// Those trunks used to draw nothing: only a retyped member carries a trunk
// anchor, so a fan-out with no near member had no elected owner and no
// aggregate chip, and a boundary port beside a labelled one went silent for a
// reason the canvas never states. The fix elects a FAR owner, which keeps the
// item shape and seats the total on its own source stub.
//
// The count is what makes this test a verdict rather than a scan: a chip that
// is never rendered is invisible to the geometry audits, which only inspect
// boxes that exist. So the corpus is classified from scratch here -- every
// fan-out trunk, then the ones with no near member -- and the set that gains an
// owner and a seat has to be exactly that set, by TRUNK KEY per plan, not by
// count. The inventory below was harvested on the branch point; a plan that
// grows or loses a far-only trunk fails until the table is re-measured.
//
// The corpus is 17 plans: the 15 fixed SCENARIOS plus the two rotating plans
// this cluster's sites name, pinned through the fixture rotating.json rather
// than left to whatever EXAM_EXTRA_SCENARIOS happens to hold in the
// environment.

import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  drawnEdge,
  chipBoxAt,
  chipBoxClearsCards,
} from "../../src/canvas/edgePath";
import {
  cardRectsFor,
  portKeepOutRect,
  seatedChipBoxes,
} from "../../src/canvas/chipSeating";
import {
  drawnPortsOf,
  nodeIndexOf,
  edgeItem,
} from "../../src/canvas/nodeGeometry";
import {
  buildLayerModel,
  classifyTrunks,
  layerSpanOf,
  type GapRecord,
} from "../../src/canvas/layerModel";
import {
  CHIP_HALF_H,
  aggregateChipText,
  chipSeatHalfW,
} from "../../src/canvas/chipMetrics";
import { DOT_KEEPOFF } from "../../src/canvas/dimensions";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import type { RFAnyNode } from "../../src/canvas/layout";
import { SCENARIOS, extraScenariosFromEnv } from "../e2e/scenarios";

// The rotating pair, pinned the way the equivalence suite pins it: set
// unconditionally, since an inherited value would silently change the corpus.
process.env.EXAM_EXTRA_SCENARIOS = resolve(
  import.meta.dirname,
  "fixtures/levelOccupancy/rotating.json",
);

const SCENARIO_LIST = [...SCENARIOS, ...extraScenariosFromEnv()];

// Floating-point slack: every coordinate here is a sum of the same fractional
// layout coordinates.
const EPS = 1e-6;

// The far-only fan-out trunks of the corpus, by plan and trunk key
// (`item|unit`). 23 across 9 plans; the other 8 plans have none. Every key but
// script43-xiranite's `u:class:q:27` is a boundary supply, which is what a
// far-only fan-out mostly is: a raw input feeding consumers deep in the graph.
const FAR_ONLY_TRUNKS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // Re-measured when the loop boxes went flat: battery5-xiranite's
  // u:in:gas_xiranite gained a near member, and on multi6 copper_ore gained one
  // while iron_ore and originium_ore lost theirs.
  "battery5-xiranite": ["gas_xiranite|u:cat:gas_xiranite"],
  multi6: [
    "gas_xiranite|u:cat:gas_xiranite",
    "iron_ore|u:in:iron_ore",
    "originium_ore|u:in:originium_ore",
  ],
  script43: [
    "gas_inert|u:in:gas_inert",
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
  ],
  "coupon-web": [
    "gas_inert|u:in:gas_inert",
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
  ],
  "gas-web": [
    "gas_inert|u:in:gas_inert",
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
  ],
  "rot-bottled_food_4": ["iron_ore|u:in:iron_ore"],
  transmuters: [
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
  ],
  "copper-script43": [
    "gas_inert|u:in:gas_inert",
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
  ],
  "script43-xiranite": [
    "gas_inert|u:in:gas_inert",
    "gas_xiranite|u:cat:gas_xiranite",
    "gas_xiranite|u:in:gas_xiranite",
    "xiranite_enr_powder|u:class:q:27",
  ],
};

const TOTAL_FAR_ONLY = Object.values(FAR_ONLY_TRUNKS).reduce(
  (sum, keys) => sum + keys.length,
  0,
);

type Laid = {
  nodes: RFAnyNode[];
  edges: Edge[];
  gaps: ReadonlyArray<GapRecord>;
};

async function layOut(scenarioId: string): Promise<Laid> {
  const scenario = SCENARIO_LIST.find((s) => s.id === scenarioId)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  return layoutSolved(solveForRender({ targets, pack }));
}

// A trunk has a NEAR member exactly when one of its members was retyped into
// the fan-out bus shape: that shape is the only one carrying a trunk segment,
// which is why the election had to be widened at all.
const drawsTheTrunk = (edge: Edge | undefined): boolean =>
  edge?.type === "bus" &&
  (edge.data as { fanout?: boolean } | undefined)?.fanout === true;

type Seat = {
  plan: string;
  trunkKey: string;
  owner: string;
  x: number;
  y: number;
  halfW: number;
};

// Every segment of every edge that carries a DIFFERENT flow than the owner's,
// as the foreign strokes its box must not contain.
function foreignSegments(
  owner: Edge,
  edges: ReadonlyArray<Edge>,
  byId: ReturnType<typeof nodeIndexOf>,
): Array<{ id: string; seg: readonly [number, number, number, number] }> {
  const ownFlow = `${edgeItem(owner) ?? ""}|${owner.source}`;
  const out: Array<{
    id: string;
    seg: readonly [number, number, number, number];
  }> = [];
  for (const edge of edges) {
    if (edge.type !== "item" && edge.type !== "bus") continue;
    if (edge.id === owner.id) continue;
    if (`${edgeItem(edge) ?? ""}|${edge.source}` === ownFlow) continue;
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const pts = drawnEdge(ends, edge.type, edge.data).pts;
    for (let i = 1; i < pts.length; i += 1) {
      const [x0, y0] = pts[i - 1]!;
      const [x1, y1] = pts[i]!;
      out.push({ id: edge.id, seg: [x0, y0, x1, y1] });
    }
  }
  return out;
}

// Does a segment touch the box? Segments are axis-aligned or 45-degree chamfer
// bevels, so sampling the two ends plus the midpoints of a short subdivision is
// exact enough at this scale: a stroke entering the box is dozens of units long
// against a 16-unit subdivision.
function segmentEntersBox(
  seg: readonly [number, number, number, number],
  box: { left: number; right: number; top: number; bottom: number },
): boolean {
  const [x0, y0, x1, y1] = seg;
  const steps = Math.max(
    2,
    Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 4),
  );
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    if (
      x > box.left + EPS &&
      x < box.right - EPS &&
      y > box.top + EPS &&
      y < box.bottom - EPS
    ) {
      return true;
    }
  }
  return false;
}

describe("a fan-out with no near member still draws its total", () => {
  it("elects an owner and seats a clear box on exactly the far-only trunks", async () => {
    const farOnlyByPlan = new Map<string, string[]>();
    const ownedByPlan = new Map<string, string[]>();
    const seats: Seat[] = [];
    const outsideZone: string[] = [];
    const onDot: string[] = [];
    const overStroke: string[] = [];
    const overChip: string[] = [];
    const overCard: string[] = [];

    for (const scenario of SCENARIO_LIST) {
      const { nodes, edges, gaps } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      const model = buildLayerModel(nodes);
      const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
      const cards = cardRectsFor(nodes);
      const surface = [
        ...cards,
        ...cards.flatMap((card) => [
          portKeepOutRect(card, "source"),
          portKeepOutRect(card, "target"),
        ]),
      ];
      const chipBoxes = seatedChipBoxes(nodes, edges);

      const farOnly: string[] = [];
      const owned: string[] = [];
      for (const trunk of classifyTrunks(nodes, edges).trunks) {
        if (trunk.kind !== "fanOut") continue;
        const members = trunk.members.map((id) => edgeById.get(id));
        if (members.some(drawsTheTrunk)) continue;
        farOnly.push(trunk.key);

        // The elected owner: the one member stamped with this trunk's
        // aggregate, drawn as an item edge that seated a trunk anchor.
        const owners = members.filter(
          (edge) =>
            (edge?.data as { trunkKey?: string; busChipOwner?: boolean })
              ?.busChipOwner === true &&
            (edge?.data as { trunkKey?: string })?.trunkKey === trunk.key,
        );
        expect(owners.map((edge) => edge!.id)).toHaveLength(1);
        const owner = owners[0]!;
        const ends = drawnPortsOf(owner, byId)!;
        const drawn = drawnEdge(ends, owner.type, owner.data);
        expect(drawn.shape).toBe("item");
        if (drawn.shape !== "item" || drawn.trunkAnchor === undefined) continue;
        owned.push(trunk.key);

        const halfW = chipSeatHalfW(aggregateChipText(owner), false);
        const seat: Seat = {
          plan: scenario.id,
          trunkKey: trunk.key,
          owner: owner.id,
          x: drawn.trunkAnchor.x,
          y: drawn.trunkAnchor.y,
          halfW,
        };
        seats.push(seat);
        const where = `${scenario.id} ${trunk.key} (${owner.id})`;
        const box = chipBoxAt(seat.x, seat.y, halfW);

        // 1. Inside the source zone of the gap its own source port stands in:
        // the room layerModel charged for this very chip.
        const span = layerSpanOf(model, owner.source, owner.target);
        const gap = gaps.find(
          (g) =>
            g.scope === span?.scope &&
            ends.sourceX > g.left &&
            ends.sourceX < g.right,
        );
        expect(gap).toBeDefined();
        if (
          gap !== undefined &&
          (box.left < gap.sourceZone.left - EPS ||
            box.right > gap.sourceZone.right + EPS)
        ) {
          outsideZone.push(
            `${where}: [${box.left}, ${box.right}] outside [${gap.sourceZone.left}, ${gap.sourceZone.right}]`,
          );
        }

        // 2. Clear of the trunk's divergence dot by the dot keep-off, in x or
        // in y: the dot is the mark that says the flow splits here, and the box
        // beside it must not touch it.
        for (const member of members) {
          const data = member?.data as
            | { fanoutJunctionX?: number; fanoutJunctionY?: number }
            | undefined;
          if (
            data?.fanoutJunctionX === undefined ||
            data.fanoutJunctionY === undefined
          ) {
            continue;
          }
          const clearsX =
            Math.abs(data.fanoutJunctionX - seat.x) >=
            halfW + DOT_KEEPOFF - EPS;
          const clearsY =
            Math.abs(data.fanoutJunctionY - seat.y) >=
            CHIP_HALF_H + DOT_KEEPOFF - EPS;
          if (!clearsX && !clearsY) {
            onDot.push(
              `${where}: dot (${data.fanoutJunctionX}, ${data.fanoutJunctionY})`,
            );
          }
        }

        // 3. No foreign stroke through the box.
        for (const { id, seg } of foreignSegments(owner, edges, byId)) {
          if (segmentEntersBox(seg, box)) {
            overStroke.push(`${where}: ${id} [${seg.join(", ")}]`);
          }
        }

        // 4. No overlap with any other seated chip of the plan.
        for (const chip of chipBoxes) {
          if (chip.edgeId === owner.id && chip.family === "fanout-agg")
            continue;
          if (
            Math.abs(chip.x - seat.x) < chip.halfW + halfW - EPS &&
            Math.abs(chip.y - seat.y) < 2 * CHIP_HALF_H - EPS
          ) {
            overChip.push(`${where}: ${chip.edgeId} ${chip.family}`);
          }
        }

        // 5. No card or port-furniture contact.
        if (!chipBoxClearsCards(seat.x, seat.y, halfW, surface)) {
          overCard.push(where);
        }
      }
      farOnlyByPlan.set(scenario.id, farOnly.sort());
      ownedByPlan.set(scenario.id, owned.sort());
    }

    // The set that gains an owner IS the far-only set, plan by plan and key by
    // key, and both equal the harvested inventory.
    const expected = new Map(
      SCENARIO_LIST.map((s) => [
        s.id,
        [...(FAR_ONLY_TRUNKS[s.id] ?? [])].sort(),
      ]),
    );
    expect(Object.fromEntries(farOnlyByPlan)).toEqual(
      Object.fromEntries(expected),
    );
    expect(Object.fromEntries(ownedByPlan)).toEqual(
      Object.fromEntries(expected),
    );
    expect(seats).toHaveLength(TOTAL_FAR_ONLY);

    expect(outsideZone).toEqual([]);
    expect(onDot).toEqual([]);
    expect(overStroke).toEqual([]);
    expect(overChip).toEqual([]);
    expect(overCard).toEqual([]);
  }, 900_000);
});
