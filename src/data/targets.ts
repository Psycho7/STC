import Fraction from "fraction.js";

export type RationalString = { num: string; denom: string };

// The one num/denom -> Fraction parse. Every layer that needs exact arithmetic
// over a wire rational goes through this instead of rebuilding the "num/denom"
// string, so a change to the rational encoding has a single edit site.
// Re-exported from src/pipeline/render/rational.ts for the render layer, which
// pairs it with rationalToString.
export function rationalFromString(r: RationalString): Fraction {
  return new Fraction(`${r.num}/${r.denom}`);
}

// Item-keyed target: "net-export this item at ratePerSec". The whole app -
// plan, UI, and solver - speaks this one shape.
export type ItemTarget = {
  itemId: string;
  ratePerSec: RationalString;
};

// The plan/UI target is the item target. The alias survives so the many
// Target-typed call sites keep compiling; both names denote the same shape.
export type Target = ItemTarget;

export function defaultTargets(): Target[] {
  return [
    { itemId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
    { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
    { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
  ];
}
