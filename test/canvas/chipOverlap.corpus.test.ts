// No two chip boxes of one plan stand on each other, and no junction dot is
// buried under a chip.
//
// A chip is a small opaque box carrying one rate. Two of them overlapping do not
// read as two labels: the reader gets one smeared figure and cannot tell which
// line either belongs to. A junction dot under a chip is the same failure seen
// from the other side -- the dot is the mark that says "this flow splits here",
// and a box over it hides the split while the chip beside it reads as the whole
// flow.
//
// This is a WHOLE-PLAN property, not a per-trunk one: the pair that collided on
// multi6 belonged to one trunk, but nothing makes two chips of unrelated edges
// keep off each other either, and the reader cannot tell the two cases apart.
// Every chip counts whatever the zoom would do with it: the LOD tiers hide
// chips as the camera pulls out, so a collision only visible at reading zoom is
// still the defect.
//
// The three ports the scoped layer model was built for are pinned by name first:
// a fan-out whose source and targets all sit inside one loop container, with a
// root card bridging the interior corridor. Under a single global layering those
// three ports merged into one layer, the trunk was declined, and both members
// took the same seat on the shared prefix.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge, type DrawnEdge } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
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
import { SCENARIOS } from "../e2e/scenarios";

// Floating-point slack: every coordinate here is a sum of the same fractional
// layout coordinates, so two boxes exactly flush must not read as overlapping.
const EPS = 1e-6;

type Chip = {
  edge: string;
  kind: string;
  x: number;
  y: number;
  halfW: number;
};

type Dot = { edge: string; kind: string; x: number; y: number };

async function layOut(scenarioId: string): Promise<{
  nodes: Awaited<ReturnType<typeof layoutSolved>>["nodes"];
  edges: Edge[];
}> {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
  );
  return { nodes, edges };
}

// Every chip one edge draws, at the anchor the path builder put it on. The same
// derivation chipAnchors.corpus uses, so the two suites judge one geometry.
function chipsOf(edge: Edge, drawn: DrawnEdge): Chip[] {
  const half = (text: Parameters<typeof chipSeatHalfW>[0]): number =>
    chipSeatHalfW(text, false);
  if (drawn.shape === "item") {
    const chips: Chip[] = [
      {
        edge: edge.id,
        kind: "item",
        x: drawn.labelAnchor.x,
        y: drawn.labelAnchor.y,
        halfW: half(rateChipText(edge)),
      },
    ];
    // The far owner of a fan-out trunk with no near member draws that trunk's
    // aggregate on the item shape, one more box that must keep off every chip
    // and every dot.
    if (drawn.trunkAnchor !== undefined) {
      chips.push({
        edge: edge.id,
        kind: "fanout aggregate",
        x: drawn.trunkAnchor.x,
        y: drawn.trunkAnchor.y,
        halfW: half(aggregateChipText(edge)),
      });
    }
    return chips;
  }
  const out: Chip[] = [
    {
      edge: edge.id,
      kind: `${drawn.shape} member`,
      x: drawn.branchAnchor.x,
      y: drawn.branchAnchor.y,
      halfW: half(branchChipText(edge)),
    },
  ];
  if (isTrunkOwner(edge.data)) {
    out.push({
      edge: edge.id,
      kind: `${drawn.shape} aggregate`,
      x: drawn.trunkAnchor.x,
      y: drawn.trunkAnchor.y,
      halfW: half(aggregateChipText(edge)),
    });
  }
  return out;
}

// Every junction dot one edge draws: the trunk junction of a retyped bus member,
// and the divergence / convergence marks chipSeating stamps on a plain item edge.
function dotsOf(edge: Edge, drawn: DrawnEdge): Dot[] {
  if (drawn.shape !== "item") {
    return [{ edge: edge.id, kind: drawn.shape, ...drawn.junction }];
  }
  const data = edge.data as
    | {
        fanoutJunctionX?: number;
        fanoutJunctionY?: number;
        faninJunctionX?: number;
        faninJunctionY?: number;
      }
    | undefined;
  const out: Dot[] = [];
  if (
    data?.fanoutJunctionX !== undefined &&
    data.fanoutJunctionY !== undefined
  ) {
    out.push({
      edge: edge.id,
      kind: "declined fanout",
      x: data.fanoutJunctionX,
      y: data.fanoutJunctionY,
    });
  }
  if (data?.faninJunctionX !== undefined && data.faninJunctionY !== undefined) {
    out.push({
      edge: edge.id,
      kind: "far fanin",
      x: data.faninJunctionX,
      y: data.faninJunctionY,
    });
  }
  return out;
}

function drawnOf(
  edge: Edge,
  byId: ReturnType<typeof nodeIndexOf>,
): DrawnEdge | undefined {
  if (edge.type !== "item" && edge.type !== "bus") return undefined;
  const ends = drawnPortsOf(edge, byId);
  if (ends === null) return undefined;
  return drawnEdge(ends, edge.type, edge.data);
}

describe("the loop fan-outs the scoped layer model was built for", () => {
  const CASES: Array<{ plan: string; source: string; targets: string[] }> = [
    {
      plan: "multi6",
      source: "u:class:q:55",
      targets: ["u:class:q:51", "u:class:q:52"],
    },
    {
      plan: "multi6",
      source: "u:class:q:56",
      targets: ["u:class:q:53", "u:class:q:54"],
    },
    {
      plan: "battery5-xiranite",
      source: "u:class:q:26",
      targets: ["u:class:q:24", "u:class:q:25"],
    },
  ];

  it.each(CASES)(
    "$plan $source fans out on one junction column with one aggregate",
    async ({ plan, source, targets }) => {
      const { edges } = await layOut(plan);
      const members = edges.filter(
        (edge) => edge.source === source && targets.includes(edge.target),
      );
      expect(members.map((edge) => edge.target).sort()).toEqual(
        [...targets].sort(),
      );

      const shape = members.map((edge) => {
        const data = edge.data as
          | { fanout?: boolean; junctionX?: number; busChipOwner?: boolean }
          | undefined;
        return {
          type: edge.type,
          fanout: data?.fanout === true,
          junctionX: data?.junctionX,
          owner: data?.busChipOwner === true,
        };
      });
      // Bus-typed members of one fan-out trunk, all on ONE junction column.
      expect(shape.every((s) => s.type === "bus" && s.fanout)).toBe(true);
      expect(new Set(shape.map((s) => s.junctionX)).size).toBe(1);
      expect(shape[0]!.junctionX).toBeTypeOf("number");
      // Exactly one member draws the trunk's aggregate chip.
      expect(shape.filter((s) => s.owner)).toHaveLength(1);
    },
    600_000,
  );
});

describe("no chip box stands on another chip box or on a junction dot", () => {
  it("holds on every corpus plan", async () => {
    const overlaps: Array<{ plan: string; a: string; b: string }> = [];
    const buried: Array<{ plan: string; chip: string; dot: string }> = [];
    let checkedChips = 0;
    let checkedDots = 0;

    for (const scenario of SCENARIOS) {
      const { nodes, edges } = await layOut(scenario.id);
      const byId = nodeIndexOf(nodes);
      const chips: Chip[] = [];
      const dots: Dot[] = [];
      for (const edge of edges) {
        const drawn = drawnOf(edge, byId);
        if (drawn === undefined) continue;
        chips.push(...chipsOf(edge, drawn));
        dots.push(...dotsOf(edge, drawn));
      }

      for (let i = 0; i < chips.length; i += 1) {
        for (let j = i + 1; j < chips.length; j += 1) {
          const a = chips[i]!;
          const b = chips[j]!;
          checkedChips += 1;
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

      for (const chip of chips) {
        for (const dot of dots) {
          checkedDots += 1;
          if (
            Math.abs(chip.x - dot.x) < chip.halfW - EPS &&
            Math.abs(chip.y - dot.y) < CHIP_HALF_H - EPS
          ) {
            buried.push({
              plan: scenario.id,
              chip: `${chip.edge} ${chip.kind}`,
              dot: `${dot.edge} ${dot.kind}`,
            });
          }
        }
      }
    }

    // Premise: the corpus really does draw chips and dots, so the empty lists
    // below are verdicts rather than empty scans.
    expect(checkedChips).toBeGreaterThan(0);
    expect(checkedDots).toBeGreaterThan(0);
    expect(overlaps).toEqual([]);
    expect(buried).toEqual([]);
  }, 600_000);
});
