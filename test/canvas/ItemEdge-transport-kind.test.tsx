import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, {
  strokeColorForKind,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";
import { itemColor } from "../../src/canvas/itemColor";

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
  // Every carrier draws the same line: solid. The kind survives on the line
  // only as the data attribute selectors and the exam probes read; what tells a
  // belt from a pipe visually is the port glyph.
  it.each(["belt", "pipe", "gas"] as const)(
    "renders a solid stroke and stamps the kind for transportKind %s",
    async (transportKind) => {
      renderEdge({
        item: "copper_nugget",
        rate: new Fraction(1),
        transportKind,
      });
      const path = await findEdgePath();
      // ItemEdge passes the stroke via inline style; jsdom exposes it as the
      // strokeDasharray DOM property. Solid = the dasharray must be empty.
      expect(path.style.strokeDasharray).toBe("");
      expect(path.getAttribute("data-transport-kind")).toBe(transportKind);
    },
  );

  it("colors a gas edge by item, like belt and pipe edges", async () => {
    renderEdge({
      item: "gas_water",
      rate: new Fraction(1),
      transportKind: "gas",
    });
    const path = await findEdgePath();
    // itemColor drives the stroke for every kind; only the no-item fallback
    // differs per kind, and that is pinned in the block below.
    expect(path.style.stroke).not.toBe("");
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

// The catalyst pool's stroke identity: the same colour as any other edge of
// that item, and the only dashed line on the canvas. The dash marks the role,
// so it is the same pattern whatever carrier the charge rides.
describe("canvas/ItemEdge catalyst stroke", () => {
  const dashOf = (path: SVGPathElement): string =>
    path.style.strokeDasharray.replace(/,\s*/g, " ");

  it.each(["belt", "gas"] as const)(
    "stamps data-pool and dashes a catalyst edge on %s",
    async (transportKind) => {
      renderEdge({
        item: "gas_xiranite",
        rate: new Fraction(1),
        transportKind,
        fromPool: "catalyst",
      });
      const base = await findEdgePath();
      expect(base.getAttribute("data-pool")).toBe("catalyst");
      expect(dashOf(base)).toBe("5 3");
    },
  );

  it("leaves a raw edge of the same item solid and unstamped", async () => {
    renderEdge({
      item: "gas_xiranite",
      rate: new Fraction(1),
      transportKind: "gas",
    });
    const base = await findEdgePath();
    expect(base.hasAttribute("data-pool")).toBe(false);
    expect(dashOf(base)).toBe("");
  });
});

// The fallback colors only show on edges with no item id (older fixtures and
// tests), so they are easier to pin directly than through a render.
describe("canvas/ItemEdge strokeColorForKind fallbacks", () => {
  it("gives gas its own fallback stroke, distinct from pipe", () => {
    expect(strokeColorForKind("gas")).toBe("#22d3ee");
    expect(strokeColorForKind("gas")).not.toBe(strokeColorForKind("pipe"));
  });

  it("prefers the item color over the gas fallback when an item is given", () => {
    expect(strokeColorForKind("gas", "gas_water")).toBe(itemColor("gas_water"));
  });
});
