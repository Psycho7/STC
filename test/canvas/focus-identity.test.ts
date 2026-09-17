// Hover focus must not hand React Flow a fresh object for an element whose
// focus state did not change: a new node or edge object re-renders its wrapper
// and invalidates every memo keyed on its data. A drag frame (new node array,
// same untouched node objects) must keep the untouched nodes, and a hover
// change, which must hand every edge new data, must let the edge memos find
// the data the copy was made from.
import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import { focusEdges, focusNodes } from "../../src/canvas/Canvas";
import { focusSourceOf } from "../../src/canvas/ItemEdge";

const NODES: Node[] = [
  { id: "g", type: "group", position: { x: 0, y: 0 }, data: {} },
  { id: "a", parentId: "g", position: { x: 0, y: 0 }, data: {} },
  { id: "b", position: { x: 300, y: 0 }, data: {} },
  { id: "c", position: { x: 600, y: 0 }, data: {} },
  { id: "h", type: "group", position: { x: 900, y: 0 }, data: {} },
];

const EDGES: Edge[] = [
  { id: "e1", source: "a", target: "b", data: { item: "x" } },
  { id: "e2", source: "b", target: "c", data: { item: "y" } },
  { id: "e3", source: "c", target: "a", data: { item: "z" } },
];

describe("canvas/focus identity", () => {
  it("keeps untouched node objects across a drag frame under hover", () => {
    const focus = { nodeIds: new Set(["a", "b"]), edgeIds: new Set(["e1"]) };
    const first = focusNodes(NODES, focus);
    // A drag frame: a new array in which only the dragged node is new, and a
    // focus memo that recomputed to an equal set.
    const dragged = { ...NODES[2]!, position: { x: 310, y: 5 } };
    const frame = [NODES[0]!, NODES[1]!, dragged, NODES[3]!, NODES[4]!];
    const again = { nodeIds: new Set(["a", "b"]), edgeIds: new Set(["e1"]) };
    const second = focusNodes(frame, again);
    for (const i of [0, 1, 3, 4]) {
      expect(second[i], NODES[i]!.id).toBe(first[i]);
    }
    expect(second[2]!.className).toBe(first[2]!.className);
    expect(second[2]!.position).toEqual({ x: 310, y: 5 });
  });

  it("keeps the dimmed and lit-container classes", () => {
    const out = focusNodes(NODES, { nodeIds: new Set(["a"]) });
    const byId = new Map(out.map((n) => [n.id, n]));
    expect(byId.get("a")).toBe(NODES[1]);
    expect(byId.get("g")!.className).toBe("lit-container");
    expect(byId.get("h")!.className).toBe("dimmed");
    expect(byId.get("b")!.className).toBe("dimmed");
    expect(focusNodes(NODES, null)).toBe(NODES);
  });

  it("maps every focus data copy back to the data it was made from", () => {
    const onE1 = focusEdges(EDGES, { edgeIds: new Set(["e1"]) });
    const onE2 = focusEdges(EDGES, { edgeIds: new Set(["e2"]) });
    for (const out of [onE1, onE2]) {
      out.forEach((edge, i) => {
        expect(edge.data, edge.id).not.toBe(EDGES[i]!.data);
        expect(focusSourceOf(edge.data), edge.id).toBe(EDGES[i]!.data);
      });
    }
    // Data that no focus pass produced is its own source.
    expect(focusSourceOf(EDGES[0]!.data)).toBe(EDGES[0]!.data);
    expect(focusSourceOf(undefined)).toBeUndefined();
  });
});
