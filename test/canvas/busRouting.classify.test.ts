// Fan-out classification and the direct-corridor gate. Fixtures come from
// ./busRouting.testkit.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import {
  routeFanoutEdges,
  assignBendColumns,
  assignEntryColumns,
  clampBackwardRails,
  directCorridorClear,
  jogForwardLegs,
  FANOUT_SPAN_MAX,
  FANOUT_SPAN_MIN,
} from "../../src/canvas/busRouting";
import { nodeWidth, portOffsetY } from "../../src/canvas/nodeGeometry";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import {
  PORT_STUB,
  CHAMFER,
  chamferFanoutPath,
  parsePathPoints,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import type { RFAnyNode } from "../../src/canvas/layout";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  mkRecipe,
  recipeNode,
  inputProductNode,
  mkEdge,
} from "./busRouting.testkit";

describe("routeFanoutEdges (6C)", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // One layer over: gap = 410 - 300 = 110, inside FANOUT_SPAN_MAX (410).
  const oneGap = 410;

  const fanData = (edges: Edge[], id: string) =>
    edges.find((e) => e.id === id)!.data as {
      fanout?: boolean;
      trunkKey?: string;
      junctionX?: number;
      busTotalRate?: Fraction;
      busMemberCount?: number;
      busChipOwner?: boolean;
      fanoutContested?: boolean;
    };

  type Rect = { left: number; top: number; right: number; bottom: number };

  // Liang-Barsky segment clip: does segment a->b cross the rectangle's interior?
  // Boundary-only contact (a run grazing an edge) is not a crossing. Mirrors the
  // helper in busRouting.columns.test.ts.
  const segCrossesRect = (
    a: readonly [number, number],
    b: readonly [number, number],
    rect: Rect,
  ): boolean => {
    let t0 = 0;
    let t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [
      a[0] - rect.left,
      rect.right - a[0],
      a[1] - rect.top,
      rect.bottom - a[1],
    ];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i]! < 0) return false;
        continue;
      }
      const t = q[i]! / p[i]!;
      if (p[i]! < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return t0 < t1;
  };

  const parseD = parsePathPoints;

  // Reconstruct a fan-out member's drawn polyline exactly as BusEdge does (same
  // builder + hints) and assert none of its segments cross the given raw rect.
  const assertMemberClearsRect = (
    out: Edge[],
    nodes: RFAnyNode[],
    id: string,
    rect: Rect,
  ): void => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const e = out.find((x) => x.id === id)!;
    const source = byId.get(e.source)!;
    const target = byId.get(e.target)!;
    const sx = source.position.x + nodeWidth(source);
    const sy = source.position.y + portOffsetY(source, "b", "out");
    const tx = target.position.x;
    const ty = target.position.y + portOffsetY(target, "b", "in");
    const d = chamferFanoutPath({
      sourceX: sx,
      sourceY: sy,
      targetX: tx,
      targetY: ty,
      ...routingHintsFromData(e.data),
    }).path;
    const pts = parseD(d);
    for (let i = 1; i < pts.length; i++) {
      expect(segCrossesRect(pts[i - 1]!, pts[i]!, rect)).toBe(false);
    }
  };

  it("groups two same-source-port one-gap edges into a fan-out trunk", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];

    const out = routeFanoutEdges(nodes, edges);

    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      const d = fanData(out, id);
      expect(d.fanout).toBe(true);
      expect(d.trunkKey).toBe("b|s");
      // Junction column stamped, inside the corridor.
      expect(typeof d.junctionX).toBe("number");
      expect(d.junctionX!).toBeGreaterThan(300); // right of source
      expect(d.junctionX!).toBeLessThan(oneGap); // left of targets
    }
    // Aggregate = summed member rates (1 + 1), count 2, exactly one owner.
    const owners = out.filter((e) => fanData(out, e.id).busChipOwner);
    expect(owners).toHaveLength(1);
    expect(owners[0]!.id).toBe("e0"); // lex-smallest edge id
    const agg = fanData(out, "e0");
    expect(agg.busTotalRate!.equals(new Fraction(2))).toBe(true);
    expect(agg.busMemberCount).toBe(2);
    // Both members share ONE junction column.
    expect(fanData(out, "e0").junctionX).toBe(fanData(out, "e1").junctionX);
  });

  it("forms an N=3 fan-out where every member reaches its own target", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];

    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
      expect(fanData(out, id).fanout).toBe(true);
    }
    expect(fanData(out, "e0").busMemberCount).toBe(3);
    expect(fanData(out, "e0").busTotalRate!.equals(new Fraction(3))).toBe(true);
    // One shared junction across all three branches.
    const jx = new Set(
      ["e0", "e1", "e2"].map((id) => fanData(out, id).junctionX),
    );
    expect(jx.size).toBe(1);
    // Exactly the lex-smallest edge (e0) is the elected owner; the branches are
    // non-owners.
    expect(fanData(out, "e0").busChipOwner).toBe(true);
    expect(fanData(out, "e1").busChipOwner).toBe(false);
    expect(fanData(out, "e2").busChipOwner).toBe(false);
  });

  it("does NOT fan out a lone within-gap member (N=1)", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[0]).toBe(edges[0]); // untouched by reference
  });

  it("does NOT fan out different items, different ports, or different sources", () => {
    const rMulti = mkRecipe("rMulti", ["a"], ["b", "c"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, rMulti),
      recipeNode("s2", 0, 900, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 900, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"), // item b from s
      mkEdge("e1", "s", "t2", "c"), // item c from s -> different port
      mkEdge("e2", "s2", "t3", "b"), // item b from a different source
    ];
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("item");
    }
  });

  it("does NOT fan out a two-layer (multi-gap) pair", () => {
    // gap = 820 - 300 = 520 > FANOUT_SPAN_MAX (410): two layers over.
    const twoGap = 820;
    expect(twoGap - 300).toBeGreaterThan(FANOUT_SPAN_MAX);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", twoGap, 0, r),
      recipeNode("t2", twoGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("does NOT fan out a sub-budget (too-tight) gap", () => {
    // gap = 360 - 300 = 60 <= FANOUT_SPAN_MIN: no room for a distinct junction
    // column, so the pair stays plain item edges (boundary case).
    const tight = 360;
    expect(tight - 300).toBeLessThanOrEqual(FANOUT_SPAN_MIN);
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", tight, 0, r),
      recipeNode("t2", tight, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("does NOT fan out backward edges", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", oneGap, 0, r), // source right of the targets
      recipeNode("t1", 0, 0, r),
      recipeNode("t2", 0, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = routeFanoutEdges(nodes, edges);
    expect(out[0]!.type).toBe("item");
    expect(out[1]!.type).toBe("item");
  });

  it("fans out input-product feeders like any other qualifying pair", () => {
    // Aggregate -> tap feeders get no special treatment: two short-gap edges
    // off one aggregate port group into a fan-out trunk exactly as recipe
    // edges would (gap 152 inside the (FANOUT_SPAN_MIN, FANOUT_SPAN_MAX]
    // window).
    const nodes: RFAnyNode[] = [
      inputProductNode("agg", "ore", 0, 0), // right edge 148
      inputProductNode("t1", "ore", 300, 0),
      inputProductNode("t2", "ore", 300, 200),
    ];
    const edges = [
      mkEdge("e0", "agg", "t1", "ore"),
      mkEdge("e1", "agg", "t2", "ore"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1"]) {
      const edge = out.find((e) => e.id === id)!;
      expect(edge.type).toBe("bus");
      expect((edge.data as { fanout?: boolean }).fanout).toBe(true);
    }
  });

  it("gives two trunks sharing one corridor distinct junction columns", () => {
    // Two aggregate -> tap trunks in one layer gap (the default plan's ore and
    // water tap columns, issue #81). Left alone, both resolve the corridor
    // midpoint and their verticals draw as one line, with the later trunk's
    // stroke running through the earlier trunk's chips and junction dot.
    const nodes: RFAnyNode[] = [
      inputProductNode("aggA", "ore", 0, 0),
      inputProductNode("aggB", "water", 0, 120),
      inputProductNode("tA1", "ore", 300, 0),
      inputProductNode("tA2", "ore", 300, 240),
      inputProductNode("tB1", "water", 300, 120),
      inputProductNode("tB2", "water", 300, 360),
    ];
    const edges = [
      mkEdge("e0", "aggA", "tA1", "ore"),
      mkEdge("e1", "aggA", "tA2", "ore"),
      mkEdge("e2", "aggB", "tB1", "water"),
      mkEdge("e3", "aggB", "tB2", "water"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2", "e3"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
    }
    const jxA = fanData(out, "e0").junctionX!;
    const jxB = fanData(out, "e2").junctionX!;
    expect(Math.abs(jxA - jxB)).toBeGreaterThanOrEqual(PORT_STUB);
    // Order-independence: shuffled edges resolve the same columns per trunk.
    const shuffled = routeFanoutEdges(nodes, [
      edges[3]!,
      edges[1]!,
      edges[2]!,
      edges[0]!,
    ]);
    expect(fanData(shuffled, "e0").junctionX).toBe(jxA);
    expect(fanData(shuffled, "e2").junctionX).toBe(jxB);
  });

  it("spreads a tight-corridor pair to the corridor ends", () => {
    // One-gap corridor: usable width 410 - 300 - 2 * (PORT_STUB + CHAMFER) = 46.
    // Two contesting trunks spread to the corridor ends, the widest separation
    // the window allows.
    const rc = mkRecipe("rc", ["a"], ["c"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s1", 0, 0, r),
      recipeNode("s2", 0, 300, rc),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 150, r),
      recipeNode("t4", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s1", "t1", "b"),
      mkEdge("e1", "s1", "t2", "b"),
      mkEdge("e2", "s2", "t3", "c"),
      mkEdge("e3", "s2", "t4", "c"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    for (const id of ["e0", "e1", "e2", "e3"]) {
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
    }
    // The top trunk (sy order) takes the corridor's low end; the other spreads
    // as far right as the obstacle model allows, at least a PORT_STUB away.
    expect(fanData(out, "e0").junctionX).toBe(300 + PORT_STUB + CHAMFER);
    expect(
      fanData(out, "e2").junctionX! - fanData(out, "e0").junctionX!,
    ).toBeGreaterThanOrEqual(PORT_STUB);
  });

  it("leaves a trunk unformed when the spread pitch falls under the column keep-out", () => {
    // THREE trunks contesting the same 46-unit corridor: the spread pitch (23)
    // sits under the one-PORT_STUB column keep-out, so one trunk finds no
    // acceptable distinct column and its members stay plain item edges (the
    // existing no-formation fallback); the formed trunks keep distinct columns.
    const rc = mkRecipe("rc", ["a"], ["c"]);
    const rd = mkRecipe("rd", ["a"], ["d"]);
    const nodes: RFAnyNode[] = [
      recipeNode("s1", 0, 0, r),
      recipeNode("s2", 0, 300, rc),
      recipeNode("s3", 0, 600, rd),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 900, r),
      recipeNode("t3", oneGap, 150, r),
      recipeNode("t4", oneGap, 750, r),
      recipeNode("t5", oneGap, 450, r),
      recipeNode("t6", oneGap, 1050, r),
    ];
    const edges = [
      mkEdge("e0", "s1", "t1", "b"),
      mkEdge("e1", "s1", "t2", "b"),
      mkEdge("e2", "s2", "t3", "c"),
      mkEdge("e3", "s2", "t4", "c"),
      mkEdge("e4", "s3", "t5", "d"),
      mkEdge("e5", "s3", "t6", "d"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    const formed = ["e0", "e2", "e4"].filter(
      (id) => out.find((e) => e.id === id)!.type === "bus",
    );
    expect(formed).toHaveLength(2);
    const columns = formed.map((id) => fanData(out, id).junctionX!);
    expect(Math.abs(columns[0]! - columns[1]!)).toBeGreaterThanOrEqual(
      PORT_STUB,
    );
    // The unformed trunk's members BOTH stayed plain item edges.
    const unformedOwner = ["e0", "e2", "e4"].find(
      (id) => !formed.includes(id),
    )!;
    const sibling = { e0: "e1", e2: "e3", e4: "e5" }[unformedOwner]!;
    expect(out.find((e) => e.id === unformedOwner)!.type).toBe("item");
    expect(out.find((e) => e.id === sibling)!.type).toBe("item");
  });

  it("groups three nested-span trunks into one contesting corridor", () => {
    // Three trunks in one 86-unit corridor whose y-spans form a chain only a
    // real interval union sees. Ports resolve to: b|s1 spans 70..97, c|s2
    // 670..697, and d|s3 80..997 -- the last one's source port sits at the
    // bottom while one of its branches climbs to the top, so it overlaps BOTH
    // siblings while they do not touch each other. Walking the trunks in
    // source-port order (b, c, d) breaks the chain at the first pair and leaves
    // b spread on its own; ordering the chain by span start unions all three.
    // With n = 3 the pitch is 43, under the worst-case chip half-box, so every
    // member's branch chip collapses to the icon-only render.
    const rb = mkRecipe("rb", ["a"], ["b"]);
    const rc = mkRecipe("rc", ["a"], ["c"]);
    const rd = mkRecipe("rd", ["a"], ["d"]);
    const tgt = 450; // gap 150: corridor [332, 418], pitch (418 - 332) / 2 = 43
    const nodes: RFAnyNode[] = [
      recipeNode("s1", 0, 0, rb),
      recipeNode("s2", 0, 600, rc),
      recipeNode("s3", 0, 900, rd),
      recipeNode("tA1", tgt, 0, rb),
      recipeNode("tA2", tgt, 20, rb),
      recipeNode("tB1", tgt, 600, rb),
      recipeNode("tB2", tgt, 620, rb),
      recipeNode("tC1", tgt, 10, rb), // d|s3's high branch, above b|s1's span
      recipeNode("tC2", tgt, 900, rb),
    ];
    const edges = [
      mkEdge("e0", "s1", "tA1", "b"),
      mkEdge("e1", "s1", "tA2", "b"),
      mkEdge("e2", "s2", "tB1", "c"),
      mkEdge("e3", "s2", "tB2", "c"),
      mkEdge("e4", "s3", "tC1", "d"),
      mkEdge("e5", "s3", "tC2", "d"),
    ];
    const out = routeFanoutEdges(nodes, edges);
    // All three trunks form, and all three are marked contested.
    for (const id of ["e0", "e1", "e2", "e3", "e4", "e5"]) {
      const d = fanData(out, id);
      expect(out.find((e) => e.id === id)!.type).toBe("bus");
      expect(d.fanout).toBe(true);
      expect(d.fanoutContested).toBe(true);
    }
    // Slots are still handed out top-to-bottom by source-port y, so the topmost
    // trunk takes the corridor's low end and the columns sit a pitch apart.
    expect(fanData(out, "e0").junctionX).toBe(300 + PORT_STUB + CHAMFER);
    const columns = ["e0", "e2", "e4"].map((id) => fanData(out, id).junctionX!);
    expect(columns[1]! - columns[0]!).toBeGreaterThanOrEqual(PORT_STUB);
    expect(columns[2]! - columns[1]!).toBeGreaterThanOrEqual(PORT_STUB);
    // Order-independent: shuffling the input resolves the same columns.
    const shuffled = routeFanoutEdges(nodes, [
      edges[5]!,
      edges[2]!,
      edges[4]!,
      edges[0]!,
      edges[3]!,
      edges[1]!,
    ]);
    for (const id of ["e0", "e2", "e4"]) {
      expect(fanData(shuffled, id).junctionX).toBe(fanData(out, id).junctionX);
      expect(fanData(shuffled, id).fanoutContested).toBe(true);
    }
  });

  it("assigns fan-out fields deterministically across shuffled input", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
      recipeNode("t3", oneGap, 600, r),
    ];
    const edges = [
      mkEdge("e0", "s", "t1", "b"),
      mkEdge("e1", "s", "t2", "b"),
      mkEdge("e2", "s", "t3", "b"),
    ];
    const project = (out: Edge[]) =>
      [...out]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((e) => {
          const d = e.data as {
            fanout?: boolean;
            trunkKey?: string;
            junctionX?: number;
            busChipOwner?: boolean;
          };
          return {
            id: e.id,
            type: e.type,
            fanout: d.fanout,
            trunkKey: d.trunkKey,
            junctionX: d.junctionX,
            owner: d.busChipOwner,
          };
        });
    const a = routeFanoutEdges(nodes, edges);
    const b = routeFanoutEdges([...nodes].reverse(), [
      edges[2]!,
      edges[0]!,
      edges[1]!,
    ]);
    expect(project(a)).toEqual(project(b));
  });

  it("routes a fan-out member through the whole pipeline as a bus edge", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", oneGap, 0, r),
      recipeNode("t2", oneGap, 300, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const out = deconflictChipAnchors(
      nodes,
      clampBackwardRails(
        nodes,
        jogForwardLegs(
          nodes,
          assignBendColumns(
            nodes,
            assignEntryColumns(nodes, routeFanoutEdges(nodes, edges)),
          ),
        ),
      ),
    );
    for (const id of ["e0", "e1"]) {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("bus");
      expect((e.data as { fanout?: boolean }).fanout).toBe(true);
    }
  });

  it("dodges a foreign card straddling the junction column", () => {
    // The acceptance-gated junction stakes the shared column clear of a
    // mid-corridor obstacle AND keeps the shared trunk leg (source port ->
    // column) and every branch leg (column -> target port) off the card. Give
    // the corridor room (gap 380), read the unobstructed column, then drop a thin
    // foreign card straddling it and spanning the junction's vertical run but
    // sitting BETWEEN the two rows (clear of every port y), so a clean dodge that
    // clears all three horizontals exists.
    const wideGap = 680; // 680 - 300 = 380, inside FANOUT_SPAN_MAX (410)
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", wideGap, 0, r),
      recipeNode("t2", wideGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const clearJx = fanData(routeFanoutEdges(nodes, edges), "e0").junctionX!;

    // Thin card straddling clearJx, vertically between the two node rows so it
    // pierces the junction column but not the trunk / branch horizontals.
    const h = measureRecipe(r).height;
    const block = inputProductNode(
      "block",
      "ore",
      clearJx - 10,
      h + 20,
      20,
      340 - h,
    );
    const withBlock = [...nodes, block];
    const out = routeFanoutEdges(withBlock, edges);
    const jx = fanData(out, "e0").junctionX!;
    // Still one shared junction, still inside the corridor, dodged off the card.
    expect(jx).toBe(fanData(out, "e1").junctionX!);
    expect(jx).not.toBe(clearJx);
    expect(jx < clearJx - 10 || jx > clearJx + 10).toBe(true);
    expect(jx).toBeGreaterThan(300);
    expect(jx).toBeLessThan(wideGap);

    // Strengthened invariant: the drawn trunk AND branch horizontals clear the
    // card's raw box (not just the junction's vertical run).
    const blockRaw: Rect = {
      left: block.position.x,
      top: block.position.y,
      right: block.position.x + (block.width ?? 0),
      bottom: block.position.y + (block.height ?? 0),
    };
    assertMemberClearsRect(out, withBlock, "e0", blockRaw);
    assertMemberClearsRect(out, withBlock, "e1", blockRaw);
  });

  it("keeps members as plain item edges when no shared column clears", () => {
    // A thin card straddling the junction column and spanning the FULL vertical
    // extent (every port y): whichever side the shared column dodges to, either
    // the trunk leg or a branch leg would slice the card, so no acceptable shared
    // column exists. The fan-out does not form; the members stay plain item edges
    // (keeping the item-edge passes' per-leg jog protection a bus retype loses).
    const wideGap = 680;
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t1", wideGap, 0, r),
      recipeNode("t2", wideGap, 400, r),
    ];
    const edges = [mkEdge("e0", "s", "t1", "b"), mkEdge("e1", "s", "t2", "b")];
    const clearJx = fanData(routeFanoutEdges(nodes, edges), "e0").junctionX!;

    // Full-height straddling block: covers the trunk row and both branch rows.
    const block = inputProductNode(
      "block",
      "ore",
      clearJx - 10,
      -200,
      20,
      1000,
    );
    const out = routeFanoutEdges([...nodes, block], edges);
    ["e0", "e1"].forEach((id, i) => {
      const e = out.find((x) => x.id === id)!;
      expect(e.type).toBe("item");
      expect(e).toBe(edges[i]); // untouched by reference
      expect(e.data).not.toHaveProperty("fanout");
      expect(e.data).not.toHaveProperty("junctionX");
    });
  });
});

describe("directCorridorClear", () => {
  const r = mkRecipe("r", ["a"], ["b"]);
  // Past two full layers, the reach the census helper is asked about.
  const far = 300 + (2 * FANOUT_SPAN_MAX + 50);

  it("reads a card-straddled corridor as blocked", () => {
    const nodes: RFAnyNode[] = [
      recipeNode("s", 0, 0, r),
      recipeNode("t", far, 0, r),
      recipeNode("mid", 600, 0, r), // straddles the corridor at the target row
    ];
    const edges = [mkEdge("e0", "s", "t", "b")];

    expect(directCorridorClear(nodes, edges, edges[0]!)).toBe(false);
  });
});
