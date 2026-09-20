// Hover membership over the corpus: every classified trunk's hover group is
// exactly its member list, every member of it draws the trunk's shared stretch
// (or is one of the two counted carve-outs), and the drawing contract the
// membership field rides on did not move.
//
// Hover grouping used to be indexed by the ONE `trunkKey` a member carries,
// gated on `type === "bus"`, so a trunk lost every member the routing pass did
// not retype -- a far member pinned to the column, a backward member on its
// detour rail -- and a dual member could only ever be grouped with one of its
// two trunks. Membership is topological (classifyTrunks), so the group is
// checked against that classification here rather than against the drawn shapes.
//
// What the SHARED half checks is the premise the segment-aware hover rests on:
// the run sharedStretches hands a member for a key really is the trunk's line --
// every member's run for one key sits on one row and overlaps its siblings' --
// so pointing at it means pointing at the trunk and not at one member.
//
// The second test is a characterisation, not a property: `trunkGroups` is
// additive, so the aggregate stamps and the seated chip boxes of every plan have
// to come out byte for byte as they did before the field existed. The baseline
// in `fixtures/trunkGroups/stamp-baseline.json` holds a sha256 per plan over the
// canonical JSON of each; it was captured by running this file with
// TRUNK_GROUP_BASELINE=write on the pre-change head, and re-capturing it is the
// only way to move it.
//
// The corpus is 17 plans: the 15 fixed SCENARIOS plus the two rotating plans,
// pinned through the fixture rotating.json rather than left to whatever
// EXAM_EXTRA_SCENARIOS happens to hold in the environment.

import { beforeAll, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Edge } from "@xyflow/react";
import type Fraction from "fraction.js";

import { layoutSolved } from "../../src/canvas/layoutSolved";
import { seatedChipBoxes } from "../../src/canvas/chipSeating";
import {
  drawnEdge,
  sharedStretches,
  type HorizontalRun,
} from "../../src/canvas/edgePath";
import { classifyTrunks } from "../../src/canvas/layerModel";
import type { RFAnyNode } from "../../src/canvas/layout";
import { drawnPortsOf, nodeIndexOf } from "../../src/canvas/nodeGeometry";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS, extraScenariosFromEnv } from "../e2e/scenarios";

process.env.EXAM_EXTRA_SCENARIOS = resolve(
  import.meta.dirname,
  "fixtures/levelOccupancy/rotating.json",
);

const SCENARIO_LIST = [...SCENARIOS, ...extraScenariosFromEnv()];

// The corpus-wide carve-out census, measured once and pinned. Both numbers are
// members whose trunk has no stretch on their own line: see `carveOuts` below.
const CARVE_OUT_TOTAL = { oneSided: 0, noGeometry: 0 };

const BASELINE_DIR = resolve(import.meta.dirname, "fixtures/trunkGroups");
const BASELINE_PATH = resolve(BASELINE_DIR, "stamp-baseline.json");
const WRITING = process.env.TRUNK_GROUP_BASELINE === "write";

type PlanDigest = {
  stampCount: number;
  stampSha: string;
  chipCount: number;
  chipSha: string;
};

// The aggregate contract of one edge: the four BusAggregate stamps, the type the
// pass left it at (a retype is part of that contract), and the trunk column it
// borrowed. Anything the hover field touched would show up here.
type StampRow = {
  id: string;
  type: string | undefined;
  trunkKey: string;
  busTotalRate: string | undefined;
  busMemberCount: number | undefined;
  busChipOwner: boolean | undefined;
  junctionX: number | undefined;
  bendX: number | undefined;
};

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function stampRows(edges: ReadonlyArray<Edge>): StampRow[] {
  const out: StampRow[] = [];
  for (const edge of edges) {
    const data = edge.data as
      | {
          trunkKey?: string;
          busTotalRate?: Fraction;
          busMemberCount?: number;
          busChipOwner?: boolean;
          junctionX?: number;
          bendX?: number;
        }
      | undefined;
    if (typeof data?.trunkKey !== "string") continue;
    out.push({
      id: edge.id,
      type: edge.type,
      trunkKey: data.trunkKey,
      busTotalRate: data.busTotalRate?.toFraction(),
      busMemberCount: data.busMemberCount,
      busChipOwner: data.busChipOwner,
      junctionX: data.junctionX,
      bendX: data.bendX,
    });
  }
  return out;
}

// The hover group index Canvas builds: every edge filed under each key of its
// `trunkGroups`, with no edge-type gate.
function hoverGroups(edges: ReadonlyArray<Edge>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const groups = (edge.data as { trunkGroups?: string[] } | undefined)
      ?.trunkGroups;
    for (const key of groups ?? []) {
      const members = out.get(key) ?? [];
      members.push(edge.id);
      out.set(key, members);
    }
  }
  return out;
}

// Every shared stretch of one plan, per trunk key and member: the drawn runs the
// hover rule hands a pointer standing on that key.
function sharedRunsByGroup(
  nodes: ReadonlyArray<RFAnyNode>,
  edges: ReadonlyArray<Edge>,
): Map<string, Map<string, HorizontalRun[]>> {
  const byId = nodeIndexOf(nodes);
  const out = new Map<string, Map<string, HorizontalRun[]>>();
  for (const edge of edges) {
    const ends = drawnPortsOf(edge, byId);
    if (ends === null) continue;
    const drawn = drawnEdge(ends, edge.type, edge.data);
    for (const { group, run } of sharedStretches(drawn, edge)) {
      const members = out.get(group) ?? new Map<string, HorizontalRun[]>();
      members.set(edge.id, [...(members.get(edge.id) ?? []), run]);
      out.set(group, members);
    }
  }
  return out;
}

const digests: Record<string, PlanDigest> = {};
const groupMismatches: string[] = [];
// A member with no shared run for one of its keys, by why: "one-sided" is a
// member whose geometry went to its OTHER trunk (a member far on both sides
// borrows one column, and the fan-out's wins), "no-geometry" one routeTrunkEdges
// could stamp membership on but no drawable column for. Neither falls back to
// whole-group hover, so both are counted rather than tolerated silently.
const carveOuts: Record<string, { oneSided: number; noGeometry: number }> = {};
const sharedMismatches: string[] = [];
let trunkCount = 0;
let memberCount = 0;
let sharedMemberCount = 0;

beforeAll(async () => {
  for (const scenario of SCENARIO_LIST) {
    const targets: ItemTarget[] = scenario.targets.map((t) => ({
      itemId: t.itemId,
      ratePerSec: t.ratePerSec,
    }));
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets, pack }),
    );

    const rows = stampRows(edges);
    const boxes = seatedChipBoxes(nodes, edges);
    digests[scenario.id] = {
      stampCount: rows.length,
      stampSha: sha(rows),
      chipCount: boxes.length,
      chipSha: sha(boxes),
    };

    const groups = hoverGroups(edges);
    const shared = sharedRunsByGroup(nodes, edges);
    const carve = { oneSided: 0, noGeometry: 0 };
    for (const trunk of classifyTrunks(nodes, edges).trunks) {
      trunkCount += 1;
      const got = [...(groups.get(trunk.key) ?? [])].sort();
      const want = [...trunk.members].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        groupMismatches.push(
          `${scenario.id} ${trunk.key} (${trunk.kind}): group [${got.join(", ")}] != members [${want.join(", ")}]`,
        );
      }

      const runsByMember = shared.get(trunk.key) ?? new Map();
      const drawn: Array<{ id: string; run: HorizontalRun }> = [];
      for (const id of trunk.members) {
        memberCount += 1;
        const runs = runsByMember.get(id) ?? [];
        if (runs.length === 1) {
          sharedMemberCount += 1;
          drawn.push({ id, run: runs[0]! });
          continue;
        }
        if (runs.length > 1) {
          sharedMismatches.push(
            `${scenario.id} ${trunk.key}: ${id} claims ${runs.length} runs for one key`,
          );
          continue;
        }
        // No run for this key: one of the two carve-outs, told apart by whether
        // the member spent its geometry on its other trunk.
        const elsewhere = [...shared.values()].some((m) => m.has(id));
        if (elsewhere) carve.oneSided += 1;
        else carve.noGeometry += 1;
      }

      // The trunk's line: one row, and every member's claim overlapping every
      // other's, so a pointer on any of them is on the same stroke.
      for (const a of drawn) {
        for (const b of drawn) {
          if (a.id >= b.id) continue;
          if (a.run.y !== b.run.y) {
            sharedMismatches.push(
              `${scenario.id} ${trunk.key}: ${a.id} at y ${a.run.y} vs ${b.id} at y ${b.run.y}`,
            );
          } else if (
            Math.min(a.run.hi, b.run.hi) <= Math.max(a.run.lo, b.run.lo)
          ) {
            sharedMismatches.push(
              `${scenario.id} ${trunk.key}: ${a.id} [${a.run.lo}, ${a.run.hi}] misses ${b.id} [${b.run.lo}, ${b.run.hi}]`,
            );
          }
        }
      }
    }
    carveOuts[scenario.id] = carve;
  }
  // The per-plan carve-out census the pinned totals below are read from.
  console.log("trunk shared-stretch carve-outs", carveOuts);

  if (WRITING) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(digests, null, 2)}\n`);
  }
}, 600_000);

describe("trunk hover membership over the corpus", () => {
  it("gives every member a shared run on its trunk's line, carve-outs aside", () => {
    // Not vacuous: the corpus really does classify trunks, in every plan, and
    // most of their members really do draw a shared stretch.
    expect(trunkCount).toBeGreaterThan(50);
    expect(Object.keys(digests)).toHaveLength(SCENARIO_LIST.length);
    expect(sharedMemberCount).toBeGreaterThan(100);
    expect(groupMismatches).toEqual([]);
    expect(sharedMismatches).toEqual([]);
    // The carve-out census, pinned: a member losing its stretch is a hover the
    // reader cannot start from that member, so the number may not drift
    // unnoticed.
    const total = Object.values(carveOuts).reduce(
      (acc, c) => ({
        oneSided: acc.oneSided + c.oneSided,
        noGeometry: acc.noGeometry + c.noGeometry,
      }),
      { oneSided: 0, noGeometry: 0 },
    );
    expect(total).toEqual(CARVE_OUT_TOTAL);
    // Every member is accounted for: one shared run, or one of the two
    // carve-outs. A member the loop failed to read would show up as a gap here
    // rather than as a silent pass.
    expect(sharedMemberCount + total.oneSided + total.noGeometry).toBe(
      memberCount,
    );
  });

  it("leaves the aggregate stamps and seated chip boxes byte-identical", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<
      string,
      PlanDigest
    >;
    expect(digests).toEqual(baseline);
  });
});
