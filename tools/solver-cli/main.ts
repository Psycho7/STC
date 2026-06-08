// Solver debug CLI.
// Usage:
//   bun run tools/solver-cli/main.ts --plan <recipeId=rate,...> [--mode full|rates|render]
//   bun run tools/solver-cli/main.ts --hash <planHash>          [--mode full|rates|render]
//
// Flags and output format are documented inline below.

import Fraction from "fraction.js";
import { pack } from "../../src/data/load";
import { defaultTransportConfig } from "../../src/data/transport-config";
import type { Target } from "../../src/data/targets";
import { solveLp } from "../../src/solver/lp";
import { solvePlanWithIntermediates } from "../../src/solver/index";
import {
  checkMassBalance,
  checkTargetsMet,
  checkRawOnlyBoundary,
  checkRepresentable,
  checkNoOrphanLogicalNodes,
} from "../../src/solver/invariants";
import { assertOptimal } from "../../src/solver/optimality";
import { loadPlan, describePlanLoadError } from "../../src/data/plan";
import { planToSolverArgs } from "../../src/solver/planToSolverArgs";
import type { ItemOverride } from "../../src/data/plan";
import type { RecipeId } from "../../src/solver/types";
import { renderPlanFromSolve } from "../../src/pipeline/driver";
import { checkRenderPlan } from "../../src/pipeline/render/invariants";
import {
  isRecipeUnit,
  isLoopUnit,
  isInputProductUnit,
  isOutputProductUnit,
} from "../../src/pipeline/types";

// ---------------------------------------------------------------------------
// Rate parsing for --plan
// ---------------------------------------------------------------------------

// Parse one "recipeId=rate" entry. Rate forms:
//   - "num/denom"  -> { num, denom } directly.
//   - integer      -> { num: integer, denom: "1" }.
//   - decimal      -> { num: d*10^p, denom: 10^p }, p = decimal places.
// Returns null on parse failure.
function parseRateEntry(entry: string): Target | null {
  const eq = entry.indexOf("=");
  if (eq < 1) return null;
  const recipeId = entry.slice(0, eq).trim();
  const rateStr = entry.slice(eq + 1).trim();
  if (!recipeId || !rateStr) return null;

  // Explicit rational: num/denom
  const slashIdx = rateStr.indexOf("/");
  if (slashIdx !== -1) {
    const num = rateStr.slice(0, slashIdx).trim();
    const denom = rateStr.slice(slashIdx + 1).trim();
    // Both sides must be non-negative integers; zero denominator is rejected.
    if (!num || !denom) return null;
    if (!/^\d+$/.test(num) || !/^\d+$/.test(denom)) return null;
    if (denom === "0") return null;
    return { recipeId, ratePerSec: { num, denom } };
  }

  // Integer
  if (/^\d+$/.test(rateStr)) {
    return { recipeId, ratePerSec: { num: rateStr, denom: "1" } };
  }

  // Decimal: split at the point, build num/denom as powers of 10. Exact only for
  // short decimals; long inputs may lose precision to floating-point arithmetic.
  const dot = rateStr.indexOf(".");
  if (dot !== -1 && /^\d+\.\d+$/.test(rateStr)) {
    const intPart = rateStr.slice(0, dot);
    const fracPart = rateStr.slice(dot + 1);
    const denom = String(Math.pow(10, fracPart.length));
    const num = String(
      Number(intPart) * Math.pow(10, fracPart.length) + Number(fracPart),
    );
    return { recipeId, ratePerSec: { num, denom } };
  }

  return null;
}

function parseInlineTargets(spec: string): Target[] | string {
  const entries = spec.split(",");
  const targets: Target[] = [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const t = parseRateEntry(entry.trim());
    if (!t)
      return `cannot parse target entry: "${entry.trim()}" (expected recipeId=rate)`;
    targets.push(t);
  }
  if (targets.length === 0) return "no targets parsed from --plan spec";
  return targets;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// toFraction() returns a stable exact string: "n/d", or "n" when d === 1n, with
// the sign already applied.
function fmtMap(map: Map<string, Fraction>): string[] {
  const keys = [...map.keys()].sort();
  return keys.map((k) => `${k}=${map.get(k)!.toFraction()}`);
}

// Format an invariant verdict as a single block of lines.
function fmtVerdict(name: string, ok: boolean, violations: string[]): string[] {
  const lines: string[] = [`${name} ok=${ok}`];
  for (const v of violations.sort()) {
    lines.push(`  violation: ${v}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Core runCli function (exported so the smoke test can call it directly)
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<string> {
  // --- Arg parse ---
  let hashArg: string | undefined;
  let planArg: string | undefined;
  let mode: "full" | "rates" | "render" = "full";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hash") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return `error: --hash requires a value`;
      hashArg = argv[++i];
    } else if (a === "--plan") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return `error: --plan requires a value`;
      planArg = argv[++i];
    } else if (a === "--mode") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return `error: --mode requires a value`;
      const m = argv[++i];
      if (m !== "full" && m !== "rates" && m !== "render")
        return `error: --mode must be full, rates, or render, got "${m}"`;
      mode = m;
    } else {
      return `error: unknown argument "${a}"`;
    }
  }

  if (hashArg !== undefined && planArg !== undefined) {
    return "error: provide exactly one of --hash or --plan, not both";
  }
  if (hashArg === undefined && planArg === undefined) {
    return "error: provide exactly one of --hash or --plan";
  }

  // --- Resolve targets and overrides ---
  let targets: Target[];
  // --plan carries no overrides; --hash threads whatever the decoded plan
  // carried so the CLI solve matches the app.
  let itemOverrides: ItemOverride[] = [];
  let recipeCosts: Map<RecipeId, number> | undefined;

  if (planArg !== undefined) {
    const parsed = parseInlineTargets(planArg);
    if (typeof parsed === "string") return `error: ${parsed}`;
    targets = parsed;
    const validIds = new Set(pack.recipes.map((r) => r.id));
    const bad = targets.find((t) => !validIds.has(t.recipeId));
    if (bad) return `error: target references unknown recipe "${bad.recipeId}"`;
  } else {
    // --hash: decode via loadPlan in src/data/plan.ts. It takes the hash with or
    // without a leading "#" and accepts "v1.XXX".
    const outcome = await loadPlan(hashArg!, pack);
    if (outcome.kind === "error") {
      return `error: failed to decode hash: ${describePlanLoadError(outcome.error)}`;
    }
    const args = planToSolverArgs(outcome.plan);
    targets = args.targets;
    itemOverrides = args.itemOverrides;
    recipeCosts = args.recipeCosts;
  }

  // --- Run LP ---
  const lpResult = solveLp({ targets, pack, itemOverrides, recipeCosts });

  const lines: string[] = [];

  lines.push(`objective=${lpResult.objectiveValue}`);
  lines.push(`status=${lpResult.status}`);
  lines.push(`softFeasible=${lpResult.softFeasible}`);
  lines.push("");

  // Rates (sorted by recipeId)
  lines.push("# rates");
  for (const line of fmtMap(lpResult.rates)) {
    lines.push(line);
  }
  lines.push("");

  // Surplus (only nonzero, already filtered by solveLp)
  if (lpResult.surplus.size > 0) {
    lines.push("# surplus");
    for (const line of fmtMap(lpResult.surplus)) {
      lines.push(line);
    }
    lines.push("");
  }

  // Deficit (only nonzero)
  if (lpResult.deficit.size > 0) {
    lines.push("# deficit");
    for (const line of fmtMap(lpResult.deficit)) {
      lines.push(line);
    }
    lines.push("");
  }

  if (mode === "full") {
    if (lpResult.status !== "feasible") {
      // Keep the rates/surplus/deficit diagnostics so a non-feasible solve still
      // reports why; the leading "error:" preserves the non-zero exit code.
      return `error: cannot run full invariants on a non-feasible solve (status=${lpResult.status})\n\n${lines.join("\n")}`;
    }
    // --- Invariants ---
    const massBalance = checkMassBalance(
      lpResult,
      pack,
      targets,
      itemOverrides,
    );
    const targetsMet = checkTargetsMet(lpResult, targets, pack);
    const rawOnlyBoundary = checkRawOnlyBoundary(lpResult, pack, itemOverrides);
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      itemOverrides,
      recipeCosts,
    );
    const representable = checkRepresentable(full);

    // checkNoOrphanLogicalNodes reports any logical recipe node with no positive
    // LP rate. Printed for visibility; a false verdict is a graph finding, not a
    // CLI error, so it never gates the run.
    const noOrphanLogicalNodes = checkNoOrphanLogicalNodes(full);

    const optimal = assertOptimal({
      targets,
      pack,
      itemOverrides,
      recipeCosts,
    });

    lines.push("# invariants");
    for (const l of fmtVerdict(
      "massBalance",
      massBalance.ok,
      massBalance.violations,
    ))
      lines.push(l);
    for (const l of fmtVerdict(
      "targetsMet",
      targetsMet.ok,
      targetsMet.violations,
    ))
      lines.push(l);
    for (const l of fmtVerdict(
      "rawOnlyBoundary",
      rawOnlyBoundary.ok,
      rawOnlyBoundary.violations,
    ))
      lines.push(l);
    for (const l of fmtVerdict(
      "representable",
      representable.ok,
      representable.violations,
    ))
      lines.push(l);
    // Informational verdict (a graph finding, not an error).
    for (const l of fmtVerdict(
      "noOrphanLogicalNodes",
      noOrphanLogicalNodes.ok,
      noOrphanLogicalNodes.violations,
    ))
      lines.push(l);
    for (const l of fmtVerdict("optimal", optimal.ok, optimal.violations))
      lines.push(l);
  }

  if (mode === "render") {
    if (lpResult.status !== "feasible") {
      return `error: cannot run render checks on a non-feasible solve (status=${lpResult.status})\n\n${lines.join("\n")}`;
    }

    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      itemOverrides,
      recipeCosts,
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, itemOverrides);

    const results = checkRenderPlan({
      plan,
      rates: lpResult.rates,
      pack,
      targets,
      itemOverrides,
    });

    // # units block
    lines.push("# units");
    const unitLines: string[] = [];
    for (const u of plan.units) {
      if (isRecipeUnit(u)) {
        const rate = lpResult.rates.get(u.recipeId);
        const rateStr = rate !== undefined ? rate.toFraction() : "0";
        unitLines.push(`recipe ${u.id} recipeId=${u.recipeId} rate=${rateStr}`);
      } else if (isLoopUnit(u)) {
        unitLines.push(`loop ${u.id} sccId=${u.sccId}`);
      } else if (isInputProductUnit(u)) {
        unitLines.push(
          `inputProduct ${u.id} item=${u.itemId} rate=${new Fraction(`${u.rate.num}/${u.rate.denom}`).toFraction()}`,
        );
      } else if (isOutputProductUnit(u)) {
        unitLines.push(
          `outputProduct ${u.id} item=${u.itemId} rate=${new Fraction(`${u.rate.num}/${u.rate.denom}`).toFraction()}`,
        );
      }
    }
    for (const l of unitLines.sort()) lines.push(l);
    lines.push("");

    // # edges block
    lines.push("# edges");
    const edgeLines: string[] = [];
    for (const e of plan.edges) {
      edgeLines.push(
        `${e.fromUnit} -> ${e.toUnit} item=${e.item} rate=${e.rate.toFraction()}`,
      );
    }
    for (const l of edgeLines.sort()) lines.push(l);
    lines.push("");

    // # render-invariants block
    const RENDER_INVARIANT_NAMES = [
      "edgeEndpointIntegrity",
      "boundaryProductsJustified",
      "internalFlowConservation",
      "consumerInputsSatisfied",
      "consumerInputsNotOverfed",
      "targetOutputsSatisfied",
      "noOrphanUnits",
    ];
    if (results.length !== RENDER_INVARIANT_NAMES.length)
      throw new Error(
        `render invariant count drift: ${results.length} results vs ${RENDER_INVARIANT_NAMES.length} labels`,
      );
    lines.push("# render-invariants");
    for (let i = 0; i < Math.min(results.length, RENDER_INVARIANT_NAMES.length); i++) {
      for (const l of fmtVerdict(
        RENDER_INVARIANT_NAMES[i],
        results[i].ok,
        results[i].violations,
      )) {
        lines.push(l);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  runCli(argv)
    .then((out) => {
      console.log(out);
      // Exit non-zero only on an error prefix (bad args / solve throw).
      if (out.startsWith("error:")) process.exit(1);
    })
    .catch((err: unknown) => {
      console.error("fatal:", err);
      process.exit(1);
    });
}
