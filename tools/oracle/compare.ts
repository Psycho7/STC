// Three-tier comparison harness: run STC's LP solver and the extracted
// FactorioLab GLPK solver on the SAME problem (one STC pack + targets +
// itemOverrides) and emit a classified record.
//
// Tiers (PROTOTYPE-001 section 4):
//   Tier 1 - objective-independent hard signals: feasibility verdict agreement
//            (status taxonomy), target-satisfiability agreement, forced
//            active-set equality.
//   Tier 2 - per-recipe exec/sec rate equality, ONLY where the solution is
//            uniquely determined (structural rule + empirical perturbation
//            guard). Units fix (#2): FactorioLab machines / time = exec/sec.
//   Tier 3 - objective / total-machine-count delta. Recorded, never asserted.
//
// HONESTY: this file never loosens a tolerance or rewrites an expected answer
// to manufacture agreement. A divergence is a finding.

import Fraction from "fraction.js";
import type { RecipePack, Recipe as StcRecipe } from "@aef/schema";
import type { ItemTarget } from "../../src/data/targets";
import type { ItemOverride } from "../../src/data/plan";
import { solveLp, type LpResult } from "../../src/solver/lp";
import { netSelfConsumption } from "../../src/solver/net-self";

import { SimplexService } from "~/services/simplex.service";
import { SimplexResultType } from "~/models/enum/simplex-result-type";
import { Rational, rational } from "~/models/rational";
import type { AdjustedDataset } from "~/models/dataset";
import { buildAdapterInput, type AdapterInput } from "./adapter";

// ---------------------------------------------------------------------------
// Scenario + result shapes
// ---------------------------------------------------------------------------

export interface Scenario {
  name: string;
  pack: RecipePack;
  targets: ItemTarget[];
  itemOverrides?: ItemOverride[];
  // When true the adapter is told to price free boundary draws at 0, matching
  // STC's strictly-free raw supply (non-equivalence #3). Used by free-source
  // tie fixtures so GLPK does not break a tie the way STC would not.
  freeSourceCostZero?: boolean;
}

export interface StcRun {
  rates: Map<string, Fraction>;
  surplus: Map<string, Fraction>;
  deficit: Map<string, Fraction>;
  status: LpResult["status"];
  softFeasible: boolean;
  objectiveValue: number;
}

export interface GlpkRun {
  resultType: SimplexResultType;
  simplexStatus?: string;
  returnCode?: string;
  // step.machines keyed by recipe id (= exec/sec * recipe.time).
  machinesByRecipe: Map<string, Rational>;
  // exec/sec per recipe = machines / time (the units fix, #2).
  ratesByRecipe: Map<string, Rational>;
  surplus: Map<string, Rational>;
  cost?: Rational;
}

// ---------------------------------------------------------------------------
// Tolerances
// ---------------------------------------------------------------------------

export const REL_TOL = 1e-6;
export const ABS_TOL = 1e-9;

// Float-bridged closeness: relative 1e-6 with an absolute floor of 1e-9.
export function closeFloat(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  if (diff <= ABS_TOL) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= REL_TOL * scale;
}

// Exact comparison where both sides carry exact rationals.
export function exactEqFracRational(a: Fraction, b: Rational): boolean {
  // Fraction.js: a.n (bigint magnitude of num), a.d, a.s (sign). Rational: p/q.
  // Compare as cross-multiplied bigints, sign-aware.
  const an = a.s * a.n; // signed numerator (bigint)
  const ad = a.d; // bigint
  return an * b.q === b.p * ad;
}

// Tolerance comparison of a Fraction (STC exec/sec) against a Rational
// (FactorioLab exec/sec). Tries exact first, then float-bridged.
export function rateClose(a: Fraction, b: Rational): boolean {
  if (exactEqFracRational(a, b)) return true;
  return closeFloat(a.valueOf(), b.toNumber());
}

// ---------------------------------------------------------------------------
// Run each solver
// ---------------------------------------------------------------------------

// Both solvers must see the SAME effective problem the real pipeline solves:
// src/solver/index.ts runs netSelfConsumption(rawPack) before solveLp, folding
// away same-item in/out stoich. The oracle mirrors that on both sides here.
// netSelfConsumption is a pure, idempotent function of the pack (a recipe with
// no overlapping in/out item is returned unchanged), so netting at every solver
// entry point is safe even when a caller already netted. Micro-fixture packs
// carry no self-consumption, so this is a no-op for the gate battery; it only
// changes the real v1.4 pack (headline / corpus scenarios).
export function nettedScenario(s: Scenario): Scenario {
  return { ...s, pack: netSelfConsumption(s.pack) };
}

export function runStc(s: Scenario): StcRun {
  const ns = nettedScenario(s);
  const r = solveLp({
    targets: ns.targets,
    pack: ns.pack,
    itemOverrides: ns.itemOverrides ?? [],
  });
  return {
    rates: r.rates,
    surplus: r.surplus,
    deficit: r.deficit,
    status: r.status,
    softFeasible: r.softFeasible,
    objectiveValue: r.objectiveValue,
  };
}

// Build the FactorioLab solve input for a scenario, optionally applying a
// per-recipe positive cost profile (used by the perturbation guard) and/or
// zeroing the free-source price.
function buildInput(
  s: Scenario,
  opts?: { recipeCostScale?: Map<string, number>; freeSourceCostZero?: boolean },
) {
  const ns = nettedScenario(s);
  const input: AdapterInput = {
    pack: ns.pack,
    targets: ns.targets,
    itemOverrides: ns.itemOverrides ?? [],
  };
  const built = buildAdapterInput(input);

  const freeZero = opts?.freeSourceCostZero ?? s.freeSourceCostZero;
  if (freeZero) {
    built.settings.costs.unproduceable = rational.zero;
  }

  const scale = opts?.recipeCostScale;
  if (scale) {
    // Replace each recipe-var cost with a distinct positive profile so the
    // objective changes shape without going degenerate. We overwrite, not
    // multiply, to guarantee a genuinely distinct cost vector even when the
    // base cost is the uniform 1.
    for (const [id, adj] of Object.entries(built.data.adjustedRecipe)) {
      const v = scale.get(id);
      if (v !== undefined) adj.cost = floatToRational(v);
    }
  }
  return built;
}

function floatToRational(x: number): Rational {
  // Keep perturbation costs as clean rationals (we only feed nice values).
  if (Number.isInteger(x)) return new Rational(BigInt(x));
  // x = a/1000 style; multiply out.
  const denom = 1_000_000;
  return new Rational(BigInt(Math.round(x * denom)), BigInt(denom));
}

function readGlpk(
  data: AdjustedDataset,
  result: ReturnType<SimplexService["solve"]>,
): GlpkRun {
  const machinesByRecipe = new Map<string, Rational>();
  const ratesByRecipe = new Map<string, Rational>();
  const surplus = new Map<string, Rational>();
  for (const step of result.steps) {
    if (step.recipeId != null && step.machines != null) {
      machinesByRecipe.set(step.recipeId, step.machines);
      const time = data.adjustedRecipe[step.recipeId]?.time;
      if (time != null && time.nonzero()) {
        ratesByRecipe.set(step.recipeId, step.machines.div(time));
      }
    }
    if (step.itemId != null && step.surplus != null && step.surplus.nonzero()) {
      surplus.set(step.itemId, step.surplus);
    }
  }
  return {
    resultType: result.resultType,
    simplexStatus: result.simplexStatus,
    returnCode: result.returnCode,
    machinesByRecipe,
    ratesByRecipe,
    surplus,
    cost: result.cost,
  };
}

export function runGlpk(
  s: Scenario,
  opts?: { recipeCostScale?: Map<string, number>; freeSourceCostZero?: boolean },
): GlpkRun {
  const { objectives, settings, data } = buildInput(s, opts);
  const result = new SimplexService().solve(objectives, settings, data, false);
  return readGlpk(data, result);
}

// ---------------------------------------------------------------------------
// Status taxonomy (written up in STATUS-MAP.md). Reduces each solver's raw
// outcome to one of three verdicts so they can be compared:
//   "satisfiable"     - feasible AND every target met with no shortfall.
//   "unsatisfiable"   - the problem as stated has no target-meeting solution
//                       (STC: feasible status but softFeasible=false / deficit;
//                        GLPK: not Solved).
//   "infeasible-hard" - structurally infeasible / unbounded reported as a hard
//                       failure by the solver (STC infeasible|unbounded status).
// STC's deficit var lets it return "feasible" status even when a target cannot
// be met; FactorioLab has no deficit var so the same problem comes back as a
// failed solve. The taxonomy folds both onto "unsatisfiable" (non-eq #4).
// ---------------------------------------------------------------------------

export type Verdict = "satisfiable" | "unsatisfiable" | "infeasible-hard";

export function stcVerdict(r: StcRun): Verdict {
  if (r.status === "infeasible" || r.status === "unbounded")
    return "infeasible-hard";
  // feasible | empty. softFeasible=false (a surviving deficit) means a target
  // could not be met -> the problem as stated is not satisfiable.
  if (!r.softFeasible) return "unsatisfiable";
  return "satisfiable";
}

export function glpkVerdict(r: GlpkRun): Verdict {
  if (r.resultType === SimplexResultType.Solved) return "satisfiable";
  // Distinguish unbounded (GLPK status 'unbounded') from an infeasible/failed
  // solve. Both block a target-meeting solution; we report hard for unbounded
  // and unsatisfiable for the no-solution case so the taxonomy stays legible.
  if (r.simplexStatus === "unbounded") return "infeasible-hard";
  return "unsatisfiable";
}

// ---------------------------------------------------------------------------
// Target satisfiability (Tier-1 signal 2)
// ---------------------------------------------------------------------------

export function stcTargetMet(r: StcRun): boolean {
  return r.softFeasible && r.deficit.size === 0;
}

export function glpkTargetMet(r: GlpkRun): boolean {
  return r.resultType === SimplexResultType.Solved;
}

// ---------------------------------------------------------------------------
// Forced active set (Tier-1 signal 3): the set of recipes that run at a
// positive rate. For a uniquely-determined problem this is the forced subgraph.
// ---------------------------------------------------------------------------

export function stcActiveSet(r: StcRun): Set<string> {
  return new Set(r.rates.keys());
}

export function glpkActiveSet(r: GlpkRun): Set<string> {
  const s = new Set<string>();
  for (const [id, m] of r.machinesByRecipe) if (m.nonzero()) s.add(id);
  return s;
}

export function setEq(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Structural uniqueness rule (PROTOTYPE-001 section 4)
//
// A scenario's active solution is structurally unique when, over the set of
// ACTIVE recipes:
//   (a) every item CONSUMED by an active recipe has exactly one producing
//       recipe in the pack (single-producer),
//   (b) the active subgraph is acyclic,
//   (c) no free-disposal / surplus-priced variable is active (no byproduct
//       dumped, no boundary over-drawn) -> no surplus on any item.
// Under (a)-(c) flow conservation + targets fully determine every active rate.
//
// We evaluate it against an ACTIVE set (the recipes that ran). "produced by"
// uses STC net stoich (out-in > 0). Free/raw items (no producer in the pack)
// are boundary supplies and are exempt from the single-producer test.
// ---------------------------------------------------------------------------

export interface UniquenessResult {
  unique: boolean;
  reasons: string[];
}

function netProducers(pack: RecipePack, itemId: string): StcRecipe[] {
  return pack.recipes.filter((r) => {
    const out = r.out.find((o) => o.item === itemId)?.qty ?? 0;
    const inn = r.in.find((i) => i.item === itemId)?.qty ?? 0;
    return out - inn > 0;
  });
}

function rawItemIds(pack: RecipePack): Set<string> {
  return new Set(pack.items.filter((i) => i.raw).map((i) => i.id));
}

export function structuralUnique(
  pack: RecipePack,
  activeIds: Set<string>,
  glpkSurplus: Map<string, Rational>,
): UniquenessResult {
  const reasons: string[] = [];
  const raw = rawItemIds(pack);
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  const active = [...activeIds]
    .map((id) => recipeById.get(id))
    .filter((r): r is StcRecipe => r != null);

  // (a) single-producer for every item consumed by an active recipe.
  const consumed = new Set<string>();
  for (const r of active) for (const s of r.in) consumed.add(s.item);
  for (const itemId of consumed) {
    if (raw.has(itemId)) continue; // boundary supply, exempt
    const producers = netProducers(pack, itemId);
    if (producers.length !== 1) {
      reasons.push(
        `item '${itemId}' consumed by an active recipe has ${producers.length} producers (need 1)`,
      );
    }
  }

  // (b) acyclic active subgraph. Edge u->v when active u net-produces an item
  // active v consumes. Detect a cycle via DFS over active nodes.
  const activeIdList = active.map((r) => r.id);
  const activeSet = new Set(activeIdList);
  const adj = new Map<string, string[]>();
  for (const u of active) {
    const outs = new Set(
      u.out
        .filter((o) => {
          const inn = u.in.find((i) => i.item === o.item)?.qty ?? 0;
          return o.qty - inn > 0;
        })
        .map((o) => o.item),
    );
    const targets: string[] = [];
    for (const v of active) {
      if (v.id === u.id) continue;
      if (v.in.some((i) => outs.has(i.item))) targets.push(v.id);
    }
    adj.set(u.id, targets);
  }
  if (hasCycle(activeIdList, adj, activeSet)) {
    reasons.push("active subgraph contains a cycle");
  }

  // (c) no surplus / free-disposal var active.
  for (const [itemId, v] of glpkSurplus) {
    if (v.nonzero()) reasons.push(`surplus on item '${itemId}' (free disposal active)`);
  }

  return { unique: reasons.length === 0, reasons };
}

function hasCycle(
  nodes: string[],
  adj: Map<string, string[]>,
  present: Set<string>,
): boolean {
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);
  const stack: { node: string; idx: number }[] = [];
  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue;
    stack.push({ node: start, idx: 0 });
    color.set(start, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const succ = (adj.get(top.node) ?? []).filter((x) => present.has(x));
      if (top.idx < succ.length) {
        const next = succ[top.idx++]!;
        const c = color.get(next);
        if (c === GRAY) return true;
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, idx: 0 });
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Empirical perturbation guard (PROTOTYPE-001 section 4)
//
// Re-solve GLPK under TWO distinct positive cost profiles and compare the two
// solutions to each other. If the active rates match -> the optimum is (within
// tolerance) the same vertex under either objective shape, i.e. uniquely
// determined; if any rate differs -> the problem has alternate optima and is
// demoted out of Tier 2. Comparing the two perturbed solves (rather than each
// against the base) makes the guard independent of GLPK's arbitrary tie-break
// on the uniform base-cost vector: a genuine cost-tie resolves to opposite
// vertices under the two opposite profiles and is caught.
// ---------------------------------------------------------------------------

export interface PerturbResult {
  stable: boolean;
  moved: string[]; // recipe ids whose rate differs between the two profiles
}

export function perturbationGuard(s: Scenario): PerturbResult {
  const ids = [...s.pack.recipes.map((r) => r.id)].sort();
  // Profile A: ascending distinct positive costs by sorted id (1,2,3,...).
  // Profile B: descending (n, n-1, ...). The two profiles order every pairwise
  // recipe tie oppositely, so any cost-tie alternate optimum lands on different
  // vertices under A vs B.
  const profA = new Map<string, number>();
  const profB = new Map<string, number>();
  ids.forEach((id, i) => {
    profA.set(id, i + 1);
    profB.set(id, ids.length - i);
  });

  const a = runGlpk(s, { recipeCostScale: profA });
  const b = runGlpk(s, { recipeCostScale: profB });

  const moved: string[] = [];
  const keys = new Set<string>([
    ...a.ratesByRecipe.keys(),
    ...b.ratesByRecipe.keys(),
  ]);
  for (const id of keys) {
    const av = a.ratesByRecipe.get(id)?.toNumber() ?? 0;
    const bv = b.ratesByRecipe.get(id)?.toNumber() ?? 0;
    if (!closeFloat(av, bv)) moved.push(id);
  }
  return { stable: moved.length === 0, moved };
}

// ---------------------------------------------------------------------------
// Full classified record
// ---------------------------------------------------------------------------

export interface CompareRecord {
  name: string;
  // Tier 1
  stcVerdict: Verdict;
  glpkVerdict: Verdict;
  verdictAgree: boolean;
  stcSoftFeasible: boolean;
  stcHasDeficit: boolean;
  stcTargetMet: boolean;
  glpkTargetMet: boolean;
  targetMetAgree: boolean;
  stcActiveSet: string[];
  glpkActiveSet: string[];
  activeSetAgree: boolean;
  // Tier 2
  uniqueness: UniquenessResult;
  perturbation: PerturbResult | null; // null when not eligible (no GLPK solve)
  tier2Eligible: boolean;
  rateDiffs: { recipeId: string; stc: string; glpk: string; close: boolean }[];
  ratesAgree: boolean | null; // null when not eligible
  // Tier 3 (record only)
  glpkCost: string | null;
  stcObjective: number;
  stcMachineEstimate: number; // sum of exec/sec * time (STC side, record-only)
  glpkMachineTotal: number; // sum of step.machines
}

export function compareScenario(s: Scenario): CompareRecord {
  // Net once so the harness's own structural analysis reads the SAME stoich the
  // solvers saw (runStc / runGlpk net internally too; the extra net is a no-op).
  const ns = nettedScenario(s);
  const stc = runStc(ns);
  const glpk = runGlpk(ns);

  const sV = stcVerdict(stc);
  const gV = glpkVerdict(glpk);

  const stcAct = stcActiveSet(stc);
  const glpkAct = glpkActiveSet(glpk);

  const stcMet = stcTargetMet(stc);
  const glpkMet = glpkTargetMet(glpk);

  const uniq = structuralUnique(ns.pack, stcAct, glpk.surplus);

  // Tier-2 eligible only when GLPK actually solved (rates exist to compare) and
  // both find the target satisfiable; otherwise rate equality is meaningless.
  const solved = glpk.resultType === SimplexResultType.Solved && stcMet;
  let perturb: PerturbResult | null = null;
  if (solved) perturb = perturbationGuard(ns);

  const tier2Eligible = solved && uniq.unique && (perturb?.stable ?? false);

  // Build the rate diff table over the union of active recipes (units fixed).
  const recipeById = new Map(ns.pack.recipes.map((r) => [r.id, r]));
  const rateDiffs: CompareRecord["rateDiffs"] = [];
  let ratesAgree: boolean | null = null;
  if (tier2Eligible) {
    ratesAgree = true;
    const keys = new Set<string>([...stcAct, ...glpkAct]);
    for (const id of [...keys].sort()) {
      const stcRate = stc.rates.get(id) ?? new Fraction(0);
      const glpkRate = glpk.ratesByRecipe.get(id) ?? rational.zero;
      const close = rateClose(stcRate, glpkRate);
      if (!close) ratesAgree = false;
      rateDiffs.push({
        recipeId: id,
        stc: stcRate.toFraction(),
        glpk: glpkRate.toFraction(),
        close,
      });
    }
  }

  // Tier-3 record-only machine totals.
  let stcMachineEstimate = 0;
  for (const [id, rate] of stc.rates) {
    const t = recipeById.get(id)?.time ?? 0;
    stcMachineEstimate += rate.valueOf() * t;
  }
  let glpkMachineTotal = 0;
  for (const m of glpk.machinesByRecipe.values()) glpkMachineTotal += m.toNumber();

  return {
    name: s.name,
    stcVerdict: sV,
    glpkVerdict: gV,
    verdictAgree: sV === gV,
    stcSoftFeasible: stc.softFeasible,
    stcHasDeficit: stc.deficit.size > 0,
    stcTargetMet: stcMet,
    glpkTargetMet: glpkMet,
    targetMetAgree: stcMet === glpkMet,
    stcActiveSet: [...stcAct].sort(),
    glpkActiveSet: [...glpkAct].sort(),
    activeSetAgree: setEq(stcAct, glpkAct),
    uniqueness: uniq,
    perturbation: perturb,
    tier2Eligible,
    rateDiffs,
    ratesAgree,
    glpkCost: glpk.cost ? glpk.cost.toFraction() : null,
    stcObjective: stc.objectiveValue,
    stcMachineEstimate,
    glpkMachineTotal,
  };
}
