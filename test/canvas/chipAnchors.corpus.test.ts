// Every chip of every corpus plan stands where the rule says, on the geometry
// the canvas actually draws.
//
// Two properties, both whole-corpus and both without a baseline -- they are
// invariants of the anchor rule, not measurements of a pass:
//   1. ON ITS OWN LINE. Every anchor -- a 1-to-1 edge's label anchor, a trunk's
//      aggregate anchor, a member's own anchor -- lies on a HORIZONTAL segment
//      of that edge's own polyline. A chip is a horizontal box, so a seat on a
//      diagonal or a vertical does not read as a label of the run beneath it.
//   2. IN ITS RESERVE ZONE. layerModel widens every inter-layer gap to hold a
//      source chip reserve, the trunk columns and a target chip reserve; a
//      trunk chip that stands outside its side's zone is standing in room
//      reserved for something else. The chip is measured as the BOX it draws
//      (chipMetrics), and it must also clear its trunk's junction dot by
//      RESERVE_COLUMN_PAD, the column-side pad of that same model.
//
// Plain 1-to-1 chips are deliberately out of scope for (2): they follow their
// own longest run wherever it goes, and only trunk chips are reserve-placed.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import {
  PORT_STUB,
  chipBoxAt,
  drawnEdge,
  horizontalRuns,
  type DrawnEdge,
} from "../../src/canvas/edgePath";
import { cardRectsFor } from "../../src/canvas/chipSeating";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import {
  RESERVE_COLUMN_PAD,
  type GapRecord,
} from "../../src/canvas/layerModel";
import {
  CHIP_HALF_H,
  aggregateChipText,
  branchChipText,
  chipSeatHalfW,
  rateChipText,
} from "../../src/canvas/chipMetrics";
import { isTrunkOwner } from "../../src/canvas/busRouting";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import type { RFAnyNode } from "../../src/canvas/layout";
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: the anchors and the zone bounds are sums of the same
// fractional layout coordinates, so they agree well inside a pixel.
const EPS = 1e-6;

type Chip = {
  plan: string;
  edge: string;
  kind: string;
  x: number;
  y: number;
  halfW: number;
};

type Laid = {
  nodes: RFAnyNode[];
  edges: Edge[];
  gaps: ReadonlyArray<GapRecord>;
};

async function layOut(scenarioId: string): Promise<Laid> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  return layoutSolved(solveForRender({ targets, pack }));
}

// Every chip one edge draws, at the anchor the path builder put it on.
function chipsOf(plan: string, edge: Edge, drawn: DrawnEdge): Chip[] {
  const half = (text: Parameters<typeof chipSeatHalfW>[0]): number =>
    chipSeatHalfW(text, false);
  if (drawn.shape === "item") {
    return [
      {
        plan,
        edge: edge.id,
        kind: "item",
        x: drawn.labelAnchor.x,
        y: drawn.labelAnchor.y,
        halfW: half(rateChipText(edge)),
      },
    ];
  }
  const out: Chip[] = [
    {
      plan,
      edge: edge.id,
      kind: `${drawn.shape} member`,
      x: drawn.branchAnchor.x,
      y: drawn.branchAnchor.y,
      halfW: half(branchChipText(edge)),
    },
  ];
  if (isTrunkOwner(edge.data)) {
    out.push({
      plan,
      edge: edge.id,
      kind: `${drawn.shape} aggregate`,
      x: drawn.trunkAnchor.x,
      y: drawn.trunkAnchor.y,
      halfW: half(aggregateChipText(edge)),
    });
  }
  return out;
}

// Is the point on a HORIZONTAL segment of this polyline?
function onHorizontalSegment(
  p: { x: number; y: number },
  pts: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    if (y0 !== y1) continue;
    if (Math.abs(p.y - y0) > EPS) continue;
    if (p.x >= Math.min(x0, x1) - EPS && p.x <= Math.max(x0, x1) + EPS) {
      return true;
    }
  }
  return false;
}

// The chip boxes that stand over a card and are NOT the 1-to-1 rule's to move:
// trunk chips, seated in the gap reserve beside the port they label. Sliding one
// along its run would walk it out of the reserve it was charged to, so these are
// recorded exactly rather than fixed. No growth allowed.
const RESIDUE: Array<{ plan: string; edge: string; kind: string }> = [
  {
    plan: "multi6",
    edge: "e:85:u:in:liquid_water:loop:plant_grass_1->u:class:q:52:liquid_water",
    kind: "fanout member",
  },
  {
    plan: "multi6",
    edge: "e:87:u:in:liquid_water:loop:plant_grass_2->u:class:q:54:liquid_water",
    kind: "fanout member",
  },
];

const gapAt = (
  gaps: ReadonlyArray<GapRecord>,
  x: number,
): GapRecord | undefined => gaps.find((g) => x > g.left && x < g.right);

describe("every chip anchor stands on a horizontal run of its own line", () => {
  it("holds on every corpus plan", async () => {
    const offLine: Array<Chip> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      for (const edge of edges) {
        if (edge.type !== "item" && edge.type !== "bus") continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        const drawn = drawnEdge(ends, edge.type, edge.data);
        for (const chip of chipsOf(scenario.id, edge, drawn)) {
          checked += 1;
          if (!onHorizontalSegment(chip, drawn.pts)) offLine.push(chip);
        }
      }
    }

    // Premise: the corpus really does draw chips, so the empty list below is a
    // verdict rather than an empty scan.
    expect(checked).toBeGreaterThan(0);
    expect(offLine).toEqual([]);
  }, 600_000);
});

describe("every trunk chip's box stands in its gap's chip reserve", () => {
  it("holds on every corpus plan", async () => {
    const outside: Array<Chip & { zone: string; box: [number, number] }> = [];
    const onDot: Array<Chip & { dot: [number, number] }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges, gaps } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      for (const edge of edges) {
        if (edge.type !== "bus") continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        const drawn = drawnEdge(ends, edge.type, edge.data);
        if (drawn.shape === "item") continue;
        // A DUAL member (a fan-out member handing its flow to a fan-in column)
        // owns only the run BETWEEN the two columns, which is the column zone
        // by construction: it is not reserve-placed and is ruled out here.
        const dual =
          drawn.shape === "fanout" &&
          (edge.data as { faninJoinX?: number } | undefined)?.faninJoinX !==
            undefined;
        for (const chip of chipsOf(scenario.id, edge, drawn)) {
          if (dual && chip.kind.endsWith("member")) continue;
          // Which side of the gap a chip is reserved on follows the port it
          // labels: a fan-out aggregate and a fan-in member stand beside their
          // source, a fan-in aggregate and a fan-out member leg beside their
          // target. The reserve was charged to the gap beside THAT port, which
          // for a member reaching two layers over is not the gap its trunk
          // column stands in.
          const sourceSide =
            chip.kind === "fanout aggregate" || chip.kind === "fanin member";
          const gap = gapAt(gaps, sourceSide ? ends.sourceX : ends.targetX);
          if (gap === undefined) continue;
          const zone = sourceSide ? gap.sourceZone : gap.targetZone;
          checked += 1;
          const box: [number, number] = [
            chip.x - chip.halfW,
            chip.x + chip.halfW,
          ];
          if (box[0] < zone.left - EPS || box[1] > zone.right + EPS) {
            outside.push({
              ...chip,
              zone: `${sourceSide ? "source" : "target"}[${zone.left}, ${zone.right}]`,
              box,
            });
          }
          const clearsX =
            Math.abs(drawn.junction.x - chip.x) >=
            chip.halfW + RESERVE_COLUMN_PAD - EPS;
          const clearsY =
            Math.abs(drawn.junction.y - chip.y) >=
            CHIP_HALF_H + RESERVE_COLUMN_PAD - EPS;
          if (!clearsX && !clearsY) {
            onDot.push({ ...chip, dot: [drawn.junction.x, drawn.junction.y] });
          }
        }
      }
    }

    expect(checked).toBeGreaterThan(0);
    expect(outside).toEqual([]);
    expect(onDot).toEqual([]);
  }, 600_000);
});

// The rects a chip box must not stand on: the RAW drawn card boxes, container
// slabs excluded (a slab is a tint behind a whole group, not a label surface).
function cardRectsOf(nodes: ReadonlyArray<RFAnyNode>): ReadonlyArray<{
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}> {
  const byId = nodeIndexOf(nodes);
  return cardRectsFor(
    nodes.filter((node) => node.type !== "group"),
    byId,
  );
}

describe("no two chips of one trunk overlap", () => {
  it("holds on every corpus plan", async () => {
    // A trunk draws one aggregate chip and one chip per member. They label
    // different quantities on different stretches of the same structure, so two
    // of them standing on one another is a misread, not a crowding nuisance.
    const overlaps: Array<{ plan: string; a: string; b: string }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      const byTrunk = new Map<string, Chip[]>();
      for (const edge of edges) {
        if (edge.type !== "item" && edge.type !== "bus") continue;
        const key = (edge.data as { trunkKey?: string } | undefined)?.trunkKey;
        if (key === undefined) continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        const drawn = drawnEdge(ends, edge.type, edge.data);
        const list = byTrunk.get(key) ?? [];
        list.push(...chipsOf(scenario.id, edge, drawn));
        byTrunk.set(key, list);
      }
      for (const chips of byTrunk.values()) {
        for (let i = 0; i < chips.length; i++) {
          for (let j = i + 1; j < chips.length; j++) {
            const a = chips[i]!;
            const b = chips[j]!;
            checked += 1;
            if (
              Math.abs(a.x - b.x) < a.halfW + b.halfW - EPS &&
              Math.abs(a.y - b.y) < 2 * CHIP_HALF_H - EPS
            ) {
              overlaps.push({
                plan: scenario.id,
                a: `${a.edge} ${a.kind}`,
                b: `${b.edge} ${b.kind}`,
              });
            }
          }
        }
      }
    }

    // Premise: the corpus really does draw multi-chip trunks.
    expect(checked).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
  }, 600_000);
});

describe("a far trunk member's chip stands on the run the rule names", () => {
  it("holds on every corpus plan", async () => {
    // A member pinned to a trunk's column (faninColumn / fanoutColumn) is drawn
    // as a plain item edge, and the run that is its OWN is not the longest one:
    // a far fan-in member owns its source stub (the first run) and a far fan-out
    // member its leg into the target (the last run). Everything else is the
    // trunk's shared stroke.
    const wrong: Array<Chip & { run: string }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      for (const edge of edges) {
        if (edge.type !== "item") continue;
        const data = edge.data as
          | { faninColumn?: boolean; fanoutColumn?: boolean }
          | undefined;
        const fanout = data?.fanoutColumn === true;
        const fanin = data?.faninColumn === true;
        if (!fanout && !fanin) continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        const drawn = drawnEdge(ends, edge.type, edge.data);
        if (drawn.shape !== "item") continue;
        const runs = horizontalRuns(drawn.pts);
        // A dual far member -- both flags -- reads as the fan-out member it is.
        const run = fanout ? runs[runs.length - 1] : runs[0];
        if (run === undefined) continue;
        const chip = chipsOf(scenario.id, edge, drawn)[0]!;
        checked += 1;
        const port = fanout ? ends.targetX : ends.sourceX;
        const seat = fanout
          ? port - PORT_STUB - chip.halfW
          : port + PORT_STUB + chip.halfW;
        const onRun =
          Math.abs(chip.y - run.y) <= EPS &&
          chip.x >= run.lo - EPS &&
          chip.x <= run.hi + EPS;
        // The seat is the port-stub one, or the run's own end where the run is
        // too short to hold the box that far out.
        const seated =
          Math.abs(chip.x - seat) <= EPS ||
          Math.abs(chip.x - run.lo) <= EPS ||
          Math.abs(chip.x - run.hi) <= EPS;
        if (!onRun || !seated) {
          wrong.push({ ...chip, run: `[${run.lo}, ${run.hi}] @ ${run.y}` });
        }
      }
    }

    // Premise: the corpus really does pin far members to trunk columns.
    expect(checked).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  }, 600_000);
});

describe("no 1-to-1 chip box stands over a card", () => {
  it("holds on every corpus plan", async () => {
    // A chip box on a card reads as that card's own label. The 1-to-1 rule
    // slides the box along its run to the nearest card-clear seat (next-longest
    // run when none clears), so this list is empty; the residue below is the
    // chip families that rule does not cover -- trunk chips, which are
    // reserve-placed beside a port and may not leave their reserve.
    const overCard: Array<Chip & { card: string }> = [];
    const residue: Array<{ plan: string; edge: string; kind: string }> = [];
    let checked = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      const cards = cardRectsOf(nodes);
      for (const edge of edges) {
        if (edge.type !== "item" && edge.type !== "bus") continue;
        const ends = drawnPortsOf(edge, byId);
        if (ends === null) continue;
        const drawn = drawnEdge(ends, edge.type, edge.data);
        for (const chip of chipsOf(scenario.id, edge, drawn)) {
          checked += 1;
          const box = chipBoxAt(chip.x, chip.y, chip.halfW);
          const hit = cards.find(
            (card) =>
              box.right > card.left + EPS &&
              box.left < card.right - EPS &&
              box.bottom > card.top + EPS &&
              box.top < card.bottom - EPS,
          );
          if (hit === undefined) continue;
          if (drawn.shape === "item" && chip.kind === "item") {
            overCard.push({ ...chip, card: hit.id });
            continue;
          }
          residue.push({ plan: chip.plan, edge: chip.edge, kind: chip.kind });
        }
      }
    }

    // Premise: the corpus really does draw chips against cards.
    expect(checked).toBeGreaterThan(0);
    expect(overCard).toEqual([]);
    expect(residue).toEqual(RESIDUE);
  }, 600_000);
});
