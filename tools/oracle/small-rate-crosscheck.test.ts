// Decisive cross-check for the 19 small-rate Tier-1 disagreements found by
// real-pack-sweep: STC says unsatisfiable at 1/1000, GLPK says satisfiable.
// If GLPK's solution is exactly feasible under STC's own netted stoichiometry
// (every non-raw item's net flow covers demand, in exact rational arithmetic),
// then STC's verdict is a genuine false negative, not a GLPK artifact.

import Fraction from "fraction.js";
import { loadModule } from "glpk-ts";
import { beforeAll, describe, expect, it } from "vitest";

import { pack as realPack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";
import { runGlpk, nettedScenario, type Scenario } from "./compare";

beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

const ITEMS = [
  "carbon_enr",
  "carbon_enr_powder",
  "crystal_enr",
  "crystal_enr_powder",
  "equip_script_4",
  "glass_enr_bottle",
  "glass_enr_cmpt",
  "iron_enr",
  "iron_enr_bottle",
  "iron_enr_cmpt",
  "iron_enr_powder",
  "jinlong_coupon",
  "originium_enr_powder",
  "plant_moss_enr_powder_1",
  "plant_moss_enr_powder_2",
  "plant_moss_powder_3",
  "quartz_enr",
  "quartz_enr_powder",
  "tundra_coupon",
];

describe("small-rate disagreement cross-check (exact feasibility of GLPK solution)", () => {
  for (const itemId of ITEMS) {
    it(`${itemId}@1/1000: GLPK solution is exactly feasible under STC stoich`, () => {
      const targets: ItemTarget[] = [
        { itemId, ratePerSec: { num: "1", denom: "1000" } },
      ];
      const scenario: Scenario = {
        name: `xcheck:${itemId}`,
        pack: realPack,
        targets,
      };
      const ns = nettedScenario(scenario);
      const glpk = runGlpk(ns);

      // Exact exec/sec per recipe from GLPK rationals.
      const rate = new Map<string, Fraction>();
      for (const [rid, r] of glpk.ratesByRecipe) {
        rate.set(rid, new Fraction(r.p, r.q));
      }

      const rawById = new Map(
        ns.pack.items.map((i: { id: string; raw: boolean }): [string, boolean] => [
          i.id,
          i.raw,
        ]),
      );
      const net = new Map<string, Fraction>();
      const add = (id: string, f: Fraction) =>
        net.set(id, (net.get(id) ?? new Fraction(0)).add(f));

      for (const rec of ns.pack.recipes) {
        const x = rate.get(rec.id);
        if (x === undefined || x.equals(0)) continue;
        for (const out of rec.out) add(out.item, x.mul(out.qty));
        for (const inp of rec.in) add(inp.item, x.mul(inp.qty).neg());
      }

      const demand = new Fraction(1, 1000);
      const violations: string[] = [];
      for (const [id, f] of net) {
        if (rawById.get(id) === true) continue; // free boundary draw
        const needed = id === itemId ? demand : new Fraction(0);
        if (f.compare(needed) < 0) {
          violations.push(`${id}: net=${f.toFraction()} < ${needed.toFraction()}`);
        }
      }
      // The target may not appear in `net` at all if GLPK met it with free
      // supply of a no-producer input; that would be an artifact, so require
      // the target row explicitly.
      if (!net.has(itemId)) violations.push(`${itemId}: no net flow at all`);

      expect(glpk.resultType).toBe("solved");
      expect(violations).toEqual([]);
    });
  }
});
