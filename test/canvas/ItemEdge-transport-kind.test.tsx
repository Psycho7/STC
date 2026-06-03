import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, { type ItemEdgeData } from "../../src/canvas/ItemEdge";

afterEach(() => {
  cleanup();
});

const edgeTypes = { item: ItemEdge };

const NODES: Node[] = [
  { id: "src", position: { x: 0, y: 0 }, data: { label: "src" } },
  { id: "tgt", position: { x: 300, y: 0 }, data: { label: "tgt" } },
];

function makeEdge(data: ItemEdgeData): Edge {
  return {
    id: "e1",
    type: "item",
    source: "src",
    target: "tgt",
    data: data as unknown as Record<string, unknown>,
  };
}

function renderEdge(data: ItemEdgeData) {
  return render(
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodes={NODES} edges={[makeEdge(data)]} edgeTypes={edgeTypes} />
    </div>,
  );
}

async function findEdgePath(): Promise<SVGPathElement> {
  let path: SVGPathElement | null = null;
  await waitFor(() => {
    // BaseEdge renders the visible stroke as the first <path> inside the
    // React Flow edge group; the second is the wider interaction layer.
    path = document.querySelector<SVGPathElement>(
      ".react-flow__edge .react-flow__edge-path",
    );
    expect(path).not.toBeNull();
  });
  return path as unknown as SVGPathElement;
}

describe("canvas/ItemEdge transport-kind styling", () => {
  it("renders a solid stroke (no dasharray) for transportKind belt", async () => {
    renderEdge({
      item: "copper_nugget",
      rate: new Fraction(1),
      transportKind: "belt",
    });
    const path = await findEdgePath();
    // ItemEdge passes the stroke via inline style; jsdom exposes it as the
    // strokeDasharray DOM property. Belt = solid: dasharray must be empty.
    expect(path.style.strokeDasharray).toBe("");
    expect(path.getAttribute("data-transport-kind")).toBe("belt");
  });

  it("renders a dashed stroke (4 2) for transportKind pipe", async () => {
    renderEdge({
      item: "water",
      rate: new Fraction(1),
      transportKind: "pipe",
    });
    const path = await findEdgePath();
    // Normalise the comma form some browsers emit (e.g. "4, 2"), then compare
    // to the chosen pattern.
    const dash = path.style.strokeDasharray.replace(/,\s*/g, " ");
    expect(dash).toBe("4 2");
    expect(path.getAttribute("data-transport-kind")).toBe("pipe");
  });

  it("falls back to belt styling for an unknown transportKind without throwing", async () => {
    renderEdge({
      item: "phantom_item",
      rate: new Fraction(1),
      transportKind: "phantom",
    });
    const path = await findEdgePath();
    expect(path.style.strokeDasharray).toBe("");
    // The data attribute echoes whatever the caller supplied (the kind is
    // opaque); only the visual fallback is locked here.
    expect(path.getAttribute("data-transport-kind")).toBe("phantom");
  });

  it("falls back to belt styling when transportKind is absent (legacy edges)", async () => {
    renderEdge({ item: "copper_nugget", rate: new Fraction(1) });
    const path = await findEdgePath();
    expect(path.style.strokeDasharray).toBe("");
    // The data attribute is omitted entirely when transportKind is absent so
    // selectors can distinguish "real belt" from "unclassified legacy edge".
    expect(path.hasAttribute("data-transport-kind")).toBe(false);
  });
});
