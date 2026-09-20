// The level-occupancy extraction changes no routed geometry.
//
// Moving the run bands, the floor predicate, the port-row waiver and the
// candidate generation out of busRouting.ts into levelOccupancy.ts is a move,
// not a rewrite, and the only way to say that with a straight face is to route
// the whole corpus twice and compare the answers field by field. The ratchet
// tables in the e2e geometry audit cannot do it: every cell is an upper bound
// compared with toBeLessThanOrEqual, so a relocation that lowers a count passes
// silently. A whole-scene diff cannot do it either: the capture carries build
// provenance and camera metadata that differ between builds.
//
// So the "before" side is a set of fixtures written from the base commit by the
// same code below (LEVEL_OCCUPANCY_FIXTURES=write, then `prettier --write` over
// the fixture directory, since prettier packs short arrays onto one line and
// JSON.stringify does not), committed beside this file. The comparison is EXACT
// -- Object.is on every recorded field, no epsilon.
// What is recorded per edge is what the extraction could move: the drawn
// polyline points, every assigned column, every resolved level and the seated
// chip anchor, plus the node placements the routing reads.
//
// The corpus is 17 plans: the 15 fixed SCENARIOS plus the two rotating plans
// this cluster's sites name, pinned through the fixture rotating.json rather
// than left to whatever EXAM_EXTRA_SCENARIOS happens to hold in the
// environment.

import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { drawnEdge } from "../../src/canvas/edgePath";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import type { RFAnyNode } from "../../src/canvas/layout";
import { SCENARIOS, extraScenariosFromEnv } from "../e2e/scenarios";

const FIXTURE_DIR = resolve(import.meta.dirname, "fixtures/levelOccupancy");

// The two rotating plans arrive through extraScenariosFromEnv, which reads this
// variable when it is called. Set unconditionally: an inherited value would
// silently change which 17 plans are compared.
process.env.EXAM_EXTRA_SCENARIOS = resolve(FIXTURE_DIR, "rotating.json");

const SCENARIO_LIST = [...SCENARIOS, ...extraScenariosFromEnv()];

// Writing mode regenerates the fixtures from the tree as it stands. Run it on
// the base commit, never on the branch under test.
const WRITING = process.env.LEVEL_OCCUPANCY_FIXTURES === "write";

// Every routed field the extraction could move, by name.
//   columns  bendX / entryX / jogDescentX / srcColX / railXLeft / railXRight
//   levels   legY / railY
//   chip     chipX / chipY, plus the junction anchors seated in the same pass
const ROUTED_FIELDS = [
  "bendX",
  "entryX",
  "jogDescentX",
  "srcColX",
  "railXLeft",
  "railXRight",
  "legY",
  "railY",
  "chipX",
  "chipY",
  "fanoutJunctionX",
  "fanoutJunctionY",
  "faninJunctionX",
  "faninJunctionY",
] as const;

// The chip and dot anchors the drawn shape seats, by name. Reading them off
// drawnEdge rather than off the chipX / chipY stamps is deliberate: the stamps
// are only written where the seat pass MOVED a chip, so a plan where nothing
// moved would record no anchors at all and prove nothing.
const ANCHOR_KEYS = [
  "labelAnchor",
  "junction",
  "trunkAnchor",
  "branchAnchor",
] as const;

type EdgeRecord = {
  id: string;
  type: string;
  pts: ReadonlyArray<readonly [number, number]> | null;
  anchors: Partial<Record<(typeof ANCHOR_KEYS)[number], [number, number]>>;
} & Partial<Record<(typeof ROUTED_FIELDS)[number], number>>;

type NodeRecord = { id: string; x: number; y: number };

type Snapshot = { nodes: NodeRecord[]; edges: EdgeRecord[] };

function snapshotOf(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Snapshot {
  const byId = nodeIndexOf(nodes);
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
    })),
    edges: edges.map((edge) => {
      const ends = drawnPortsOf(edge, byId);
      const drawn =
        ends === null ? null : drawnEdge(ends, edge.type, edge.data);
      const anchors: EdgeRecord["anchors"] = {};
      const shape = (drawn ?? {}) as Record<string, unknown>;
      for (const key of ANCHOR_KEYS) {
        const anchor = shape[key] as { x: number; y: number } | undefined;
        if (anchor !== undefined) anchors[key] = [anchor.x, anchor.y];
      }
      const record: EdgeRecord = {
        id: edge.id,
        type: edge.type ?? "",
        pts: drawn === null ? null : drawn.pts,
        anchors,
      };
      const data = (edge.data ?? {}) as Record<string, unknown>;
      for (const field of ROUTED_FIELDS) {
        const value = data[field];
        if (typeof value === "number") record[field] = value;
      }
      return record;
    }),
  };
}

async function routeOf(scenarioId: string): Promise<Snapshot> {
  const scenario = SCENARIO_LIST.find((s) => s.id === scenarioId)!;
  const targets: ItemTarget[] = scenario.targets.map((t) => ({
    itemId: t.itemId,
    ratePerSec: t.ratePerSec,
  }));
  const { nodes, edges } = await layoutSolved(
    solveForRender({ targets, pack }),
  );
  return snapshotOf(nodes, edges);
}

const fixturePathOf = (planId: string): string =>
  resolve(FIXTURE_DIR, `${planId}.json`);

// Every field of every edge and node, flattened to one comparable map, so a
// difference reports the plan, the edge and the field name rather than dumping
// two polylines side by side.
function flatten(snapshot: Snapshot): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const node of snapshot.nodes) {
    out.set(`node:${node.id}.x`, node.x);
    out.set(`node:${node.id}.y`, node.y);
  }
  for (const edge of snapshot.edges) {
    out.set(`edge:${edge.id}.type`, edge.type);
    out.set(
      `edge:${edge.id}.pts`,
      edge.pts === null ? null : JSON.stringify(edge.pts),
    );
    for (const field of ROUTED_FIELDS) {
      out.set(`edge:${edge.id}.${field}`, edge[field]);
    }
    for (const key of ANCHOR_KEYS) {
      const anchor = edge.anchors[key];
      out.set(
        `edge:${edge.id}.${key}`,
        anchor === undefined ? undefined : JSON.stringify(anchor),
      );
    }
  }
  return out;
}

describe("the level-occupancy extraction routes the corpus identically", () => {
  for (const scenario of SCENARIO_LIST) {
    it(`matches the base fixture on ${scenario.id}`, async () => {
      const after = await routeOf(scenario.id);
      if (WRITING) {
        writeFileSync(
          fixturePathOf(scenario.id),
          // Two-space indent so a regenerated fixture is already in the shape
          // `prettier --check` wants.
          `${JSON.stringify(after, null, 2)}\n`,
          "utf8",
        );
        return;
      }
      const before = JSON.parse(
        readFileSync(fixturePathOf(scenario.id), "utf8"),
      ) as Snapshot;

      // Premise: the fixture really does hold this plan's routed geometry, so
      // an empty difference list below is a verdict and not an empty read.
      expect(before.edges.length).toBeGreaterThan(0);
      expect(after.edges.length).toBe(before.edges.length);

      const lhs = flatten(before);
      const rhs = flatten(after);
      const differing: string[] = [];
      for (const key of new Set([...lhs.keys(), ...rhs.keys()])) {
        if (Object.is(lhs.get(key), rhs.get(key))) continue;
        differing.push(`${key}: ${lhs.get(key)} -> ${rhs.get(key)}`);
      }
      expect(differing).toEqual([]);
    }, 600_000);
  }
});
