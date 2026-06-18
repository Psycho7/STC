import { describe, expect, it } from "vitest";
import { solveLp, type LpInput, type LpResult } from "./lp";
import {
  checkMassBalance,
  checkRawOnlyBoundary,
  checkTargetsMet,
} from "./invariants";
import { pack } from "../data/load";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";

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
  targets: Target[],
  overrides: ItemOverride[] = [],
  recipeCosts?: Map<string, number>,
): LpResult {
  const input: LpInput = { targets, pack, itemOverrides: overrides };
  if (recipeCosts !== undefined) input.recipeCosts = recipeCosts;
  return solveLp(input);
}

// The invariants must pass and softFeasible must agree with the deficit map.
function expectSoundAndHonest(
  r: LpResult,
  targets: Target[],
  overrides: ItemOverride[] = [],
): void {
  expect(checkMassBalance(r, pack, targets, overrides).violations).toEqual([]);
  expect(checkRawOnlyBoundary(r, pack, overrides).violations).toEqual([]);
  expect(checkTargetsMet(r, targets, pack).violations).toEqual([]);
  // softFeasible is true exactly when no demand was left unmet.
  expect(r.softFeasible).toBe(r.deficit.size === 0);
}

// A fully satisfied plan: balanced with no deficit (the real producer ran).
function expectFullySatisfied(
  r: LpResult,
  targets: Target[],
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
    const targets: Target[] = [
      { recipeId: "plant_moss_3", ratePerSec: { num: "1", denom: "1000" } },
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
    const targets: Target[] = [
      {
        recipeId: "originium_enr_powder",
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
    const targets: Target[] = [
      {
        recipeId: "jinlong_coupon-copper_enr_cmpt",
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
    const targets: Target[] = [
      { recipeId: "glass_bottle", ratePerSec: { num: "1", denom: "700" } },
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
    const targets: Target[] = [{ recipeId: "equip_script_4_2", ratePerSec: ONE }];
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
    const targets: Target[] = [{ recipeId: "copper_enr", ratePerSec: ONE }];
    const recipeCosts = new Map<string, number>([["liquid_copper_enr", 1e8]]);
    const r = solve(targets, [], recipeCosts);
    expectSoundAndHonest(r, targets);
    const iron = r.rates.get("iron_powder")?.valueOf() ?? 0;
    expect(Math.abs(iron - 1)).toBeLessThan(1e-5); // was 3e-4 pre-fix
  });

  // D7: a feasible pinned target at an ultra-low rate was reported empty because
  // the engine omitted its sub-tolerance primal. The pin floor must be honored.
  it("D7: ultra-low-rate proc_battery_5 honors its pinned floor", () => {
    const targets: Target[] = [
      {
        recipeId: "proc_battery_5",
        ratePerSec: { num: "1", denom: "100000000" },
      },
    ];
    const r = solve(targets);
    expect(r.status).toBe("feasible");
    expect(r.rates.get("proc_battery_5")?.compare(0)).toBeGreaterThan(0);
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
      const targets: Target[] = [
        { recipeId: recipe.id, ratePerSec: { num: "1", denom: "1000" } },
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
