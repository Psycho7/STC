import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ReactFlow, type Edge, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import ItemEdge, {
  CHIP_ICON_ONLY_MAX_ZOOM,
  LABEL_MIN_ZOOM,
  type ItemEdgeData,
} from "../../src/canvas/ItemEdge";
import { HIDE_STALE_EPS } from "../../src/canvas/dimensions";
import { properCrossPoint } from "../../src/canvas/crossings";
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

function renderEdge(data: ItemEdgeData, zoom?: number, nodes: Node[] = NODES) {
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

  it("renders the label inside .flow-chip", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("flow-chip")).toBe(true);
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

  it("collapses a chipIconOnly rate chip above the icon-only zoom", async () => {
    // The seating pass stamps chipIconOnly on a leg too short for the full box,
    // so the collapse must come from the edge data, not from the zoom gate:
    // zoom 1 is well ABOVE CHIP_ICON_ONLY_MAX_ZOOM and would keep the digits.
    renderEdge({ item: "belt", rate: new Fraction(2, 1), chipIconOnly: true }, 1);
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("icon-only")).toBe(true);
    // Icon kept, digits dropped; the exact rate stays on the hover tooltip.
    expect(label!.querySelector(".ico.ico-16 .spr")).not.toBeNull();
    expect(label!.textContent).toBe("");
    expect(label!.getAttribute("title")).toContain("120/min");
  });

  it("keeps a focused chipIconOnly chip's digits", async () => {
    // Hover overrides the short-leg collapse the same way it overrides the zoom
    // one, so no chip is permanently rate-less.
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(2, 1),
        chipIconOnly: true,
        focused: true,
      },
      1,
    );
    const label = await findLabel();
    expect(label).not.toBeNull();
    expect(label!.classList.contains("icon-only")).toBe(false);
    expect(label!.textContent).toBe("120/min");
  });

});

describe("canvas/ItemEdge fan-in marker", () => {
  // The marker is stale-checked against the LIVE target port y, so a fixture has
  // to discover that y from a plain render before it can seat a stamp on it.
  async function livePortY(): Promise<number> {
    renderEdge({ item: "belt", rate: new Fraction(2, 1) }, 1);
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    const pts = parsePathPoints(
      document
        .querySelector<SVGPathElement>(".react-flow__edge-path")!
        .getAttribute("d")!,
    );
    const y = pts[pts.length - 1]![1];
    cleanup();
    return y;
  }

  it("draws the merge dot and the owner's own rate chip, never an aggregate", async () => {
    const targetY = await livePortY();
    // The legacy aggregate stamp rides along on purpose: the seating pass no
    // longer emits these fields, and no render path may be left that could turn
    // them back into a chip. The cast is what feeds them past the data type.
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
      } as ItemEdgeData,
      1,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="fanin-junction-e1"]'),
      ).not.toBeNull(),
    );
    // The owner is an ordinary member chip: its OWN rate, not a total.
    const label = document.querySelector<HTMLElement>(
      '[data-testid="item-edge-label-e1"]',
    );
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("60/min");
    expect(document.querySelector(".flow-chip.sigma")).toBeNull();
    expect(
      document.querySelector('[data-testid="bus-edge-fanin-e1-drop"]'),
    ).toBeNull();
  });

  it("drops the owner's chip below the label zoom, leaving the dot alone", async () => {
    // Accepted consequence of removing the gate-exempt aggregate: at a dense
    // plan's fit zoom a fan-in port shows the dot and no number. The target
    // card's input row still states the rate.
    const targetY = await livePortY();
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        faninJunctionX: 120,
        faninJunctionY: targetY,
      },
      LABEL_MIN_ZOOM - 0.05,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="fanin-junction-e1"]'),
      ).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="item-edge-label-e1"]'),
    ).toBeNull();
  });
});

describe("canvas/ItemEdge declined fan-out dot", () => {
  // Source and target on DIFFERENT rows, far enough apart that a stamp seated on
  // one port row is unambiguously stale against the other. Without that spread
  // the two staleness axes are indistinguishable.
  const SPLIT_ROW_NODES: Node[] = [
    { id: "src", position: { x: 0, y: 0 }, data: { label: "src" } },
    { id: "tgt", position: { x: 300, y: 160 }, data: { label: "tgt" } },
  ];

  // Live port rows, read off the drawn polyline's ends -- the same discovery the
  // fan-in marker tests do, since the stale check compares a stamp to the props
  // React Flow measured, not to anything the fixture can assert directly.
  async function portRows(): Promise<{ sourceY: number; targetY: number }> {
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    const pts = parsePathPoints(
      document
        .querySelector<SVGPathElement>(".react-flow__edge-path")!
        .getAttribute("d")!,
    );
    return { sourceY: pts[0]![1], targetY: pts[pts.length - 1]![1] };
  }

  async function fanoutDot(): Promise<HTMLElement | null> {
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge")).not.toBeNull(),
    );
    return document.querySelector<HTMLElement>(
      '[data-testid^="fanout-junction-"]',
    );
  }

  it("draws the dot for a stamp seated on the live SOURCE port row", async () => {
    renderEdge({ item: "belt", rate: new Fraction(1, 1) }, 1, SPLIT_ROW_NODES);
    const { sourceY, targetY } = await portRows();
    // Premise: the two rows are far enough apart to tell the axes apart.
    expect(Math.abs(targetY - sourceY)).toBeGreaterThan(HIDE_STALE_EPS);
    cleanup();

    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        fanoutJunctionX: 120,
        fanoutJunctionY: sourceY,
      },
      1,
      SPLIT_ROW_NODES,
    );
    const dot = await fanoutDot();
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute("data-testid")).toBe("fanout-junction-e1");
  });

  it("drops the dot for a stamp off the source row, even sitting on the target row", async () => {
    // The divergence dot marks a split just outside the SOURCE port, so the
    // drag-staleness check runs against the live source y. A stamp parked on the
    // target row is exactly as stale as any other off-row stamp: it must vanish,
    // not survive because the other end happens to agree with it.
    renderEdge({ item: "belt", rate: new Fraction(1, 1) }, 1, SPLIT_ROW_NODES);
    const { sourceY, targetY } = await portRows();
    expect(Math.abs(targetY - sourceY)).toBeGreaterThanOrEqual(HIDE_STALE_EPS);
    cleanup();

    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        fanoutJunctionX: 120,
        fanoutJunctionY: targetY,
      },
      1,
      SPLIT_ROW_NODES,
    );
    expect(await fanoutDot()).toBeNull();
  });
});

describe("canvas/ItemEdge crossing cues", () => {
  // A cue stamp is only drawable while it sits on the edge's own live polyline
  // (the stale-stamp rule), so a fixture has to discover a live on-line point
  // from a plain render first -- the same discovery the fan-in marker tests do.
  async function liveMidpoint(): Promise<{ x: number; y: number }> {
    renderEdge({ item: "belt", rate: new Fraction(1, 1) }, 1);
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    const pts = parsePathPoints(
      document
        .querySelector<SVGPathElement>(".react-flow__edge-path")!
        .getAttribute("d")!,
    );
    cleanup();
    return { x: pts[0]![0] + 40, y: pts[0]![1] };
  }

  it("draws a cue circle before the coloured path when the edge carries crossings", async () => {
    const on = await liveMidpoint();
    renderEdge(
      { item: "belt", rate: new Fraction(1, 1), crossingCues: [on] },
      1,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="edge-crossing-cue"]'),
      ).not.toBeNull(),
    );
    const cue = document.querySelector<SVGCircleElement>(
      '[data-testid="edge-crossing-cue"]',
    )!;
    // Centred on the stamped point, in the path's own (graph) coordinates.
    expect(Number(cue.getAttribute("cx"))).toBeCloseTo(on.x, 6);
    expect(Number(cue.getAttribute("cy"))).toBeCloseTo(on.y, 6);
    // Zoom-clamped radius in graph units (a real radius, not the default 0).
    expect(Number(cue.getAttribute("r"))).toBeGreaterThan(0);
    // DOM order: the cue paints BEFORE the coloured path inside this edge's
    // group, so the path repaints the cue's centre and only the OTHER (the
    // z-beneath) edge's line is erased around the point.
    const path = document.querySelector(".react-flow__edge-path")!;
    expect(
      cue.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("draws no cue when the edge carries no crossings", async () => {
    renderEdge({ item: "belt", rate: new Fraction(1, 1) }, 1);
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="edge-crossing-cue"]'),
    ).toBeNull();
  });

  it("drops a stale cue whose stamp no longer sits on the live polyline", async () => {
    // The stamp below is well off the drawn line, the state a node drag
    // leaves behind (the seating pass does not rerun on drag).
    renderEdge(
      {
        item: "belt",
        rate: new Fraction(1, 1),
        crossingCues: [{ x: -500, y: -500 }],
      },
      1,
    );
    await waitFor(() =>
      expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
    );
    expect(
      document.querySelector('[data-testid="edge-crossing-cue"]'),
    ).toBeNull();
  });

  it("drops a cue whose stamped partner has since moved away, and keeps one whose partner stands still", async () => {
    // The partner-side stale rule: the cue's stamp names the OTHER edge of
    // the crossing pair and records that edge's endpoint node anchors as of
    // the seating pass. Nodes stay mouse-draggable without a re-seat, so a
    // dragged partner leaves the cue's own stamp intact -- its own polyline
    // never moved -- while the crossing itself is gone from the partner's
    // side. The renderer consults React Flow's store (by id, per partner)
    // and drops the cue once the partner edge is missing or either endpoint
    // has drifted past the shared stale eps.
    const on = await liveMidpoint();
    // A second, real edge in the same flow so the store's edge lookup can
    // find the partner: P1 -> P2, both top-level, so their absolute anchor
    // positions are exactly their fixture positions.
    const P1 = {
      id: "P1",
      position: { x: 500, y: 100 },
      data: { label: "P1" },
    };
    const P2 = {
      id: "P2",
      position: { x: 900, y: 100 },
      data: { label: "P2" },
    };
    const partnerEdge: Edge = {
      id: "eP",
      type: "item",
      source: "P1",
      target: "P2",
      data: { item: "belt", rate: new Fraction(1, 1) },
    };
    const renderPair = (partner: {
      edgeId: string;
      source: { x: number; y: number };
      target: { x: number; y: number };
    }): void => {
      render(
        <LocaleProvider locale="en">
          <div style={{ width: 800, height: 600 }}>
            <ReactFlow
              nodes={[...NODES, P1, P2]}
              edges={[
                makeEdge({
                  item: "belt",
                  rate: new Fraction(1, 1),
                  crossingCues: [{ x: on.x, y: on.y, partner }],
                }),
                partnerEdge,
              ]}
              edgeTypes={edgeTypes}
              minZoom={0.05}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            />
          </div>
        </LocaleProvider>,
      );
    };
    const cueVisible = async (): Promise<boolean> => {
      await waitFor(() =>
        expect(document.querySelector(".react-flow__edge-path")).not.toBeNull(),
      );
      return (
        document.querySelector('[data-testid="edge-crossing-cue"]') !== null
      );
    };

    // Anchors agreeing with the live nodes: the crossing still stands on
    // both sides, so the disk renders.
    const agreeing = {
      edgeId: "eP",
      source: { x: 500, y: 100 },
      target: { x: 900, y: 100 },
    };
    await renderPair(agreeing);
    expect(await cueVisible()).toBe(true);
    cleanup();

    // The partner's source dragged well past the eps: its end of the
    // crossing is gone, and the cue must vanish instead of cutting a gap in
    // a stroke that no longer crosses there.
    const moved = {
      edgeId: "eP",
      source: { x: 500 + HIDE_STALE_EPS * 2, y: 100 },
      target: { x: 900, y: 100 },
    };
    await renderPair(moved);
    expect(await cueVisible()).toBe(false);
    cleanup();

    // The partner edge deleted outright: same verdict, same rule.
    const gone = {
      edgeId: "eOther",
      source: { x: 500, y: 100 },
      target: { x: 900, y: 100 },
    };
    await renderPair(gone);
    expect(await cueVisible()).toBe(false);
  });

  it("renders a pair's crossing cue on BOTH edges, each before its own path", async () => {
    // The both-edges render contract: the seating pass stamps the crossing
    // point on each edge of the pair (selection elevation can invert the
    // paint order between member edges, so the cue must not depend on one
    // edge winning a z ruling), and each edge's renderer draws the disk from
    // its OWN stamp inside its own svg group. At rest exactly one of the two
    // disks visibly cuts a stroke -- the one in the svg painting above --
    // and the other reads as a background halo under nothing: it paints
    // before its own path, so its own stroke repaints the disk's centre and
    // stays continuous (no double gap). This pins that both groups carry
    // the disk at the shared crossing, and that each precedes its own path.
    const CROSS_NODES: Node[] = [
      { id: "A1", position: { x: 0, y: 0 }, data: { label: "A1" } },
      { id: "A2", position: { x: 1000, y: 0 }, data: { label: "A2" } },
      { id: "B1", position: { x: 600, y: -160 }, data: { label: "B1" } },
      { id: "B2", position: { x: 1200, y: 200 }, data: { label: "B2" } },
    ];
    const mkItem = (id: string, source: string, target: string): Edge => ({
      id,
      type: "item",
      source,
      target,
      data: { item: "belt", rate: new Fraction(1, 1) },
    });
    // First render both edges plain and read the crossing point off the
    // DRAWN polylines, so the stamp below sits on both live lines whatever
    // port offsets the jsdom harness measures.
    render(
      <LocaleProvider locale="en">
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow
            nodes={CROSS_NODES}
            edges={[mkItem("eA", "A1", "A2"), mkItem("eB", "B1", "B2")]}
            edgeTypes={edgeTypes}
            minZoom={0.05}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          />
        </div>
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".react-flow__edge-path").length).toBe(
        2,
      ),
    );
    const dOf = (id: string): ReadonlyArray<readonly [number, number]> =>
      parsePathPoints(
        document
          .querySelector<SVGPathElement>(`.react-flow__edge-path#${id}`)!
          .getAttribute("d")!,
      );
    const da = dOf("eA");
    const db = dOf("eB");
    let cross: readonly [number, number] | null = null;
    for (let i = 1; i < da.length && cross === null; i++) {
      for (let j = 1; j < db.length && cross === null; j++) {
        cross = properCrossPoint(da[i - 1]!, da[i]!, db[j - 1]!, db[j]!);
      }
    }
    // Premise: the two drawn polylines properly cross.
    expect(cross).not.toBeNull();
    cleanup();

    // Both edges stamped at the crossing, each naming the other as its
    // partner with the other's endpoint anchors (top-level, so absolute
    // positions are the fixture positions) -- the shape the seating pass
    // now emits for a pair.
    const cue = {
      x: Math.round(cross![0] * 100) / 100,
      y: Math.round(cross![1] * 100) / 100,
    };
    const stamped: Edge[] = [
      {
        ...mkItem("eA", "A1", "A2"),
        data: {
          item: "belt",
          rate: new Fraction(1, 1),
          crossingCues: [
            {
              ...cue,
              partner: {
                edgeId: "eB",
                source: { x: 600, y: -160 },
                target: { x: 1200, y: 200 },
              },
            },
          ],
        },
      },
      {
        ...mkItem("eB", "B1", "B2"),
        data: {
          item: "belt",
          rate: new Fraction(1, 1),
          crossingCues: [
            {
              ...cue,
              partner: {
                edgeId: "eA",
                source: { x: 0, y: 0 },
                target: { x: 1000, y: 0 },
              },
            },
          ],
        },
      },
    ];
    render(
      <LocaleProvider locale="en">
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow
            nodes={CROSS_NODES}
            edges={stamped}
            edgeTypes={edgeTypes}
            minZoom={0.05}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          />
        </div>
      </LocaleProvider>,
    );
    await waitFor(() =>
      expect(document.querySelectorAll(".react-flow__edge-path").length).toBe(
        2,
      ),
    );
    // Each edge's own group carries its own disk at the shared crossing,
    // painted before its own coloured path.
    for (const id of ["eA", "eB"]) {
      const path = document.querySelector<SVGPathElement>(
        `.react-flow__edge-path#${id}`,
      )!;
      const group = path.closest(".react-flow__edge")!;
      const disk = group.querySelector<SVGCircleElement>(
        '[data-testid="edge-crossing-cue"]',
      );
      expect(disk, `cue disk inside ${id}'s group`).not.toBeNull();
      expect(Number(disk!.getAttribute("cx"))).toBeCloseTo(cue.x, 5);
      expect(Number(disk!.getAttribute("cy"))).toBeCloseTo(cue.y, 5);
      expect(
        disk!.compareDocumentPosition(path) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
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
    // target y.
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
              makeEdge({ item: "Iron Plate", rate: new Fraction(2, 1) }),
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

  it("falls back to the smoothstep midpoint", async () => {
    renderEdge({ item: "Iron Plate", rate: new Fraction(2, 1) });
    const label = await findLabel();
    expect(label).not.toBeNull();
    // Midpoint x sits between source and target x; the label still renders.
    expect(transformFor(label!)).toMatch(/translate\(.+px,.+px\)/);
  });
});
