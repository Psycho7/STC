import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Item, RecipePack } from "@aef/schema";
import {
  buildSupplyTable,
  effectiveSupply,
} from "../../src/solver/effectiveSupply";
import { netSelfConsumption } from "../../src/solver/net-self";
import { pack as shippedPack } from "../../src/data/load";
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
      sourceRepo: "",
      sourceCommit: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items,
    machines: [],
    transports: [],
    recipes: [],
    environmentBadges: { stable: "badge_stable", acidic: "badge_acidic" },
  };
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

describe("buildSupplyTable", () => {
  it("resolves the same supply for a netted pack as for its raw original", () => {
    // The solve half resolves supply against the netted pack and the render
    // half against the raw one. netSelfConsumption rewrites `recipes` only, so
    // both halves must see one table. The shipped pack carries two
    // self-consuming recipes (phase_trans_1-liquid_xiranite,
    // phase_trans_2-gas_xiranite), so netting is a real change here.
    const netted = netSelfConsumption(shippedPack);
    expect(netted).not.toBe(shippedPack);

    const overrides: ItemOverride[] = [
      {
        itemId: shippedPack.items[0]!.id,
        ratePerSec: { num: "3", denom: "2" },
      },
      { itemId: shippedPack.items[1]!.id, plan: true },
    ];
    const raw = buildSupplyTable(shippedPack, overrides);
    const net = buildSupplyTable(netted, overrides);

    for (const it of shippedPack.items) {
      const a = raw.supplyOf(it.id);
      const b = net.supplyOf(it.id);
      if (a === Infinity || b === Infinity) {
        expect(b).toBe(a);
        continue;
      }
      expect((a as Fraction).equals(b as Fraction)).toBe(true);
    }
    expect([...net.entries()].length).toBe([...raw.entries()].length);
  });

  it("resolves an override on an item absent from the pack", () => {
    const overrides: ItemOverride[] = [
      { itemId: "other_ghost", ratePerSec: { num: "9", denom: "1" } },
    ];
    const table = buildSupplyTable(PACK, overrides);

    const ghost = table.supplyOf("other_ghost");
    expect(ghost).not.toBe(Infinity);
    expect((ghost as Fraction).equals(new Fraction(9))).toBe(true);
    expect([...table.entries()].map(([id]) => id)).toContain("other_ghost");

    // An id in neither the pack nor the overrides is non-raw with no override.
    const unknown = table.supplyOf("ghost_item");
    expect(unknown).not.toBe(Infinity);
    expect((unknown as Fraction).equals(new Fraction(0))).toBe(true);
  });

  it("rejects a malformed ratePerSec at construction, not at query", () => {
    // The rule parses lazily, so the zero denominator only bites the item that
    // carries the override. The table parses every row up front, which moves
    // the same Fraction throw from query time to build time.
    const overrides: ItemOverride[] = [
      { itemId: "raw_item", ratePerSec: { num: "1", denom: "0" } },
    ];
    expect(() => effectiveSupply("built_item", PACK, overrides)).not.toThrow();
    expect(() => effectiveSupply("raw_item", PACK, overrides)).toThrow(
      /division by zero/i,
    );
    expect(() => buildSupplyTable(PACK, overrides)).toThrow(
      /division by zero/i,
    );
  });
});
