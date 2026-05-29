import type { RecipeEdge, RecipeGraph, Scc, TornEdge } from "./types";

export function pickTearEdges(scc: Scc, g: RecipeGraph): TornEdge[] {
  if (scc.recipeIds.length < 2) return [];
  const members = new Set(scc.recipeIds);
  const color = new Map<string, "white" | "gray" | "black">();
  for (const r of scc.recipeIds) color.set(r, "white");
  // The tree edge that first discovered each node, or null for a DFS root.
  const parentEdge = new Map<string, RecipeEdge | null>();
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
    parentEdge.set(start, null);
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
        parentEdge.set(w, e);
        frames.push({ v: w, iter: internalEdges(w)[Symbol.iterator]() });
      } else if (c === "gray") {
        backEdges.push(e);
      }
    }
  }

  // Every back edge closes one fundamental cycle: the back edge itself plus the
  // tree path from its target back up to its source. We walk that cycle and
  // tear its lowest-qty edge rather than always tearing the back edge, so a
  // cheaper tree edge can be cut instead.
  type Scored = { edge: RecipeEdge; bottleneck: number; key: string };
  const scored: Scored[] = backEdges.map((be) => {
    const cycleEdges: RecipeEdge[] = [be];
    let cur = be.source;
    while (cur !== be.target) {
      const pe = parentEdge.get(cur);
      if (!pe) break;
      cycleEdges.push(pe);
      cur = pe.source;
    }
    // Rank the cycle's edges by qty and take the cheapest one.
    type Candidate = { edge: RecipeEdge; qty: number; key: string };
    const candidates: Candidate[] = cycleEdges.map((e) => ({
      edge: e,
      qty: qtyOfEdge(e, g),
      key: `${e.source} ${e.item} ${e.target}`,
    }));
    candidates.sort(
      (x, y) => x.qty - y.qty || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
    );
    const best = candidates[0]!;
    return { edge: best.edge, bottleneck: best.qty, key: best.key };
  });

  // Different back edges can land on the same tear candidate, so drop repeats.
  const seen = new Set<string>();
  const unique: Scored[] = [];
  for (const s of scored) {
    if (!seen.has(s.key)) {
      seen.add(s.key);
      unique.push(s);
    }
  }

  unique.sort(
    (x, y) =>
      x.bottleneck - y.bottleneck ||
      (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );

  return unique.map((s) => ({ id: s.key, edge: s.edge, sccId: scc.id }));
}

function qtyOfEdge(e: RecipeEdge, g: RecipeGraph): number {
  const producer = g.nodes.get(e.source);
  if (!producer) return 1; // synthetic test path fallback
  const out = producer.out.find((o) => o.item === e.item);
  return out?.qty ?? 1;
}
