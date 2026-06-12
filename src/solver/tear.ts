import type { RecipeEdge, RecipeGraph, Scc, TornEdge } from "./types";

export function pickTearEdges(scc: Scc, g: RecipeGraph): TornEdge[] {
  if (scc.recipeIds.length < 2) return [];
  const members = new Set(scc.recipeIds);
  const color = new Map<string, "white" | "gray" | "black">();
  for (const r of scc.recipeIds) color.set(r, "white");
  const backEdges: RecipeEdge[] = [];

  function internalEdges(v: string): RecipeEdge[] {
    return (g.outgoing.get(v) ?? []).filter((e) => members.has(e.target));
  }

  for (const start of scc.recipeIds) {
    if (color.get(start) !== "white") continue;
    type Frame = { v: string; iter: Iterator<RecipeEdge> };
    const frames: Frame[] = [
      { v: start, iter: internalEdges(start)[Symbol.iterator]() },
    ];
    color.set(start, "gray");
    while (frames.length) {
      const f = frames[frames.length - 1]!;
      const n = f.iter.next();
      if (n.done) {
        color.set(f.v, "black");
        frames.pop();
        continue;
      }
      const e = n.value;
      const w = e.target;
      const c = color.get(w);
      if (c === "white") {
        color.set(w, "gray");
        frames.push({ v: w, iter: internalEdges(w)[Symbol.iterator]() });
      } else if (c === "gray") {
        backEdges.push(e);
      }
    }
  }

  // Tear the back edges themselves. Every directed cycle inside the SCC
  // contains at least one DFS back edge (white-path theorem), so removing the
  // whole back-edge set provably leaves the SCC's internal subgraph acyclic.
  // Substituting a cheaper edge of the back edge's fundamental cycle (the old
  // behavior) voided that cover: chords through the back edge's endpoints
  // survived untorn. Each edge object is visited exactly once by the DFS, so
  // backEdges has no repeats; sort by id for a stable output order (assemble
  // emits return arcs in torn order, which feeds layout).
  // The (source, item, target) triple is unique per graph: both edge builders
  // (buildGraph and augmentGraphWithLpSupport) skip an edge when one with the
  // same source, item, and target already exists, so this id cannot collide.
  const torn: TornEdge[] = backEdges.map((e) => ({
    id: `${e.source} ${e.item} ${e.target}`,
    edge: e,
    sccId: scc.id,
  }));
  torn.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return torn;
}
