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

  // The transmuter catalysts used to be the shipped pack's only overlaps. They
  // now live in `catalyst`, which this pass never reads, so the raw pack
  // already satisfies what netting exists to produce.
  it("shipped pack: no recipe carries an item on both sides", () => {
    const offenders = pack.recipes
      .filter((r) => {
        const outs = new Set(r.out.map((o) => o.item));
        return r.in.some((i) => outs.has(i.item));
      })
      .map((r) => r.id);
    expect(offenders).toEqual([]);
  });

  // Identity by REFERENCE, not by value: it is the cheap proof that nothing was
  // rewritten, and it fails the moment a data refresh reintroduces an overlap -
  // which is the review this suite exists to force. Do not soften it to a deep
  // comparison; the whole netting path stays here for exactly that refresh.
  it("shipped pack: netting is the identity", () => {
    expect(netSelfConsumption(pack)).toBe(pack);
  });
});
