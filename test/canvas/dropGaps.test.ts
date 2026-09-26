// A drop re-measures the gap records on the live placement (rerouteAfterDrop)
// instead of replaying the ones the last layout widened. On a hand-built
// fixture laid out by widenLayerGaps and then dragged:
//   - the drop's records are exactly measureGapRecords on the live nodes, and
//     the drop's edges the routing fold over them;
//   - a gap squeezed below its requirement keeps every zone left <= right and
//     its trunk columns ordered and distinct, and no chip box stands on a card
//     or its port furniture (a chip that no longer fits its run demotes);
//   - a gap too narrow even for its columns compresses their pitch, still
//     ordered and distinct.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import {
  rerouteAfterDrop,
  rerouteEdges,
  type RFAnyNode,
} from "../../src/canvas/layout";
import {
  COLUMN_PITCH,
  gapKeyOf,
  measureGapRecords,
  widenLayerGaps,
  type GapRecord,
} from "../../src/canvas/layerModel";
import { buildGapColumnOrder } from "../../src/canvas/gapColumnOrder";
import {
  cardRectsFor,
  portKeepOutRect,
  seatedChipBoxes,
} from "../../src/canvas/chipSeating";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
import {
  mkEdge,
  mkRecipe,
  orderedRecipeNode,
  recipeNode,
} from "./busRouting.testkit";

// Recipe cards RECIPE_WIDTH wide, ELK's 110 between two layers.
const LAYER_PITCH = RECIPE_WIDTH + 110;
// Overlap slack: a box touching an obstacle's edge does not stand on it.
const EPS = 0.5;

const producer = (id: string, y: number, item: string): RFAnyNode =>
  recipeNode(id, 0, y, mkRecipe(id, [], [item]));

// Gap 0 carries a fan-out (p -> c1, c2) and a fan-in (q1, q2 -> d), each with
// its aggregate chip, laid out the way the app lays it out: widened first.
// With `secondFanOut`, p2 fans a third trunk out of layer 0 (p2 -> c3, c4), so
// gap 0 owes three trunk columns.
function laidOut(secondFanOut = false): { nodes: RFAnyNode[]; edges: Edge[] } {
  const nodes: RFAnyNode[] = [
    producer("p", 0, "s"),
    producer("q1", 200, "t"),
    producer("q2", 400, "t"),
    orderedRecipeNode("c1", LAYER_PITCH, 0, ["s"]),
    orderedRecipeNode("c2", LAYER_PITCH, 200, ["s"]),
    orderedRecipeNode("d", LAYER_PITCH, 400, ["t"]),
  ];
  const edges: Edge[] = [
    mkEdge("e:0", "p", "c1", "s"),
    mkEdge("e:1", "p", "c2", "s"),
    mkEdge("e:2", "q1", "d", "t"),
    mkEdge("e:3", "q2", "d", "t"),
  ];
  if (secondFanOut) {
    nodes.push(
      producer("p2", 600, "u"),
      orderedRecipeNode("c3", LAYER_PITCH, 600, ["u"]),
      orderedRecipeNode("c4", LAYER_PITCH, 800, ["u"]),
    );
    edges.push(mkEdge("e:4", "p2", "c3", "u"), mkEdge("e:5", "p2", "c4", "u"));
  }
  return { nodes: widenLayerGaps(nodes, edges).nodes, edges };
}

const moveTo = (
  nodes: ReadonlyArray<RFAnyNode>,
  id: string,
  dx: number,
): RFAnyNode[] =>
  nodes.map((n) =>
    n.id === id
      ? { ...n, position: { x: n.position.x + dx, y: n.position.y } }
      : n,
  );

// Every chip box the drop draws, at the seat the renderer uses: an item chip
// that deconflictChipAnchors slid is drawn at its stamped seat.
function drawnChipBoxes(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
) {
  const byId = new Map(edges.map((e) => [e.id, e]));
  return seatedChipBoxes(nodes, edges).map((box) => {
    const data = byId.get(box.edgeId)!.data as
      | { chipX?: number; chipY?: number }
      | undefined;
    return box.family === "label" && data?.chipX !== undefined
      ? { ...box, x: data.chipX, y: data.chipY! }
      : box;
  });
}

function chipsOnFurniture(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): string[] {
  const rects = cardRectsFor(nodes).flatMap((card) => [
    { name: `card ${card.id}`, ...card },
    { name: `source ports ${card.id}`, ...portKeepOutRect(card, "source") },
    { name: `target ports ${card.id}`, ...portKeepOutRect(card, "target") },
  ]);
  const hits: string[] = [];
  for (const box of drawnChipBoxes(nodes, edges)) {
    for (const r of rects) {
      if (
        box.x + box.halfW > r.left + EPS &&
        box.x - box.halfW < r.right - EPS &&
        box.y + box.halfH > r.top + EPS &&
        box.y - box.halfH < r.bottom - EPS
      ) {
        hits.push(`${box.edgeId} ${box.family} on ${r.name}`);
      }
    }
  }
  return hits;
}

function invertedZones(gaps: ReadonlyArray<GapRecord>): string[] {
  return gaps.flatMap((gap) =>
    (["sourceZone", "columnZone", "targetZone"] as const)
      .filter((zone) => gap[zone].left > gap[zone].right)
      .map((zone) => `${gapKeyOf(gap)} ${zone}`),
  );
}

// Each gap's trunk columns in the gap's own left-to-right order.
function laneColumns(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
  gaps: ReadonlyArray<GapRecord>,
): Map<string, number[]> {
  const order = buildGapColumnOrder(nodes, edges, gaps);
  const out = new Map<string, number[]>();
  for (const [key, gap] of order.gaps) {
    const xs = gap.ordered
      .map((c) => order.laneColumn(c.id))
      .filter((x): x is number => x !== undefined);
    out.set(key, xs);
  }
  return out;
}

describe("a drop re-measures the gap records on the live placement", () => {
  it("routes the drop over exactly the records measured on the live nodes", () => {
    const { nodes, edges } = laidOut();
    const moved = moveTo(nodes, "d", -150);

    const drop = rerouteAfterDrop(moved, edges);
    expect(drop.gaps).toEqual(measureGapRecords(moved, edges));
    expect(drop.edges).toEqual(rerouteEdges(moved, edges, { gaps: drop.gaps }));
  });

  it("replays the layout exactly at rest", () => {
    const { nodes, edges } = laidOut();
    const { gaps } = widenLayerGaps(nodes, edges);

    const drop = rerouteAfterDrop(nodes, edges);
    expect(drop.gaps).toEqual(gaps);
    expect(drop.edges).toEqual(rerouteEdges(nodes, edges, { gaps }));
  });

  // The fan-in side (d dragged left) and the fan-out side (p dragged right)
  // both squeeze gap 0 from 397 to 247, below its requirement and above the
  // 128 its two columns owe.
  for (const [id, dx] of [
    ["d", -150],
    ["p", 150],
  ] as const) {
    it(`keeps chips off cards and columns in order when ${id} squeezes the gap by ${Math.abs(dx)}`, () => {
      const { nodes, edges } = laidOut();
      const atRest = rerouteAfterDrop(nodes, edges);
      expect(chipsOnFurniture(nodes, atRest.edges)).toEqual([]);

      const moved = moveTo(nodes, id, dx);
      const drop = rerouteAfterDrop(moved, edges);
      const gap = drop.gaps[0]!;
      expect(gap.right - gap.left).toBe(247);

      expect(invertedZones(drop.gaps)).toEqual([]);
      expect(chipsOnFurniture(moved, drop.edges)).toEqual([]);
      const xs = laneColumns(moved, edges, drop.gaps).get(gapKeyOf(gap))!;
      expect(xs).toHaveLength(2);
      for (let i = 1; i < xs.length; i += 1) {
        expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(COLUMN_PITCH);
      }
    });
  }

  it("compresses the column pitch when the columns alone exceed the gap", () => {
    const { nodes, edges } = laidOut(true);
    // d drops 40 right of layer 0, clear of c1 to c4: a layer of its own, and
    // a 40-wide gap 0 that still owes both fan-outs' columns and the fan-in's.
    // Three walks at the full pitch would need 96: the fan-out walk would run
    // past the fan-in column and out of the zone.
    const d = nodes.find((n) => n.id === "d")!;
    const moved = moveTo(nodes, "d", RECIPE_WIDTH + 40 - d.position.x);

    const drop = rerouteAfterDrop(moved, edges);
    const gap = drop.gaps[0]!;
    expect(gap.right - gap.left).toBe(40);
    expect(invertedZones(drop.gaps)).toEqual([]);

    const xs = laneColumns(moved, edges, drop.gaps).get(gapKeyOf(gap))!;
    expect(xs).toHaveLength(3);
    for (let i = 1; i < xs.length; i += 1) {
      const pitch = xs[i]! - xs[i - 1]!;
      expect(pitch).toBeGreaterThan(0);
      expect(pitch).toBeLessThan(COLUMN_PITCH);
    }
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(gap.columnZone.left);
      expect(x).toBeLessThanOrEqual(gap.columnZone.right);
    }
  });
});
