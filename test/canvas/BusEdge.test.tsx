import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import BusEdge, { junctionRadius } from "../../src/canvas/BusEdge";
import type { BusEdgeData } from "../../src/canvas/busRouting";
import { busRiseBase } from "../../src/canvas/edgePath";
import {
  CHIP_ICON_ONLY_MAX_ZOOM,
  LABEL_MIN_ZOOM,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";
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

// Same src / tgt ids as NODES, but the target sits far downstream so the lane
// run spans several layers -- a "long detour" for the consumer-labeling gate.
const FAR_NODES: Node[] = [
  { id: "src", position: { x: 0, y: 0 }, data: { label: "src" } },
  { id: "tgt", position: { x: 2000, y: 0 }, data: { label: "tgt" } },
];

function renderEdge(data: BusData, zoom?: number, nodes: Node[] = NODES) {
  return render(
    <LocaleProvider locale="en">
      <div style={{ width: 800, height: 600 }}>
        <ReactFlow
          nodes={nodes}
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

  it("draws no aggregate chip on a multi-member trunk", async () => {
    // A multi-member trunk draws no drop chip: its summed total restated the
    // source card's own rate one card-width away while reading as one more
    // flow, so the members' own chips and the card rates carry the information
    // (issue #39).
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1), // this member: 60/min
        laneY: 500,
        trunkKey: "Iron Plate|src",
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1), // trunk total: 120/min
        busMemberCount: 2,
      },
      1,
    );
    await findEdgePath();
    expect(
      document.querySelector('[data-testid="bus-edge-label-e1-drop"]'),
    ).toBeNull();
    // The member's own rise chip carries the share instead: compact digits on
    // the chip (no unit, so the pair fits the fixed chip box), full wording
    // with the localized unit on the hover / aria text.
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/120");
    expect(rise!.getAttribute("aria-label")).toBe("Iron Plate x 60 of 120/min");
    expect(rise!.getAttribute("title")).toBe("Iron Plate x 60 of 120/min");
  });

  it("keeps the plain rate on a single-member trunk's chips", async () => {
    // The share form is a multi-member affordance only: on a lone member the
    // rate IS the trunk total, so "60/60" would be noise. Both chips keep the
    // plain "rate + unit" reading.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
        busChipOwner: true,
        busTotalRate: new Fraction(1, 1),
        busMemberCount: 1,
      },
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/min");
    expect(rise!.getAttribute("aria-label")).toBe("Iron Plate x 60/min");
  });

  it("shares the fan-out branch chips of a multi-member trunk too", async () => {
    // Workstream B applies to every multi-member trunk member, lane rise and
    // fan-out branch alike -- the branch chip reads the same share form.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        trunkKey: "Iron Plate|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busDisplayTotalRate: new Fraction(2, 1),
        busMemberCount: 3,
      } as BusData,
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/120");
  });

  it("shows the DRAWN trunk total on the chip and the exact total on hover", async () => {
    // The chip total is the trunk's displayed total (the same rounding the
    // member chips use), so the visible members sum to the number shown; the
    // tooltip keeps the exact total behind it.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busDisplayTotalRate: new Fraction(199, 100),
        busMemberCount: 2,
      },
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/119.4");
    expect(rise!.getAttribute("title")).toBe("Iron Plate x 60 of 120/min");
  });

  it("skips the branch chip of a fan-out member flagged fanoutBranchHidden", async () => {
    // deconflictChipAnchors hides a branch chip when no chip/card-clear seat
    // exists anywhere on the member's own polyline (a narrow-corridor fan-out
    // whose aggregate covers the whole short path). This trunk is multi-member,
    // so it draws no aggregate either: the member is left with no chip at all
    // and its share rides the hover tooltip (next test).
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        trunkKey: "Iron Plate|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 2,
        fanoutBranchHidden: true,
      } as BusData,
      1,
    );
    await findEdgePath();
    expect(
      document.querySelector('[data-testid="bus-edge-label-e1-rise"]'),
    ).toBeNull();
    expect(chips()).toHaveLength(0);
  });

  it("drops a stale hide on real anchor divergence but rides out reconstruction noise", async () => {
    // fanoutBranchHidden is decided from layout-time geometry, but nodes stay
    // mouse-draggable. The hide carries the branch anchor it was decided at;
    // once the live recomputed anchor truly diverges (the user dragged the
    // fan-out apart), the hide is stale and the member's rate chip must
    // return. The stamp comes from the seating pass's port reconstruction,
    // which disagrees with React Flow's measured handles by up to ~1 unit, so
    // a mismatch that small is noise, not a drag, and must keep the hide.
    const fanData = {
      item: "Iron Plate",
      rate: new Fraction(1, 1),
      trunkKey: "Iron Plate|src",
      fanout: true,
      busChipOwner: true,
      busTotalRate: new Fraction(2, 1),
      busMemberCount: 2,
    } as BusData;
    // Measure the live branch anchor from an unhidden render's rise chip.
    renderEdge(fanData, 1);
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    const m = rise!.style.transform.match(
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/,
    );
    const anchor = { x: Number(m![1]), y: Number(m![2]) };
    cleanup();

    // A stamp off by a unit is reconstruction noise: the hide holds. The trunk
    // is multi-member, so no aggregate chip stands in for it either.
    renderEdge(
      {
        ...fanData,
        fanoutBranchHidden: true,
        fanoutBranchHiddenAt: { x: anchor.x + 1, y: anchor.y - 1 },
      } as BusData,
      1,
    );
    await findEdgePath();
    expect(chips()).toHaveLength(0);
    cleanup();

    // A stamp a hundred units away is a drag: the hide is stale, chip returns.
    renderEdge(
      {
        ...fanData,
        fanoutBranchHidden: true,
        fanoutBranchHiddenAt: { x: anchor.x - 100, y: anchor.y },
      } as BusData,
      1,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(1);
    expect(labels.map((l) => l.getAttribute("data-testid"))).toContain(
      "bus-edge-label-e1-rise",
    );
  });

  it("keeps a hidden branch's share reachable as a native tooltip on its path", async () => {
    // The hidden branch chip was the only carrier of the member's exact-rate
    // title. A transparent hover path with an SVG <title> keeps the share
    // reachable on the edge itself, so hiding the chip loses no information.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        trunkKey: "Iron Plate|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 2,
        fanoutBranchHidden: true,
      } as BusData,
      1,
    );
    await findEdgePath();
    const title = document.querySelector(".react-flow__edge title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Iron Plate x 60 of 120/min");
  });

  it("renders only the aggregate drop chip below the zoom threshold", async () => {
    // In the band between the icon-only gate and LABEL_MIN_ZOOM the per-member
    // rise chip is gated, but the owner's aggregate drop chip is exempt and still
    // carries its full total (this lone member is its own owner, showing its rate
    // as the total). NODES are one layer apart, so the lane run is short and the
    // consumer-labeling exemption (#32) does not trigger. Zoom sits above the
    // icon-only gate so the aggregate keeps its digits (the collapse below it has
    // its own test).
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      (CHIP_ICON_ONLY_MAX_ZOOM + LABEL_MIN_ZOOM) / 2,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(1);
    expect(labels[0]!.getAttribute("data-testid")).toBe("bus-edge-label-e1-drop");
    expect(labels[0]!.textContent).toBe("120/min");
  });

  it("reveals a focused member's rise chip below the zoom threshold", async () => {
    // Canvas's hover focus stamps `focused` on every lit edge; the lit member's
    // rise chip then survives the zoom gate and the aggregate keeps its digits,
    // so the hover shows a rate at fit zoom.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
        focused: true,
      },
      0.3,
    );
    await findEdgePath();
    const drop = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-drop"]',
    );
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(drop).not.toBeNull();
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("120/min");
    expect(drop!.classList.contains("icon-only")).toBe(false);
  });

  it("exempts the rise chip on a lone member's long detour below the zoom threshold", async () => {
    // A single-member trunk whose lane run spans several layers (FAR_NODES) is a
    // long detour: its rise end sits far from the source-side drop chip, so the
    // consumer would arrive unlabeled at fit zoom. The rise chip is exempted from
    // the zoom gate too, so both ends are labeled (#32). routeBusEdges omits the
    // lane slot (busChipX) for this case -- as this manually built edge does --
    // so the chip must anchor at the geometric rise column (busRiseBase of the
    // target port), the consumer end, not mid-lane.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
      },
      0.3,
      FAR_NODES,
    );
    const path = await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.getAttribute("data-testid")).sort()).toEqual([
      "bus-edge-label-e1-drop",
      "bus-edge-label-e1-rise",
    ]);
    // Anchor check: the rise chip's x sits on the drawn rise column, one
    // busRiseBase inside the target port (the path's final point).
    const end = path
      .getAttribute("d")!
      .match(/L\s*(-?[\d.]+),(-?[\d.]+)\s*$/);
    const tx = Number(end![1]);
    const rise = labels.find(
      (l) => l.getAttribute("data-testid") === "bus-edge-label-e1-rise",
    )!;
    const t = rise.style.transform.match(
      /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/,
    );
    expect(Number(t![1])).toBeCloseTo(busRiseBase(tx), 1);
  });

  it("collapses the exempt aggregate drop chip to icon-only below the icon-only zoom", async () => {
    // "belt" carries a sprite, so the icon survives the collapse. A lone member
    // is its own owner and its drop chip carries no marker, so the collapsed
    // body is empty.
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "belt|src",
      },
      CHIP_ICON_ONLY_MAX_ZOOM - 0.05,
    );
    await findEdgePath();
    const drop = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-drop"]',
    );
    expect(drop).not.toBeNull();
    expect(drop!.classList.contains("icon-only")).toBe(true);
    expect(drop!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
    expect(drop!.textContent).toBe("");
    // The exact rate still rides the hover tooltip.
    expect(drop!.getAttribute("title")).toContain("120/min");
  });

  it("renders the full aggregate chip at the icon-only zoom threshold", async () => {
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "belt|src",
      },
      CHIP_ICON_ONLY_MAX_ZOOM,
    );
    await findEdgePath();
    const drop = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-drop"]',
    );
    expect(drop).not.toBeNull();
    expect(drop!.classList.contains("icon-only")).toBe(false);
    expect(drop!.textContent).toBe("120/min");
  });

  it("collapses a lone member's exempt long-detour rise chip to icon-only", async () => {
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        laneY: 500,
        trunkKey: "belt|src",
      },
      CHIP_ICON_ONLY_MAX_ZOOM - 0.05,
      FAR_NODES,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.classList.contains("icon-only")).toBe(true);
    expect(rise!.textContent).toBe("");
    expect(rise!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
  });

  it("keeps a multi-member trunk's rise chips gated on a long detour", async () => {
    // The exemption is lone-member only: a multi-member trunk's per-member rise
    // chips stay behind the zoom gate even on a long run, so a dense bus stays
    // legible at fit zoom. Such a trunk draws no aggregate either, so it is
    // unlabeled at this zoom and the shares ride the hover.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        laneY: 500,
        trunkKey: "Iron Plate|src",
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 2,
      },
      0.3,
      FAR_NODES,
    );
    await findEdgePath();
    expect(
      document.querySelector('[data-testid="bus-edge-label-e1-rise"]'),
    ).toBeNull();
    expect(chips()).toHaveLength(0);
  });
});
