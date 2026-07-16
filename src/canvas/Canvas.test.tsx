// @vitest-environment jsdom
//
// The canvas HUD chip must count rendered recipe units (type === "recipe"
// React Flow nodes), not every node: the raw array also carries group
// containers and product chips. Clustering can aggregate replicas into class
// units, so the chip is labeled UNITS rather than REPLICAS.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import type { Recipe } from "@aef/schema";
import Canvas, { zoomBand } from "./Canvas";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";

// The camera-refit effect drives fitView imperatively off the React Flow
// instance and the node-measurement signal. jsdom never measures nodes, so the
// real useNodesInitialized stays false and fitView is a real no-op; mock both to
// make the fit deterministic and spy-able.
const fitViewSpy = vi.hoisted(() => vi.fn());
// Canvas fits via fitBounds when contentBounds yields a rect (the common case:
// any non-empty graph), and falls back to fitView only for an empty graph. Spy
// both off the mocked instance.
const fitBoundsSpy = vi.hoisted(() => vi.fn());
vi.mock("@xyflow/react", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...orig,
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
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
});

function setClipboard(clipboard: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    value: clipboard,
    configurable: true,
  });
}

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

test("copy-share button is disabled while the canvas is stale (ERROR status)", () => {
  const { container } = render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={[]} edges={[]} status="ERROR" />
      </ItemPackProvider>
    </LocaleProvider>,
  );
  const btn = container.querySelector(
    '[data-testid="copy-share"]',
  ) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
});

test("copy-share button is enabled when the canvas is current (READY status)", () => {
  const { container } = renderCanvas([], []);
  const btn = container.querySelector(
    '[data-testid="copy-share"]',
  ) as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
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

test("copy share button flips to a copied state then reverts", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard({ writeText });
  const { container } = renderCanvas([], []);
  const btn = container.querySelector(
    '[data-testid="copy-share"]',
  ) as HTMLElement;
  await act(async () => {
    fireEvent.click(btn);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(writeText).toHaveBeenCalledWith(window.location.href);
  expect(btn.textContent).toMatch(/copied/i);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(btn.textContent).not.toMatch(/copied/i);
});

test("copy share button shows a failure state when the clipboard API is missing", () => {
  vi.useFakeTimers();
  setClipboard(undefined);
  const { container } = renderCanvas([], []);
  const btn = container.querySelector(
    '[data-testid="copy-share"]',
  ) as HTMLElement;
  act(() => {
    fireEvent.click(btn);
  });
  expect(btn.textContent).toMatch(/failed/i);
});

test("copy share button shows a failure state when the write is rejected", async () => {
  vi.useFakeTimers();
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  setClipboard({ writeText });
  const { container } = renderCanvas([], []);
  const btn = container.querySelector(
    '[data-testid="copy-share"]',
  ) as HTMLElement;
  await act(async () => {
    fireEvent.click(btn);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(btn.textContent).toMatch(/failed/i);
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
