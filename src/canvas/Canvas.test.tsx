// @vitest-environment jsdom
//
// The canvas HUD chip must count rendered recipe units (type === "recipe"
// React Flow nodes), not every node: the raw array also carries group
// containers and product chips. Clustering can aggregate replicas into class
// units, so the chip is labeled UNITS rather than REPLICAS.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { FC } from "react";
import type { Edge, Node } from "@xyflow/react";
import type { Recipe } from "@aef/schema";
import Canvas, { zoomBand } from "./Canvas";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";
import { cssBlock } from "../../test/canvas/cssContract";

// The camera-refit effect drives fitView imperatively off the React Flow
// instance and the node-measurement signal. jsdom never measures nodes, so the
// real useNodesInitialized stays false and fitView is a real no-op; mock both to
// make the fit deterministic and spy-able.
const fitViewSpy = vi.hoisted(() => vi.fn());
// Canvas fits via fitBounds when contentBounds yields a rect (the common case:
// any non-empty graph), and falls back to fitView only for an empty graph. Spy
// both off the mocked instance.
const fitBoundsSpy = vi.hoisted(() => vi.fn());
// Every props object React Flow was handed, newest last. React Flow memoizes
// its node and edge wrappers on prop identity, so the hover handlers arriving
// with a stable identity across re-renders is the contract that keeps a zoom
// tick or a drag frame from re-reconciling the whole graph.
const rfRenders = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@xyflow/react", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@xyflow/react")>();
  const { createElement } = await import("react");
  const OrigFlow = orig.ReactFlow as unknown as FC<Record<string, unknown>>;
  return {
    ...orig,
    ReactFlow: (props: Record<string, unknown>) => {
      rfRenders.push(props);
      return createElement(OrigFlow, props);
    },
    useReactFlow: () => ({ fitView: fitViewSpy, fitBounds: fitBoundsSpy }),
    useNodesInitialized: () => true,
  };
});

const PACK = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map([["mk1", { id: "mk1", icon: "mk1" }]]),
} as unknown as ItemPackContextValue;

const RECIPE = {
  id: "widget_recipe",
  category: "assemble",
  time: 2,
  producers: ["mk1"],
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "widget", qty: 1 }],
} as unknown as Recipe;

const NODES: Node[] = [
  {
    id: "u1",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
  {
    id: "g1",
    type: "group",
    position: { x: 0, y: 0 },
    data: { containerKind: "loop-box", containerId: "loop:scc-1" },
  },
  {
    id: "p1",
    type: "product",
    position: { x: 0, y: 0 },
    data: {
      kind: "outputProduct",
      itemId: "widget",
      rate: { num: "1", denom: "1" },
      flavor: "target",
    },
  },
];

beforeEach(() => {
  fitViewSpy.mockClear();
  fitBoundsSpy.mockClear();
  rfRenders.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Two standalone recipes plus a container box, used by the hover tests.
const HOVER_NODES: Node[] = [
  {
    id: "u1",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
  {
    id: "u2",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
  {
    id: "g1",
    type: "group",
    position: { x: 0, y: 0 },
    data: { containerKind: "loop-box", containerId: "loop:scc-1", memberCount: 1 },
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

// Canvas at a named layout generation, for the plan-swap hover tests.
function hoverWrap(gen: number, nodes: Node[]) {
  return (
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={nodes} edges={[]} layoutGeneration={gen} />
      </ItemPackProvider>
    </LocaleProvider>
  );
}

function isDimmed(container: HTMLElement, id: string): boolean {
  const el = container.querySelector(`[data-id="${id}"]`);
  return el?.className.includes("dimmed") ?? false;
}

test("zoomBand derives the low / mid / clear bands from zoom", () => {
  expect(zoomBand(0.1)).toBe("zoom-low");
  expect(zoomBand(0.39)).toBe("zoom-low");
  // 0.4 is the low/mid boundary: no longer low.
  expect(zoomBand(0.4)).toBe("zoom-mid");
  expect(zoomBand(0.6)).toBe("zoom-mid");
  expect(zoomBand(0.79)).toBe("zoom-mid");
  // At and above 0.8 no band class applies (full detail).
  expect(zoomBand(0.8)).toBe("");
  expect(zoomBand(1)).toBe("");
  expect(zoomBand(2)).toBe("");
});

test("canvas theme container carries the derived zoom-band class", () => {
  // jsdom's React Flow store initialises the transform to zoom 1, so the derived
  // band is clear: the container keeps just the base theme class (no zoom-low /
  // zoom-mid), proving the band output is wired onto the same element as
  // hover-active without leaking a band at full zoom.
  const { container } = render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={[]} edges={[]} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
  const theme = container.querySelector(".ak-canvas-theme")!;
  expect(theme.className).toBe("ak-canvas-theme");
  expect(theme.className).not.toContain("zoom-low");
  expect(theme.className).not.toContain("zoom-mid");
});

// UX-18: arrow keys must not move focused nodes, but Tab must still traverse
// them. React Flow's disableKeyboardA11y kills the arrow-key drag handler while
// leaving tabIndex=0 on the node wrapper. The a11y node description (which
// documents the arrow-key move) is only wired when keyboard a11y is on, so its
// absence is a reliable proxy that the flag is set.
test("nodes stay Tab-focusable while arrow-key movement is disabled", () => {
  const { container } = renderCanvas(NODES, []);
  const node = container.querySelector(
    '.react-flow__node[data-id="u1"]',
  ) as HTMLElement;
  expect(node).not.toBeNull();
  expect(node.tabIndex).toBe(0);
  expect(node.getAttribute("aria-describedby")).toBeNull();
});

test("status annotation reflects the status prop", () => {
  const { container } = render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={[]} edges={[]} status="SOLVING" />
      </ItemPackProvider>
    </LocaleProvider>,
  );
  expect(container.querySelector(".canvas-annot.bottom-right")?.textContent).toBe(
    "STATUS · SOLVING",
  );
});

// The canvas is a pan surface, so an opaque screen-fixed control in a corner
// hides whatever card or chip pans under it. The canvas carries no HUD controls
// of its own; the only overlays left are the React Flow viewport panels
// (Controls / MiniMap), which are React Flow's own children.
test("canvas renders no HUD control overlay", () => {
  const { container } = renderCanvas([], []);
  const theme = container.querySelector(".ak-canvas-theme")!;
  expect(theme.querySelector("button:not(.react-flow__controls-button)")).toBeNull();
});

// The generic app-shell button rule also reaches the Controls cluster and
// replaces the vendor's padding / border, collapsing the content box the icon
// svg is sized from. jsdom does no layout, so the rule text itself is the
// assertable contract.
test("controls buttons re-assert the vendor padding and border the app-shell rule overrides", () => {
  const rule = cssBlock(".ak-canvas-theme .react-flow__controls-button");
  expect(rule).toMatch(/padding:\s*4px;/);
  expect(rule).toMatch(/border:\s*none;/);
});

test("hovering a group node is inert and dims nothing", () => {
  vi.useFakeTimers();
  const { container } = renderCanvas(HOVER_NODES, []);
  fireEvent.mouseEnter(container.querySelector('[data-id="g1"]')!);
  act(() => vi.advanceTimersByTime(500));
  expect(isDimmed(container, "u1")).toBe(false);
  expect(isDimmed(container, "u2")).toBe(false);
});

test("hover dim applies only after the 150ms intent delay", () => {
  vi.useFakeTimers();
  const { container } = renderCanvas(HOVER_NODES, []);
  fireEvent.mouseEnter(container.querySelector('[data-id="u1"]')!);
  act(() => vi.advanceTimersByTime(100));
  expect(isDimmed(container, "u2")).toBe(false);
  act(() => vi.advanceTimersByTime(100));
  expect(isDimmed(container, "u2")).toBe(true);
});

test("hover intent is cancelled if the pointer leaves before the delay", () => {
  vi.useFakeTimers();
  const { container } = renderCanvas(HOVER_NODES, []);
  const u1 = container.querySelector('[data-id="u1"]')!;
  fireEvent.mouseEnter(u1);
  act(() => vi.advanceTimersByTime(100));
  fireEvent.mouseLeave(u1);
  act(() => vi.advanceTimersByTime(200));
  expect(isDimmed(container, "u2")).toBe(false);
});

test("a container lit because of a focused child gets the lit-container class", () => {
  vi.useFakeTimers();
  const nodes: Node[] = [
    {
      id: "g1",
      type: "group",
      position: { x: 0, y: 0 },
      data: {
        containerKind: "loop-box",
        containerId: "loop:scc-1",
        memberCount: 1,
      },
    },
    {
      id: "u1",
      type: "recipe",
      parentId: "g1",
      position: { x: 0, y: 0 },
      data: { recipe: RECIPE, kind: "recipe" },
    },
    {
      id: "u2",
      type: "recipe",
      position: { x: 0, y: 0 },
      data: { recipe: RECIPE, kind: "recipe" },
    },
  ];
  const edges = [
    { id: "e1", source: "u1", target: "u2", type: "item" },
  ] as unknown as Edge[];
  const { container } = renderCanvas(nodes, edges);
  fireEvent.mouseEnter(container.querySelector('[data-id="u1"]')!);
  act(() => vi.advanceTimersByTime(200));
  const g1 = container.querySelector('[data-id="g1"]')!;
  expect(g1.className).toContain("lit-container");
  expect(g1.className).not.toContain("dimmed");
});

test("the camera fits once per layout generation", () => {
  const wrap = (gen: number) => (
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={NODES} edges={[]} layoutGeneration={gen} />
      </ItemPackProvider>
    </LocaleProvider>
  );
  const { rerender } = render(wrap(1));
  // Initial mount fits the first generation once (via fitBounds: the graph is
  // non-empty, so contentBounds yields a rect).
  expect(fitBoundsSpy).toHaveBeenCalledTimes(1);
  // A re-render with the same generation must not re-fit.
  rerender(wrap(1));
  expect(fitBoundsSpy).toHaveBeenCalledTimes(1);
  // A new generation re-fits exactly once.
  rerender(wrap(2));
  expect(fitBoundsSpy).toHaveBeenCalledTimes(2);
});

// A plan can land with the pointer standing still (Enter in an already-focused
// rate field, the bus-lane toggle, hash navigation). The hover it leaves behind
// names an id the new graph does not have, which lights nothing and dims
// everything until the next enter or pane click.
test("a plan swap retires a hover whose element is gone", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(hoverWrap(1, HOVER_NODES));
  fireEvent.mouseEnter(container.querySelector('[data-id="u1"]')!);
  act(() => vi.advanceTimersByTime(200));
  expect(isDimmed(container, "u2")).toBe(true);
  // The next plan carries none of the hovered ids, the case the mouse path
  // never reaches because travelling to the side panel clears the hover first.
  const replaced: Node[] = [
    {
      id: "u3",
      type: "recipe",
      position: { x: 0, y: 0 },
      data: { recipe: RECIPE, kind: "recipe" },
    },
    {
      id: "u4",
      type: "recipe",
      position: { x: 0, y: 0 },
      data: { recipe: RECIPE, kind: "recipe" },
    },
  ];
  rerender(hoverWrap(2, replaced));
  expect(isDimmed(container, "u3")).toBe(false);
  expect(isDimmed(container, "u4")).toBe(false);
  expect(container.querySelector(".ak-canvas-theme")!.className).not.toContain(
    "hover-active",
  );
});

// A hover still inside its intent window was aimed at the old graph, and no
// leave event fires under a standing pointer to cancel it. The ids all survive
// here, so a dim could only come from the pending hover settling.
test("a plan landing inside the intent window cancels the pending hover", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(hoverWrap(1, HOVER_NODES));
  fireEvent.mouseEnter(container.querySelector('[data-id="u1"]')!);
  act(() => vi.advanceTimersByTime(100));
  // A fresh array of fresh node objects, the way a new plan arrives.
  const respun = HOVER_NODES.map((n) => ({ ...n }));
  rerender(hoverWrap(2, respun));
  act(() => vi.advanceTimersByTime(200));
  expect(isDimmed(container, "u2")).toBe(false);
});

// The flip side of the retirement: a settled hover whose element the new plan
// still carries keeps its highlight. React Flow keeps the same wrapper mounted
// under a standing pointer, so nothing would fire a mouseenter to light it
// again if this dropped it.
test("a hover whose element survives the plan swap keeps its highlight", () => {
  vi.useFakeTimers();
  const { container, rerender } = render(hoverWrap(1, HOVER_NODES));
  fireEvent.mouseEnter(container.querySelector('[data-id="u1"]')!);
  act(() => vi.advanceTimersByTime(200));
  expect(isDimmed(container, "u2")).toBe(true);
  const respun = HOVER_NODES.map((n) => ({ ...n }));
  rerender(hoverWrap(2, respun));
  expect(isDimmed(container, "u2")).toBe(true);
});

// React Flow's node wrappers are memoized on prop identity, so a handler
// rebuilt on every render re-reconciles the whole tree on each zoom tick.
test("the hover handlers keep their identity across re-renders", () => {
  const wrap = (nodes: Node[]) => (
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={nodes} edges={[]} layoutGeneration={1} />
      </ItemPackProvider>
    </LocaleProvider>
  );
  const { rerender } = render(wrap(NODES));
  // A fresh array of fresh node objects is what a drag frame hands Canvas.
  const respun = NODES.map((n) => ({ ...n }));
  rerender(wrap(respun));
  const first = rfRenders[0]!;
  const last = rfRenders[rfRenders.length - 1]!;
  expect(rfRenders.length).toBeGreaterThan(1);
  expect(last.onNodeMouseEnter).toBe(first.onNodeMouseEnter);
  expect(last.onEdgeMouseEnter).toBe(first.onEdgeMouseEnter);
});

test("a container resize triggers a debounced re-fit", () => {
  vi.useFakeTimers();
  let observed: (() => void) | null = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        observed = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={NODES} edges={[]} layoutGeneration={1} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
  fitBoundsSpy.mockClear();
  // The first callback is the initial observe() and is skipped; a genuine later
  // resize fits once, after the debounce window.
  act(() => observed?.());
  act(() => {
    observed?.();
    vi.advanceTimersByTime(100);
  });
  expect(fitBoundsSpy).toHaveBeenCalledTimes(1);
});

// The re-fit is debounced by 100 ms and a drag hands Canvas a new node array on
// every pointer frame. While the fit closure depended on that array, each frame
// tore the observer down and re-subscribed it, dropping the pending re-fit and
// leaving the graph parked off-centre after a resize.
test("a node array change does not drop a pending debounced re-fit", () => {
  vi.useFakeTimers();
  // React Flow observes elements of its own, so key on the theme container:
  // that is the one Canvas subscribes to.
  const themeCallbacks: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: () => void) {}
      observe(el: Element) {
        if (!el.classList.contains("ak-canvas-theme")) return;
        themeCallbacks.push(this.cb);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  const wrap = (nodes: Node[]) => (
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={nodes} edges={[]} layoutGeneration={1} />
      </ItemPackProvider>
    </LocaleProvider>
  );
  const { rerender } = render(wrap(NODES));
  expect(themeCallbacks).toHaveLength(1);
  const resized = themeCallbacks[0]!;
  fitBoundsSpy.mockClear();
  // First callback is the initial observe() and is skipped; the second starts
  // the debounce window.
  act(() => resized());
  act(() => resized());
  rerender(wrap(NODES.map((n) => ({ ...n }))));
  act(() => vi.advanceTimersByTime(100));
  expect(fitBoundsSpy).toHaveBeenCalledTimes(1);
  expect(themeCallbacks).toHaveLength(1);
});

test("HUD chip shows UNITS counting only recipe-type nodes", () => {
  const { container } = render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={NODES} edges={[]} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
  const annot = container.querySelector(".canvas-annot.top-right");
  expect(annot?.textContent).toBe("UNITS:1");
});
