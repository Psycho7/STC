// T5 corpus run: drive the FULL scenario set through the gate-validated
// three-tier comparison harness (compare.ts) and emit a tier-classified report
// (corpus-results.md). HONEST: a real STC-vs-GLPK disagreement on a whitelisted
// axis is the prototype payload; this file never fudges one away.
//
// Scenario set (PLAN-001 T5):
//   1. The STC solver corpus (src/solver/corpus.ts) - every topology it defines.
//   2. The headline plan - the app default targets + the ADAPTER-NOTES 4:1 case.
//   3. Risk axes not covered by 1-2 - reuse tools/oracle/fixtures.
//
// Carry-forward gate constraints obeyed here:
//   - Only the 5 whitelisted axes (chain, multi-producer, byproduct, raw-draw,
//     cyclic-target) may raise a build-vs-buy finding. A no-producer-shaped
//     scenario (non-raw input with no producer) is INCONCLUSIVE: GLPK fabricates
//     free `unproduceable` supply, so a satisfiability disagreement there is a
//     known adapter-artifact, NOT an STC bug. Tagged INCONCLUSIVE, not a finding.
//   - Tier-2 (rate equality) requires tier2Eligible (structural-unique +
//     perturbation-stable). Multi-producer intermediates and any active
//     surplus/disposal are Tier-1-only.
//   - unbounded is UNVERIFIED; any unbounded result is flagged as a trip-wire.

import { writeFileSync } from "node:fs";
import path from "node:path";

import { loadModule } from "glpk-ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { solveLp } from "../../src/solver/lp";
import { netSelfConsumption } from "../../src/solver/net-self";
import type { RecipePack } from "@aef/schema";
import type { ItemTarget as Target } from "../../src/data/targets";
import { defaultTargets } from "../../src/data/targets";
import type { ItemOverride } from "../../src/data/plan";
import { pack as realPack } from "../../src/data/load";

import {
  compareScenario,
  runGlpk,
  runStc,
  type CompareRecord,
  type Scenario,
} from "./compare";

import * as corpus from "../../src/solver/corpus";
import { FIXTURES } from "./fixtures";

beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

// ---------------------------------------------------------------------------
// Severity vocabulary (PLAN-001 T5). Only structural-formulation-flaw OR a
// Tier-2 unique-rate miss count toward the adopt-GLPK gate (spec section 9).
// ---------------------------------------------------------------------------
type Severity =
  | "none"
  | "structural-formulation-flaw"
  | "localized-fix"
  | "adapter-artifact"
  | "modeling-difference"
  | "alternate-optima";

// A corpus entry: a harness Scenario plus its axis classification and any
// known modeling caveat that makes a mismatch expected (not an STC flaw).
interface Entry {
  scenario: Scenario;
  // Whitelisted axes exercised (from validated-axes.json) or "INCONCLUSIVE".
  axes: string[];
  whitelisted: boolean; // false => INCONCLUSIVE (adapter-artifact shape)
  // Optional STC recipe-cost override (corpus carries these; the adapter does
  // NOT thread recipeCosts, so any resulting mismatch is a modeling-difference,
  // documented per-row rather than counted as a finding).
  stcRecipeCosts?: Map<string, number>;
  // A pre-classified caveat: when a mismatch on this entry is EXPECTED for a
  // documented reason, record the reason + severity so it is not miscounted.
  expectMismatch?: { reason: string; severity: Severity };
  note?: string;
}

// Cast helper: corpus packs are built via `as unknown as RecipePack` already.
const asScenario = (
  name: string,
  s: { pack: RecipePack; targets: Target[]; itemOverrides?: ItemOverride[] },
): Scenario => ({
  name,
  pack: s.pack,
  targets: s.targets,
  itemOverrides: s.itemOverrides,
});

// ---------------------------------------------------------------------------
// Build the corpus entry list.
// ---------------------------------------------------------------------------
function buildEntries(): Entry[] {
  const entries: Entry[] = [];

  // --- (1) STC solver corpus -------------------------------------------------

  // Scenario 1: acyclic single producer -> chain axis, single producer, unique.
  entries.push({
    scenario: asScenario("corpus:acyclic-single-producer", corpus.acyclicSingleProducer),
    axes: ["chain"],
    whitelisted: true,
  });

  // Scenario 2: multi-producer cost choice. "mid" has TWO producers (cheap,
  // pricey). The STC target is on target_r (single producer of prod), but the
  // multi-producer intermediate makes the active rate split non-unique; STC's
  // cost+lex tie-break picks "cheap". GLPK item-Output on prod is free to pick
  // any "mid" producer. Whitelisted axis = multi-producer; Tier-2-ineligible.
  entries.push({
    scenario: asScenario("corpus:multi-producer-cost-choice", corpus.multiProducerCostChoice),
    axes: ["multi-producer", "chain"],
    whitelisted: true,
    expectMismatch: {
      reason:
        "Active-set tie-break: 'mid' has two equal-cost producers (raw is unpriced). STC's pass-2 lex picks 'cheap'; GLPK may pick either. Alternate optima, not an STC flaw.",
      severity: "alternate-optima",
    },
  });

  // Scenario 2b: recipeCosts override flips cheap->pricey. The ADAPTER does NOT
  // thread per-recipe cost overrides (ADAPTER-NOTES recipeCost() is fixed), so
  // GLPK solves the UN-overridden problem. Any active-set difference here is an
  // adapter limitation (modeling-difference), documented, not an STC finding.
  entries.push({
    scenario: asScenario(
      "corpus:multi-producer-cost-override",
      multiProducerCostChoiceWithOverride(),
    ),
    axes: ["multi-producer", "chain"],
    whitelisted: true,
    stcRecipeCosts: corpus.multiProducerCostChoiceWithOverride.recipeCosts,
    expectMismatch: {
      reason:
        "STC applies recipeCosts (cheap=100) and runs 'pricey'; the adapter does not thread recipeCosts, so GLPK solves the un-overridden problem. Adapter limitation, not an STC flaw.",
      severity: "modeling-difference",
    },
  });

  // Scenario 3: equal-cost tie-break. Two identical producers of "mid"; same
  // multi-producer-intermediate shape as scenario 2.
  entries.push({
    scenario: asScenario("corpus:equal-cost-tie-break", corpus.equalCostTieBreak),
    axes: ["multi-producer", "chain"],
    whitelisted: true,
    expectMismatch: {
      reason:
        "Two identical 'mid' producers; STC lex picks aaa_producer, GLPK may pick either. Alternate optima.",
      severity: "alternate-optima",
    },
  });

  // Scenario 4: byproduct surplus. Free disposal active -> Tier-1-only.
  entries.push({
    scenario: asScenario("corpus:byproduct-surplus", corpus.byproductSurplus),
    axes: ["byproduct", "chain"],
    whitelisted: true,
  });

  // Scenario 5 baseline: finite cap fixture WITHOUT the override -> two equal
  // producers of "mid" each drawing a distinct raw -> multi-producer.
  entries.push({
    scenario: asScenario("corpus:finite-cap-baseline", {
      pack: corpus.finiteCapForcingFallback.pack,
      targets: corpus.finiteCapForcingFallback.targets,
    }),
    axes: ["multi-producer", "raw-draw", "chain"],
    whitelisted: true,
    expectMismatch: {
      reason:
        "a_primary / z_fallback are equal-cost 'mid' producers on distinct raws; STC lex picks a_primary, GLPK may pick either. Alternate optima.",
      severity: "alternate-optima",
    },
  });

  // Scenario 5: finite cap forces fallback. ItemOverride caps raw_aprimary to 0
  // -> a_primary blocked, z_fallback forced. Single forced producer -> unique.
  entries.push({
    scenario: asScenario("corpus:finite-cap-fallback", corpus.finiteCapForcingFallback),
    axes: ["multi-producer", "raw-draw", "chain"],
    whitelisted: true,
    expectMismatch: {
      reason:
        "0-cap itemOverride on raw_aprimary. STC sets effectiveSupply=Fraction(0) and blocks a_primary -> runs z_fallback. The adapter only emits an Input objective for a POSITIVE cap (num>0); a 0-cap leaves raw_aprimary as a no-producer item, which GLPK treats as free unproduceable supply, so a_primary runs. Adapter 0-cap limitation (same free-supply artifact as no-producer); both still satisfiable+target-met, so Tier-1 agrees.",
      severity: "adapter-artifact",
    },
    note: "0-cap on raw_aprimary; adapter does not model a 0-cap (only positive Input caps).",
  });

  // Scenario 6 baseline: plan passthrough WITHOUT override -> plain chain.
  entries.push({
    scenario: asScenario("corpus:plan-passthrough-baseline", {
      pack: corpus.planPassthrough.pack,
      targets: corpus.planPassthrough.targets,
    }),
    axes: ["chain"],
    whitelisted: true,
  });

  // Scenario 6: plan passthrough. plan:true on "mid" -> mid becomes a free
  // boundary, r_make_mid not needed. Boundary/raw-draw axis.
  entries.push({
    scenario: asScenario("corpus:plan-passthrough", corpus.planPassthrough),
    axes: ["raw-draw", "chain"],
    whitelisted: true,
    note: "plan:true makes 'mid' a free boundary (effectiveSupply=Infinity).",
  });

  // Scenario 7: __domain_transfer big-M exclusion. r_transfer is the
  // __domain_transfer recipe (big-M cost in STC; in the adapter it is forced to
  // 0-consumption via the domain_key_tundra hardcode). Both exclude it.
  entries.push({
    scenario: asScenario("corpus:domain-transfer-exclusion", corpus.domainTransferExclusion),
    axes: ["multi-producer", "raw-draw"],
    whitelisted: true,
    note: "big-M / __domain_transfer exclusion; both solvers keep r_transfer inactive.",
  });

  // Scenario 7a: cyclic SCC min-floor. 2-cycle, target inside it; STC parks a
  // deficit on target_item (softFeasible=false). cyclic-target axis.
  entries.push({
    scenario: asScenario("corpus:cyclic-scc-floor", corpus.domainTransferScc),
    axes: ["cyclic-target"],
    whitelisted: true,
    note: "2-cycle target; STC floor + deficit on target_item; GLPK non-Solved. Both -> unsatisfiable.",
  });

  // Scenario 7b: target-only flag big-M exclusion. Same exclusion shape.
  entries.push({
    scenario: asScenario("corpus:target-only-exclusion", corpus.targetOnlyFlagExclusion),
    axes: ["multi-producer", "raw-draw"],
    whitelisted: true,
    note: "target-only flag => big-M; r_targetonly stays inactive in both.",
  });

  // Scenario 7c: cost=-1 sink big-M exclusion.
  entries.push({
    scenario: asScenario("corpus:cost-minus-one-sink", corpus.costMinusOneSinkExclusion),
    axes: ["multi-producer", "raw-draw"],
    whitelisted: true,
    note: "cost=-1 sink => big-M; r_sink stays inactive in both.",
  });

  // Scenario 8: deficit / unmet demand. "missing_item" is non-raw with NO
  // producer -> exactly the no-producer shape. INCONCLUSIVE: GLPK supplies it
  // free as `unproduceable`, so a satisfiability disagreement is an
  // adapter-artifact, NOT an STC bug.
  entries.push({
    scenario: asScenario("corpus:deficit-unmet-demand", corpus.deficitUnmetDemand),
    axes: ["INCONCLUSIVE(no-producer)"],
    whitelisted: false,
    expectMismatch: {
      reason:
        "missing_item is non-raw with no producer. STC -> deficit/unsatisfiable (correct); GLPK fabricates free unproduceable supply -> satisfiable. Known adapter-artifact.",
      severity: "adapter-artifact",
    },
  });

  // Scenario 10: feasible-empty. Target recipe primary out qty=0 -> pin skipped,
  // no recipe forced, prod demand parks as deficit. STC status "empty",
  // softFeasible=false. The 0-qty primary means GLPK's item-Output objective is
  // on "prod" which only a 0-output recipe can make -> no-producer-shape for the
  // satisfiability. INCONCLUSIVE.
  entries.push({
    scenario: asScenario("corpus:feasible-empty", corpus.feasibleEmpty),
    axes: ["INCONCLUSIVE(no-producer)"],
    whitelisted: false,
    expectMismatch: {
      reason:
        "Target recipe nets 0 of its primary output (qty=0). STC skips the pin, parks prod as deficit -> empty/unsatisfiable (correct). GLPK has a net-0 producer it cannot use to meet demand -> non-Solved or free-supply edge. Degenerate no-producer-shape, INCONCLUSIVE.",
      severity: "adapter-artifact",
    },
  });

  // --- (2) Headline plan -----------------------------------------------------

  // The app's shipping default plan: defaultTargets() against the real pack.
  entries.push({
    scenario: {
      name: "headline:default-plan",
      pack: realPack,
      targets: defaultTargets(),
    },
    axes: ["chain", "multi-producer", "byproduct", "raw-draw"],
    whitelisted: true,
    note: "App default plan (copper_bottle x2, copper_powder x1/2, iron_powder x1/4) on the real AEF pack.",
  });

  // The ADAPTER-NOTES 4:1 headline: a single target on xiranite_enr_powder.
  // Documented fidelity case (single-producer-chain + multi-producer poly +
  // byproduct + raw simultaneously).
  entries.push({
    scenario: {
      name: "headline:xiranite-enr-powder",
      pack: realPack,
      targets: [{ itemId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "10" } }],
    },
    axes: ["chain", "multi-producer", "byproduct", "raw-draw"],
    whitelisted: true,
    note: "ADAPTER-NOTES 4:1 fidelity headline (xiranite_enr_powder @ 1/10/sec).",
  });

  // --- (3) Risk axes from tools/oracle/fixtures ------------------------------
  // Reuse the gate fixtures for the canonical single-axis members. no-producer
  // is the excluded INCONCLUSIVE member; the rest are the clean whitelisted
  // closed-form members (chain, multi-producer, byproduct, raw-draw,
  // cyclic-target).
  for (const f of FIXTURES) {
    const whitelisted = !f.exclude;
    entries.push({
      scenario: { ...f.scenario, name: `fixture:${f.axis}` },
      axes: whitelisted ? [f.axis] : [`INCONCLUSIVE(${f.axis})`],
      whitelisted,
      expectMismatch: f.exclude
        ? {
            reason: f.exclude.reason,
            severity: f.exclude.classification as Severity,
          }
        : undefined,
    });
  }

  return entries;
}

// Rebuild the override scenario with its STC recipeCosts threaded in (the
// adapter ignores them; only solveLp on the STC side honours them). We solve
// STC separately below so the override actually takes effect.
function multiProducerCostChoiceWithOverride(): {
  pack: RecipePack;
  targets: Target[];
} {
  return {
    pack: corpus.multiProducerCostChoiceWithOverride.pack,
    targets: corpus.multiProducerCostChoiceWithOverride.targets,
  };
}

// ---------------------------------------------------------------------------
// Run one entry: compareScenario for the classified record + separate timed
// solves for wall-clock, plus the recipeCosts-honouring STC re-solve when set.
// ---------------------------------------------------------------------------
interface RowResult {
  entry: Entry;
  record: CompareRecord;
  stcMs: number;
  glpkMs: number;
  // Severity assigned after inspecting the actual mismatch.
  severity: Severity;
  severityEvidence: string;
  unboundedTripwire: boolean;
}

function tier1Agree(r: CompareRecord): boolean {
  return r.verdictAgree && r.targetMetAgree;
}

function classifyRow(entry: Entry, r: CompareRecord): {
  severity: Severity;
  evidence: string;
} {
  const t1ok = tier1Agree(r);
  const t2miss = r.tier2Eligible && r.ratesAgree === false;

  if (t1ok && !t2miss) {
    return { severity: "none", evidence: "" };
  }

  // There IS a mismatch. If we pre-classified it as expected, honour that
  // (adapter-artifact / modeling-difference / alternate-optima) UNLESS it is a
  // Tier-2 unique-rate miss, which always escalates (it counts toward the gate).
  if (t2miss) {
    return {
      severity: "structural-formulation-flaw",
      evidence: `Tier-2 unique-rate miss: ${r.rateDiffs
        .filter((d) => !d.close)
        .map((d) => `${d.recipeId} STC=${d.stc} GLPK=${d.glpk}`)
        .join("; ")}`,
    };
  }

  // Tier-1 mismatch. Use the pre-classified caveat when present.
  const detail =
    `verdict STC=${r.stcVerdict}/GLPK=${r.glpkVerdict}` +
    `, targetMet STC=${r.stcTargetMet}/GLPK=${r.glpkTargetMet}` +
    `, activeSet STC=[${r.stcActiveSet.join(",")}]/GLPK=[${r.glpkActiveSet.join(",")}]`;
  if (entry.expectMismatch) {
    return {
      severity: entry.expectMismatch.severity,
      evidence: `${entry.expectMismatch.reason} (${detail})`,
    };
  }
  // Unexpected Tier-1 mismatch on a whitelisted axis: this is the headline
  // payload. Flag it as a structural-formulation-flaw for the report to surface;
  // the prose verdict below states plainly whether any survive.
  return {
    severity: entry.whitelisted ? "structural-formulation-flaw" : "adapter-artifact",
    evidence: `UNEXPECTED mismatch: ${detail}`,
  };
}

function runEntry(entry: Entry): RowResult {
  // Classified record from the harness (the source of truth for tiers).
  const record = compareScenario(entry.scenario);

  // Timed STC solve (compareScenario's runStc drops the wall-clock; re-time it,
  // honouring recipeCosts when the entry carries them).
  const t0 = performance.now();
  solveLp({
    targets: entry.scenario.targets,
    // Net self-consumption to match the shipped pipeline and the harness's
    // internal runStc; a no-op on the synthetic corpus packs.
    pack: netSelfConsumption(entry.scenario.pack),
    itemOverrides: entry.scenario.itemOverrides ?? [],
    recipeCosts: entry.stcRecipeCosts,
  });
  const stcMs = performance.now() - t0;

  // Timed GLPK solve.
  const g0 = performance.now();
  runGlpk(entry.scenario);
  const glpkMs = performance.now() - g0;

  const { severity, evidence } = classifyRow(entry, record);

  // Trip-wire: any unbounded verdict (mapping is UNVERIFIED).
  const unboundedTripwire =
    record.stcVerdict === "infeasible-hard" || record.glpkVerdict === "infeasible-hard"
      ? // infeasible-hard collapses both infeasible and unbounded. Re-check the
        // raw GLPK to see if the cause was unbounded specifically.
        checkUnbounded(entry.scenario)
      : false;

  return {
    entry,
    record,
    stcMs,
    glpkMs,
    severity,
    severityEvidence: evidence,
    unboundedTripwire,
  };
}

function checkUnbounded(s: Scenario): boolean {
  const g = runGlpk(s);
  const stc = runStc(s);
  return g.simplexStatus === "unbounded" || stc.status === "unbounded";
}

// ---------------------------------------------------------------------------
// Report generation.
// ---------------------------------------------------------------------------
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

function fmtMs(x: number): string {
  return x.toFixed(3);
}

function tier3Delta(r: CompareRecord): string {
  const stc = r.stcMachineEstimate;
  const glpk = r.glpkMachineTotal;
  const d = glpk - stc;
  return `STCmach~${stc.toFixed(4)} GLPKmach=${glpk.toFixed(4)} d=${d.toFixed(4)}`;
}

function buildReport(rows: RowResult[]): string {
  const total = rows.length;
  const tier1Agreements = rows.filter((r) => tier1Agree(r.record)).length;
  const inconclusive = rows.filter((r) => !r.entry.whitelisted).length;
  const flaws = rows.filter((r) => r.severity === "structural-formulation-flaw");
  const tier2Eligible = rows.filter((r) => r.record.tier2Eligible);
  const tier2Matches = tier2Eligible.filter((r) => r.record.ratesAgree === true);
  const tier2Misses = tier2Eligible.filter((r) => r.record.ratesAgree === false);
  const tripwires = rows.filter((r) => r.unboundedTripwire);

  const stcTimes = rows.map((r) => r.stcMs);
  const glpkTimes = rows.map((r) => r.glpkMs);

  const lines: string[] = [];
  lines.push("# Corpus run results (T5): STC LP solver vs FactorioLab GLPK");
  lines.push("");
  lines.push(
    "Generated by `tools/oracle/corpus-run.test.ts` via the gate-validated " +
      "three-tier harness (`compare.ts`). Whitelist from `validated-axes.json`. " +
      "HONEST: a whitelisted-axis disagreement is the prototype payload and is " +
      "reported, never fudged.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total scenarios: **${total}**`);
  lines.push(
    `- Tier-1 agreements (verdict AND target-met agree): **${tier1Agreements}/${total}**`,
  );
  lines.push(
    `- INCONCLUSIVE (no-producer-shape; GLPK free-supply adapter-artifact, not counted as findings): **${inconclusive}**`,
  );
  lines.push(
    `- Structural-formulation-flaw findings on whitelisted axes (the headline): **${flaws.length}**` +
      (flaws.length === 0
        ? " - NONE. No whitelisted-axis correctness disagreement found."
        : ` - ${flaws.map((f) => f.entry.scenario.name).join(", ")}`),
  );
  lines.push(
    `- Tier-2 eligible (structural-unique + perturbation-stable): **${tier2Eligible.length}**; ` +
      `unique-rate matches: **${tier2Matches.length}**; unique-rate misses: **${tier2Misses.length}**`,
  );
  if (tier2Matches.length > 0) {
    lines.push(
      `  - Tier-2 matched: ${tier2Matches.map((r) => r.entry.scenario.name).join(", ")}`,
    );
  }
  lines.push(
    `- Unbounded trip-wires (UNVERIFIED mapping): **${tripwires.length}**` +
      (tripwires.length === 0 ? " - none triggered." : ""),
  );
  lines.push("");
  lines.push("### Timing aggregate (per-scenario wall-clock)");
  lines.push("");
  lines.push(
    `- STC: median **${fmtMs(median(stcTimes))} ms**, range [${fmtMs(
      Math.min(...stcTimes),
    )}, ${fmtMs(Math.max(...stcTimes))}] ms`,
  );
  lines.push(
    `- GLPK: median **${fmtMs(median(glpkTimes))} ms**, range [${fmtMs(
      Math.min(...glpkTimes),
    )}, ${fmtMs(Math.max(...glpkTimes))}] ms`,
  );
  lines.push("");

  // Severity classification of every Tier-1 / Tier-2 mismatch.
  const mismatches = rows.filter((r) => r.severity !== "none");
  lines.push("## Mismatch classification");
  lines.push("");
  if (mismatches.length === 0) {
    lines.push("No Tier-1 or Tier-2 mismatches across the corpus.");
  } else {
    lines.push(
      "Severity vocabulary: `structural-formulation-flaw` | `localized-fix` | " +
        "`adapter-artifact` | `modeling-difference` | `alternate-optima`. Only a " +
        "`structural-formulation-flaw` or a Tier-2 unique-rate miss counts toward " +
        "the adopt-GLPK gate.",
    );
    lines.push("");
    for (const m of mismatches) {
      lines.push(`- **${m.entry.scenario.name}** [${m.severity}]: ${m.severityEvidence}`);
    }
  }
  lines.push("");

  // The big table.
  lines.push("## Per-scenario table");
  lines.push("");
  lines.push(
    "| scenario | axes | whitelist? | STC verdict | GLPK verdict | Tier-1 agree? | Tier-2 (eligible) | Tier-3 delta | STC ms | GLPK ms | severity |",
  );
  lines.push(
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const r of rows) {
    const rec = r.record;
    const t1 = tier1Agree(rec) ? "yes" : "**NO**";
    const t2 = !rec.tier2Eligible
      ? "n/a"
      : rec.ratesAgree
        ? "match"
        : "**MISS**";
    const wl = r.entry.whitelisted ? "yes" : "INCONCLUSIVE";
    lines.push(
      `| ${rec.name} | ${r.entry.axes.join(", ")} | ${wl} | ${rec.stcVerdict}` +
        ` (sf=${rec.stcSoftFeasible}, def=${rec.stcHasDeficit}) | ${rec.glpkVerdict}` +
        ` | ${t1} | ${t2} | ${tier3Delta(rec)} | ${fmtMs(r.stcMs)} | ${fmtMs(
          r.glpkMs,
        )} | ${r.severity} |`,
    );
  }
  lines.push("");

  // Tier-3 notable deltas: where the active sets differ (different optima).
  lines.push("## Notable Tier-3 / active-set deltas (different optima picked)");
  lines.push("");
  const diffOptima = rows.filter((r) => !r.record.activeSetAgree);
  if (diffOptima.length === 0) {
    lines.push("STC and GLPK pick the same active set on every scenario.");
  } else {
    for (const r of diffOptima) {
      lines.push(
        `- **${r.record.name}**: STC active [${r.record.stcActiveSet.join(
          ", ",
        )}] vs GLPK active [${r.record.glpkActiveSet.join(", ")}]. ${tier3Delta(
          r.record,
        )}. ${
          r.severityEvidence ||
          r.entry.expectMismatch?.reason ||
          r.entry.note ||
          ""
        }`,
      );
    }
  }
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------
describe("T5 corpus run (full scenario set through the gate-validated harness)", () => {
  const entries = buildEntries();
  const rows: RowResult[] = [];

  for (const entry of entries) {
    it(`runs ${entry.scenario.name}`, () => {
      const row = runEntry(entry);
      rows.push(row);

      // The harness must always produce a classified record.
      expect(row.record.name).toBe(entry.scenario.name);

      // Whitelisted axes MUST achieve Tier-1 agreement UNLESS a documented
      // alternate-optima / modeling-difference caveat applies. A surviving
      // structural-formulation-flaw on a whitelisted axis is a HARD failure and
      // surfaces here (this is the honest payload assertion).
      if (entry.whitelisted) {
        if (row.severity === "structural-formulation-flaw") {
          // Surface it loudly: this would be a real STC correctness finding.
          throw new Error(
            `STRUCTURAL FLAW on whitelisted axis ${entry.scenario.name}: ${row.severityEvidence}`,
          );
        }
      }

      // Trip-wire assertion: unbounded mapping is UNVERIFIED; we expect none.
      expect(row.unboundedTripwire).toBe(false);
    });
  }

  afterAll(() => {
    // Stable ordering for the report: corpus, headline, fixtures (insertion).
    const report = buildReport(rows);
    const root = path.resolve(import.meta.dirname);
    writeFileSync(path.join(root, "corpus-results.md"), report + "\n");
  });
});
