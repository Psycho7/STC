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
import Canvas from "./Canvas";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";

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
