import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import BusEdge from "../../src/canvas/BusEdge";
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

  it("draws a junction dot at the branch point (riseX - CHAMFER, laneY)", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      laneY: 500,
      trunkKey: "Iron Plate|src",
    });
    await findEdgePath();
    const dot = document.querySelector<SVGCircleElement>("circle");
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("cy")).toBe("500");
  });
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
      0.6,
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

  it("renders no chips below the zoom threshold", async () => {
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      0.4,
    );
    await findEdgePath();
    expect(chips()).toHaveLength(0);
  });
});
