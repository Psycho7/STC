// The jog frame gap, the rail floor rescan, the chip slide, the far-owner trunk
// total and the fan-out slot order move exactly these lines.
//
// The fixtures are the routed corpus at the level-occupancy extraction (the
// commit before the F, D, A, H and B work), and they were written to prove that
// the extraction moved nothing. They still serve: the F candidate arm, the D
// rescan, the A chip slide, the H trunk total and the B slot order are
// deliberate behaviour changes, and the question this test now answers is which
// lines they reach. Every field of every other edge and node must still match
// the extraction byte for byte, and the keys that do differ must be exactly the
// ones the four tables below enumerate. The ratchet tables in the e2e geometry
// audit cannot say that:
// every cell is an upper bound compared with toBeLessThanOrEqual, so a
// relocation that lowers a count passes silently. A whole-scene diff cannot say
// it either: the capture carries build provenance and camera metadata that
// differ between builds.
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

// The edges the jog frame gap (F) and the rail floor rescan (D) move, by plan.
// A listed edge may differ in any recorded field:
//   F  relocated jog runs that were riding a foreign loop frame -- multi6 e:67,
//      e:69 and e:81, rot-bottled_food_4 e:14, battery5-xiranite e:28 -- plus
//      multi6 e:77 and e:79, which take the levels the moved runs vacated.
//   D  loop-return rails that sat inside a forward run's floor: battery5 e:4
//      and e:6, battery5-xiranite e:9 and e:13, multi6 e:43 and e:45.
//      battery5 e:11 is a knock-on: a rail keeps its level off the rails
//      resolved before it, and e:4 moved.
//   J  the jog pass asks the floor at its DRAWN port rows, the frame the
//      bands are built in: battery5 e:19, copper-script43 e:31, multi6 e:12,
//      rot-bottled_food_4 e:9, script43 e:27 and script43-xiranite e:28 lose
//      a jog the model rows fired; coupon-web e:27 and multi6 e:28 keep their
//      level and only move their descent column.
//   K  a jogged fan-in member descends at its trunk's pinned column and never
//      takes the target row as its level: battery5-xiranite e:7 and
//      transmuters e:15 move their descent onto the pin; default e:5 and
//      multi6 e:27 and e:31 stop riding the target row and take a level.
//      battery5 e:19 (already listed under J) moves the same way.
//   G  one column order per gap: the columns of a gap are ordered once, from
//      the port rows their runs leave and enter on, across all four column
//      kinds, and every column pass reads that order. Bends fan in the order's
//      rank instead of by edge id, a column that must stand beyond a trunk
//      walks with it, a late drop leaves a slot for a descent the order puts
//      right of it, and a jog descent keeps its constraints:
//      battery5 e:0, e:2, e:12, e:13, e:15, e:16, e:17, e:22;
//      battery5-xiranite e:4, e:24, e:29, e:33, e:35; copper-script43
//      e:6, e:7, e:8, e:13, e:14, e:15, e:16, e:18, e:19, e:20, e:21,
//      e:22, e:25, e:33; coupon-web e:11, e:13, e:17, e:20; equip4 e:0,
//      e:13; multi6 e:3, e:4, e:5, e:7, e:8, e:9, e:10, e:15, e:18, e:20,
//      e:24, e:26, e:30, e:38, e:39, e:40, e:41, e:56, e:60, e:61, e:62,
//      e:63, e:64, e:71, e:91; script43 e:0, e:6, e:7, e:14, e:15, e:16,
//      e:17, e:20, e:22, e:29; script43-xiranite e:0, e:6, e:7, e:14,
//      e:17, e:18, e:21, e:23, e:30; transmuters e:0, e:1, e:11.
// An edge key is the short `e:NN` head of the routed edge id.
const MOVED: Readonly<Record<string, ReadonlyArray<string>>> = {
  battery5: [
    "e:0",
    "e:2",
    "e:4",
    "e:6",
    "e:11",
    "e:12",
    "e:13",
    "e:15",
    "e:16",
    "e:17",
    "e:19",
    "e:22",
  ],
  "battery5-xiranite": [
    "e:4",
    "e:7",
    "e:9",
    "e:13",
    "e:24",
    "e:28",
    "e:29",
    "e:33",
    "e:35",
  ],
  "copper-script43": [
    "e:6",
    "e:7",
    "e:8",
    "e:13",
    "e:14",
    "e:15",
    "e:16",
    "e:18",
    "e:19",
    "e:20",
    "e:21",
    "e:22",
    "e:25",
    "e:31",
    "e:33",
  ],
  "coupon-web": ["e:11", "e:13", "e:17", "e:20", "e:27"],
  default: ["e:5"],
  equip4: ["e:0", "e:13"],
  multi6: [
    "e:3",
    "e:4",
    "e:5",
    "e:7",
    "e:8",
    "e:9",
    "e:10",
    "e:12",
    "e:15",
    "e:18",
    "e:20",
    "e:24",
    "e:26",
    "e:27",
    "e:28",
    "e:30",
    "e:31",
    "e:38",
    "e:39",
    "e:40",
    "e:41",
    "e:43",
    "e:45",
    "e:56",
    "e:60",
    "e:61",
    "e:62",
    "e:63",
    "e:64",
    "e:67",
    "e:69",
    "e:71",
    "e:77",
    "e:79",
    "e:81",
    "e:91",
  ],
  "rot-bottled_food_4": ["e:9", "e:14"],
  script43: [
    "e:0",
    "e:6",
    "e:7",
    "e:14",
    "e:15",
    "e:16",
    "e:17",
    "e:20",
    "e:22",
    "e:27",
    "e:29",
  ],
  "script43-xiranite": [
    "e:0",
    "e:6",
    "e:7",
    "e:14",
    "e:17",
    "e:18",
    "e:21",
    "e:23",
    "e:28",
    "e:30",
  ],
  transmuters: ["e:0", "e:1", "e:11", "e:15"],
};

// `edge:e:43:u:class:q:51->...plant_grass_1.railY` -> `e:43`.
const edgeHeadOf = (key: string): string | null =>
  /^edge:(e:\d+):/.exec(key)?.[1] ?? null;

// The second named delta: family A slides a 1-to-1 chip off any foreign
// vertical crossing its box, so these edges' chip seats moved and nothing else
// did. Keyed by the full edge id and narrower than MOVED -- only the three seat
// fields of a listed edge may differ -- because A moves no polyline, column,
// level or node placement, and the test should keep saying so.
//
// All four tables compose: an unlisted key still compares exact, the union of
// what they permit is the whole permitted delta, and a listed edge that stops
// differing fails whichever table lists it, so no list can rot into a blanket
// waiver.
const SEAT_FIELDS = ["chipX", "chipY", "labelAnchor"] as const;
const CHIP_SEATS_MOVED: Readonly<Record<string, ReadonlyArray<string>>> = {
  battery5: [
    "e:16:u:class:q:5->u:surplus:copper_nugget:copper_nugget",
    "e:18:u:class:q:9->u:class:q:10:liquid_xiranite_lowpoly",
  ],
  "battery5-xiranite": [
    "e:6:u:class:q:14->u:class:q:16:liquid_xiranite_lowpoly",
    "e:18:u:class:q:28->u:class:q:8:xiranite_poly",
  ],
  // e:63 left this list with J (see MOVED): the vertical its chip slid off
  // was e:12's jog descent, which the drawn-frame floor no longer draws.
  multi6: [
    "e:26:u:class:q:27->u:class:q:18:copper_nugget",
    "e:46:u:class:q:54->u:class:q:14:plant_grass_2",
  ],
  // Not one of the 12 sites: e:25's rule seat stood 6 units off a foreign
  // vertical, inside the CHAMFER pad, so the slide clears the pad as well as
  // the stroke.
  "gas-web": ["e:25:u:in:liquid_water->u:class:q:9:liquid_water"],
  transmuters: [
    "e:3:u:cat:liquid_xiranite->u:class:q:11:liquid_xiranite",
    "e:11:u:class:q:4->u:class:q:0:copper_nugget",
  ],
  "copper-script43": ["e:26:u:class:q:9->u:class:q:32:gas_xiranite_enr"],
  "rot-bottled_rec_hp_1": ["e:4:u:class:q:4->u:class:q:5:plant_moss_1"],
  "rot-proc_bomb_1": ["e:4:u:class:q:4->u:class:q:5:plant_bbflower_1"],
};

// The third named delta: family H gives a fan-out trunk with no near member a
// far owner, and that owner's item shape seats the trunk's total where it drew
// nothing before. Nothing else moves -- the polyline, the columns, the levels
// and the label seat of the very same edge still compare exact -- so the
// exemption is one FIELD on a named list of edges, narrower still than
// CHIP_SEATS_MOVED. The fixtures stay as written on the base commit;
// regenerating them would prove nothing.
const TOTAL_FIELDS = ["trunkAnchor"] as const;
const FAR_OWNERS_SEATED: Readonly<Record<string, ReadonlyArray<string>>> = {
  "battery5-xiranite": [
    "e:0:u:cat:gas_xiranite->u:class:q:23:gas_xiranite",
    "e:30:u:in:gas_xiranite->u:class:q:2:gas_xiranite",
  ],
  multi6: [
    "e:0:u:cat:gas_xiranite->u:class:q:12:gas_xiranite",
    "e:65:u:in:copper_ore->u:class:q:22:copper_ore",
  ],
  script43: [
    "e:0:u:cat:gas_xiranite->u:class:q:20:gas_xiranite",
    "e:24:u:in:gas_inert->u:class:q:1:gas_inert",
    "e:26:u:in:gas_xiranite->u:class:q:3:gas_xiranite",
  ],
  "coupon-web": [
    "e:0:u:cat:gas_xiranite->u:class:q:20:gas_xiranite",
    "e:25:u:in:gas_inert->u:class:q:3:gas_inert",
    "e:27:u:in:gas_xiranite->u:class:q:1:gas_xiranite",
  ],
  "gas-web": [
    "e:0:u:cat:gas_xiranite->u:class:q:0:gas_xiranite",
    "e:18:u:in:gas_inert->u:class:q:7:gas_inert",
    "e:21:u:in:gas_xiranite->u:class:q:0:gas_xiranite",
  ],
  "rot-bottled_food_4": ["e:12:u:in:iron_ore->u:class:q:3:iron_ore"],
  transmuters: [
    "e:0:u:cat:gas_xiranite->u:class:q:13:gas_xiranite",
    "e:20:u:in:gas_xiranite->u:class:q:2:gas_xiranite",
  ],
  "copper-script43": [
    "e:0:u:cat:gas_xiranite->u:class:q:25:gas_xiranite",
    "e:28:u:in:gas_inert->u:class:q:2:gas_inert",
    "e:30:u:in:gas_xiranite->u:class:q:4:gas_xiranite",
  ],
  "script43-xiranite": [
    "e:0:u:cat:gas_xiranite->u:class:q:20:gas_xiranite",
    "e:15:u:class:q:27->u:class:q:5:xiranite_enr_powder",
    "e:25:u:in:gas_inert->u:class:q:1:gas_inert",
    "e:27:u:in:gas_xiranite->u:class:q:3:gas_xiranite",
  ],
};

// The fourth named delta: family B swaps the two fan-out columns of `default`'s
// first gap -- the Cuprium Ore trunk's and the Clean Water trunk's -- so both
// trunks' members redraw on the other's column and the ore split dot comes off
// the water leg. Nothing else in the corpus reorders a gap. Field-restricted
// like the two tables above, because the only thing a slot swap can reach is
// the column the members draw on, which this snapshot records as the drawn
// polyline and the junction anchor a fan-out shape seats on it. A listed edge
// that moves its chip anchor or its level is a finding, not a waiver.
const SLOT_FIELDS = ["pts", "junction"] as const;
const COLUMNS_SWAPPED: Readonly<Record<string, ReadonlyArray<string>>> = {
  default: [
    "e:8:u:in:copper_ore->u:class:q:2:copper_ore",
    "e:9:u:in:copper_ore->u:class:q:3:copper_ore",
    "e:11:u:in:liquid_water->u:class:q:2:liquid_water",
    "e:12:u:in:liquid_water->u:class:q:3:liquid_water",
  ],
};

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
      const moved = MOVED[scenario.id] ?? [];
      const seats = CHIP_SEATS_MOVED[scenario.id] ?? [];
      const seated = FAR_OWNERS_SEATED[scenario.id] ?? [];
      const swapped = COLUMNS_SWAPPED[scenario.id] ?? [];
      const seatKeys = new Map<string, string>();
      for (const id of seats) {
        for (const field of SEAT_FIELDS)
          seatKeys.set(`edge:${id}.${field}`, id);
      }
      const totalKeys = new Map<string, string>();
      for (const id of seated) {
        for (const field of TOTAL_FIELDS)
          totalKeys.set(`edge:${id}.${field}`, id);
      }
      const slotKeys = new Map<string, string>();
      for (const id of swapped) {
        for (const field of SLOT_FIELDS)
          slotKeys.set(`edge:${id}.${field}`, id);
      }
      const unexpected: string[] = [];
      const movedHeads = new Set<string>();
      const seatsSeen = new Set<string>();
      const seatedSeen = new Set<string>();
      const swappedSeen = new Set<string>();
      for (const key of new Set([...lhs.keys(), ...rhs.keys()])) {
        if (Object.is(lhs.get(key), rhs.get(key))) continue;
        // A key any table permits is permitted, and credits every table that
        // permits it -- all of them, where a seat, total or slot field of an
        // edge MOVED already covers differs.
        const seat = seatKeys.get(key);
        if (seat !== undefined) seatsSeen.add(seat);
        const owner = totalKeys.get(key);
        if (owner !== undefined) seatedSeen.add(owner);
        const slot = slotKeys.get(key);
        if (slot !== undefined) swappedSeen.add(slot);
        const head = edgeHeadOf(key);
        if (head !== null && moved.includes(head)) movedHeads.add(head);
        else if (
          seat === undefined &&
          owner === undefined &&
          slot === undefined
        )
          unexpected.push(`${key}: ${lhs.get(key)} -> ${rhs.get(key)}`);
      }

      // No node placement and no unlisted key moved, and every listed edge
      // really did move in the fields its table permits -- an entry that goes
      // stale is as much a finding as a line that moves without one.
      expect(unexpected).toEqual([]);
      expect([...movedHeads].sort()).toEqual([...moved].sort());
      expect([...seatsSeen].sort()).toEqual([...seats].sort());
      expect([...seatedSeen].sort()).toEqual([...seated].sort());
      expect([...swappedSeen].sort()).toEqual([...swapped].sort());
    }, 600_000);
  }
});
