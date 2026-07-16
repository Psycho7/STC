// @vitest-environment jsdom
//
// BusBands render layer: the faint bus-lane band marking drawn beneath the edges
// via ViewportPortal. A band region exists for each non-null lane band, so bus
// edges carrying { laneY, busBand } produce a `bus-band-<band>` rect with a BUS
// tag; a graph with no bus lanes produces nothing. The band geometry itself is
// unit-tested in busRouting; this suite pins the component wiring (testids, tag,
// null-render) through the same full-flow Canvas mount the dim suite uses.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { Node, Edge } from "@xyflow/react";
import Fraction from "fraction.js";
import Canvas from "../../src/canvas/Canvas";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import { LocaleProvider } from "../../src/data/i18n-context";

const PACK = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map(),
} as unknown as ItemPackContextValue;

afterEach(() => {
  cleanup();
});

const NODES: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, width: 200, data: { label: "a" } },
  { id: "b", position: { x: 900, y: 0 }, width: 200, data: { label: "b" } },
  { id: "c", position: { x: 900, y: 400 }, width: 200, data: { label: "c" } },
];

function busData(
  band: "top" | "bottom",
  laneY: number,
): Record<string, unknown> {
  return {
    item: "Iron",
    rate: new Fraction(1, 1),
    laneY,
    trunkKey: `Iron|a|${band}`,
    busBand: band,
  } as unknown as Record<string, unknown>;
}

// One trunk in the top band, one in the bottom band -> both region rects render.
const BANDED_EDGES: Edge[] = [
  { id: "e1", type: "bus", source: "a", target: "b", data: busData("top", 80) },
  { id: "e2", type: "bus", source: "a", target: "c", data: busData("bottom", 480) },
];

// No bus edges -> no lane bands -> BusBands renders null.
const PLAIN_EDGES: Edge[] = [
  {
    id: "p1",
    type: "item",
    source: "a",
    target: "b",
    data: {
      item: "Iron",
      rate: new Fraction(1, 1),
    } as unknown as Record<string, unknown>,
  },
];

function renderCanvas(nodes: Node[], edges: Edge[]) {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={nodes} edges={edges} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

describe("canvas/bus-bands", () => {
  it("renders a top and bottom band with a BUS tag when trunks occupy both", async () => {
    const { container } = renderCanvas(NODES, BANDED_EDGES);
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="bus-band-top"]'),
      ).not.toBeNull();
    });
    const top = container.querySelector<HTMLElement>(
      '[data-testid="bus-band-top"]',
    )!;
    const bottom = container.querySelector<HTMLElement>(
      '[data-testid="bus-band-bottom"]',
    );
    expect(bottom).not.toBeNull();
    // Each band carries a BUS tag.
    expect(top.querySelector(".bus-band-tag")?.textContent).toBe("BUS");
    expect(bottom!.querySelector(".bus-band-tag")?.textContent).toBe("BUS");
  });

  it("renders no band when the graph has no bus lanes", async () => {
    const { container } = renderCanvas(NODES, PLAIN_EDGES);
    // Let the canvas settle (nodes measure, edges mount) before asserting the
    // absence, so this is a real null-render and not a not-yet-mounted race.
    await waitFor(() => {
      expect(
        container.querySelector('.react-flow__node[data-id="a"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector('[data-testid="bus-band-top"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="bus-band-bottom"]'),
    ).toBeNull();
    expect(container.querySelector(".bus-band")).toBeNull();
  });
});
