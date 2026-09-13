import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import { buildRecipeGraphMulti, augmentGraphWithLpSupport } from "./graph";
import { pack } from "../data/load";
import { isExcludedProducer } from "../data/recipe-category";
import type { ItemTarget } from "../data/targets";
import type { RecipeId } from "./types";

describe("buildRecipeGraphMulti", () => {
  it("enumerates all producers of a multi-produced item as incoming edges", () => {
    // xiranite_enr_powder consumes liquid_xiranite_poly, which is produced by
    // both liquid_xiranite_poly and liquid_xiranite_poly-purifier.
    const targets: ItemTarget[] = [
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
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

  it("seeds every non-excluded producer of a target item", () => {
    // iron_nugget is produced by iron_nugget-iron_ore, iron_nugget-iron_powder,
    // and the excluded transfer_tundra_iron_nugget. Both non-excluded
    // producers (and their input cones) must be in the graph; the excluded one
    // must not.
    const targets: ItemTarget[] = [
      { itemId: "iron_nugget", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);
    expect(g.nodes.has("iron_nugget-iron_ore")).toBe(true);
    expect(g.nodes.has("iron_nugget-iron_powder")).toBe(true);
    expect(g.nodes.has("transfer_tundra_iron_nugget")).toBe(false);
    // The seeded sibling's input cone is walked too.
    expect(g.nodes.has("iron_powder")).toBe(true);
  });
});

describe("augmentGraphWithLpSupport", () => {
  // copper_bottle is the real disposal absorber: the LP runs it to consume
  // over-produced copper_nugget, but no target cone reaches it.
  it("adds a positive-rate off-graph recipe and wires its input producers", () => {
    const targets: ItemTarget[] = [
      { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);
    expect(g.nodes.has("copper_bottle")).toBe(false);

    const rates = new Map<RecipeId, Fraction>([
      ["copper_nugget", new Fraction(3)],
      ["copper_bottle", new Fraction(1)],
    ]);
    const added = augmentGraphWithLpSupport(g, rates, pack);

    expect([...added]).toEqual(["copper_bottle"]);
    expect(g.nodes.has("copper_bottle")).toBe(true);
    const inEdges = g.incoming.get("copper_bottle") ?? [];
    expect(
      inEdges.some((e) => e.source === "copper_nugget" && e.item === "copper_nugget"),
    ).toBe(true);
    // The new node's edges are registered on the producer side too.
    expect(
      (g.outgoing.get("copper_nugget") ?? []).some((e) => e.target === "copper_bottle"),
    ).toBe(true);
  });

  it("wires off-graph chains: an augmented node can feed another augmented node", () => {
    const targets: ItemTarget[] = [
      { itemId: "xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "liquid_xiranite_poly", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);
    const rates = new Map<RecipeId, Fraction>([
      ["originium_powder", new Fraction(8)],
      ["originium_enr_powder", new Fraction(4)],
      ["proc_battery_5", new Fraction(1, 5)],
    ]);
    const added = augmentGraphWithLpSupport(g, rates, pack);

    expect([...added].sort()).toEqual([
      "originium_enr_powder",
      "originium_powder",
      "proc_battery_5",
    ]);
    // Chain wiring among augmented nodes (two-phase: nodes first, then edges).
    expect(
      (g.incoming.get("originium_enr_powder") ?? []).some(
        (e) => e.source === "originium_powder",
      ),
    ).toBe(true);
    expect(
      (g.incoming.get("proc_battery_5") ?? []).some(
        (e) => e.source === "originium_enr_powder",
      ),
    ).toBe(true);
  });

  it("skips excluded producers even at positive rate", () => {
    const excluded = pack.recipes.find((r) => isExcludedProducer(r));
    expect(excluded).toBeDefined();
    const targets: ItemTarget[] = [
      { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);
    expect(g.nodes.has(excluded!.id)).toBe(false);
    const rates = new Map<RecipeId, Fraction>([[excluded!.id, new Fraction(1)]]);
    const added = augmentGraphWithLpSupport(g, rates, pack);
    expect(added.size).toBe(0);
    expect(g.nodes.has(excluded!.id)).toBe(false);
  });

  it("is a strict no-op when every positive-rate recipe is already in the graph", () => {
    const targets: ItemTarget[] = [
      { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);
    const nodesBefore = g.nodes.size;
    const edgesBefore = [...g.outgoing.values()].reduce((n, a) => n + a.length, 0);
    const rates = new Map<RecipeId, Fraction>(
      [...g.nodes.keys()].map((id) => [id, new Fraction(1)]),
    );
    const added = augmentGraphWithLpSupport(g, rates, pack);
    expect(added.size).toBe(0);
    expect(g.nodes.size).toBe(nodesBefore);
    expect(
      [...g.outgoing.values()].reduce((n, a) => n + a.length, 0),
    ).toBe(edgesBefore);
  });
});

describe("pack census: self-consuming recipes", () => {
  // Pack-update tripwire. Self-consuming recipes are only legal because the
  // solve pipeline nets them away at its boundary (see netSelfConsumption).
  // The transmuter catalysts were the two that relied on it; they now sit in
  // `catalyst`, so the raw pack has no offender left and nothing leans on that
  // support. Pinning the empty set keeps a data refresh that reintroduces one
  // under review instead of letting it quietly resume depending on netting.
  it("the raw pack has no self-consuming recipe", () => {
    const offenders = pack.recipes
      .filter((r) => {
        const outs = new Set(r.out.map((o) => o.item));
        return r.in.some((i) => outs.has(i.item));
      })
      .map((r) => r.id)
      .sort();
    expect(offenders).toEqual([]);
  });
});

// The catalyst split is a reachability change, not just a stoich one: a
// catalyst on `in` makes the walk pull the catalyst's entire production chain
// into every plan that runs a transmuter. gas_copper is the sharp case - only
// the two transmuters produce it, and both recycle a xiranite fluid - so its
// walk is the direct witness that the split holds.
describe("catalyst reachability", () => {
  it("a transmuter target does not pull its catalyst's production chain", () => {
    const targets: ItemTarget[] = [
      { itemId: "gas_copper", ratePerSec: { num: "1", denom: "1" } },
    ];
    const g = buildRecipeGraphMulti(targets, pack);

    // The whole reached set, pinned: the two gas_copper transmuters plus the
    // copper feedstock cone they actually consume.
    expect([...g.nodes.keys()].sort()).toEqual([
      "copper_nugget",
      "copper_powder",
      "liquid_copper",
      "phase_trans_1-gas_copper",
      "phase_trans_1-liquid_copper",
      "phase_trans_2-copper_nugget",
      "phase_trans_2-gas_copper",
    ]);

    // Named negatives, so a future widening reads as the specific regression it
    // is: liquid_xiranite is phase_trans_1-gas_copper's catalyst, and folding
    // it back onto `in` drags in the xiranite transmuters and, behind them, the
    // whole carbon / planter mix pool that feeds xiranite_powder.
    for (const id of [
      "liquid_xiranite",
      "phase_trans_1-liquid_xiranite",
      "phase_trans_2-xiranite_powder",
      "xiranite_powder-carbon_mtl",
      "carbon_mtl-plant_moss_1",
    ]) {
      expect(g.nodes.has(id)).toBe(false);
    }
  });
});
