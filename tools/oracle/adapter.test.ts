import Fraction from "fraction.js";
import { loadModule } from "glpk-ts";
import { beforeAll, describe, expect, it } from "vitest";

import { pack as rawPack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";
import { netSelfConsumption } from "../../src/solver/net-self";
import { buildAdapterInput } from "./adapter";
import { runGlpk, runStc, exactEqFracRational, type Scenario } from "./compare";

// Hand the adapter the SAME netted pack the real pipeline (src/solver/index.ts)
// solves, so the GLPK fidelity check reflects the shipped solve, not the raw
// self-consuming stoichiometry.
const pack = netSelfConsumption(rawPack);

import { SimplexService } from "~/services/simplex.service";
import { Rational } from "~/models/rational";
import { SimplexResultType } from "~/models/enum/simplex-result-type";

// glpk-ts requires its WASM module loaded before any Model is constructed.
beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

// The headline plan: a single item target on xiranite_enr_powder at
// 6/60 = 0.1 enr_powder/sec.
const headline: ItemTarget[] = [
  { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
];

describe("STC -> FactorioLab adapter", () => {
  it("solves the headline plan from the ACTUAL STC pack with non-empty steps", () => {
    const { objectives, settings, data } = buildAdapterInput({
      pack,
      targets: headline,
    });

    const result = new SimplexService().solve(objectives, settings, data, false);

    expect(result.resultType).toBe(SimplexResultType.Solved);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  // Fidelity check under the v1.4 pack.
  //
  // PREMISE UPDATED: the old fixture asserted a 4:1 liquid_xiranite_poly :
  // -purifier machine ratio. That poly/purifier route is NOT the v1.4 cost-min
  // optimum -- v1.4 added a sewage loop and the sewage-treat-export producer,
  // and the LP now takes the gas / phase-transition route
  // (gas_xiranite -> gas_xiranite_enr -> phase_trans_2 -> xiranite_enr_powder),
  // so neither poly recipe runs. Rather than hardcode a new happens-to-be ratio,
  // this asserts the fidelity the adapter exists to provide, on values derived
  // from the actual solve:
  //   1. the sole active producer of the target runs at its FORCED closed-form
  //      rate (demand / output-qty), and
  //   2. GLPK reproduces STC's solve exactly, recipe by recipe, after the units
  //      fix (FactorioLab machines / time == STC exec/sec).
  it("reproduces STC's solve on the v1.4 headline (exact per-recipe fidelity)", () => {
    const scenario: Scenario = { name: "headline", pack, targets: headline };
    const stc = runStc(scenario);
    const glpk = runGlpk(scenario);

    // Both solve and meet the target with no shortfall.
    expect(glpk.resultType).toBe(SimplexResultType.Solved);
    expect(stc.softFeasible).toBe(true);

    // Closed-form anchor: xiranite_enr_powder is produced only by
    // phase_trans_2-xiranite_enr_powder (2 per exec, time 10). Demand 1/10 /sec
    // forces exec = (1/10)/2 = 1/20 /sec, i.e. machines = 1/20 * 10 = 1/2.
    const targetProducer = "phase_trans_2-xiranite_enr_powder";
    expect(stc.rates.get(targetProducer)?.equals(new Fraction(1, 20))).toBe(true);
    expect(glpk.machinesByRecipe.get(targetProducer)?.eq(new Rational(1n, 2n))).toBe(
      true,
    );

    // Active sets agree, and every active recipe agrees exactly after the units
    // fix (machines/time == exec/sec). The stale poly route stays inactive.
    const stcActive = new Set(stc.rates.keys());
    const glpkActive = new Set(
      [...glpk.machinesByRecipe]
        .filter(([, m]) => m.nonzero())
        .map(([id]) => id),
    );
    expect([...glpkActive].sort()).toEqual([...stcActive].sort());
    for (const id of stcActive) {
      const sr = stc.rates.get(id)!;
      const gr = glpk.ratesByRecipe.get(id)!;
      expect(exactEqFracRational(sr, gr), `rate mismatch on ${id}`).toBe(true);
    }
    expect(stcActive.has("liquid_xiranite_poly")).toBe(false);
  });
});
