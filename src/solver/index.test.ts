import { describe, expect, it } from "vitest";
import { solvePlanWithIntermediates } from "./index";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { Target } from "../data/targets";

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
