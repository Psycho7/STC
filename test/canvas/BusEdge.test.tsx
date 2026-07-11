import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import BusEdge, { junctionRadius } from "../../src/canvas/BusEdge";
import type { BusEdgeData } from "../../src/canvas/busRouting";
import type { ItemEdgeData } from "../../src/canvas/ItemEdge";
import { itemColor } from "../../src/canvas/itemColor";
import { LocaleProvider } from "../../src/data/i18n-context";
import { expectRightwardFinish } from "./pathAssertions";

afterEach(() => {
  cleanup();
});

const edgeTypes = { bus: BusEdge };

const NODES: Node[] = [
  {
    id: "src",
    position: { x: 0, y: 0 },
    data: { label: "src" },
  },
  {
    id: "tgt",
    position: { x: 300, y: 0 },
    data: { label: "tgt" },
  },
];

type BusData = ItemEdgeData & BusEdgeData;

function makeEdge(data: BusData): Edge {
  return {
    id: "e1",
    type: "bus",
    source: "src",
    target: "tgt",
    data: data as unknown as Record<string, unknown>,
  };
}

function renderEdge(data: BusData, zoom?: number) {
  return render(
    <LocaleProvider locale="en">
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow
          nodes={NODES}
          edges={[makeEdge(data)]}
          edgeTypes={edgeTypes}
          minZoom={0.05}
          {...(zoom !== undefined
            ? { defaultViewport: { x: 0, y: 0, zoom } }
            : {})}
        />
      </div>
    </LocaleProvider>,
  );
}

async function findEdgePath(): Promise<SVGPathElement> {
  let path: SVGPathElement | null = null;
  await waitFor(() => {
    path = document.querySelector<SVGPathElement>(".react-flow__edge-path");
    expect(path).not.toBeNull();
  });
  return path!;
}

describe("canvas/BusEdge", () => {
  it("routes the path drop -> lane run -> rise through data.laneY", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      laneY: 500,
      trunkKey: "Iron Plate|src",
    });
    const path = await findEdgePath();
    const d = path.getAttribute("d") ?? "";
    // The lane run sits at laneY = 500 (appears as the y of the lane points).
    expect(d).toContain(",500");
    // The path enters the target with a final rightward horizontal so the arrow
    // points right.
    expectRightwardFinish(d);
  });

  it("draws the junction dot in the HTML label layer at (branch point, laneY)", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      laneY: 500,
      trunkKey: "Iron Plate|src",
    });
    await findEdgePath();
    // No SVG circle any more: the dot moved into the label layer so it z-wins
    // over the aggregate chip.
    expect(document.querySelector("circle")).toBeNull();
    const dot = document.querySelector<HTMLElement>(
      '[data-testid="bus-junction-e1"]',
    );
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains("bus-junction")).toBe(true);
    // Centred on the branch point via the double translate: the -50%,-50% centre
    // plus an explicit numeric x on the branch column and laneY = 500 on the y.
    // Pin both axes so an axis swap or a dropped coordinate fails, not just y.
    expect(dot!.style.transform).toMatch(
      /translate\(-50%, -50%\) translate\(-?\d[\d.]*px, 500px\)/,
    );
    // Not dimmed when the edge carries no dim state.
    expect(dot!.classList.contains("dimmed")).toBe(false);
  });

  it("dims the junction dot when its edge is dimmed", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      laneY: 500,
      trunkKey: "Iron Plate|src",
      dimmed: true,
    } as unknown as BusData);
    await findEdgePath();
    const dot = document.querySelector<HTMLElement>(
      '[data-testid="bus-junction-e1"]',
    );
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains("dimmed")).toBe(true);
  });
});

describe("canvas/BusEdge junctionRadius clamp", () => {
  // The dot is drawn in graph units, so its on-screen radius is r * zoom. The
  // clamp keeps that screen radius inside [3, 5] px across zoom: below zoom 1 the
  // graph radius grows to hold the 3px floor, above it (zoom 2.0) it stops at the
  // 5px cap.
  it.each([0.2, 0.5, 1.0, 2.0])(
    "keeps the screen radius in [3, 5] at zoom %s",
    (zoom) => {
      const screen = junctionRadius(zoom) * zoom;
      expect(screen).toBeGreaterThanOrEqual(3);
      expect(screen).toBeLessThanOrEqual(5);
    },
  );
});

describe("canvas/BusEdge trunk labels", () => {
  function chips(): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="bus-edge-label-e1"]'),
    );
  }

  it("renders two rate chips at drop and rise points when zoomed in", async () => {
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      1,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.textContent).toBe("120/min");
      expect(label.getAttribute("aria-label")).toBe("Iron Plate x 120/min");
    }
  });

  it("renders two chips at the threshold zoom", async () => {
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      0.35,
    );
    await findEdgePath();
    expect(chips()).toHaveLength(2);
  });

  it("sets --chip-accent to itemColor of the edge item on both chips", async () => {
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      1,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(label.style.getPropertyValue("--chip-accent")).toBe(
        itemColor("Iron Plate"),
      );
    }
  });

  it("renders only the aggregate drop chip below the zoom threshold", async () => {
    // Below LABEL_MIN_ZOOM the per-member rise chip is gated, but the owner's
    // aggregate drop chip is exempt so the trunk's total survives at the
    // dense-plan fit zoom (this lone member is its own owner, showing its rate as
    // the total).
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      0.3,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.getAttribute("data-testid")).toBe("bus-edge-label-e1-drop");
    expect(labels[0]!.textContent).toBe("120/min");
  });
});
