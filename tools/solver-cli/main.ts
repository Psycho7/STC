// Solver debug CLI.
// Usage:
//   bun run tools/solver-cli/main.ts --plan <recipeId=rate,...> [--mode full|rates]
//   bun run tools/solver-cli/main.ts --hash <planHash>          [--mode full|rates]
//
// See tools/solver-cli/README.md for full usage details.

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

// ---------------------------------------------------------------------------
// Rate parsing for --plan
// ---------------------------------------------------------------------------

// Parse a single "recipeId=rate" entry.
// Accepted rate forms:
//   - "num/denom"  -> RationalString { num, denom } directly.
//   - integer      -> { num: integer, denom: "1" }.
//   - decimal      -> { num: d*10^p, denom: 10^p } where p is decimal places.
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
    if (!num || !denom) return null;
    return { recipeId, ratePerSec: { num, denom } };
  }

  // Integer
  if (/^\d+$/.test(rateStr)) {
    return { recipeId, ratePerSec: { num: rateStr, denom: "1" } };
  }

  // Decimal: split at the point, build num/denom as powers of 10.
  const dot = rateStr.indexOf(".");
  if (dot !== -1 && /^\d+\.\d+$/.test(rateStr)) {
    const intPart = rateStr.slice(0, dot);
    const fracPart = rateStr.slice(dot + 1);
    const denom = String(Math.pow(10, fracPart.length));
    const num = String(Number(intPart) * Math.pow(10, fracPart.length) + Number(fracPart));
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
    if (!t) return `cannot parse target entry: "${entry.trim()}" (expected recipeId=rate)`;
    targets.push(t);
  }
  if (targets.length === 0) return "no targets parsed from --plan spec";
  return targets;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Format a Fraction as a stable string. f.n, f.s, f.d are BigInt in fraction.js v5.
// toFraction() returns "n/d" or just "n" when d === 1n; s is the sign factor.
// We delegate entirely to toFraction() for an exact, consistent representation.
function fmtFrac(f: Fraction): string {
  // toFraction() already handles the sign and omits the denominator when it is 1.
  return f.toFraction();
}

function fmtMap(map: Map<string, Fraction>): string[] {
  const keys = [...map.keys()].sort();
  return keys.map((k) => `${k}=${fmtFrac(map.get(k)!)}`);
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
  let mode: "full" | "rates" = "full";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hash") {
      hashArg = argv[++i];
    } else if (a === "--plan") {
      planArg = argv[++i];
    } else if (a === "--mode") {
      const m = argv[++i];
      if (m !== "full" && m !== "rates") return `error: --mode must be full or rates, got "${m}"`;
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

  // --- Resolve targets ---
  let targets: Target[];

  if (planArg !== undefined) {
    const parsed = parseInlineTargets(planArg);
    if (typeof parsed === "string") return `error: ${parsed}`;
    targets = parsed;
  } else {
    // --hash: decode via the existing loadPlan decoder in src/data/plan.ts.
    // loadPlan expects the hash with or without leading "#"; it accepts "v1.XXX".
    const outcome = await loadPlan(hashArg!, pack);
    if (outcome.kind === "error") {
      return `error: failed to decode hash: ${describePlanLoadError(outcome.error)}`;
    }
    targets = outcome.plan.targets;
  }

  // --- Run LP ---
  const lpResult = solveLp({ targets, pack });

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
    // --- Invariants ---
    const massBalance = checkMassBalance(lpResult, pack, targets);
    const targetsMet = checkTargetsMet(lpResult, targets, pack);
    const rawOnlyBoundary = checkRawOnlyBoundary(lpResult, pack, []);
    const full = solvePlanWithIntermediates(targets, pack, defaultTransportConfig);
    const representable = checkRepresentable(full);

    // NOTE: checkNoOrphanLogicalNodes is EXPECTED to return ok=false on the
    // stock pack due to a copper_enr orphan node in the graph assembly. This
    // is a known, documented out-of-scope graph finding and is NOT a CLI error.
    const noOrphanLogicalNodes = checkNoOrphanLogicalNodes(full);

    const optimal = assertOptimal({ targets, pack });

    lines.push("# invariants");
    for (const l of fmtVerdict("massBalance", massBalance.ok, massBalance.violations)) lines.push(l);
    for (const l of fmtVerdict("targetsMet", targetsMet.ok, targetsMet.violations)) lines.push(l);
    for (const l of fmtVerdict("rawOnlyBoundary", rawOnlyBoundary.ok, rawOnlyBoundary.violations)) lines.push(l);
    for (const l of fmtVerdict("representable", representable.ok, representable.violations)) lines.push(l);
    // noOrphanLogicalNodes is expected ok=false on the stock pack (copper_enr orphan).
    for (const l of fmtVerdict("noOrphanLogicalNodes", noOrphanLogicalNodes.ok, noOrphanLogicalNodes.violations)) lines.push(l);
    for (const l of fmtVerdict("optimal", optimal.ok, optimal.violations)) lines.push(l);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  runCli(argv).then((out) => {
    console.log(out);
    // Exit non-zero only on an error prefix (bad args / solve throw).
    if (out.startsWith("error:")) process.exit(1);
  }).catch((err: unknown) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}
