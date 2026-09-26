import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { pack } from "../../src/data/load";
import { loadPlan, type ItemOverride } from "../../src/data/plan";
import type { ItemTarget } from "../../src/data/targets";
import { solveLp, type LpResult } from "../../src/solver/lp";
import { netSelfConsumption } from "../../src/solver/net-self";
import { SCENARIOS } from "../e2e/scenarios";

// Plans whose extracted result used to carry a deficit the LP never left: a
// phantom SHORTFALL built by float noise, not by a real lack of supply.
//  - Rounded primals: the engine rounds every primal to 1e-8, and a
//    __domain_transfer column moves hundreds of units per execution, so its
//    balance rows came out a few 1e-6 off and read as a deficit.
//  - Snap: each rate was snapped on its own within a 1e-6 window onto a nearby
//    small-denominator rational, and a row whose rates legitimately carry large
//    denominators no longer closed.

const netted = netSelfConsumption(pack);

function targetsOf(id: string): ItemTarget[] {
  const scenario = SCENARIOS.find((s) => s.id === id);
  if (scenario === undefined) throw new Error(`no scenario ${id}`);
  return scenario.targets;
}

function capped(itemId: string, num: string, denom: string): ItemOverride[] {
  return [{ itemId, ratePerSec: { num, denom } }];
}

function deficitIds(r: LpResult): string[] {
  return [...r.deficit.keys()].sort();
}

describe("exact tableau primals: no phantom deficit", () => {
  it("battery5 with iron_ore capped at 48/min", () => {
    const r = solveLp({
      targets: targetsOf("battery5"),
      pack: netted,
      itemOverrides: capped("iron_ore", "48", "60"),
    });
    expect(deficitIds(r)).toEqual([]);
    expect(r.softFeasible).toBe(true);
  });

  it("multi6 with iron_ore capped at 270/min", () => {
    const r = solveLp({
      targets: targetsOf("multi6"),
      pack: netted,
      itemOverrides: capped("iron_ore", "270", "60"),
    });
    expect(deficitIds(r)).toEqual([]);
    expect(r.softFeasible).toBe(true);
  });
});

describe("exact dyadic snap: no phantom deficit", () => {
  it("copper-script43 with copper_ore capped at 604395/10000 per second", () => {
    const r = solveLp({
      targets: targetsOf("copper-script43"),
      pack: netted,
      itemOverrides: capped("copper_ore", "604395", "10000"),
    });
    expect(deficitIds(r)).toEqual([]);
    expect(r.softFeasible).toBe(true);
  });

  it("copper-script43 with copper_ore capped at 2323/min names only the real shortfall", () => {
    const r = solveLp({
      targets: targetsOf("copper-script43"),
      pack: netted,
      itemOverrides: capped("copper_ore", "2323", "60"),
    });
    expect(deficitIds(r)).toEqual(["equip_script_4_3"]);
    expect(r.softFeasible).toBe(false);
  });

  it("many-n60 with every target at 1/7 of its rate", async () => {
    const n60 =
      "#v1.H4sIAAAAAAAAA62WwW6jMBCG32XOtBtCtkl5g95W2mNVWYM9ULeO7RrTNory7hWCZsWp2hkuiMv_Mf49Mz9niKhfoX4E8qa15MyNRqd_tahzSDY4bKCAze12fGLVNPsDER6q6r7c79uyqRosTXnX3m20pnZ_uN9sNTwVkDF1lHuoH89gMx0fDNSAOtt3m09KhxgpqRjcCQpImOkPpb-koT6DH45QQwkFGPJher9cih8wSh9jXovVYb8WKofgVmB92oTeZhLzrqAmfK7CIZ9WZbnBd6vB_NB1JGqLK261utg1NSFnR0a1IRhVSgFbKaCSAnZSwG8BIJFWz1Fk44yQGDkjJFbOCImZM4Jjp8bUBD_OmkisYvgwJGAcM2crzmL-x6flPPko1d84-zZYo6JDn1WXsO9Z7fkjlNOwM5QZsrOa2SVXsaDwUS2vXnzTI0NWxQsKPGRHz6wPSXB2_pSlU5_Rcdvnn1peghjQP5PjbCp6G2xUvU42ZtZWWAA4g7QAcAJrAeDE1RIgd2En92HHcqK1Lo_LlDdOHfYKtTVM6TSNIjFzEpcAjvcjwXpKnBU2aj8ws4_-_f8ulHO9c2Nys-Nnkv9H8jxdvgAzDixAGRAAAA";
    const outcome = await loadPlan(n60, pack);
    if (outcome.kind === "error") throw new Error("n60 plan did not load");
    const targets = outcome.plan.targets.map((t) => {
      const rate = new Fraction(t.ratePerSec.num)
        .div(t.ratePerSec.denom)
        .div(7);
      return {
        ...t,
        ratePerSec: { num: rate.n.toString(), denom: rate.d.toString() },
      };
    });
    const r = solveLp({ targets, pack: netted });
    expect(deficitIds(r)).toEqual([]);
    expect(r.softFeasible).toBe(true);
  });
});
