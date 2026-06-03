import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { Item, Machine } from "@aef/schema";
import {
  ItemPackProvider,
  useItemPack,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import type { ItemOverride } from "../../src/data/plan";

afterEach(() => cleanup());

function makeValue(): ItemPackContextValue {
  const item: Item = {
    id: "iron-ore",
    name: "Iron Ore",
    category: "raw",
    icon: "iron-ore",
    row: 0,
    raw: true,
    transportKind: "belt",
  };
  const machine: Machine = {
    id: "assembler-t1",
    name: "Assembler T1",
    icon: "assembler-t1",
    speed: 1,
    powerType: "electric",
    powerKw: 75,
    hideRate: false,
  };
  const overrides: ItemOverride[] = [{ itemId: "iron-ore", plan: true }];
  return {
    itemById: new Map([[item.id, item]]),
    overrides,
    machineById: new Map([[machine.id, machine]]),
  };
}

describe("useItemPack", () => {
  it("returns the provided value when called inside ItemPackProvider", () => {
    const value = makeValue();
    const { result } = renderHook(() => useItemPack(), {
      wrapper: ({ children }) => (
        <ItemPackProvider value={value}>{children}</ItemPackProvider>
      ),
    });
    expect(result.current).toBe(value);
    expect(result.current.itemById.get("iron-ore")?.name).toBe("Iron Ore");
    expect(result.current.machineById.get("assembler-t1")?.speed).toBe(1);
    expect(result.current.overrides).toHaveLength(1);
  });

  it("throws when called outside of ItemPackProvider", () => {
    expect(() => renderHook(() => useItemPack())).toThrow(
      /useItemPack must be called inside <ItemPackProvider>/,
    );
  });
});
