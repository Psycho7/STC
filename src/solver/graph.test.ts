import { describe, expect, it } from "vitest";
import { buildRecipeGraphMulti } from "./graph";
import { pack } from "../data/load";
import type { Target } from "../data/targets";

describe("buildRecipeGraphMulti", () => {
  it("enumerates all producers of a multi-produced item as incoming edges", () => {
    // xiranite_enr_powder consumes liquid_xiranite_poly, which is produced by
    // both liquid_xiranite_poly and liquid_xiranite_poly-purifier.
    const targets: Target[] = [
      { recipeId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);

    const incomingToEnr = g.incoming.get("xiranite_enr_powder") ?? [];
    const polyProducers = incomingToEnr
      .filter((e) => e.item === "liquid_xiranite_poly")
      .map((e) => e.source)
      .sort();

    expect(polyProducers).toContain("liquid_xiranite_poly");
    expect(polyProducers).toContain("liquid_xiranite_poly-purifier");
  });
});
