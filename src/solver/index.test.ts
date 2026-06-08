import { describe, expect, it, vi } from "vitest";
import { solvePlan, solvePlanWithIntermediates } from "./index";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";
import type { RecipePack } from "@aef/schema";
import type { LpResult } from "./lp";

// Force a specific LpResult.status for the infeasible/unbounded throw-arm tests.
// The LP model puts deficit+surplus slack on every finite-supply item, so the
// raw solver is always feasible for real recipe-pack data; "infeasible" and
// "unbounded" are unreachable through the public API with real packs. The flag
// overrides solveLp's status on the real entry points while every other test
// keeps using the real solver.
const lpStatusOverride = vi.hoisted(() => ({
  status: undefined as LpResult["status"] | undefined,
}));

vi.mock("./lp", async () => {
  const actual = await vi.importActual<typeof import("./lp")>("./lp");
  return {
    ...actual,
    solveLp: (input: Parameters<typeof actual.solveLp>[0]): LpResult => {
      const result = actual.solveLp(input);
      if (lpStatusOverride.status !== undefined) {
        return { ...result, status: lpStatusOverride.status };
      }
      return result;
    },
  };
});

describe("solvePlanWithIntermediates (LP)", () => {
  it("includes both purifier producers in the rate map", () => {
    const targets: Target[] = [
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
    );
    expect(full.rates.get("liquid_xiranite_poly")).toBeDefined();
    expect(full.rates.get("liquid_xiranite_poly-purifier")).toBeDefined();
    expect(full.logical.nodes.length).toBeGreaterThan(0);
  });
});

describe("solver status handling", () => {
  // (b) Empty-but-feasible: a non-empty targets input whose optimum runs zero
  // recipes. The "zero_out" recipe has a primary output qty of 0, so solveLp
  // skips the target pin, demand for "prod" becomes pure deficit, and no
  // x_recipe runs positive, giving status "empty" with empty rates.
  // Must not throw: an empty-but-feasible optimum is a legitimate result.
  const emptyFeasiblePack = {
    recipes: [
      {
        id: "zero_out",
        category: "material",
        time: 1,
        in: [{ item: "raw_a", qty: 1 }],
        out: [{ item: "prod", qty: 0 }],
      },
    ],
    machines: [],
    items: [
      { id: "raw_a", raw: true },
      { id: "prod", raw: false },
    ],
  } as unknown as RecipePack;
  const emptyFeasibleTargets: Target[] = [
    { recipeId: "zero_out", ratePerSec: { num: "1", denom: "1" } },
  ];

  it("does not throw on an empty-but-feasible optimum (solvePlanWithIntermediates)", () => {
    const full = solvePlanWithIntermediates(
      emptyFeasibleTargets,
      emptyFeasiblePack,
      defaultTransportConfig,
    );
    expect(full.rates.size).toBe(0);
    expect(full.logical.nodes.length).toBe(0);
  });

  it("does not throw on an empty-but-feasible optimum (solvePlan)", () => {
    const logical = solvePlan(
      emptyFeasibleTargets,
      emptyFeasiblePack,
      defaultTransportConfig,
    );
    expect(logical.nodes.length).toBe(0);
  });

  // (a) Infeasible: status "infeasible" is unreachable through the public API
  // with real packs (universal slack, see the override note above), so the flag
  // forces solveLp's status. Both entry points must surface it as a throw whose
  // message matches /infeasible/.
  const targets: Target[] = [
    { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
  ];

  it("throws on infeasible status (both entry points)", () => {
    lpStatusOverride.status = "infeasible";
    try {
      expect(() =>
        solvePlanWithIntermediates(targets, pack, defaultTransportConfig),
      ).toThrow(/infeasible/);
      expect(() =>
        solvePlan(targets, pack, defaultTransportConfig),
      ).toThrow(/infeasible/);
    } finally {
      lpStatusOverride.status = undefined;
    }
  });
});
