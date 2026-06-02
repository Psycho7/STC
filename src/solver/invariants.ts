import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import type { LpResult } from "./lp";
import type { SolvePlanFull } from "./index";
import { effectiveSupply } from "./effectiveSupply";

// Reference-free feasibility invariant checkers. Each function is pure: it
// derives its verdict only from the inputs handed to it, never from any
// external golden. The shared result shape carries a boolean verdict and a
// list of human-readable violation strings (empty when ok).
export type InvariantResult = {
  ok: boolean;
  violations: string[];
};

// Relative tolerance for floating residual comparisons, matching the existing
// mass-balance test in lp.test.ts.
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

// Demand per item: sum over targets of the rate placed on the target recipe's
// primary output item (recipe.out[0]).
function demandByItem(pack: RecipePack, targets: Target[]): Map<string, number> {
  const demandOf = new Map<string, number>();
  for (const t of targets) {
    const r = pack.recipes.find((x) => x.id === t.recipeId);
    if (!r || r.out.length === 0) continue;
    const prim = r.out[0]!;
    const d = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    demandOf.set(prim.item, (demandOf.get(prim.item) ?? 0) + d);
  }
  return demandOf;
}

/**
 * Mass balance: for each item the LP built a mass-balance row for,
 * production - consumption - surplus + deficit - demand must be ~0, scaled by
 * max(1, |demand|). Items whose effective supply is Infinity are free boundary
 * draws (raw items, or non-raw items carrying a plan:true override); the LP
 * builds no row for them, so the checker skips them to stay aligned. This
 * generalizes the inline "precision (mass-balance residual)" check in
 * lp.test.ts, which uses the residual form `bal - surplus + deficit - demand`.
 */
export function checkMassBalance(
  result: LpResult,
  pack: RecipePack,
  targets: Target[],
  overrides: ItemOverride[],
): InvariantResult {
  const violations: string[] = [];
  const demandOf = demandByItem(pack, targets);

  for (const it of pack.items) {
    if (effectiveSupply(it.id, pack, overrides) === Infinity) continue;
    const bal = netProduction(result, pack, it.id);
    const surplus = result.surplus.get(it.id)?.valueOf() ?? 0;
    const deficit = result.deficit.get(it.id)?.valueOf() ?? 0;
    const demand = demandOf.get(it.id) ?? 0;
    const residual = bal - surplus + deficit - demand;
    const scale = Math.max(1, Math.abs(demand));
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
    const slack = Math.max(1, Math.abs(floor)) * REL_TOL;
    if (actual < floor - slack) {
      violations.push(
        `target ${t.recipeId} runs at ${actual}, below floor ${floor}`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Raw-only boundary: the external supply a solution draws for each item must
 * not exceed what the item's effective supply permits.
 *
 * Direct supply model (reference-free). For each item:
 *   external_supply(item) = consumption(item) - production(item) + surplus(item)
 * i.e. the amount the solution had to draw from outside the system (anything
 * consumed beyond what is produced internally, plus any leftover surplus the
 * boundary pushed in). Assert:
 *   external_supply(item) <= effectiveSupply(item) + tol
 *     - effectiveSupply === Infinity  -> always passes (raw or uncapped
 *       boundary; unlimited external supply).
 *     - finite override cap            -> external_supply <= cap + tol.
 *     - plain non-raw (effectiveSupply 0) -> external_supply <= 0 + tol; no
 *       external supply is allowed.
 *
 * This subsumes the old Part-1 "positive surplus must be on a boundary item"
 * check: a plain non-raw item with positive surplus yields
 * external_supply = surplus > 0 > 0 + tol, which this single check already
 * flags. Part 1 is therefore removed to avoid double-reporting the same defect.
 *
 * Production/consumption are summed in exact Fraction arithmetic over all
 * recipes (same iteration style as checkMassBalance); only the final tolerance
 * comparison drops to number.
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

    // Scale the slack by the cap magnitude, matching checkMassBalance and
    // checkTargetsMet; a flat absolute REL_TOL is too tight on large caps.
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

// Set of recipe ids that the logical graph represents. A LogicalRecipeNode
// (kind "recipe") carries its recipeId on node.recipe.id; its node.id is a
// safe-encoded replica id, not the recipeId. A LogicalGroupNode (kind "group")
// is a container with no recipe of its own, so it contributes nothing here.
function recipeIdsInLogical(full: SolvePlanFull): Set<string> {
  const ids = new Set<string>();
  for (const node of full.logical.nodes) {
    if (node.kind === "recipe") ids.add(node.recipe.id);
  }
  return ids;
}

/**
 * Forward representability from the LP layer (full.rates) to the 2b
 * LogicalGraph (full.logical.nodes): every positive-rate recipe must appear as
 * a recipe in the logical graph, EXCEPT recipes that buildRecipeGraphMulti
 * legitimately excludes: a recipe in the __domain_transfer category, or a
 * cost === -1 sink recipe. These are sanctioned boundary/sink recipes and may
 * carry a positive LP rate without a logical node.
 *
 * The reverse direction (logical node -> positive LP rate) is intentionally a
 * separate checker, checkNoOrphanLogicalNodes, because it reports a known
 * out-of-scope graph-assembly finding on the current pack.
 */
export function checkRepresentable(full: SolvePlanFull): InvariantResult {
  const violations: string[] = [];
  const logicalIds = recipeIdsInLogical(full);

  // Forward: positive-rate recipe -> must be in logical, unless sanctioned.
  for (const [recipeId, rate] of full.rates) {
    if (rate.compare(FRAC_ZERO) <= 0) continue;
    if (logicalIds.has(recipeId)) continue;
    const recipe = full.recipeById.get(recipeId);
    const isTransfer = recipe?.category === "__domain_transfer";
    const isSink = recipe?.cost === -1;
    if (isTransfer || isSink) continue;
    violations.push(
      `positive-rate recipe ${recipeId} has no node in the logical graph`,
    );
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Reverse representability: every recipe node in the 2b LogicalGraph
 * (full.logical.nodes, kind "recipe") must map back to a positive-rate recipe
 * in full.rates. A node whose recipe has no positive LP rate is an orphan: the
 * graph assembly materialized a node the LP gave zero (or no) rate.
 *
 * This catches zero-rate/orphan recipe nodes produced by the 2b graph
 * assembly. On the current pack the headline plan legitimately reports
 * `copper_enr` (a known render/graph-assembly finding, out of scope to fix
 * here), so this checker is expected to return ok:false there.
 */
export function checkNoOrphanLogicalNodes(full: SolvePlanFull): InvariantResult {
  const violations: string[] = [];
  const logicalIds = recipeIdsInLogical(full);

  for (const recipeId of logicalIds) {
    const rate = full.rates.get(recipeId);
    if (!rate || rate.compare(FRAC_ZERO) <= 0) {
      violations.push(`logical recipe node ${recipeId} has no positive LP rate`);
    }
  }

  return { ok: violations.length === 0, violations };
}
