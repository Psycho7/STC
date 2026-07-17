// Golden regression oracle for the LP solver topology corpus.
//
// Goldens (objectiveValue + activeRecipes) were captured from solveLp output on
// each fixture. They pin known-good behavior so any solver regression trips.
//
// objectiveValue uses a 1e-9 relative tolerance
// (Math.abs(actual - expected) / Math.max(1, |expected|) < 1e-9), which avoids
// float-noise flakiness and is tighter than the solver's own 1e-6 simplify
// threshold.
//
// The active set compares Array.from(activeRecipeSet(result)).sort() as a sorted
// string array (exact equality), so any change in which recipes run trips a
// golden.

import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { solveLp } from "./lp";
import { activeRecipeSet } from "./optimality";
import { checkMassBalance, checkTargetsMet } from "./invariants";
import {
  acyclicSingleProducer,
  acyclicSingleProducerGolden,
  multiProducerCostChoice,
  multiProducerCostChoiceGolden,
  multiProducerCostChoiceWithOverride,
  multiProducerCostChoiceWithOverrideGolden,
  equalCostTieBreak,
  equalCostTieBreakGolden,
  byproductSurplus,
  byproductSurplusGolden,
  finiteCapForcingFallback,
  finiteCapForcingFallbackBaseline,
  finiteCapForcingFallbackGolden,
  planPassthrough,
  planPassthroughBaseline,
  planPassthroughGolden,
  domainTransferExclusion,
  domainTransferExclusionGolden,
  domainTransferScc,
  domainTransferSccGolden,
  targetOnlyFlagExclusion,
  targetOnlyFlagExclusionGolden,
  costMinusOneSinkExclusion,
  costMinusOneSinkExclusionGolden,
  deficitUnmetDemand,
  deficitUnmetDemandGolden,
  feasibleEmpty,
  feasibleEmptyGolden,
  producerChoiceByCost,
  producerChoiceByCostGolden,
  byproductOnlyTarget,
  byproductOnlyTargetGolden,
  rawItemTargetViaMiner,
  rawItemTargetViaMinerGolden,
  freeBoundaryTarget,
  freeBoundaryTargetGolden,
  freeBoundaryTargetWithMiner,
  freeBoundaryTargetWithMinerGolden,
} from "./corpus";

// Relative tolerance for objectiveValue; tighter than the 1e-6
// Fraction.simplify threshold in lp.ts.
const OBJ_TOL = 1e-9;

function assertObjective(actual: number, expected: number): void {
  const scale = Math.max(1, Math.abs(expected));
  expect(Math.abs(actual - expected) / scale).toBeLessThan(OBJ_TOL);
}

function activeList(result: ReturnType<typeof solveLp>): string[] {
  return Array.from(activeRecipeSet(result)).sort();
}

// ---------------------------------------------------------------------------
// Scenario 1: acyclic single producer
// ---------------------------------------------------------------------------
describe("Scenario 1: acyclic single producer", () => {
  it("runs exactly the linear chain and hits the expected objective", () => {
    const result = solveLp({
      targets: acyclicSingleProducer.targets,
      pack: acyclicSingleProducer.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, acyclicSingleProducerGolden.objectiveValue);
    // Both chain members must run; no alternative exists for either item.
    expect(activeList(result)).toEqual(acyclicSingleProducerGolden.activeRecipes);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: multi-producer cost choice
// ---------------------------------------------------------------------------
describe("Scenario 2: multi-producer cost choice", () => {
  it("selects the cheaper producer and excludes the pricey one", () => {
    const result = solveLp({
      targets: multiProducerCostChoice.targets,
      pack: multiProducerCostChoice.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, multiProducerCostChoiceGolden.objectiveValue);
    // "cheap" wins; "pricey" must stay inactive.
    expect(activeList(result)).toEqual(multiProducerCostChoiceGolden.activeRecipes);
    expect(activeList(result)).not.toContain("pricey");
  });

  it("flips the winner when a recipeCosts override makes cheap expensive", () => {
    const result = solveLp({
      targets: multiProducerCostChoiceWithOverride.targets,
      pack: multiProducerCostChoiceWithOverride.pack,
      recipeCosts: multiProducerCostChoiceWithOverride.recipeCosts,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, multiProducerCostChoiceWithOverrideGolden.objectiveValue);
    // Override forces "pricey" active; "cheap" must stay inactive.
    expect(activeList(result)).toEqual(multiProducerCostChoiceWithOverrideGolden.activeRecipes);
    expect(activeList(result)).not.toContain("cheap");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: equal-cost tie-break
// ---------------------------------------------------------------------------
describe("Scenario 3: equal-cost tie-break", () => {
  it("picks the lexicographically smaller recipe id in the tie-break pass", () => {
    const result = solveLp({
      targets: equalCostTieBreak.targets,
      pack: equalCostTieBreak.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, equalCostTieBreakGolden.objectiveValue);
    // "aaa_producer" wins (lex rank 0); "zzz_producer" stays inactive.
    expect(activeList(result)).toEqual(equalCostTieBreakGolden.activeRecipes);
    expect(activeList(result)).not.toContain("zzz_producer");
  });

  it("is repeatable: same scenario solved twice yields identical goldens", () => {
    // Run-to-run repeatability, not input-order invariance (lp.test.ts covers
    // the latter by shuffling the recipe/item arrays). equalCostTieBreak
    // exercises the two-pass lex tie-break (pass 2 minimizes recipe-id rank);
    // a non-deterministic sort or LP tie-break would flip aaa_producer /
    // zzz_producer across runs. acyclicSingleProducer has no tie-break
    // ambiguity, so it cannot detect that.
    const r1 = solveLp({ targets: equalCostTieBreak.targets, pack: equalCostTieBreak.pack });
    const r2 = solveLp({ targets: equalCostTieBreak.targets, pack: equalCostTieBreak.pack });
    assertObjective(r1.objectiveValue, r2.objectiveValue);
    expect(activeList(r1)).toEqual(activeList(r2));
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: byproduct surplus
// ---------------------------------------------------------------------------
describe("Scenario 4: byproduct surplus", () => {
  it("accumulates surplus on the excess byproduct and accounts for it in the objective", () => {
    const result = solveLp({
      targets: byproductSurplus.targets,
      pack: byproductSurplus.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    // Objective = 2 recipe runs (cost 1 each) + surplus(byp)=1 * 1e-3 = 2.001.
    assertObjective(result.objectiveValue, byproductSurplusGolden.objectiveValue);
    expect(activeList(result)).toEqual(byproductSurplusGolden.activeRecipes);
    // "byp" surplus = 1: r_main emits 2, r_finalize consumes 1, leaving 1 over.
    expect(result.surplus.has("byp")).toBe(true);
    const bypSurplus = result.surplus.get("byp")!;
    expect(Math.abs(bypSurplus.valueOf() - byproductSurplusGolden.surplusByp)).toBeLessThan(1e-9);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: finite cap forces fallback producer
// ---------------------------------------------------------------------------
describe("Scenario 5: finite cap forces fallback", () => {
  it("baseline picks a_primary via lex tie-break", () => {
    const result = solveLp({
      targets: finiteCapForcingFallback.targets,
      pack: finiteCapForcingFallback.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, finiteCapForcingFallbackBaseline.objectiveValue);
    expect(activeList(result)).toEqual(finiteCapForcingFallbackBaseline.activeRecipes);
  });

  it("cap on raw_aprimary=0 forces z_fallback to cover all demand", () => {
    // Baseline (no cap): lex tie-break picks a_primary; z_fallback stays inactive.
    // With cap: a_primary is blocked at 0; z_fallback covers all demand.
    // The companion assertion below makes the cap's binding self-evident.
    const uncapped = solveLp({
      targets: finiteCapForcingFallback.targets,
      pack: finiteCapForcingFallback.pack,
    });
    expect(activeList(uncapped)).not.toContain("z_fallback");

    const result = solveLp({
      targets: finiteCapForcingFallback.targets,
      pack: finiteCapForcingFallback.pack,
      itemOverrides: finiteCapForcingFallback.itemOverrides,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, finiteCapForcingFallbackGolden.objectiveValue);
    // a_primary must be inactive; z_fallback is the active fallback.
    expect(activeList(result)).toEqual(finiteCapForcingFallbackGolden.activeRecipes);
    expect(activeList(result)).not.toContain("a_primary");
    expect(activeList(result)).toContain("z_fallback");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: plan passthrough
// ---------------------------------------------------------------------------
describe("Scenario 6: plan passthrough", () => {
  it("baseline activates r_make_mid to supply the intermediate", () => {
    const result = solveLp({
      targets: planPassthrough.targets,
      pack: planPassthrough.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, planPassthroughBaseline.objectiveValue);
    expect(activeList(result)).toEqual(planPassthroughBaseline.activeRecipes);
    expect(activeList(result)).toContain("r_make_mid");
  });

  it("plan:true on mid makes it a boundary so r_make_mid is NOT active", () => {
    const result = solveLp({
      targets: planPassthrough.targets,
      pack: planPassthrough.pack,
      itemOverrides: planPassthrough.itemOverrides,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, planPassthroughGolden.objectiveValue);
    expect(activeList(result)).toEqual(planPassthroughGolden.activeRecipes);
    // r_make_mid must NOT run: "mid" is supplied at the boundary.
    expect(activeList(result)).not.toContain("r_make_mid");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: big-M exclusion (__domain_transfer, target-only, cost=-1)
// ---------------------------------------------------------------------------
describe("Scenario 7: big-M cost signals exclude synthetic recipes", () => {
  it("__domain_transfer recipe stays inactive when a normal recipe covers the target", () => {
    const result = solveLp({
      targets: domainTransferExclusion.targets,
      pack: domainTransferExclusion.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, domainTransferExclusionGolden.objectiveValue);
    // r_normal (cost 1) satisfies the target; r_transfer (cost 1e6) must not run.
    expect(activeList(result)).toEqual(domainTransferExclusionGolden.activeRecipes);
    expect(activeList(result)).not.toContain("r_transfer");
  });

  it("target-only flagged recipe stays inactive when a normal recipe covers the target", () => {
    const result = solveLp({
      targets: targetOnlyFlagExclusion.targets,
      pack: targetOnlyFlagExclusion.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, targetOnlyFlagExclusionGolden.objectiveValue);
    // r_targetonly (cost 1e6) must not run.
    expect(activeList(result)).toEqual(targetOnlyFlagExclusionGolden.activeRecipes);
    expect(activeList(result)).not.toContain("r_targetonly");
  });

  it("cost=-1 sink recipe stays inactive when a normal recipe covers the target", () => {
    const result = solveLp({
      targets: costMinusOneSinkExclusion.targets,
      pack: costMinusOneSinkExclusion.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, costMinusOneSinkExclusionGolden.objectiveValue);
    // r_sink (cost 1e6) must not run.
    expect(activeList(result)).toEqual(costMinusOneSinkExclusionGolden.activeRecipes);
    expect(activeList(result)).not.toContain("r_sink");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7a: cyclic SCC -- net-export contract
// ---------------------------------------------------------------------------
describe("Scenario 7a: cyclic SCC -- net-export contract", () => {
  it("reports the unmeetable cyclic demand as a deficit on the demanded item", () => {
    const result = solveLp({
      targets: domainTransferScc.targets,
      pack: domainTransferScc.pack,
    });

    expect(result.status).toBe(domainTransferSccGolden.status);
    expect(result.softFeasible).toBe(domainTransferSccGolden.softFeasible);
    assertObjective(result.objectiveValue, domainTransferSccGolden.objectiveValue);
    // The cycle recycles its own output, so it cannot create net export;
    // running it would only add recipe cost. Nothing runs.
    expect(activeList(result)).toEqual(domainTransferSccGolden.activeRecipes);
    // Deficit on target_item because the cycle cannot resolve the demand.
    expect(result.deficit.has(domainTransferSccGolden.deficitItem)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: deficit (unmet demand)
// ---------------------------------------------------------------------------
describe("Scenario 8: deficit (unmet demand)", () => {
  it("reports softFeasible=false with the deficit on the demanded item", () => {
    const result = solveLp({
      targets: deficitUnmetDemand.targets,
      pack: deficitUnmetDemand.pack,
    });

    // Universal slack keeps the raw solver feasible even though demand is
    // unmet; the flat-edge junk vertex keeps r_target at a positive rate.
    expect(result.status).toBe(deficitUnmetDemandGolden.status);
    // The deficit var survives the >1e-12 filter.
    expect(result.softFeasible).toBe(deficitUnmetDemandGolden.softFeasible);
    // Deficit objective: 1e9 * 1 unit total, however the edge splits it.
    assertObjective(result.objectiveValue, deficitUnmetDemandGolden.objectiveValue);
    expect(activeList(result)).toEqual(deficitUnmetDemandGolden.activeRecipes);
    // The demanded item carries the bulk of the deficit, and the reported
    // split covers the demand exactly.
    expect(result.deficit.has(deficitUnmetDemandGolden.deficitItem)).toBe(true);
    const total = [...result.deficit.values()].reduce(
      (acc, v) => acc + v.valueOf(),
      0,
    );
    expect(total).toBeCloseTo(1, 9);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: feasible-empty (zero output qty skips target pin)
// ---------------------------------------------------------------------------
describe("Scenario 10: feasible-empty", () => {
  it("returns status empty and an empty rates map when primary output qty is 0", () => {
    const result = solveLp({
      targets: feasibleEmpty.targets,
      pack: feasibleEmpty.pack,
    });

    // The only producer of "prod" emits qty 0, so no rate creates net output;
    // the LP optimum is 0 runs, so status is "empty" and rates.size === 0.
    expect(result.status).toBe(feasibleEmptyGolden.status);
    expect(result.softFeasible).toBe(feasibleEmptyGolden.softFeasible);
    expect(result.rates.size).toBe(0);
    expect(activeList(result)).toEqual(feasibleEmptyGolden.activeRecipes);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: producer choice by cost
// ---------------------------------------------------------------------------
describe("Scenario 11: producer choice by cost", () => {
  it("picks the cheaper producer even though its id sorts last (cost, not lex)", () => {
    const result = solveLp({
      targets: producerChoiceByCost.targets,
      pack: producerChoiceByCost.pack,
      recipeCosts: producerChoiceByCost.recipeCosts,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, producerChoiceByCostGolden.objectiveValue);
    // z_cheap (cost 2) wins over a_pricey (cost 5, lex rank 0). A lex-only
    // tie-break would have picked a_pricey; cost drives the choice.
    expect(activeList(result)).toEqual(producerChoiceByCostGolden.activeRecipes);
    expect(activeList(result)).not.toContain("a_pricey");
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: byproduct-only item target
// ---------------------------------------------------------------------------
describe("Scenario 12: byproduct-only item target", () => {
  it("meets a byproduct target via co-production and surpluses the primary", () => {
    const result = solveLp({
      targets: byproductOnlyTarget.targets,
      pack: byproductOnlyTarget.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    // Objective = 1 recipe run + 1e-3 * surplus(primary)=1 = 1.001.
    assertObjective(result.objectiveValue, byproductOnlyTargetGolden.objectiveValue);
    expect(activeList(result)).toEqual(byproductOnlyTargetGolden.activeRecipes);
    // The unconsumed primary co-product lands in free-disposal surplus.
    expect(result.surplus.has("primary")).toBe(true);
    const primarySurplus = result.surplus.get("primary")!;
    expect(
      Math.abs(primarySurplus.valueOf() - byproductOnlyTargetGolden.surplusPrimary),
    ).toBeLessThan(1e-9);
    // The targeted byproduct is fully consumed as net export: no surplus, no deficit.
    expect(result.deficit.has("byp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: raw item target via a miner recipe (miner runs)
// ---------------------------------------------------------------------------
describe("Scenario 13: raw item target via a miner recipe", () => {
  it("runs the miner to net-export a non-boundary ore at the declared rate", () => {
    const result = solveLp({
      targets: rawItemTargetViaMiner.targets,
      pack: rawItemTargetViaMiner.pack,
    });

    expect(result.status).toBe("feasible");
    expect(result.softFeasible).toBe(true);
    assertObjective(result.objectiveValue, rawItemTargetViaMinerGolden.objectiveValue);
    expect(activeList(result)).toEqual(rawItemTargetViaMinerGolden.activeRecipes);
    // Non-raw ore is not boundary-drawable: no draw, no deficit; the miner runs.
    expect(result.draws.has("ore")).toBe(false);
    expect(result.deficit.size).toBe(0);
    expect(result.rates.get("r_miner")!.equals(new Fraction(1))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14: free-boundary item target met by boundary draw
// ---------------------------------------------------------------------------
describe("Scenario 14: free-boundary item target", () => {
  it("meets a raw:true target via boundary draw with nothing running", () => {
    const result = solveLp({
      targets: freeBoundaryTarget.targets,
      pack: freeBoundaryTarget.pack,
    });

    // Nothing runs -> status empty; demand is met by the free boundary draw, so
    // the solve is soft-feasible with no deficit.
    expect(result.status).toBe(freeBoundaryTargetGolden.status);
    expect(result.softFeasible).toBe(freeBoundaryTargetGolden.softFeasible);
    assertObjective(result.objectiveValue, freeBoundaryTargetGolden.objectiveValue);
    expect(activeList(result)).toEqual(freeBoundaryTargetGolden.activeRecipes);
    // The boundary draw covers the full declared rate.
    expect(result.draws.has("ore")).toBe(true);
    expect(result.draws.get("ore")!.equals(new Fraction(freeBoundaryTargetGolden.drawOre))).toBe(true);
    expect(result.deficit.size).toBe(0);
    // The checkers agree: demand met, mass balance holds.
    expect(checkTargetsMet(result, freeBoundaryTarget.targets).violations).toEqual([]);
    expect(
      checkMassBalance(result, freeBoundaryTarget.pack, freeBoundaryTarget.targets, []).violations,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 15: free-boundary target with a costly miner (draw wins)
// ---------------------------------------------------------------------------
describe("Scenario 15: free-boundary target prefers the free draw over a miner", () => {
  it("keeps the miner idle and meets the raw:true target via boundary draw", () => {
    const result = solveLp({
      targets: freeBoundaryTargetWithMiner.targets,
      pack: freeBoundaryTargetWithMiner.pack,
    });

    expect(result.status).toBe(freeBoundaryTargetWithMinerGolden.status);
    expect(result.softFeasible).toBe(freeBoundaryTargetWithMinerGolden.softFeasible);
    assertObjective(result.objectiveValue, freeBoundaryTargetWithMinerGolden.objectiveValue);
    expect(activeList(result)).toEqual(freeBoundaryTargetWithMinerGolden.activeRecipes);
    // The free draw (cost 0) beats the miner (cost 1): the miner stays idle.
    expect(activeList(result)).not.toContain("r_mine");
    expect(result.draws.has("ore")).toBe(true);
    expect(
      result.draws.get("ore")!.equals(new Fraction(freeBoundaryTargetWithMinerGolden.drawOre)),
    ).toBe(true);
    expect(result.deficit.size).toBe(0);
  });
});
