import { describe, expect, it } from "vitest";
import type { RecipePack } from "@aef/schema";
import { computeItemTiers, computeRecipeDepths } from "./recipe-depth";

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

describe("computeItemTiers", () => {
  it("(a) gives acyclic items their fixpoint min-producer depth", () => {
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
    const tiers = computeItemTiers(pack);
    // a is produced by r_a (depth 1); b by r_b (depth 2).
    expect(tiers.get("a")).toBe(1);
    expect(tiers.get("b")).toBe(2);
  });

  it("(a) takes the min over an item's producers", () => {
    const pack = mkPack(
      [
        { id: "raw", raw: true },
        { id: "a" },
        { id: "b" },
        { id: "p" },
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
      ],
    );
    // p resolves to the shallower producer (depth 1).
    expect(computeItemTiers(pack).get("p")).toBe(1);
  });

  it("(b) gives loop items 1 + a tier-2 external input", () => {
    const pack = mkPack(
      [
        { id: "raw", raw: true },
        { id: "a" },
        { id: "e" },
        { id: "p" },
        { id: "q" },
      ],
      [
        {
          id: "r_a",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "a", qty: 1 }],
        },
        {
          id: "r_e",
          in: [{ item: "a", qty: 1 }],
          out: [{ item: "e", qty: 1 }],
        },
        // p <-> q loop, fed from outside by e (item-depth 2).
        {
          id: "r_p",
          in: [
            { item: "q", qty: 1 },
            { item: "e", qty: 1 },
          ],
          out: [{ item: "p", qty: 1 }],
        },
        {
          id: "r_q",
          in: [{ item: "p", qty: 1 }],
          out: [{ item: "q", qty: 1 }],
        },
      ],
    );
    const tiers = computeItemTiers(pack);
    expect(tiers.get("e")).toBe(2);
    expect(tiers.get("p")).toBe(3);
    expect(tiers.get("q")).toBe(3);
  });

  it("(c) gives a self-consuming recipe with a raw input a finite tier", () => {
    const pack = mkPack(
      [{ id: "raw", raw: true }, { id: "x" }],
      [
        // x is both an input and the output; only raw feeds it from outside.
        {
          id: "r_x",
          in: [
            { item: "x", qty: 1 },
            { item: "raw", qty: 1 },
          ],
          out: [{ item: "x", qty: 1 }],
        },
      ],
    );
    // Fixpoint leaves x at Infinity; SCC collapse gives 1 + raw(0).
    expect(computeRecipeDepths(pack).get("r_x")).toBe(Number.POSITIVE_INFINITY);
    expect(computeItemTiers(pack).get("x")).toBe(1);
  });

  it("(d) gives a downstream loop the upstream loop's tier + 1", () => {
    const pack = mkPack(
      [
        { id: "raw", raw: true },
        { id: "a" },
        { id: "b" },
        { id: "c" },
        { id: "d" },
      ],
      [
        // Loop 1 {a,b}, fed by raw.
        {
          id: "r_a",
          in: [
            { item: "b", qty: 1 },
            { item: "raw", qty: 1 },
          ],
          out: [{ item: "a", qty: 1 }],
        },
        {
          id: "r_b",
          in: [{ item: "a", qty: 1 }],
          out: [{ item: "b", qty: 1 }],
        },
        // Loop 2 {c,d}, fed by a from loop 1.
        {
          id: "r_c",
          in: [
            { item: "d", qty: 1 },
            { item: "a", qty: 1 },
          ],
          out: [{ item: "c", qty: 1 }],
        },
        {
          id: "r_d",
          in: [{ item: "c", qty: 1 }],
          out: [{ item: "d", qty: 1 }],
        },
      ],
    );
    const tiers = computeItemTiers(pack);
    expect(tiers.get("a")).toBe(1);
    expect(tiers.get("b")).toBe(1);
    expect(tiers.get("c")).toBe(2);
    expect(tiers.get("d")).toBe(2);
  });

  it("(e) leaves an excluded-only-producer item at Infinity", () => {
    const pack = mkPack(
      [{ id: "raw", raw: true }, { id: "ex" }],
      [
        {
          id: "r_ex",
          category: "__domain_transfer",
          in: [{ item: "raw", qty: 1 }],
          out: [{ item: "ex", qty: 1 }],
        },
      ],
    );
    expect(computeItemTiers(pack).get("ex")).toBe(Number.POSITIVE_INFINITY);
  });

  it("(f) gives a raw item tier 0", () => {
    const pack = mkPack([{ id: "raw", raw: true }], []);
    expect(computeItemTiers(pack).get("raw")).toBe(0);
  });
});
