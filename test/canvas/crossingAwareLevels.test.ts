// jogForwardLegs takes, among the levels that clear every card and the level
// floor, the one crossing the fewest columns and runs already on the canvas,
// the nearest such level breaking a tie.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  ENTRY_SLOT_PITCH,
  columnsBreakPitch,
  jogForwardLegs,
  sharesTrunk,
} from "../../src/canvas/busRouting";
import { drawnEdge } from "../../src/canvas/edgePath";
import type { RFAnyNode } from "../../src/canvas/layout";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { countCrossings } from "../e2e/geometry";
import { SCENARIOS } from "../e2e/scenarios";
import { inputProductNode, mkEdge } from "./busRouting.testkit";

const legYOf = (edges: Edge[], id: string): number | undefined =>
  (edges.find((e) => e.id === id)?.data as { legY?: number } | undefined)?.legY;

describe("the jog level sees what it crosses", () => {
  // e0 runs s -> t (source row 39, target row 139) past the tall card F, so it
  // must jog above F (level 64, the nearer) or below it (level 316). e1 leaves
  // a card above the corridor and stands its column at x 620, down to b.
  const fixture = (
    bLeft: number,
    bTop: number,
  ): { nodes: RFAnyNode[]; edges: Edge[] } => ({
    nodes: [
      inputProductNode("s", "ore", 0, 0), // right 148, port y 39
      inputProductNode("t", "ore", 760, 100), // left 760, port y 139
      inputProductNode("F", "ore", 360, 80, 220, 220), // y 80..300
      inputProductNode("a", "ore", 0, -200), // right 148, port y -161
      inputProductNode("b", "ore", bLeft, bTop, 40, 40),
    ],
    edges: [
      {
        ...mkEdge("e0", "s", "t", "ore"),
        data: { item: "ore", rate: new Fraction(1), bendX: 200 },
      },
      {
        ...mkEdge("e1", "a", "b", "ore"),
        data: { item: "ore", rate: new Fraction(1), bendX: 620 },
      },
    ],
  });

  it("takes the farther level when the nearer one crosses a column", () => {
    // b beside the corridor at row 200: e1's column crosses 64 only.
    const { nodes, edges } = fixture(660, 180);
    const out = jogForwardLegs(nodes, edges);
    expect(legYOf(out, "e0")).toBe(316);
    expect(legYOf(out, "e1")).toBeUndefined();
  });

  it("keeps the nearer level when both cross the same number", () => {
    // b past t at row 431: e1's column crosses both levels, and its run lies
    // beyond the reach of e0's descent, so distance decides.
    const { nodes, edges } = fixture(1000, 411);
    const out = jogForwardLegs(nodes, edges);
    expect(legYOf(out, "e0")).toBe(64);
    expect(legYOf(out, "e1")).toBeUndefined();
  });
});

describe("the column pitch floor between two verticals", () => {
  const col = (x: number, top: number, bottom: number) => ({ x, top, bottom });

  it("breaks where two overlapping verticals stand closer than the pitch", () => {
    expect(columnsBreakPitch(col(100, 0, 200), col(100, 150, 300))).toBe(true);
    expect(
      columnsBreakPitch(
        col(100, 0, 200),
        col(100 + ENTRY_SLOT_PITCH / 2, 50, 60),
      ),
    ).toBe(true);
  });

  it("holds one pitch apart", () => {
    expect(
      columnsBreakPitch(col(100, 0, 200), col(100 + ENTRY_SLOT_PITCH, 0, 200)),
    ).toBe(false);
  });

  it("holds where the rows do not overlap, even on one x", () => {
    expect(columnsBreakPitch(col(100, 0, 200), col(100, 200, 300))).toBe(false);
  });

  it("exempts two members of one trunk", () => {
    const trunk = { key: "k" } as never;
    const byId = new Map([
      ["a", { fanOut: trunk }],
      ["b", { fanOut: trunk }],
      ["c", {}],
    ]);
    expect(sharesTrunk(byId, "a", "b")).toBe(true);
    expect(sharesTrunk(byId, "a", "c")).toBe(false);
  });
});

type Plan = Awaited<ReturnType<typeof layoutSolved>>;

async function layoutOf(id: string): Promise<Plan> {
  const scenario = SCENARIOS.find((s) => s.id === id)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  return layoutSolved(solveForRender({ targets, pack }));
}

function planCrossings({ nodes, edges }: Plan): number {
  const byId = nodeIndexOf(nodes);
  const drawn: { id: string; d: string }[] = [];
  for (const edge of edges) {
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    drawn.push({ id: edge.id, d: drawnEdge(ends, edge.type, edge.data).path });
  }
  return countCrossings(drawn);
}

describe("the jog level on the corpus", () => {
  it("runs rot-bottled_food_4's far water member above the cycle", async () => {
    // e:16, u:in:liquid_water -> q:8, far fan-out member whose card-clear
    // levels straddle the cycle q:7 / q:10. The nearest, 209.5 under the
    // cycle, crosses 8 lines; the one above it crosses the plan's base 3.
    const plan = await layoutOf("rot-bottled_food_4");
    const e16 = plan.edges.find((e) => e.id.startsWith("e:16:"))!;
    const legY = (e16.data as { legY?: number }).legY!;
    expect(legY).toBeLessThan(89); // q:7's top
    expect(planCrossings(plan)).toBeLessThanOrEqual(3);
  }, 600_000);

  it("passes a card clear of its clearance where the crossings tie", async () => {
    // copper-script43 e:32, u:in:gas_xiranite -> q:8: 958, 961, 962.5 and 965
    // each cross two lines. The first three run inside q:9's clearance, a
    // unit to five and a half under it; 965 is q:9's own escape level.
    const plan = await layoutOf("copper-script43");
    const e32 = plan.edges.find((e) => e.id.startsWith("e:32:"))!;
    expect((e32.data as { legY?: number }).legY).toBe(965);
  }, 600_000);

  it("keeps the nearest level where the clear levels tie", async () => {
    // default e:5, q:3 -> the sewage surplus: its clear levels 177.5, 179,
    // 185.5 and 297 each cross one line, so the nearest stands, as it did
    // before the crossing count.
    const plan = await layoutOf("default");
    const e5 = plan.edges.find((e) => e.id.startsWith("e:5:"))!;
    expect((e5.data as { legY?: number }).legY).toBe(177.5);
  }, 600_000);
});
