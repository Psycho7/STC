import { createContext, useContext, type ReactNode } from "react";
import type { Item, Machine } from "@aef/schema";
import type { ItemOverride } from "../data/plan";

export type ItemPackContextValue = {
  itemById: Map<string, Item>;
  overrides: ItemOverride[];
  machineById: Map<string, Machine>;
};

const ItemPackContext = createContext<ItemPackContextValue | null>(null);

export function ItemPackProvider({
  value,
  children,
}: {
  value: ItemPackContextValue;
  children: ReactNode;
}) {
  return (
    <ItemPackContext.Provider value={value}>
      {children}
    </ItemPackContext.Provider>
  );
}

export function useItemPack(): ItemPackContextValue {
  const value = useContext(ItemPackContext);
  if (value === null) {
    throw new Error("useItemPack must be called inside <ItemPackProvider>");
  }
  return value;
}
