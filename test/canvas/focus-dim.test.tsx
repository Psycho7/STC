// @vitest-environment jsdom
//
// Ego-network highlight: hovering a node or edge keeps its neighbourhood at full
// opacity and marks everything else with the `dimmed` class. The class mapping
// is pure render-side (no layout), so these tests drive the Canvas component and
// assert the `dimmed` class lands on the right React Flow node / edge wrappers.
//
// Edges only mount once React Flow has measured the endpoint nodes; that
// measurement never fires when ResizeObserver is stubbed out, so this suite
// leaves the real (absent) ResizeObserver in place and waits for edge wrappers.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
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
  { id: "a", position: { x: 0, y: 0 }, data: { label: "a" } },
  { id: "b", position: { x: 300, y: 0 }, data: { label: "b" } },
  { id: "c", position: { x: 300, y: 200 }, data: { label: "c" } },
  { id: "d", position: { x: 600, y: 0 }, data: { label: "d" } },
];

function busData(trunkKey: string): Record<string, unknown> {
  return {
    item: "Iron",
    rate: new Fraction(1, 1),
    laneY: 100,
    trunkKey,
  } as unknown as Record<string, unknown>;
}

const EDGES: Edge[] = [
  // Two bus edges fan out of "a" on the same trunk.
  { id: "e1", type: "bus", source: "a", target: "b", data: busData("Iron|a") },
  { id: "e2", type: "bus", source: "a", target: "c", data: busData("Iron|a") },
  // An unrelated item edge into "c" from "d" on no trunk.
  {
    id: "e3",
    type: "item",
    source: "d",
    target: "c",
    data: { item: "Copper", rate: new Fraction(1, 1) } as unknown as Record<
      string,
      unknown
    >,
  },
];

function renderCanvas() {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={NODES} edges={EDGES} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

async function edgeEl(container: HTMLElement, id: string): Promise<HTMLElement> {
  let el: HTMLElement | null = null;
  await waitFor(() => {
    el = container.querySelector<HTMLElement>(
      `.react-flow__edge[data-id="${id}"]`,
    );
    expect(el).not.toBeNull();
  });
  return el!;
}

describe("canvas/focus-dim", () => {
  it("dims a non-adjacent node but not an adjacent one on node hover", () => {
    const { container } = renderCanvas();
    // Hover node "a": adjacent to b and c (edges e1, e2); "d" is not adjacent.
    fireEvent.mouseEnter(nodeEl(container, "a"));
    expect(nodeEl(container, "b").classList.contains("dimmed")).toBe(false);
    expect(nodeEl(container, "a").classList.contains("dimmed")).toBe(false);
    expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
  });

  it("keeps a same-trunk sibling edge undimmed on bus-edge hover", async () => {
    const { container } = renderCanvas();
    // Wait for the last edge to mount, then re-query e1 fresh: earlier waitFor
    // rounds can replace edge DOM as React Flow re-measures, detaching a stale
    // reference so events fired on it would no-op.
    await edgeEl(container, "e3");
    const e1 = container.querySelector<HTMLElement>(
      '.react-flow__edge[data-id="e1"]',
    )!;
    // Hover bus edge e1: the whole "Iron|a" trunk (e1 + e2) stays lit; the
    // unrelated item edge e3 dims. The hover re-renders edges, so settle the DOM
    // with waitFor before reading classes.
    fireEvent.mouseEnter(e1);
    await waitFor(() => {
      const e3 = container.querySelector<HTMLElement>(
        '.react-flow__edge[data-id="e3"]',
      );
      expect(e3).not.toBeNull();
      expect(e3!.classList.contains("dimmed")).toBe(true);
    });
    expect(
      container
        .querySelector<HTMLElement>('.react-flow__edge[data-id="e2"]')!
        .classList.contains("dimmed"),
    ).toBe(false);
  });

  it("clears all dimmed classes on mouse leave", () => {
    const { container } = renderCanvas();
    fireEvent.mouseEnter(nodeEl(container, "a"));
    expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
    fireEvent.mouseLeave(nodeEl(container, "a"));
    expect(container.querySelectorAll(".dimmed")).toHaveLength(0);
  });

  it("clears all dimmed classes on pane click", () => {
    const { container } = renderCanvas();
    fireEvent.mouseEnter(nodeEl(container, "a"));
    expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
    const pane = container.querySelector<HTMLElement>(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    expect(container.querySelectorAll(".dimmed")).toHaveLength(0);
  });
});
