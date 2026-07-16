import { describe, expect, it } from "vitest";
import type { RecipePack } from "@aef/schema";
import { computeRecipeDepths } from "./recipe-depth";

// Hand-built mini-packs. Only the fields computeRecipeDepths reads are set;
// the rest of the RecipePack shape is cast away.
function mkPack(
  items: Array<{ id: string; raw?: boolean }>,
  recipes: Array<{
    id: string;
    category?: string;
    cost?: number;
    in?: Array<{ item: string; qty: number }>;
    out?: Array<{ item: string; qty: number }>;
  }>,
): RecipePack {
  return {
    items: items.map((i) => ({ id: i.id, raw: i.raw ?? false })),
    recipes: recipes.map((r) => ({
      id: r.id,
      category: r.category ?? "craft",
      cost: r.cost ?? 1,
      in: r.in ?? [],
      out: r.out ?? [],
    })),
  } as unknown as RecipePack;
}

describe("computeRecipeDepths", () => {
  it("seeds raw-fed recipes at 1 and increments along an acyclic chain", () => {
    const pack = mkPack(
      [{ id: "raw", raw: true }, { id: "a" }, { id: "b" }],
      [
        {
          id: "r_a",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "a", qty: 1 }],
        },
        {
          id: "r_b",
          in: [{ item: "a", qty: 1 }],
          out: [{ item: "b", qty: 1 }],
        },
      ],
    );
    const depths = computeRecipeDepths(pack);
    expect(depths.get("r_a")).toBe(1);
    expect(depths.get("r_b")).toBe(2);
  });

  it("gives a zero-input recipe depth 1", () => {
    const pack = mkPack(
      [{ id: "z" }],
      [{ id: "r_z", in: [], out: [{ item: "z", qty: 1 }] }],
    );
    expect(computeRecipeDepths(pack).get("r_z")).toBe(1);
  });

  it("takes the max over input depths (raw mixed with a deep input)", () => {
    const pack = mkPack(
      [{ id: "raw", raw: true }, { id: "a" }, { id: "b" }, { id: "m" }],
      [
        {
          id: "r_a",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "a", qty: 1 }],
        },
        {
          id: "r_b",
          in: [{ item: "a", qty: 1 }],
          out: [{ item: "b", qty: 1 }],
        },
        {
          id: "r_mix",
          in: [
            { item: "raw", qty: 1 },
            { item: "b", qty: 1 },
          ],
          out: [{ item: "m", qty: 1 }],
        },
      ],
    );
    // b sits at item-depth 2, so r_mix = max(0, 2) + 1 = 3.
    expect(computeRecipeDepths(pack).get("r_mix")).toBe(3);
  });

  it("takes the min over an item's producers, so a consumer follows the shallower one", () => {
    const pack = mkPack(
      [
        { id: "raw", raw: true },
        { id: "a" },
        { id: "b" },
        { id: "p" },
        { id: "u" },
      ],
      [
        {
          id: "r_a",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "a", qty: 1 }],
        },
        {
          id: "r_b",
          in: [{ item: "a", qty: 1 }],
          out: [{ item: "b", qty: 1 }],
        },
        // p has a shallow producer (from raw, depth 1) and a deep one (from b).
        {
          id: "r_p_shallow",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "p", qty: 1 }],
        },
        {
          id: "r_p_deep",
          in: [{ item: "b", qty: 1 }],
          out: [{ item: "p", qty: 1 }],
        },
        {
          id: "r_use",
          in: [{ item: "p", qty: 1 }],
          out: [{ item: "u", qty: 1 }],
        },
      ],
    );
    const depths = computeRecipeDepths(pack);
    // item p resolves to the shallower producer (depth 1), so r_use = 1 + 1.
    expect(depths.get("r_use")).toBe(2);
  });

  it("leaves cycle-only recipes at POSITIVE_INFINITY", () => {
    const pack = mkPack(
      [{ id: "x" }, { id: "y" }],
      [
        {
          id: "r_x",
          in: [{ item: "y", qty: 1 }],
          out: [{ item: "x", qty: 1 }],
        },
        {
          id: "r_y",
          in: [{ item: "x", qty: 1 }],
          out: [{ item: "y", qty: 1 }],
        },
      ],
    );
    const depths = computeRecipeDepths(pack);
    expect(depths.get("r_x")).toBe(Number.POSITIVE_INFINITY);
    expect(depths.get("r_y")).toBe(Number.POSITIVE_INFINITY);
  });

  it("never lets an excluded producer feed depth (__domain_transfer and cost === -1)", () => {
    const pack = mkPack(
      [
        { id: "raw", raw: true },
        { id: "e_transfer" },
        { id: "e_sentinel" },
        { id: "ft" },
        { id: "fs" },
      ],
      [
        // Only producers of e_transfer / e_sentinel are excluded, so those items
        // never gain a finite depth and their consumers stay unreachable.
        {
          id: "r_transfer",
          category: "__domain_transfer",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "e_transfer", qty: 1 }],
        },
        {
          id: "r_sentinel",
          cost: -1,
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "e_sentinel", qty: 1 }],
        },
        {
          id: "r_use_transfer",
          in: [{ item: "e_transfer", qty: 1 }],
          out: [{ item: "ft", qty: 1 }],
        },
        {
          id: "r_use_sentinel",
          in: [{ item: "e_sentinel", qty: 1 }],
          out: [{ item: "fs", qty: 1 }],
        },
      ],
    );
    const depths = computeRecipeDepths(pack);
    // Excluded producers get no entry at all.
    expect(depths.has("r_transfer")).toBe(false);
    expect(depths.has("r_sentinel")).toBe(false);
    // Their outputs never feed a finite depth to downstream consumers.
    expect(depths.get("r_use_transfer")).toBe(Number.POSITIVE_INFINITY);
    expect(depths.get("r_use_sentinel")).toBe(Number.POSITIVE_INFINITY);
  });
});
