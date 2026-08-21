// Synthetic micro-pack builder for the Phase-0 gate fixtures.
//
// solveLp (src/solver/lp.ts) only reads pack.recipes and pack.items; the
// adapter additionally reads pack.items[].stack. We build a minimal but
// schema-shaped RecipePack so both the real STC solver and the adapter run
// unmodified. Recipes carry integer in/out stoich + a `time`; items carry a
// `raw` flag (the only field effectiveSupply consults beyond id).

import type {
  Item,
  Recipe,
  RecipePack,
  Stoich,
} from "@aef/schema";

export interface MicroRecipe {
  id: string;
  time: number;
  in: Record<string, number>;
  out: Record<string, number>;
  cost?: number;
  flags?: string[];
  category?: string;
}

export interface MicroItem {
  id: string;
  raw?: boolean;
  stack?: number;
}

function toStoich(m: Record<string, number>): Stoich[] {
  return Object.entries(m).map(([item, qty]) => ({ item, qty }));
}

export function makePack(
  recipes: MicroRecipe[],
  items: MicroItem[],
): RecipePack {
  const recs: Recipe[] = recipes.map((r) => ({
    id: r.id,
    name: r.id,
    category: r.category ?? "cat",
    icon: r.id,
    row: 0,
    time: r.time,
    in: toStoich(r.in),
    out: toStoich(r.out),
    producers: ["machine"],
    ...(r.flags ? { flags: r.flags } : {}),
    ...(r.cost !== undefined ? { cost: r.cost } : {}),
  }));

  const its: Item[] = items.map((i) => ({
    id: i.id,
    name: i.id,
    category: "cat",
    icon: i.id,
    row: 0,
    raw: i.raw ?? false,
    transportKind: "belt",
    ...(i.stack !== undefined ? { stack: i.stack } : {}),
  }));

  return {
    schemaVersion: "0.2",
    source: {
      name: "micro",
      sourceRepo: "",
      sourceCommit: "",
      gameVersion: "",
      extractedAt: "",
    },
    categories: [{ id: "cat", name: "cat", icon: "cat" }],
    locations: [],
    items: its,
    machines: [
      {
        id: "machine",
        name: "machine",
        icon: "machine",
        speed: 1,
        powerType: "electric",
        powerKw: 1,
        hideRate: false,
      },
    ],
    transports: [],
    recipes: recs,
  } as RecipePack;
}
