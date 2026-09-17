import { createContext, useContext, type ReactNode } from "react";
import type { Item, Machine } from "@aef/schema";

export type ItemPackContextValue = {
  itemById: ReadonlyMap<string, Item>;
  machineById: ReadonlyMap<string, Machine>;
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
