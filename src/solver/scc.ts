import type { Condensation, RecipeGraph, Scc, SccId } from "./types";

export function tarjanScc(g: RecipeGraph): Scc[] {
  const ids = [...g.outgoing.keys()];
  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: Scc[] = [];
  let index = 0;

  for (const start of ids) {
    if (indexOf.has(start)) continue;
    const frames: Array<{ v: string; iter: Iterator<{ target: string }> }> = [];
    indexOf.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    frames.push({
      v: start,
      iter: (g.outgoing.get(start) ?? [])[Symbol.iterator](),
    });

    while (frames.length) {
      const frame = frames[frames.length - 1]!;
      const next = frame.iter.next();
      if (next.done) {
        if (low.get(frame.v) === indexOf.get(frame.v)) {
          const members: string[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            members.push(w);
            if (w === frame.v) break;
          }
          members.sort();
          sccs.push({ id: members[0]!, recipeIds: members });
        }
        frames.pop();
        if (frames.length) {
          const parent = frames[frames.length - 1]!;
          low.set(parent.v, Math.min(low.get(parent.v)!, low.get(frame.v)!));
        }
      } else {
        const w = next.value.target;
        if (!indexOf.has(w)) {
          indexOf.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          frames.push({
            v: w,
            iter: (g.outgoing.get(w) ?? [])[Symbol.iterator](),
          });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, indexOf.get(w)!));
        }
      }
    }
  }
  return sccs;
}

export function condense(g: RecipeGraph, sccs: Scc[]): Condensation {
  const sccOfRecipe = new Map<string, SccId>();
  for (const s of sccs) for (const r of s.recipeIds) sccOfRecipe.set(r, s.id);
  const outgoing = new Map<SccId, Set<SccId>>();
  const incoming = new Map<SccId, Set<SccId>>();
  for (const s of sccs) {
    outgoing.set(s.id, new Set());
    incoming.set(s.id, new Set());
  }
  for (const [src, edges] of g.outgoing) {
    const srcScc = sccOfRecipe.get(src)!;
    for (const e of edges) {
      const dstScc = sccOfRecipe.get(e.target)!;
      if (srcScc === dstScc) continue;
      outgoing.get(srcScc)!.add(dstScc);
      incoming.get(dstScc)!.add(srcScc);
    }
  }
  return { sccs, sccOfRecipe, outgoing, incoming };
}
