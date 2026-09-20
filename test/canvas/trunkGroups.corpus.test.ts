// Hover membership over the corpus: every classified trunk's hover group is
// exactly its member list, and the drawing contract the membership field rides
// on did not move.
//
// Hover grouping used to be indexed by the ONE `trunkKey` a member carries,
// gated on `type === "bus"`, so a trunk lost every member the routing pass did
// not retype -- a far member pinned to the column, a backward member on its
// detour rail -- and a dual member could only ever be grouped with one of its
// two trunks. Membership is topological (classifyTrunks), so the group is
// checked against that classification here rather than against the drawn shapes.
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
import { classifyTrunks } from "../../src/canvas/layerModel";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { SCENARIOS, extraScenariosFromEnv } from "../e2e/scenarios";

process.env.EXAM_EXTRA_SCENARIOS = resolve(
  import.meta.dirname,
  "fixtures/levelOccupancy/rotating.json",
);

const SCENARIO_LIST = [...SCENARIOS, ...extraScenariosFromEnv()];

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

const digests: Record<string, PlanDigest> = {};
const groupMismatches: string[] = [];
let trunkCount = 0;

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
    for (const trunk of classifyTrunks(nodes, edges).trunks) {
      trunkCount += 1;
      const got = [...(groups.get(trunk.key) ?? [])].sort();
      const want = [...trunk.members].sort();
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        groupMismatches.push(
          `${scenario.id} ${trunk.key} (${trunk.kind}): group [${got.join(", ")}] != members [${want.join(", ")}]`,
        );
      }
    }
  }

  if (WRITING) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify(digests, null, 2)}\n`);
  }
}, 600_000);

describe("trunk hover membership over the corpus", () => {
  it("gives every classified trunk a hover group equal to its member list", () => {
    // Not vacuous: the corpus really does classify trunks, in every plan.
    expect(trunkCount).toBeGreaterThan(50);
    expect(Object.keys(digests)).toHaveLength(SCENARIO_LIST.length);
    expect(groupMismatches).toEqual([]);
  });

  it("leaves the aggregate stamps and seated chip boxes byte-identical", () => {
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Record<
      string,
      PlanDigest
    >;
    expect(digests).toEqual(baseline);
  });
});
