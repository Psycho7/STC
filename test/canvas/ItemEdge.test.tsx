import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, { type ItemEdgeData } from "../../src/canvas/ItemEdge";
import { pathMidpoint } from "../../src/canvas/edgePath";
import { itemColor } from "../../src/canvas/itemColor";
import { LocaleProvider } from "../../src/data/i18n-context";

afterEach(() => {
  cleanup();
});

const edgeTypes = { item: ItemEdge };

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

function makeEdge(data: ItemEdgeData): Edge {
  return {
    id: "e1",
    type: "item",
    source: "src",
    target: "tgt",
    data: data as unknown as Record<string, unknown>,
  };
}

function renderEdge(data: ItemEdgeData, zoom?: number) {
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

async function findLabel(): Promise<HTMLElement | null> {
  let label: HTMLElement | null = null;
  await waitFor(() => {
    label = document.querySelector<HTMLElement>(
      '[data-testid="item-edge-label-e1"]',
    );
    const edgePath = document.querySelector(".react-flow__edge");
    expect(edgePath).not.toBeNull();
  });
  return label;
}

describe("canvas/ItemEdge", () => {
  it("renders '150/min' chip body for Fraction(5, 2) (2.5/s * 60)", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(5, 2) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("150/min");
    expect(label!.getAttribute("aria-label")).toBe("Iron Plate x 150/min");
    expect(label!.getAttribute("title")).toBe("Iron Plate x 150/min");
  });

  it("renders '240/min' chip body for Fraction(4, 1) (4/s * 60)", async () => {
    renderEdge({ item: "Copper Plate", rate: new Fraction(4, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("240/min");
    expect(label!.getAttribute("aria-label")).toBe("Copper Plate x 240/min");
  });

  it("renders '90/min' chip body for Fraction(3, 2) (1.5/s * 60)", async () => {
    renderEdge({ item: "Gear", rate: new Fraction(3, 2) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("90/min");
    expect(label!.getAttribute("aria-label")).toBe("Gear x 90/min");
  });

  it("does not render a label when rate is Fraction(0, 1)", async () => {
    renderEdge({ item: "Nothing", rate: new Fraction(0, 1) });
    const label = await findLabel();
    expect(label).toBeNull();
  });

  it("leaves pointerEvents unset so the title tooltip is hoverable", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.style.pointerEvents).toBe("");
  });

  it("applies nodrag and nopan classes to the label", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("nodrag")).toBe(true);
    expect(label!.classList.contains("nopan")).toBe(true);
  });

  it("renders the label inside .flow-chip without .red when isTearEdge is absent", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("flow-chip")).toBe(true);
    expect(label!.classList.contains("red")).toBe(false);
  });

  it("renders .flow-chip.red when isTearEdge is true", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      isTearEdge: true,
    });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("flow-chip")).toBe(true);
    expect(label!.classList.contains("red")).toBe(true);
  });

  it("sets --chip-accent to itemColor of the edge item", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.style.getPropertyValue("--chip-accent")).toBe(
      itemColor("Iron Plate"),
    );
  });

  it("renders an .ico-16 .spr sprite for a known item id inside the flow-chip", async () => {
    renderEdge({ item: "belt", rate: new Fraction(1, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    const spr = label!.querySelector<HTMLElement>(".ico.ico-16 .spr");
    expect(spr).not.toBeNull();
    expect(spr!.style.backgroundPosition).not.toBe("");
  });

  it("omits the sprite slot when the item id has no icon entry", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.querySelector(".ico.ico-16")).toBeNull();
  });
});

async function findEntry(): Promise<HTMLElement | null> {
  let entry: HTMLElement | null = null;
  await waitFor(() => {
    entry = document.querySelector<HTMLElement>(
      '[data-testid="item-edge-entry-e1"]',
    );
    const edgePath = document.querySelector(".react-flow__edge");
    expect(edgePath).not.toBeNull();
  });
  return entry;
}

describe("canvas/ItemEdge entry chip", () => {
  it("renders an icon-only entry chip when multiInputTarget and zoom >= gate", async () => {
    renderEdge(
      { item: "belt", rate: new Fraction(1), multiInputTarget: true },
      0.6,
    );
    const entry = await findEntry();
    expect(entry).not.toBeNull();
    expect(entry!.classList.contains("flow-chip")).toBe(true);
    expect(entry!.classList.contains("entry")).toBe(true);
    // Icon-only: the sprite is present and there is no rate text in the body.
    expect(entry!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
    expect(entry!.textContent).toBe("");
  });

  it("names the item on title and aria-label", async () => {
    renderEdge(
      { item: "belt", rate: new Fraction(1), multiInputTarget: true },
      0.6,
    );
    const entry = await findEntry();
    expect(entry).not.toBeNull();
    // The rate is per-second * 60; Fraction(1) -> 60/min. The exact item name
    // comes from i18n, so only the "Name x <rate>/min" tail is pinned here.
    expect(entry!.getAttribute("title")).toMatch(/ x 60\/min$/);
    expect(entry!.getAttribute("aria-label")).toBe(entry!.getAttribute("title"));
  });

  it("sets --chip-accent to itemColor of the edge item", async () => {
    renderEdge(
      { item: "belt", rate: new Fraction(1), multiInputTarget: true },
      0.6,
    );
    const entry = await findEntry();
    expect(entry).not.toBeNull();
    expect(entry!.style.getPropertyValue("--chip-accent")).toBe(
      itemColor("belt"),
    );
  });

  it("does not render the entry chip when multiInputTarget is absent", async () => {
    renderEdge({ item: "belt", rate: new Fraction(1) }, 0.6);
    const entry = await findEntry();
    expect(entry).toBeNull();
  });

  it("does not render the entry chip when zoom is below the gate", async () => {
    renderEdge(
      { item: "belt", rate: new Fraction(1), multiInputTarget: true },
      0.4,
    );
    const entry = await findEntry();
    expect(entry).toBeNull();
  });
});

describe("canvas/ItemEdge zoom gating", () => {
  it("hides the label when zoomed below the threshold", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }, 0.4);
    const label = await findLabel();
    expect(label).toBeNull();
  });

  it("shows the label at the threshold zoom", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }, 0.6);
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("120/min");
  });

  it("shows the label when zoomed in", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }, 1.5);
    const label = await findLabel();
    expect(label).not.toBeNull();
  });
});

describe("canvas/ItemEdge label placement", () => {
  function transformFor(label: HTMLElement): string {
    return label.style.transform;
  }

  it("anchors the label at the path midpoint regardless of labelSide", async () => {
    // Nodes at different y so the drawn path bends: the length midpoint's y
    // then differs from targetY, which is where the old labelSide override
    // pinned the chip. labelSide is set to prove it no longer moves the label.
    const nodes: Node[] = [
      { id: "src", position: { x: 0, y: 0 }, data: { label: "src" } },
      { id: "tgt", position: { x: 300, y: 100 }, data: { label: "tgt" } },
    ];
    render(
      <LocaleProvider locale="en">
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow
            nodes={nodes}
            edges={[
              makeEdge({
                item: "Iron Plate",
                rate: new Fraction(2, 1),
                labelSide: "target",
              }),
            ]}
            edgeTypes={edgeTypes}
          />
        </div>
      </LocaleProvider>,
    );
    const label = await findLabel();
    expect(label).not.toBeNull();
    // The rendered edge path and the chip share the same graph coordinate
    // space, so the chip's translate must equal pathMidpoint of the drawn d.
    const path = document.querySelector<SVGPathElement>(
      ".react-flow__edge-path",
    );
    expect(path).not.toBeNull();
    const d = path!.getAttribute("d")!;
    const [mx, my] = pathMidpoint(d);
    expect(transformFor(label!)).toBe(
      `translate(-50%, -50%) translate(${mx}px, ${my}px)`,
    );
    // The old behavior pinned y to targetY (the path's final point) when
    // labelSide was "target"; the midpoint anchor must not do that here.
    const ty = Number(d.match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/)![2]);
    expect(my).not.toBe(ty);
  });

  it("falls back to the smoothstep midpoint when labelSide is undefined", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    // Midpoint x sits between source and target x; the label still renders.
    expect(transformFor(label!)).toMatch(/translate\(.+px,.+px\)/);
  });
});
