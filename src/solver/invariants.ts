import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { LpResult } from "./lp";
import { demandByItem, toleranceScaleFloor } from "./lp";
import type { SolvePlanFull } from "./index";
import { effectiveSupply } from "./effectiveSupply";
import { isExcludedProducer } from "../data/recipe-category";

// Reference-free feasibility invariant checkers. Each function is pure: its
// verdict comes only from its inputs, never from an external golden. The shared
// result shape carries a boolean verdict and a list of violation strings (empty
// when ok).
export type InvariantResult = {
  ok: boolean;
  violations: string[];
};

// Relative tolerance for floating residual comparisons, matching the mass-balance
// test in lp.test.ts.
const REL_TOL = 1e-6;

function rateOf(result: LpResult, recipeId: string): number {
  return result.rates.get(recipeId)?.valueOf() ?? 0;
}

// Net production (production - consumption) of an item across all recipes,
// weighted by each recipe's LP rate. Negative means net consumption.
function netProduction(
  result: LpResult,
  pack: RecipePack,
  itemId: string,
): number {
  let net = 0;
  for (const r of pack.recipes) {
    const out = r.out.find((o) => o.item === itemId)?.qty ?? 0;
    const inq = r.in.find((i) => i.item === itemId)?.qty ?? 0;
    net += (out - inq) * rateOf(result, r.id);
  }
  return net;
}

/**
 * Mass balance: for each item the LP built a mass-balance row for,
 * production - consumption - surplus + deficit - demand must be ~0, scaled by
 * max(scaleFloor, |demand|), where scaleFloor is the plan-magnitude tolerance
 * floor shared with the extraction hygiene gate (toleranceScaleFloor). Items
 * whose effective supply is Infinity are free boundary draws (raw items, or
 * non-raw items with a plan:true override); the LP builds no row for them, so
 * the checker skips them to stay aligned. Same residual form
 * `bal - surplus + deficit - demand` as the check in lp.test.ts.
 */
export function checkMassBalance(
  result: LpResult,
  pack: RecipePack,
  targets: Target[],
  overrides: ItemOverride[],
): InvariantResult {
  const violations: string[] = [];
  const demandOf = demandByItem(pack, targets);
  const scaleFloor = toleranceScaleFloor(demandOf);

  for (const it of pack.items) {
    if (effectiveSupply(it.id, pack, overrides) === Infinity) continue;
    const bal = netProduction(result, pack, it.id);
    const surplus = result.surplus.get(it.id)?.valueOf() ?? 0;
    const deficit = result.deficit.get(it.id)?.valueOf() ?? 0;
    const demand = demandOf.get(it.id) ?? 0;
    const residual = bal - surplus + deficit - demand;
    const scale = Math.max(scaleFloor, Math.abs(demand));
    if (Math.abs(residual) / scale >= REL_TOL) {
      violations.push(`mass-balance residual for ${it.id}: ${residual}`);
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Targets met: each target recipe must run at or above its requested floor.
 * Mirrors the target-floor block in lp.ts: floor = (rate/sec) / primary.qty,
 * primary = recipe.out[0], skipped when primary.qty <= 0. A recipe absent from
 * result.rates counts as rate 0 (a violation unless its floor is 0).
 */
export function checkTargetsMet(
  result: LpResult,
  targets: Target[],
  pack: RecipePack,
): InvariantResult {
  const violations: string[] = [];
  const scaleFloor = toleranceScaleFloor(demandByItem(pack, targets));

  for (const t of targets) {
    const recipe = pack.recipes.find((r) => r.id === t.recipeId);
    if (!recipe || recipe.out.length === 0) continue;
    const primary = recipe.out[0]!;
    // Match lp.ts: a zero/negative primary qty means no floor was pinned.
    if (!(primary.qty > 0)) continue;
    const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    const floor = rate / primary.qty;
    const actual = rateOf(result, t.recipeId);
    // Allow a relative slack so float noise at the floor is not a violation.
    const slack = Math.max(scaleFloor, Math.abs(floor)) * REL_TOL;
    if (actual < floor - slack) {
      violations.push(
        `target ${t.recipeId} runs at ${actual}, below floor ${floor}`,
      );
    }
    // Upper bound: the one-sided floor lets a co-product subsidize over-running
    // the target, silently over-producing the requested item. The requested item
    // must not carry meaningful surplus (keyed by item; shared across duplicate
    // targets on the same primary item, so a per-target read is fine). The
    // slack keeps the absolute floor of 1: the LP's surplus cap grants the
    // targeted item an eps of max(floor, 1) * 1e-7, so a plan-magnitude floor
    // here could tag a surplus legitimately sitting at that cap.
    const surplus = result.surplus.get(primary.item)?.valueOf() ?? 0;
    const surplusSlack = Math.max(1, Math.abs(floor)) * REL_TOL;
    if (surplus > surplusSlack) {
      violations.push(
        `target ${t.recipeId} over-produces ${primary.item}: surplus ${surplus}`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Raw-only boundary: the external supply a solution draws for each item must not
 * exceed what the item's effective supply permits.
 *
 * For each item:
 *   external_supply(item) = consumption(item) - production(item) + surplus(item)
 * i.e. what the solution drew from outside the system (consumed beyond internal
 * production, plus any leftover surplus the boundary pushed in). Assert:
 *   external_supply(item) <= effectiveSupply(item) + tol
 *     - effectiveSupply === Infinity  -> always passes (raw/uncapped boundary).
 *     - finite override cap            -> external_supply <= cap + tol.
 *     - plain non-raw (effectiveSupply 0) -> external_supply <= 0 + tol.
 *
 * A plain non-raw item with positive surplus yields external_supply = surplus >
 * 0 + tol, so this single check also flags any "surplus off a boundary item".
 *
 * Production/consumption are summed in exact Fraction arithmetic over all recipes
 * (like checkMassBalance); only the final tolerance comparison drops to number.
 */
export function checkRawOnlyBoundary(
  result: LpResult,
  pack: RecipePack,
  overrides: ItemOverride[],
): InvariantResult {
  const violations: string[] = [];

  for (const it of pack.items) {
    let production = new Fraction(0);
    let consumption = new Fraction(0);
    for (const r of pack.recipes) {
      const rate = result.rates.get(r.id);
      if (!rate) continue;
      const out = r.out.find((o) => o.item === it.id)?.qty ?? 0;
      const inq = r.in.find((i) => i.item === it.id)?.qty ?? 0;
      if (out !== 0) production = production.add(new Fraction(out).mul(rate));
      if (inq !== 0) consumption = consumption.add(new Fraction(inq).mul(rate));
    }
    const surplus = result.surplus.get(it.id) ?? new Fraction(0);
    const externalSupply = consumption.sub(production).add(surplus);

    const cap = effectiveSupply(it.id, pack, overrides);
    if (cap === Infinity) continue; // unlimited external supply: always passes.

    // Scale the slack by cap magnitude, like checkMassBalance and checkTargetsMet;
    // a flat absolute REL_TOL is too tight on large caps.
    const capValue = cap.valueOf();
    const slack = Math.max(1, Math.abs(capValue)) * REL_TOL;
    if (externalSupply.valueOf() > capValue + slack) {
      violations.push(
        `item ${it.id} draws external supply ${externalSupply.valueOf()} exceeding cap ${capValue}`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

const FRAC_ZERO = new Fraction(0);

// Set of recipe ids the logical graph represents. A recipe-kind node carries its
// recipeId on node.recipe.id; its node.id is a safe-encoded replica id, not the
// recipeId. A group-kind node is a container with no recipe, so it contributes
// nothing here.
function recipeIdsInLogical(full: SolvePlanFull): Set<string> {
  const ids = new Set<string>();
  for (const node of full.logical.nodes) {
    if (node.kind === "recipe") ids.add(node.recipe.id);
  }
  return ids;
}

/**
 * Forward representability from the LP layer (full.rates) to the logical graph
 * (full.logical.nodes): every positive-rate recipe must appear as a recipe in
 * the logical graph, except ones isExcludedProducer covers (__domain_transfer
 * category or cost === -1 sink). Those are sanctioned boundary/sink recipes and
 * may carry a positive LP rate without a logical node.
 *
 * The reverse direction (logical node -> positive LP rate) is a separate checker,
 * checkNoOrphanLogicalNodes, since it reports a known out-of-scope assembly
 * finding on the current pack.
 */
export function checkRepresentable(full: SolvePlanFull): InvariantResult {
  const violations: string[] = [];
  const logicalIds = recipeIdsInLogical(full);

  // Positive-rate recipe must be in the logical graph, unless sanctioned.
  for (const [recipeId, rate] of full.rates) {
    if (rate.compare(FRAC_ZERO) <= 0) continue;
    if (logicalIds.has(recipeId)) continue;
    const recipe = full.recipeById.get(recipeId);
    if (recipe && isExcludedProducer(recipe)) continue;
    violations.push(
      `positive-rate recipe ${recipeId} has no node in the logical graph`,
    );
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Reverse representability: every recipe-kind node in full.logical.nodes must map
 * back to a positive-rate recipe in full.rates. A node whose recipe has no
 * positive LP rate is an orphan: the graph assembly materialized a node the LP
 * gave zero (or no) rate. The headline plan passes (ok:true): the SCC boundary
 * walk no longer materializes phantom replicas for zero-rate producers.
 */
export function checkNoOrphanLogicalNodes(
  full: SolvePlanFull,
): InvariantResult {
  const violations: string[] = [];
  const logicalIds = recipeIdsInLogical(full);

  for (const recipeId of logicalIds) {
    const rate = full.rates.get(recipeId);
    if (!rate || rate.compare(FRAC_ZERO) <= 0) {
      violations.push(
        `logical recipe node ${recipeId} has no positive LP rate`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Run the four reference-free checkers against a completed solve and throw if any
 * fails. Dev-only (compiled out of release): a violation is a solver/assembly bug
 * that should never reach a user. checkNoOrphanLogicalNodes is omitted (known
 * out-of-scope finding).
 */
export function assertInvariants(
  full: SolvePlanFull,
  result: LpResult,
  pack: RecipePack,
  targets: Target[],
  overrides: ItemOverride[],
): void {
  const violations = [
    checkMassBalance(result, pack, targets, overrides),
    checkTargetsMet(result, targets, pack),
    checkRawOnlyBoundary(result, pack, overrides),
    checkRepresentable(full),
  ].flatMap((r) => r.violations);

  if (violations.length > 0) {
    throw new Error(`solver invariants violated:\n${violations.join("\n")}`);
  }
}
