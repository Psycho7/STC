// Shared synthetic-graph constructors for the colocated solver suites
// (assemble.test.ts, replicate.test.ts). Hand-built RecipeGraph and
// Condensation values only -- no assertions here.

import type { Recipe } from "@aef/schema";
import type {
  Condensation,
  RecipeEdge,
  RecipeGraph,
  RecipeId,
  SccId,
} from "./types";

// A minimal recipe node: only the id, category and stoichiometry matter to the
// passes under test, so the remaining schema fields carry placeholders.
export function recipe(
  id: string,
  inItems: Array<{ item: string; qty: number }>,
  outItems: Array<{ item: string; qty: number }>,
): Recipe {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    time: 1,
    in: inItems,
    out: outItems,
    producers: [],
  };
}

// Builds a RecipeGraph from a node list and (source -> item -> target) edges.
export function buildGraph(
  nodes: Recipe[],
  links: Array<{ source: RecipeId; item: string; target: RecipeId }>,
): RecipeGraph {
  const nodeMap = new Map<RecipeId, Recipe>(nodes.map((n) => [n.id, n]));
  const outgoing = new Map<RecipeId, RecipeEdge[]>();
  const incoming = new Map<RecipeId, RecipeEdge[]>();
  for (const l of links) {
    const e: RecipeEdge = {
      id: `${l.source}->${l.target}:${l.item}`,
      source: l.source,
      target: l.target,
      item: l.item,
    };
    (outgoing.get(l.source) ?? outgoing.set(l.source, []).get(l.source)!).push(
      e,
    );
    (incoming.get(l.target) ?? incoming.set(l.target, []).get(l.target)!).push(
      e,
    );
  }
  return { nodes: nodeMap, outgoing, incoming };
}

export function condensationOf(
  sccs: Array<{ id: SccId; recipeIds: RecipeId[] }>,
): Condensation {
  const sccOfRecipe = new Map<RecipeId, SccId>();
  for (const s of sccs) for (const r of s.recipeIds) sccOfRecipe.set(r, s.id);
  return {
    sccs,
    sccOfRecipe,
    outgoing: new Map(),
    incoming: new Map(),
  };
}
