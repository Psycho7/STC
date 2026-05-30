import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, RecipePack } from "@aef/schema";
import { effectiveSupply } from "../../src/solver/effectiveSupply";
import type { ItemOverride } from "../../src/data/plan";

function mkItem(id: string, raw: boolean): Item {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    raw,
    transportKind: "belt",
  } as Item;
}

function mkPack(items: Item[]): RecipePack {
  return {
    schemaVersion: "0.2",
    source: {
      name: "test",
      submodulePath: "",
      submoduleSha: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items,
    machines: [],
    transports: [],
    recipes: [],
  } as unknown as RecipePack;
}

const PACK = mkPack([mkItem("raw_item", true), mkItem("built_item", false)]);

describe("effectiveSupply", () => {
  it("raw item, no override -> Infinity", () => {
    expect(effectiveSupply("raw_item", PACK, [])).toBe(Infinity);
  });

  it("non-raw item, no override -> Fraction(0)", () => {
    // Non-raw means the item is fully built internally; boundary supply is 0.
    const result = effectiveSupply("built_item", PACK, []);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(0))).toBe(true);
  });

  it("raw item, override absent fields -> Infinity", () => {
    const overrides: ItemOverride[] = [{ itemId: "raw_item" }];
    expect(effectiveSupply("raw_item", PACK, overrides)).toBe(Infinity);
  });

  it("non-raw item, override absent fields -> Infinity", () => {
    const overrides: ItemOverride[] = [{ itemId: "built_item" }];
    expect(effectiveSupply("built_item", PACK, overrides)).toBe(Infinity);
  });

  it("raw item, override plan:true -> Fraction(0)", () => {
    const overrides: ItemOverride[] = [{ itemId: "raw_item", plan: true }];
    const result = effectiveSupply("raw_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(0))).toBe(true);
  });

  it("non-raw item, override plan:true -> Infinity", () => {
    // plan:true forces internal build only for raw items; for non-raw it is
    // ignored and the item behaves like an unlimited boundary.
    const overrides: ItemOverride[] = [{ itemId: "built_item", plan: true }];
    expect(effectiveSupply("built_item", PACK, overrides)).toBe(Infinity);
  });

  it("raw item, override ratePerSec=0 -> Fraction(0)", () => {
    const overrides: ItemOverride[] = [
      { itemId: "raw_item", ratePerSec: { num: "0", denom: "1" } },
    ];
    const result = effectiveSupply("raw_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(0))).toBe(true);
  });

  it("non-raw item, override ratePerSec=0 -> Fraction(0)", () => {
    const overrides: ItemOverride[] = [
      { itemId: "built_item", ratePerSec: { num: "0", denom: "1" } },
    ];
    const result = effectiveSupply("built_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(0))).toBe(true);
  });

  it("raw item, override ratePerSec>0 -> parsed Fraction", () => {
    const overrides: ItemOverride[] = [
      { itemId: "raw_item", ratePerSec: { num: "3", denom: "2" } },
    ];
    const result = effectiveSupply("raw_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect(
      (result as Fraction).equals(new Fraction(3).div(new Fraction(2))),
    ).toBe(true);
  });

  it("non-raw item, override ratePerSec>0 -> parsed Fraction", () => {
    const overrides: ItemOverride[] = [
      { itemId: "built_item", ratePerSec: { num: "5", denom: "1" } },
    ];
    const result = effectiveSupply("built_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(5))).toBe(true);
  });

  it("raw item, override plan:true AND ratePerSec>0 -> ratePerSec wins", () => {
    // When both fields are set, ratePerSec takes precedence; plan is ignored.
    const overrides: ItemOverride[] = [
      {
        itemId: "raw_item",
        plan: true,
        ratePerSec: { num: "5", denom: "1" },
      },
    ];
    const result = effectiveSupply("raw_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(5))).toBe(true);
  });

  it("non-raw item, override plan:true AND ratePerSec>0 -> ratePerSec wins", () => {
    // When both fields are set, ratePerSec takes precedence; plan is ignored.
    const overrides: ItemOverride[] = [
      {
        itemId: "built_item",
        plan: true,
        ratePerSec: { num: "5", denom: "1" },
      },
    ];
    const result = effectiveSupply("built_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(5))).toBe(true);
  });

  it("item not in pack, no override -> Fraction(0)", () => {
    // Unknown items are treated as non-raw; with no override the no-override
    // non-raw branch yields Fraction(0).
    const overrides: ItemOverride[] = [
      { itemId: "other_ghost", ratePerSec: { num: "9", denom: "1" } },
    ];
    const result = effectiveSupply("ghost_item", PACK, overrides);
    expect(result).not.toBe(Infinity);
    expect((result as Fraction).equals(new Fraction(0))).toBe(true);
  });
});
