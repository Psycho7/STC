import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import BusEdge, { junctionRadius } from "../../src/canvas/BusEdge";
import type { BusEdgeData } from "../../src/canvas/busRouting";
import { parsePathPoints } from "../../src/canvas/edgePath";
import {
  CHIP_ICON_ONLY_MAX_ZOOM,
  LABEL_MIN_ZOOM,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";
import { itemColor } from "../../src/canvas/itemColor";
import { LocaleProvider } from "../../src/data/i18n-context";

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
  it("draws the junction dot in the HTML label layer at the branch point", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
      busMemberCount: 2,
    });
    const path = await findEdgePath();
    // No SVG circle any more: the dot moved into the label layer so it z-wins
    // over the aggregate chip.
    expect(document.querySelector("circle")).toBeNull();
    const dot = document.querySelector<HTMLElement>(
      '[data-testid="bus-junction-e1"]',
    );
    expect(dot).not.toBeNull();
    expect(dot!.classList.contains("bus-junction")).toBe(true);
    // Centred on the branch point via the double translate: the -50%,-50%
    // centre plus an explicit numeric x on the junction column and the trunk
    // row on the y. Pin both axes so an axis swap or a dropped coordinate
    // fails, not just y: the trunk runs at the source port row, which is the
    // drawn path's first vertex.
    const sourceY = parsePathPoints(path.getAttribute("d") ?? "")[0]![1];
    expect(dot!.style.transform).toMatch(
      new RegExp(
        `translate\\(-50%, -50%\\) translate\\(-?\\d[\\d.]*px, ${sourceY}px\\)`,
      ),
    );
    // Not dimmed when the edge carries no dim state.
    expect(dot!.classList.contains("dimmed")).toBe(false);
  });

  it("dims the junction dot when its edge is dimmed", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
      busMemberCount: 2,
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

describe("canvas/BusEdge crossing cues", () => {
  // The cue stamp must sit on the edge's own live polyline (the stale-stamp
  // rule), so the fixture discovers an on-line point -- the drawn path's
  // middle vertex -- from a plain render first.
  async function pathMidpoint(): Promise<{ x: number; y: number }> {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
    });
    const path = await findEdgePath();
    const pts = parsePathPoints(path.getAttribute("d") ?? "");
    cleanup();
    const mid = pts[Math.floor(pts.length / 2)]!;
    return { x: mid[0], y: mid[1] };
  }

  it("masks its own stroke around a stamped crossing", async () => {
    const on = await pathMidpoint();
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
      crossingCues: [on],
    });
    const path = await findEdgePath();
    const cue = document.querySelector<SVGCircleElement>(
      '[data-testid="edge-crossing-cue"]',
    );
    expect(cue).not.toBeNull();
    expect(Number(cue!.getAttribute("cx"))).toBeCloseTo(on.x, 6);
    expect(Number(cue!.getAttribute("cy"))).toBeCloseTo(on.y, 6);
    // The cue is a hole in this member's own stroke: a black disc inside an
    // SVG mask that is applied to the coloured path, exactly as ItemEdge
    // cuts it, so the crossing stroke shows through and the band tint under
    // the crossing stays intact.
    const mask = cue!.closest("mask")!;
    expect(mask).not.toBeNull();
    expect(path.closest("[mask]")!.getAttribute("mask")).toBe(
      `url(#${mask.id})`,
    );
  });

  it("draws no cue when the edge carries no crossings", async () => {
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
    });
    const path = await findEdgePath();
    expect(
      document.querySelector('[data-testid="edge-crossing-cue"]'),
    ).toBeNull();
    expect(path.closest("[mask]")).toBeNull();
  });
});

describe("canvas/BusEdge transport kind", () => {
  // A bus member draws the same phase hook a plain item edge does: the
  // per-kind dim floor and hover-dash rules in canvas.css select on
  // data-transport-kind, and a gas member that omitted it kept the belt
  // treatment on a dash-dot stroke.
  it("stamps data-transport-kind on a gas member", async () => {
    renderEdge({
      item: "gas_water",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "gas_water|src",
      transportKind: "gas",
    } as BusData);
    const path = await findEdgePath();
    expect(path.getAttribute("data-transport-kind")).toBe("gas");
    // The dash pattern comes from the same kind, so the attribute and the
    // stroke can never disagree.
    expect(path.style.strokeDasharray.replace(/,\s*/g, " ")).toBe("6 2 1 2");
  });

  it("omits the attribute on a member with no transport kind", async () => {
    // Legacy / hand-built members carry no kind, and the selectors have to be
    // able to tell that apart from a real belt.
    renderEdge({
      item: "Iron Plate",
      rate: new Fraction(2, 1),
      fanout: true,
      trunkKey: "Iron Plate|src",
    });
    const path = await findEdgePath();
    expect(path.hasAttribute("data-transport-kind")).toBe(false);
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
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="bus-edge-label-e1"]',
      ),
    );
  }

  it("renders two rate chips at drop and rise points when zoomed in", async () => {
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        fanout: true,
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
        fanout: true,
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
        fanout: true,
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

  it("draws the aggregate chip on a multi-member trunk", async () => {
    // Every trunk draws its one aggregate on the owner: the whole port's total
    // beside the trunk segment, with each member's own rate on its branch. The
    // gap was widened for both chips before the trunk was routed.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1), // this member: 60/min
        fanout: true,
        trunkKey: "Iron Plate|src",
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1), // trunk total: 120/min
        busMemberCount: 2,
      },
      1,
    );
    await findEdgePath();
    const drop = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-drop"]',
    );
    expect(drop).not.toBeNull();
    expect(drop!.textContent).toBe("120/min");
    // The member's own branch chip carries its own rate (R3: a fan-out branch
    // keeps the plain rate + unit reading its unformed siblings read).
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/min");
    expect(rise!.getAttribute("aria-label")).toBe("Iron Plate x 60/min");
  });

  it("keeps the plain rate on a single-member trunk's chips", async () => {
    // The share form is a multi-member affordance only: on a lone member the
    // rate IS the trunk total, so "60/60" would be noise. Both chips keep the
    // plain "rate + unit" reading.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        fanout: true,
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

  it("keeps a fan-out branch chip on the plain rate reading", async () => {
    // R3 (exam 2026-09-04): the design spec scopes share chips to bus-LANE
    // members only. A formed fan-out branch is a direct in-corridor leg drawn
    // beside its unformed siblings' plain item edges, so its chip reads the
    // same "rate + unit" they do, never the share form.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(1, 1),
        trunkKey: "Iron Plate|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 3,
      } as BusData,
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.textContent).toBe("60/min");
  });

  it("collapses a short-leg fan-out branch chip to icon-only at every zoom", async () => {
    // A branch leg shorter than one chip box has no seat that keeps the full
    // box off the trunk's split dot, so the seating pass stamps
    // fanoutBranchIconOnly and the chip renders as the bare sprite -- at zoom 1,
    // where no zoom LOD gate applies. The rate survives on the
    // aria-label and the hover title, so the number is one hover away.
    // "belt" carries a sprite, so the icon survives the collapse.
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        trunkKey: "belt|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 2,
        fanoutBranchIconOnly: true,
      } as BusData,
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.classList.contains("icon-only")).toBe(true);
    expect(rise!.textContent).toBe("");
    expect(rise!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
    expect(rise!.getAttribute("aria-label")).toBe("Transport Belt x 60/min");
    expect(rise!.getAttribute("title")).toBe("Transport Belt x 60/min");
  });

  it("keeps a long-leg fan-out branch chip's digits", async () => {
    // The control for the collapse above: without the flag the same trunk's
    // branch chip keeps its rate digits (R3: plain rate, not the share form).
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        trunkKey: "belt|src",
        fanout: true,
        busChipOwner: true,
        busTotalRate: new Fraction(2, 1),
        busMemberCount: 2,
      } as BusData,
      1,
    );
    await findEdgePath();
    const rise = document.querySelector<HTMLElement>(
      '[data-testid="bus-edge-label-e1-rise"]',
    );
    expect(rise).not.toBeNull();
    expect(rise!.classList.contains("icon-only")).toBe(false);
    expect(rise!.textContent).toBe("60/min");
  });

  it("skips the branch chip of a fan-out member flagged fanoutBranchHidden", async () => {
    // deconflictChipAnchors hides a branch chip when no chip/card-clear seat
    // exists anywhere on the member's own polyline (a narrow-corridor fan-out
    // whose aggregate covers the whole short path). The member's own rate is
    // left to the hover tooltip (next test); the trunk's aggregate still
    // draws, since this member is its owner.
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
    expect(chips().map((l) => l.getAttribute("data-testid"))).toEqual([
      "bus-edge-label-e1-drop",
    ]);
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

    // A stamp off by a unit is reconstruction noise: the hide holds, leaving
    // the trunk's aggregate as the owner's only chip.
    renderEdge(
      {
        ...fanData,
        fanoutBranchHidden: true,
        fanoutBranchHiddenAt: { x: anchor.x + 1, y: anchor.y - 1 },
      } as BusData,
      1,
    );
    await findEdgePath();
    expect(chips().map((l) => l.getAttribute("data-testid"))).toEqual([
      "bus-edge-label-e1-drop",
    ]);
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
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.getAttribute("data-testid"))).toContain(
      "bus-edge-label-e1-rise",
    );
  });

  it("keeps a hidden branch's rate reachable as a native tooltip on its path", async () => {
    // The hidden branch chip was the only carrier of the member's exact-rate
    // title. A transparent hover path with an SVG <title> keeps the rate
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
    expect(title!.textContent).toBe("Iron Plate x 60/min");
  });

  it("draws no chip at all below the label zoom, aggregate included", async () => {
    // Band 1 of the LOD: the owner's aggregate drop chip takes the same mount
    // gate as every per-member chip, so a trunk below LABEL_MIN_ZOOM shows its
    // junction dot and no number.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        fanout: true,
        trunkKey: "Iron Plate|src",
      },
      LABEL_MIN_ZOOM - 0.05,
    );
    await findEdgePath();
    expect(chips()).toHaveLength(0);
  });

  it("collapses both chips to icon-only between the two gates", async () => {
    // Band 2: at and above LABEL_MIN_ZOOM but below the icon-only gate, the
    // aggregate and the per-member chip both mount without digits.
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        fanout: true,
        trunkKey: "belt|src",
      },
      (CHIP_ICON_ONLY_MAX_ZOOM + LABEL_MIN_ZOOM) / 2,
    );
    await findEdgePath();
    const labels = chips();
    expect(labels).toHaveLength(2);
    for (const chip of labels) {
      expect(chip.classList.contains("icon-only")).toBe(true);
      expect(chip.textContent).toBe("");
    }
  });

  it("reveals a focused member's rise chip below the zoom threshold", async () => {
    // Canvas's hover focus stamps `focused` on every lit edge; the lit member's
    // rise chip then survives the zoom gate and the aggregate keeps its digits,
    // so the hover shows a rate at fit zoom.
    renderEdge(
      {
        item: "Iron Plate",
        rate: new Fraction(2, 1),
        fanout: true,
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

  it("collapses the exempt aggregate drop chip to icon-only below the icon-only zoom", async () => {
    // "belt" carries a sprite, so the icon survives the collapse. A lone member
    // is its own owner and its drop chip carries no marker, so the collapsed
    // body is empty.
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        fanout: true,
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
        fanout: true,
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
});
