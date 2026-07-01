// @vitest-environment jsdom
//
// The canvas HUD chip must count rendered recipe units (type === "recipe"
// React Flow nodes), not every node: the raw array also carries group
// containers and product chips. Clustering can aggregate replicas into class
// units, so the chip is labeled UNITS rather than REPLICAS.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Node } from "@xyflow/react";
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
