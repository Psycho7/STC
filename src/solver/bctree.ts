import type { RecipeGraph, RecipeId } from "./types";

export function articulationPoints(g: RecipeGraph): Set<RecipeId> {
  const adj = new Map<string, Set<string>>();
  function ensure(id: string) {
    if (!adj.has(id)) adj.set(id, new Set());
  }
  for (const [src, edges] of g.outgoing) {
    ensure(src);
    for (const e of edges) {
      ensure(e.target);
      adj.get(src)!.add(e.target);
      adj.get(e.target)!.add(src);
    }
  }
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const aps = new Set<string>();
  let time = 0;
  for (const start of adj.keys()) {
    if (disc.has(start)) continue;
    type Frame = {
      v: string;
      parent: string | null;
      iter: Iterator<string>;
      childCount: number;
      currentChild: string | null;
    };
    const frames: Frame[] = [];
    disc.set(start, time);
    low.set(start, time);
    time++;
    frames.push({
      v: start,
      parent: null,
      iter: adj.get(start)![Symbol.iterator](),
      childCount: 0,
      currentChild: null,
    });
    while (frames.length) {
      const f = frames[frames.length - 1]!;
      if (f.currentChild !== null) {
        low.set(f.v, Math.min(low.get(f.v)!, low.get(f.currentChild)!));
        if (low.get(f.currentChild)! >= disc.get(f.v)! && f.parent !== null)
          aps.add(f.v);
        f.currentChild = null;
      }
      const n = f.iter.next();
      if (n.done) {
        if (f.parent === null && f.childCount >= 2) aps.add(f.v);
        frames.pop();
        continue;
      }
      const w = n.value;
      if (w === f.parent) continue;
      if (disc.has(w)) {
        low.set(f.v, Math.min(low.get(f.v)!, disc.get(w)!));
      } else {
        disc.set(w, time);
        low.set(w, time);
        time++;
        f.childCount++;
        f.currentChild = w;
        frames.push({
          v: w,
          parent: f.v,
          iter: adj.get(w)![Symbol.iterator](),
          childCount: 0,
          currentChild: null,
        });
      }
    }
  }
  return aps;
}
