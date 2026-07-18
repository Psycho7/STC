import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp, type LpInput, type LpResult } from "./lp";
import {
  checkMassBalance,
  checkRawOnlyBoundary,
  checkTargetsMet,
} from "./invariants";
import { pack } from "../data/load";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { RecipePack } from "@aef/schema";

// game v1.4's gas-system machines added an alternate copper_enr route that does
// not pass through iron_powder, so the D6 override regression (penalize the
// liquid_copper_enr route, observe iron_powder stays at 1 via the alternate) no
// longer holds on the full pack. Solving D6 against a pack without the
// gas-machine recipes keeps the pre-gas copper topology the witness needs.
const GAS_MACHINES = new Set([
  "gas_pump_1",
  "gas_reactor_1",
  "phase_trans_1",
  "phase_trans_2",
]);
const legacyPack: RecipePack = {
  ...pack,
  recipes: pack.recipes.filter(
    (r) => !r.producers.some((p) => GAS_MACHINES.has(p)),
  ),
};

// Regression suite for the small-rate / override producer-drop defect class
// (bug-hunt 2026-06-16, D1-D7). The shared failure: at small target magnitudes
// or under finite caps / large recipeCost overrides, the two-pass solve drops a
// required producer (pass-2 lex routes through a BIG_M transfer the extraction
// then strips) and reports status=feasible, softFeasible=true, deficit empty,
// while mass balance / raw-only-boundary fail materially.
//
// Core correctness property asserted everywhere: the solver invariants hold and
// softFeasible is honest. A plan is correct iff it is either fully balanced
// (a producer was re-admitted) or it closes its rows via a reported deficit and
// flags softFeasible=false. It must never report softFeasible=true with a
// broken row and an empty deficit.

const ONE = { num: "1", denom: "1" };

function solve(
  targets: ItemTarget[],
  overrides: ItemOverride[] = [],
  recipeCosts?: Map<string, number>,
  p: RecipePack = pack,
): LpResult {
  const input: LpInput = { targets, pack: p, itemOverrides: overrides };
  if (recipeCosts !== undefined) input.recipeCosts = recipeCosts;
  return solveLp(input);
}

// The invariants must pass and softFeasible must agree with the deficit map.
function expectSoundAndHonest(
  r: LpResult,
  targets: ItemTarget[],
  overrides: ItemOverride[] = [],
  p: RecipePack = pack,
): void {
  expect(checkMassBalance(r, p, targets, overrides).violations).toEqual([]);
  expect(checkRawOnlyBoundary(r, p, overrides).violations).toEqual([]);
  expect(checkTargetsMet(r, targets).violations).toEqual([]);
  // softFeasible is true exactly when no demand was left unmet.
  expect(r.softFeasible).toBe(r.deficit.size === 0);
}

// A fully satisfied plan: balanced with no deficit (the real producer ran).
function expectFullySatisfied(
  r: LpResult,
  targets: ItemTarget[],
  overrides: ItemOverride[] = [],
): void {
  expectSoundAndHonest(r, targets, overrides);
  expect(r.softFeasible).toBe(true);
  expect(r.deficit.size).toBe(0);
}

// Total reported deficit, in absolute terms across all items.
function totalDeficit(r: LpResult): number {
  let t = 0;
  for (const v of r.deficit.values()) t += Math.abs(v.valueOf());
  return t;
}

describe("LP small-rate / override producer-drop regressions", () => {
  // D1 (blocker): low-rate single target dropped its internal producer.
  it("D1: plant_moss_3 at 1/1000 keeps its producer chain balanced", () => {
    const targets: ItemTarget[] = [
      { itemId: "plant_moss_3", ratePerSec: { num: "1", denom: "1000" } },
    ];
    const r = solve(targets);
    expect(r.status).toBe("feasible");
    expectFullySatisfied(r, targets);
  });

  // D2: small-rate chain truncation (originium / iron / quartz family). The
  // producer chain is restored (was truncated to the lone target, residual
  // ~1e-2); any remaining shortfall is sub-material snap drift the extraction
  // cannot close exactly, surfaced honestly as a tiny deficit rather than a
  // silent broken row. Exact closure is the deferred exact-rational snap work.
  it("D2: originium_enr_powder at 1/200 runs the full chain", () => {
    const targets: ItemTarget[] = [
      {
        itemId: "originium_enr_powder",
        ratePerSec: { num: "1", denom: "200" },
      },
    ];
    const r = solve(targets);
    expect(r.status).toBe("feasible");
    expectSoundAndHonest(r, targets);
    expect(r.rates.size).toBeGreaterThan(1); // the chain runs, not just the target
    expect(totalDeficit(r)).toBeLessThan(1e-5); // material producer-drop is gone
  });

  // D3: lex-pass big-M drop deleted a legitimate boundary supplier.
  it("D3: jinlong_coupon-copper_enr_cmpt at 1/7 supplies iron_powder", () => {
    const targets: ItemTarget[] = [
      {
        itemId: "jinlong_coupon",
        ratePerSec: { num: "1", denom: "7" },
      },
    ];
    const r = solve(targets);
    expectFullySatisfied(r, targets);
  });

  // D4: extraction dropped the sole producer of an intermediate at a small rate
  // (quartz_glass was entirely unsupplied, residual = full demand ~2.86e-3). The
  // producer is restored; any remaining shortfall is sub-material snap drift
  // surfaced honestly. Exact closure is the deferred exact-rational snap work.
  it("D4: glass_bottle at 1/700 produces quartz_glass", () => {
    const targets: ItemTarget[] = [
      { itemId: "glass_bottle", ratePerSec: { num: "1", denom: "700" } },
    ];
    const r = solve(targets);
    expectSoundAndHonest(r, targets);
    expect(r.rates.has("quartz_glass-quartz_sand")).toBe(true); // producer present
    expect(totalDeficit(r)).toBeLessThan(1e-5);
  });

  // D5: finite cap on an intermediate left an unrepairable byproduct imbalance
  // (a consumer-side snap error). Acceptable outcome: balanced, or an honest
  // deficit + softFeasible=false. Never a broken row reported feasible.
  it("D5: finite cap on copper_enr_cmpt for equip_script_4_2 is sound and honest", () => {
    const targets: ItemTarget[] = [{ itemId: "equip_script_4_2", ratePerSec: ONE }];
    const overrides: ItemOverride[] = [
      { itemId: "copper_enr_cmpt", ratePerSec: { num: "1", denom: "4" } },
    ];
    const r = solve(targets, overrides);
    expectSoundAndHonest(r, targets, overrides);
  });

  // D6: a large finite recipeCost override perturbed an unrelated active recipe
  // and leaked an uncapped draw (iron_powder ran at 3322/3323, residual ~3e-4).
  // The capEps clamp cuts the perturbation ~200x (now ~1.5e-6) and any residual
  // is reported honestly (no silent uncapped draw); the rate stays within snap
  // tolerance of its true value 1.
  it("D6: large recipeCosts override does not materially perturb iron_powder", () => {
    // legacyPack: on the full v1.4 pack copper_enr is met via the gas route
    // (no iron_powder), so the liquid_copper_enr penalty no longer exercises
    // the iron-fed alternate this override regression pins.
    const targets: ItemTarget[] = [{ itemId: "copper_enr", ratePerSec: ONE }];
    const recipeCosts = new Map<string, number>([["liquid_copper_enr", 1e8]]);
    const r = solve(targets, [], recipeCosts, legacyPack);
    expectSoundAndHonest(r, targets, [], legacyPack);
    const iron = r.rates.get("iron_powder")?.valueOf() ?? 0;
    expect(Math.abs(iron - 1)).toBeLessThan(1e-5); // was 3e-4 pre-fix
  });

  // D7: at an ultra-low rate the engine omits the sub-tolerance primal
  // entirely. The recipe pin used to reconstruct the lost rate; with item
  // demand there is nothing to reconstruct it from, so the honest outcome is
  // a reported deficit on the demanded item with softFeasible false - never a
  // silent "empty but satisfied" result. (Known small-rate false negative:
  // the plan is mathematically feasible.)
  it("D7: ultra-low-rate proc_battery_5 is reported honestly", () => {
    const targets: ItemTarget[] = [
      {
        itemId: "proc_battery_5",
        ratePerSec: { num: "1", denom: "100000000" },
      },
    ];
    const r = solve(targets);
    expect(r.softFeasible).toBe(false);
    expect(
      r.deficit
        .get("proc_battery_5")
        ?.equals(new Fraction(1, 100000000)),
    ).toBe(true);
    expectSoundAndHonest(r, targets);
  });
});

describe("LP small-rate bulk sweep (regression gate)", () => {
  const targetable = pack.recipes.filter((r) => r.out.length > 0);

  // Every targetable recipe as a single target at 1/1000: the rate where the
  // producer-drop class is endemic (was 103/196 dirty pre-fix). Each solve must
  // satisfy the solver invariants - balanced, or honest deficit closing the
  // rows. This is the gate that keeps the whole class from silently returning.
  it("no single-target plan at rate 1/1000 violates mass balance or raw-only boundary", () => {
    const offenders: string[] = [];
    for (const recipe of targetable) {
      const targets: ItemTarget[] = [
        { itemId: recipe.out[0]!.item, ratePerSec: { num: "1", denom: "1000" } },
      ];
      const r = solveLp({ targets, pack, itemOverrides: [] });
      if (r.status !== "feasible" && r.status !== "empty") continue;
      const mb = checkMassBalance(r, pack, targets, []).violations;
      const rb = checkRawOnlyBoundary(r, pack, []).violations;
      const honest = r.softFeasible === (r.deficit.size === 0);
      if (mb.length || rb.length || !honest) {
        offenders.push(
          `${recipe.id}: mb=${mb.length} rb=${rb.length} honest=${honest}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
