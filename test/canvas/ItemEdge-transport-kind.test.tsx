import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, {
  strokeForKind,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";

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

  it("renders a dash-dot stroke (6 2 1 2) for transportKind gas", async () => {
    renderEdge({
      item: "gas_water",
      rate: new Fraction(1),
      transportKind: "gas",
    });
    const path = await findEdgePath();
    const dash = path.style.strokeDasharray.replace(/,\s*/g, " ");
    expect(dash).toBe("6 2 1 2");
    // The attribute is what the gas dim and hover rules in canvas.css select
    // on, so it is part of the contract, not an implementation detail.
    expect(path.getAttribute("data-transport-kind")).toBe("gas");
  });

  it("colors a gas edge by item, like belt and pipe edges", async () => {
    renderEdge({
      item: "gas_water",
      rate: new Fraction(1),
      transportKind: "gas",
    });
    const path = await findEdgePath();
    // itemColor drives the stroke for every kind; only the no-item fallback
    // differs per kind, and that is pinned in the strokeForKind block below.
    expect(path.style.stroke).not.toBe("");
  });

  it("keeps the gas attribute on a dimmed edge, which is what the gas dim rule selects on", async () => {
    // jsdom does not apply the stylesheet, so this pins the hook the CSS needs
    // rather than the fade itself; the rendered result is checked in a browser.
    renderEdge({
      item: "gas_water",
      rate: new Fraction(1),
      transportKind: "gas",
      dimmed: true,
    });
    const path = await findEdgePath();
    expect(path.getAttribute("data-transport-kind")).toBe("gas");
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

// The fallback colors only show on edges with no item id (older fixtures and
// tests), so they are easier to pin directly than through a render.
describe("canvas/ItemEdge strokeForKind fallbacks", () => {
  it("gives gas its own fallback stroke, distinct from pipe", () => {
    const gas = strokeForKind("gas");
    const pipe = strokeForKind("pipe");
    expect(gas.stroke).toBe("#22d3ee");
    expect(gas.stroke).not.toBe(pipe.stroke);
    expect(gas.strokeDasharray).toBe("6 2 1 2");
  });

  it("prefers the item color over the gas fallback when an item is given", () => {
    const withItem = strokeForKind("gas", "gas_water");
    expect(withItem.stroke).not.toBe("#22d3ee");
    expect(withItem.strokeDasharray).toBe("6 2 1 2");
  });
});
