import { describe, expect, it } from "vitest";
import type { Recipe, RecipePack } from "@aef/schema";
import { pack } from "../data/load";
import { netSelfConsumption } from "./net-self";

function makeRecipe(overrides: Partial<Recipe> & Pick<Recipe, "id" | "in" | "out">): Recipe {
  return {
    name: overrides.id,
    category: "material",
    icon: overrides.id,
    row: 0,
    time: 1,
    producers: ["m"],
    ...overrides,
  };
}

function makePack(recipes: Recipe[]): RecipePack {
  return { ...pack, recipes };
}

describe("netSelfConsumption", () => {
  it("returns the same pack reference when no recipe self-consumes", () => {
    const clean = makePack([
      makeRecipe({ id: "a", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 2 }] }),
    ]);
    expect(netSelfConsumption(clean)).toBe(clean);
  });

  it("nets a catalyst input into a reduced output and drops the self input", () => {
    const raw = makeRecipe({
      id: "r",
      in: [
        { item: "gas_x", qty: 1 },
        { item: "liquid_x", qty: 0.2 },
      ],
      out: [{ item: "liquid_x", qty: 1 }],
    });
    const netted = netSelfConsumption(makePack([raw]));
    const r = netted.recipes[0]!;
    expect(r.in).toEqual([{ item: "gas_x", qty: 1 }]);
    expect(r.out).toEqual([{ item: "liquid_x", qty: 0.8 }]);
    // The source recipe object must stay untouched: the raw pack is the
    // display-side source of truth.
    expect(raw.in).toHaveLength(2);
    expect(raw.out).toEqual([{ item: "liquid_x", qty: 1 }]);
  });

  it("keeps a net-negative overlap on the input side", () => {
    const netted = netSelfConsumption(
      makePack([
        makeRecipe({
          id: "r",
          in: [{ item: "x", qty: 1 }],
          out: [
            { item: "x", qty: 0.2 },
            { item: "y", qty: 1 },
          ],
        }),
      ]),
    );
    const r = netted.recipes[0]!;
    expect(r.in).toEqual([{ item: "x", qty: 0.8 }]);
    expect(r.out).toEqual([{ item: "y", qty: 1 }]);
  });

  it("drops a zero-net (pure catalyst) item from both sides", () => {
    const netted = netSelfConsumption(
      makePack([
        makeRecipe({
          id: "r",
          in: [
            { item: "cat", qty: 1 },
            { item: "x", qty: 1 },
          ],
          out: [
            { item: "cat", qty: 1 },
            { item: "y", qty: 1 },
          ],
        }),
      ]),
    );
    const r = netted.recipes[0]!;
    expect(r.in).toEqual([{ item: "x", qty: 1 }]);
    expect(r.out).toEqual([{ item: "y", qty: 1 }]);
  });

  it("keeps non-overlapping recipe objects by reference", () => {
    const clean = makeRecipe({ id: "a", in: [{ item: "x", qty: 1 }], out: [{ item: "y", qty: 1 }] });
    const dirty = makeRecipe({ id: "b", in: [{ item: "y", qty: 0.5 }], out: [{ item: "y", qty: 1 }] });
    const netted = netSelfConsumption(makePack([clean, dirty]));
    expect(netted.recipes[0]).toBe(clean);
    expect(netted.recipes[1]).not.toBe(dirty);
  });

  it("shipped pack: netting leaves no recipe with an item on both sides", () => {
    const netted = netSelfConsumption(pack);
    const offenders = netted.recipes
      .filter((r) => {
        const outs = new Set(r.out.map((o) => o.item));
        return r.in.some((i) => outs.has(i.item));
      })
      .map((r) => r.id);
    expect(offenders).toEqual([]);
  });

  it("shipped pack: the two phase-transition catalysts net to exact fractions", () => {
    const netted = netSelfConsumption(pack);
    const byId = new Map(netted.recipes.map((r) => [r.id, r]));

    const liquid = byId.get("phase_trans_1-liquid_xiranite")!;
    expect(liquid.in).toEqual([{ item: "gas_xiranite", qty: 1 }]);
    expect(liquid.out).toEqual([{ item: "liquid_xiranite", qty: 0.8 }]);

    const gas = byId.get("phase_trans_2-gas_xiranite")!;
    expect(gas.in).toEqual([{ item: "xiranite_powder", qty: 1 }]);
    expect(gas.out).toEqual([{ item: "gas_xiranite", qty: 0.8 }]);
  });
});
