// @vitest-environment jsdom
//
// The supply-rates map the inputs panel reads is derived state of a COMMITTED
// solve, not of the live node array. Two identities follow from that, and this
// file pins both: a drag hands App a fresh nodes array every pointer frame, so
// the panel must keep the map it already has; every committed solve hands the
// panel a fresh map, even when the rates in it are identical, because the map
// is written once where the nodes it describes are.
//
// layoutRenderPlan is mocked so the product nodes the fold reads are fixed per
// solve rather than by a real layout pass, which is what lets a re-solve
// produce byte-identical supply entries. Canvas and InputsPanel are stubbed
// down to the two seams these tests drive: a position change through
// onNodesChange, and an override commit through the panel's onChange.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import type { ItemOverride } from "./data/plan";
import type { RationalString } from "./pipeline/types";

const hoisted = vi.hoisted(() => ({
  // One entry per InputsPanel render, in order: the prop identity is the whole
  // point, so the captures are the props themselves, not copies.
  supplyCaptures: [] as Array<ReadonlyMap<string, RationalString> | undefined>,
}));

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({
      nodes: [],
      edges: [],
      gaps: [],
      baseEdges: [],
    })),
  };
});

vi.mock("./canvas/Canvas", () => ({
  default: (props: {
    nodes: ReadonlyArray<{ id: string }>;
    onNodesChange: (changes: ReadonlyArray<unknown>) => void;
  }) => (
    <button
      type="button"
      data-testid="drag-node"
      onClick={() =>
        props.onNodesChange([
          {
            id: props.nodes[0]?.id,
            type: "position",
            position: { x: 123, y: 456 },
            dragging: true,
          },
        ])
      }
    />
  ),
}));

vi.mock("./components/InputsPanel", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("./components/InputsPanel")>();
  return {
    ...orig,
    InputsPanel: (props: {
      supplyRateByItem?: ReadonlyMap<string, RationalString>;
      onChange: (update: (current: ItemOverride[]) => ItemOverride[]) => void;
    }) => {
      hoisted.supplyCaptures.push(props.supplyRateByItem);
      return (
        <button
          type="button"
          data-testid="commit-override"
          onClick={() => props.onChange(() => [{ itemId: "copper_ore" }])}
        />
      );
    },
  };
});

import App from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { encodeItemOverrideKey } from "./data/plan";

type LaidOut = Awaited<ReturnType<typeof layoutRenderPlan>>;

// One input product node is enough for the fold: it is the only node shape
// buildRealizedRateByItem reads, and its id is what the position change targets.
function inputNodes(rate: RationalString): LaidOut {
  return {
    nodes: [
      {
        id: "in:copper_ore",
        type: "product",
        position: { x: 0, y: 0 },
        data: { kind: "inputProduct", itemId: "copper_ore", rate },
      },
    ],
    edges: [],
    gaps: [],
    baseEdges: [],
  } as unknown as LaidOut;
}

const COPPER_ORE_KEY = encodeItemOverrideKey({ itemId: "copper_ore" });

function lastCapture(): ReadonlyMap<string, RationalString> | undefined {
  return hoisted.supplyCaptures[hoisted.supplyCaptures.length - 1];
}

beforeEach(() => {
  hoisted.supplyCaptures.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // The DEV-only render invariant runs over a render plan this file
  // deliberately does not lay out.
  vi.stubEnv("DEV", false);
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.location.hash = "";
});

test("a position change keeps the panel's supply-rates map instance", async () => {
  vi.mocked(layoutRenderPlan).mockResolvedValue(
    inputNodes({ num: "1", denom: "2" }),
  );
  render(<App />);

  await waitFor(
    () => {
      expect(lastCapture()?.get(COPPER_ORE_KEY)).toBeDefined();
    },
    { timeout: 10000 },
  );
  const beforeDrag = lastCapture();
  const rendersBeforeDrag = hoisted.supplyCaptures.length;

  screen.getByTestId("drag-node").click();

  // The drag re-renders the tree with a new nodes array; the map must ride
  // through untouched.
  await waitFor(() => {
    expect(hoisted.supplyCaptures.length).toBeGreaterThan(rendersBeforeDrag);
  });
  expect(lastCapture()).toBe(beforeDrag);
});

test("a re-solve with identical supply entries hands over a new map", async () => {
  vi.mocked(layoutRenderPlan).mockResolvedValue(
    inputNodes({ num: "1", denom: "2" }),
  );
  render(<App />);

  await waitFor(
    () => {
      expect(lastCapture()?.get(COPPER_ORE_KEY)).toBeDefined();
    },
    { timeout: 10000 },
  );
  const beforeCommit = lastCapture();
  const hashBefore = window.location.hash;

  screen.getByTestId("commit-override").click();

  // The hash is rewritten after applySolved, so a changed hash means the
  // committed solve has landed.
  await waitFor(
    () => {
      expect(window.location.hash).not.toBe(hashBefore);
    },
    { timeout: 10000 },
  );
  expect(lastCapture()).not.toBe(beforeCommit);
  // Same mocked layout, so the values the panel reads are unchanged: the fresh
  // instance is bookkeeping, not a different answer.
  expect([...lastCapture()!]).toEqual([...beforeCommit!]);
});

test("a re-solve whose rates changed reaches the panel", async () => {
  vi.mocked(layoutRenderPlan).mockResolvedValue(
    inputNodes({ num: "1", denom: "2" }),
  );
  render(<App />);

  await waitFor(
    () => {
      expect(lastCapture()?.get(COPPER_ORE_KEY)).toEqual({
        num: "1",
        denom: "2",
      });
    },
    { timeout: 10000 },
  );
  const hashBefore = window.location.hash;

  vi.mocked(layoutRenderPlan).mockResolvedValue(
    inputNodes({ num: "7", denom: "3" }),
  );
  screen.getByTestId("commit-override").click();

  await waitFor(
    () => {
      expect(window.location.hash).not.toBe(hashBefore);
    },
    { timeout: 10000 },
  );
  expect(lastCapture()?.get(COPPER_ORE_KEY)).toEqual({
    num: "7",
    denom: "3",
  });
});
