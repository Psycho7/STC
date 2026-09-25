import type { RenderEdge } from "../types";

// Assigns a labelSide to each edge based on the per-item degree at each
// endpoint. Runs in O(E) and mutates the input array in place.
export function assignLabelSides(edges: RenderEdge[]): void {
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const e of edges) {
    const oKey = `${e.fromUnit}\0${e.item}`;
    const iKey = `${e.toUnit}\0${e.item}`;
    outDeg.set(oKey, (outDeg.get(oKey) ?? 0) + 1);
    inDeg.set(iKey, (inDeg.get(iKey) ?? 0) + 1);
  }
  for (const e of edges) {
    const o = outDeg.get(`${e.fromUnit}\0${e.item}`) ?? 1;
    const i = inDeg.get(`${e.toUnit}\0${e.item}`) ?? 1;
    if (o > i) e.labelSide = "target";
    else if (i > o) e.labelSide = "source";
    else e.labelSide = "target"; // 1-to-1 and N-to-M tie
  }
}
