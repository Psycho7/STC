// T4 Phase-0 validity gate.
//
// For EACH gate fixture, assert STC's result matches its declared closed-form
// expected answer AND GLPK's result matches the expected answer -- NOT merely
// that the two solvers agree (agreeing on a wrong problem must not pass). Plus
// mass-balance + target-satisfiability on the unique members and the expected
// verdict on the infeasible members.
//
// An axis whose STC result diverges from closed-form truth is a CORRECTNESS
// FINDING and is EXCLUDED from the whitelist with a reason. The gate "passes"
// when every axis is either validated-against-truth OR explicitly excluded;
// it does NOT require all axes to agree.
//
// Emits tools/oracle/validated-axes.json (the whitelist consumed by T5/T7).

import { writeFileSync } from "node:fs";
import path from "node:path";

import Fraction from "fraction.js";
import { loadModule } from "glpk-ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Rational } from "~/models/rational";
import {
  compareScenario,
  exactEqFracRational,
  rateClose,
  runGlpk,
  runStc,
  stcTargetMet,
  type Verdict,
} from "./compare";
import { FIXTURES, UNBOUNDED_CONSTRUCTIBLE, type Fixture } from "./fixtures";

beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

interface AxisOutcome {
  axis: string;
  validated: boolean;
  excludedReason?: string;
  classification?: string;
  expectedVerdict: Verdict;
  stcVerdict: Verdict;
  glpkVerdict: Verdict;
}

const outcomes: AxisOutcome[] = [];

// STC mass balance per item, computed from the solved rates (exec/sec, per-exec
// stoich). Returns true when, for every NON-raw NON-deficit item, net produced
// = consumed + targetDemand - surplus (i.e. the balance closes). Raw items are
// boundary supplies (exempt). This is the closed-form mass-balance check used on
// the unique members.
function stcMassBalanceCloses(f: Fixture): boolean {
  const stc = runStc(f.scenario);
  const raw = new Set(
    f.scenario.pack.items.filter((i) => i.raw).map((i) => i.id),
  );
  // demand per item from targets (targets are item-shaped: {itemId, rate}).
  const demand = new Map<string, number>();
  const recipeById = new Map(
    f.scenario.pack.recipes.map((r) => [r.id, r]),
  );
  for (const t of f.scenario.targets) {
    const rate = Number(t.ratePerSec.num) / Number(t.ratePerSec.denom);
    demand.set(t.itemId, (demand.get(t.itemId) ?? 0) + rate);
  }
  for (const it of f.scenario.pack.items) {
    if (raw.has(it.id)) continue;
    if (stc.deficit.has(it.id)) continue; // unsatisfiable item, not balanced
    let net = 0;
    for (const [rid, rate] of stc.rates) {
      const r = recipeById.get(rid)!;
      const out = r.out.find((o) => o.item === it.id)?.qty ?? 0;
      const inn = r.in.find((i) => i.item === it.id)?.qty ?? 0;
      net += (out - inn) * rate.valueOf();
    }
    const surplus = stc.surplus.get(it.id)?.valueOf() ?? 0;
    const want = demand.get(it.id) ?? 0;
    // net production must equal target demand + surplus dumped.
    if (Math.abs(net - (want + surplus)) > 1e-9) return false;
  }
  return true;
}

describe("Phase-0 validity gate (STC and GLPK each vs closed-form truth)", () => {
  for (const f of FIXTURES) {
    describe(`axis: ${f.axis}`, () => {
      if (!f.exclude) {
        // VALIDATED axis: both solvers must match the declared closed-form truth.
        it("STC matches the expected verdict + target-met", () => {
          const stc = runStc(f.scenario);
          const r = compareScenario(f.scenario);
          expect(r.stcVerdict).toBe(f.expected.verdict);
          expect(stcTargetMet(stc)).toBe(f.expected.targetMet);
        });

        it("GLPK matches the expected verdict + target-met", () => {
          const r = compareScenario(f.scenario);
          expect(r.glpkVerdict).toBe(f.expected.verdict);
          expect(r.glpkTargetMet).toBe(f.expected.targetMet);
        });

        if (f.expected.deficitItems) {
          it("STC parks the expected items in deficit", () => {
            const stc = runStc(f.scenario);
            for (const item of f.expected.deficitItems!) {
              expect(stc.deficit.has(item)).toBe(true);
            }
          });
        }

        if (f.expected.unique && f.expected.rates) {
          it("STC + GLPK rates match the closed-form (units fix #2)", () => {
            const stc = runStc(f.scenario);
            const glpk = runGlpk(f.scenario);
            for (const er of f.expected.rates!) {
              const expFrac = new Fraction(er.num, er.den);
              // STC exec/sec.
              const stcRate = stc.rates.get(er.recipeId);
              expect(stcRate, `STC rate for ${er.recipeId}`).toBeDefined();
              expect(
                exactEqFracRational(
                  stcRate!,
                  new Rational(BigInt(er.num), BigInt(er.den)),
                ),
              ).toBe(true);
              // FactorioLab machines = exec/sec * time.
              const machines = glpk.machinesByRecipe.get(er.recipeId);
              expect(machines, `GLPK machines for ${er.recipeId}`).toBeDefined();
              expect(
                machines!.eq(new Rational(BigInt(er.machinesNum), BigInt(er.machinesDen))),
              ).toBe(true);
              // exec/sec equality after the units fix.
              const glpkRate = glpk.ratesByRecipe.get(er.recipeId)!;
              expect(rateClose(expFrac, glpkRate)).toBe(true);
            }
          });

          it("active set agrees with the closed-form forced subgraph", () => {
            const r = compareScenario(f.scenario);
            expect(r.stcActiveSet).toEqual(f.expected.activeSet!.slice().sort());
            expect(r.glpkActiveSet).toEqual(f.expected.activeSet!.slice().sort());
          });

          it("Tier-2 eligible (structural unique + perturbation stable)", () => {
            const r = compareScenario(f.scenario);
            expect(r.tier2Eligible).toBe(true);
            expect(r.ratesAgree).toBe(true);
          });

          it("STC mass balance closes", () => {
            expect(stcMassBalanceCloses(f)).toBe(true);
          });
        }

        if (f.expected.surplus) {
          it("GLPK dumps the expected byproduct as surplus", () => {
            const glpk = runGlpk(f.scenario);
            for (const exp of f.expected.surplus!) {
              const s = glpk.surplus.get(exp.itemId);
              expect(s, `surplus for ${exp.itemId}`).toBeDefined();
              expect(s!.eq(new Rational(BigInt(exp.num), BigInt(exp.den)))).toBe(
                true,
              );
            }
          });
        }

        if (!f.expected.unique && f.expected.verdict === "satisfiable") {
          it("structural uniqueness correctly reports NOT unique (demoted)", () => {
            const r = compareScenario(f.scenario);
            expect(r.uniqueness.unique).toBe(false);
            expect(r.tier2Eligible).toBe(false);
          });
        }

        afterAll(() => {
          const r = compareScenario(f.scenario);
          outcomes.push({
            axis: f.axis,
            validated: true,
            expectedVerdict: f.expected.verdict,
            stcVerdict: r.stcVerdict,
            glpkVerdict: r.glpkVerdict,
          });
        });
      } else {
        // EXCLUDED axis: STC must still match the closed-form truth (that is the
        // honest payload), and the divergence the exclusion describes must be
        // real (the two solvers DISAGREE). We do NOT force agreement.
        it("STC matches the closed-form truth (divergence is on the GLPK side)", () => {
          const stc = runStc(f.scenario);
          const r = compareScenario(f.scenario);
          expect(r.stcVerdict).toBe(f.expected.verdict);
          expect(stcTargetMet(stc)).toBe(f.expected.targetMet);
        });

        it("the documented divergence is real (solvers disagree)", () => {
          const r = compareScenario(f.scenario);
          expect(r.verdictAgree).toBe(false);
        });

        afterAll(() => {
          const r = compareScenario(f.scenario);
          outcomes.push({
            axis: f.axis,
            validated: false,
            excludedReason: f.exclude!.reason,
            classification: f.exclude!.classification,
            expectedVerdict: f.expected.verdict,
            stcVerdict: r.stcVerdict,
            glpkVerdict: r.glpkVerdict,
          });
        });
      }
    });
  }

  it("unbounded axis (axis 7) is documented as NOT constructible -> mapping UNVERIFIED", () => {
    // The construction was attempted and proven impossible in this model (no
    // negative-cost variable exists for either solver). Recorded, not skipped.
    expect(UNBOUNDED_CONSTRUCTIBLE).toBe(false);
  });
});

afterAll(() => {
  // Emit the whitelist artifact: axes validated against closed-form truth, plus
  // explicit exclusions with reason + classification. Consumed by T5/T7.
  const validatedAxes = outcomes
    .filter((o) => o.validated)
    .map((o) => o.axis)
    .sort();
  const excluded = outcomes
    .filter((o) => !o.validated)
    .map((o) => ({
      axis: o.axis,
      reason: o.excludedReason,
      classification: o.classification,
      expectedVerdict: o.expectedVerdict,
      stcVerdict: o.stcVerdict,
      glpkVerdict: o.glpkVerdict,
    }));

  const artifact = {
    generatedBy: "tools/oracle/gate.test.ts",
    note: "Axes validated against CLOSED-FORM truth (both STC and GLPK match) are whitelisted. Excluded axes diverged from truth on one solver; reason + severity classification recorded. unboundedConstructible=false: the unbounded status mapping is UNVERIFIED (see STATUS-MAP.md).",
    unboundedConstructible: UNBOUNDED_CONSTRUCTIBLE,
    validatedAxes,
    excluded,
  };

  const root = path.resolve(import.meta.dirname);
  writeFileSync(
    path.join(root, "validated-axes.json"),
    JSON.stringify(artifact, null, 2) + "\n",
  );
});
