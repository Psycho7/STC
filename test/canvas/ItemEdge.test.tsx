import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, {
  CHIP_ICON_ONLY_MAX_ZOOM,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";
import { parsePathPoints } from "../../src/canvas/edgePath";
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
          minZoom={0.05}
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

describe("canvas/ItemEdge zoom gating", () => {
  it("hides the label when zoomed below the threshold", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }, 0.3);
    const label = await findLabel();
    expect(label).toBeNull();
  });

  it("shows the label at the threshold zoom", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }, 0.35);
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

describe("canvas/ItemEdge icon-only collapse", () => {
  const belowIconOnly = CHIP_ICON_ONLY_MAX_ZOOM - 0.05;

  it("keeps the zoom-gated rate chip hidden below the icon-only zoom, never collapsing it to an icon", async () => {
    // The plain member rate chip is gated by LABEL_MIN_ZOOM (0.35), a HIGHER
    // gate than the icon-only zoom. Below the icon-only zoom it must stay fully
    // hidden -- it must not turn into an icon-only chip the way the exempt
    // aggregates do.
    renderEdge({ item: "belt", rate: new Fraction(2, 1) }, belowIconOnly);
    const label = await findLabel();
    expect(label).toBeNull();
  });

  it("collapses the exempt fan-in Sigma aggregate to icon-only below the icon-only zoom", async () => {
    // Discover the live target port y from a plain render so the fan-in marker
    // is seated on it (faninStale compares the stamp to the live targetY).
    renderEdge({ item: "belt", rate: new Fraction(2, 1) }, 1);
    await waitFor(() =>
      expect(
        document.querySelector(".react-flow__edge-path"),
      ).not.toBeNull(),
    );
    const pts = parsePathPoints(
      document
        .querySelector<SVGPathElement>(".react-flow__edge-path")!
        .getAttribute("d")!,
    );
    const targetY = pts[pts.length - 1]![1];
    cleanup();

    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        faninJunctionX: 120,
        faninJunctionY: targetY,
        faninSigmaX: 150,
        faninSigmaY: targetY,
        faninTotalRate: new Fraction(5, 1), // 300/min
        faninMemberCount: 3,
      },
      belowIconOnly,
    );
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge")).not.toBeNull(),
    );
    const sigma = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-fanin-e1-drop"]',
    );
    expect(sigma).not.toBeNull();
    // Icon kept, only the sum glyph in the body, digits dropped.
    expect(sigma!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
    expect(sigma!.textContent).toBe("Σ");
    expect(sigma!.classList.contains("icon-only")).toBe(true);
    // The exact total still rides the hover tooltip.
    expect(sigma!.getAttribute("title")).toContain("Σ300/min");
  });

  it("marks the fan-in Sigma chip with the sigma variant class", async () => {
    // The aggregate is styled as a summary tag of the junction beside it, not
    // as one more per-edge rate chip, so it carries its own variant class.
    renderEdge({ item: "belt", rate: new Fraction(2, 1) }, 1);
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    const pts = parsePathPoints(
      document
        .querySelector<SVGPathElement>(".react-flow__edge-path")!
        .getAttribute("d")!,
    );
    const targetY = pts[pts.length - 1]![1];
    cleanup();

    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        faninJunctionX: 120,
        faninJunctionY: targetY,
        faninSigmaX: 150,
        faninSigmaY: targetY,
        faninTotalRate: new Fraction(5, 1),
        faninMemberCount: 3,
      },
      1,
    );
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge")).not.toBeNull(),
    );
    const sigma = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-fanin-e1-drop"]',
    );
    expect(sigma).not.toBeNull();
    expect(sigma!.classList.contains("sigma")).toBe(true);
  });
});

describe("canvas/ItemEdge hover reveal", () => {
  it("reveals the rate chip of a focused edge below the label zoom gate", async () => {
    // Hovering singles out one edge to ask for its rate, so the lit edge's chip
    // is exempt from LABEL_MIN_ZOOM: at the dense-plan fit zoom the hover would
    // otherwise answer with no number anywhere.
    renderEdge(
      { item: "Iron Plate", rate: new Fraction(2, 1), focused: true },
      0.3,
    );
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("120/min");
  });

  it("keeps a focused chip's digits below the icon-only zoom", async () => {
    renderEdge(
      { item: "Iron Plate", rate: new Fraction(2, 1), focused: true },
      CHIP_ICON_ONLY_MAX_ZOOM - 0.05,
    );
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("icon-only")).toBe(false);
    expect(label!.textContent).toBe("120/min");
  });
});

describe("canvas/ItemEdge label placement", () => {
  function transformFor(label: HTMLElement): string {
    return label.style.transform;
  }

  it("anchors the label on its clear corridor (bend-vertical) segment", async () => {
    // Nodes at different y so the drawn path bends: the forward step has a
    // vertical bend column. The clear-segment anchor (2B) rides that vertical,
    // NOT the geometric midpoint (which drifts onto a horizontal) and NOT the
    // old labelSide target-y pin. labelSide is set to prove it no longer moves
    // the label.
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
    const path = document.querySelector<SVGPathElement>(
      ".react-flow__edge-path",
    );
    expect(path).not.toBeNull();
    const d = path!.getAttribute("d")!;
    const m = transformFor(label!).match(
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/,
    )!;
    const ax = Number(m[1]);
    const ay = Number(m[2]);
    // Parse the polyline and find the segment the anchor sits on.
    const pts = parsePathPoints(d);
    const onSegment = (
      p: readonly [number, number],
      a: readonly [number, number],
      b: readonly [number, number],
    ): boolean => {
      const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (Math.abs(cross) > 1) return false;
      const within = (lo: number, hi: number, v: number) =>
        v >= Math.min(lo, hi) - 1 && v <= Math.max(lo, hi) + 1;
      return within(a[0], b[0], p[0]) && within(a[1], b[1], p[1]);
    };
    let host: readonly [readonly [number, number], readonly [number, number]] | null =
      null;
    for (let i = 1; i < pts.length; i++) {
      if (onSegment([ax, ay], pts[i - 1]!, pts[i]!)) {
        host = [pts[i - 1]!, pts[i]!];
        break;
      }
    }
    // The anchor lies on the polyline...
    expect(host).not.toBeNull();
    // ...and specifically on a VERTICAL segment (the preferred corridor leg).
    expect(host![0][0]).toBe(host![1][0]);
    // The old behavior pinned y to targetY (the path's final point); the
    // clear-segment anchor must not sit at the target level.
    const targetY = Number(d.match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/)![2]);
    expect(ay).not.toBe(targetY);
  });

  it("falls back to the smoothstep midpoint when labelSide is undefined", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    // Midpoint x sits between source and target x; the label still renders.
    expect(transformFor(label!)).toMatch(/translate\(.+px,.+px\)/);
  });
});
