// Fixture data for the ten placement-regression scenarios. Each scenario is a
// named set of solver targets the app loads from a share hash. The spec encodes
// these into v1 hashes at runtime with the app's own encoder, so the fixtures
// stay regenerable from the target data rather than pinned to copied blobs.
//
// Rates are exact rationals in items-per-second. The audit states them per
// minute, so each target's trailing comment records the original per-minute
// figure (per-second = per-minute / 60).

import { encodePlan, type Plan } from "../../src/data/plan";

export type ScenarioTarget = {
  itemId: string;
  ratePerSec: { num: string; denom: string };
};

export type Scenario = {
  id: string;
  title: string;
  targets: ScenarioTarget[];
  // Screenshot pixel budget for toHaveScreenshot at 1920x1080. Scenarios that
  // rasterized bit-identically across determinism runs demand an exact match.
  // Dense graphs carry heavy anti-aliased diagonal-edge and label coverage
  // whose sub-pixel blending jitters between runs; each such budget is roughly
  // double the worst noise measured for that scenario (battery5-xiranite /
  // multi6 up to 14394 px, battery5 3454 px), still far below what a relocated
  // node or edge moves.
  maxDiffPixels: number;
};

// Recipe-pack triple for the wire envelope: [source name, schemaVersion,
// sourceCommit]. Mirrors data/aef/recipe-pack.json; loadPlan validates the
// schemaVersion against the live pack, so this must track the shipped pack.
export const PACK: [id: string, schemaVersion: string, sha: string] = [
  "endfield-calc/factoriolab",
  "0.2",
  "4fc462948fe9f652db20258953dd8dc09b3dfc97",
];

export const SCENARIOS: Scenario[] = [
  {
    id: "default",
    title: "default",
    targets: [
      { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } }, // 120/min
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } }, // 15/min
    ],
    maxDiffPixels: 0,
  },
  {
    id: "battery5",
    title: "battery5",
    targets: [
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    ],
    maxDiffPixels: 7000,
  },
  {
    id: "battery5-xiranite",
    title: "battery5-xiranite",
    targets: [
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } }, // 60/min
    ],
    maxDiffPixels: 30000,
  },
  {
    id: "crystal",
    title: "crystal",
    targets: [
      { itemId: "crystal_enr", ratePerSec: { num: "1", denom: "1" } }, // 60/min
    ],
    maxDiffPixels: 0,
  },
  {
    id: "equip4",
    title: "equip4",
    targets: [
      { itemId: "equip_script_4", ratePerSec: { num: "1", denom: "5" } }, // 12/min
    ],
    maxDiffPixels: 0,
  },
  {
    id: "multi6",
    title: "multi6",
    targets: [
      { itemId: "bottled_food_5", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "bottled_rec_hp_5", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "proc_battery_3", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "equip_script_2", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "glass_enr_cmpt", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "copper_enr_cmpt", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    ],
    maxDiffPixels: 30000,
  },
  {
    id: "tundra",
    title: "tundra",
    targets: [
      {
        itemId: "tundra_coupon",
        ratePerSec: { num: "1", denom: "2" }, // 30/min
      },
    ],
    maxDiffPixels: 0,
  },
  // The three below reproduce plans from the 2026-08-22 render exam, added so
  // the chip-seating ratchets cover the v1.4 recipes that exposed the seating
  // defects (script chains, the coupon web, and the gas web). All three take
  // the exact-match budget, whose criterion is that the plan renders
  // bit-identically to its golden -- solo and in a full-corpus batch.
  {
    id: "script43",
    title: "script43",
    targets: [
      { itemId: "equip_script_4_3", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    ],
    maxDiffPixels: 0,
  },
  {
    id: "coupon-web",
    title: "coupon-web",
    targets: [
      { itemId: "jinlong_coupon", ratePerSec: { num: "1", denom: "1" } }, // 60/min
      { itemId: "filter_core", ratePerSec: { num: "1", denom: "4" } }, // 15/min
      { itemId: "copper_jar", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    ],
    maxDiffPixels: 0,
  },
  {
    id: "gas-web",
    title: "gas-web",
    targets: [
      { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "gas_copper_enr2", ratePerSec: { num: "1", denom: "2" } }, // 30/min
      { itemId: "gas_inert", ratePerSec: { num: "1", denom: "4" } }, // 15/min
    ],
    maxDiffPixels: 0,
  },
];

// Build a v1 share hash from a scenario with the app's own encoder. Encoding at
// runtime keeps the fixtures derived from the target data (no copied blobs) and
// guarantees the exact wire format the app decodes. Shared by every spec that
// loads a scenario, so all of them agree on the scenario -> hash mapping.
export async function scenarioHash(scenario: Scenario): Promise<string> {
  const plan: Plan = {
    version: 1,
    pack: { id: PACK[0], schemaVersion: PACK[1], submoduleSha: PACK[2] },
    title: scenario.title,
    targets: scenario.targets,
  };
  return encodePlan(plan);
}
