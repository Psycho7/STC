import type { Condensation, SccId } from "./types";

export function topologicalOrder(c: Condensation): SccId[] {
  const inDegree = new Map<SccId, number>();
  for (const s of c.sccs) inDegree.set(s.id, c.incoming.get(s.id)!.size);
  const ready: SccId[] = [...inDegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id)
    .sort();
  const order: SccId[] = [];
  while (ready.length) {
    ready.sort();
    const v = ready.shift()!;
    order.push(v);
    for (const w of c.outgoing.get(v)!) {
      inDegree.set(w, inDegree.get(w)! - 1);
      if (inDegree.get(w) === 0) ready.push(w);
    }
  }
  return order;
}
