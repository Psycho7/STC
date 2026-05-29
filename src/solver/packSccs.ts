import type { RecipePack } from "@aef/schema";
import { buildRecipeGraph } from "./graph";
import { tarjanScc } from "./scc";
import type { Target } from "../data/targets";
import type { RecipeGraph } from "./types";

// Reports the recipes that can't be targeted yet because their precursor
// closure reaches a non-trivial SCC; the solver throws SingularSccError on
// such targets. Pinning a target that lives inside an SCC would lift the
// restriction, but that isn't implemented. The lookup runs against the
// pack-wide recipe graph with every recipe held at rate 0 so producer choices
// line up with what solvePlan would pick at runtime.
export function computeInSccRecipes(pack: RecipePack): ReadonlySet<string> {
  const allTargets: Target[] = pack.recipes.map((r) => ({
    recipeId: r.id,
    ratePerSec: { num: "0", denom: "1" },
  }));
  const g = buildRecipeGraph(allTargets, pack);
  const sccs = tarjanScc(g);
  const inScc = new Set<string>();
  for (const s of sccs) {
    if (s.recipeIds.length > 1) {
      for (const r of s.recipeIds) inScc.add(r);
    }
  }
  const unsafe = new Set<string>(inScc);
  for (const r of pack.recipes) {
    if (unsafe.has(r.id)) continue;
    if (precursorsTouchScc(r.id, inScc, g)) unsafe.add(r.id);
  }
  return unsafe;
}

function precursorsTouchScc(
  start: string,
  inScc: ReadonlySet<string>,
  g: RecipeGraph,
): boolean {
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur !== start && inScc.has(cur)) return true;
    for (const e of g.incoming.get(cur) ?? []) {
      if (seen.has(e.source)) continue;
      seen.add(e.source);
      queue.push(e.source);
    }
  }
  return false;
}
