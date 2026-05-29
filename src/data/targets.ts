export type RationalString = { num: string; denom: string };

export type Target = {
  recipeId: string;
  ratePerSec: RationalString;
};

export function defaultTargets(): Target[] {
  return [
    { recipeId: "copper_bottle", ratePerSec: { num: "2", denom: "1" } },
    { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
    // Sink recipes (cost === -1) aren't valid targets anymore, so the old
    // third default (liquid_cleaner_1-sewage) is swapped for a non-sink recipe.
    // That way a freshly loaded plan satisfies the picker rules and the seed
    // survives sanitization instead of getting stripped out.
    { recipeId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
  ];
}
