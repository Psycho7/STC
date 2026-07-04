// @vitest-environment jsdom
//
// Header RECIPES chip semantics: it must count distinct recipe ids in the
// logical graph, not raw logical.nodes.length, which mixes kind:"group"
// containers with per-replica kind:"recipe" stamps. The crystal_enr plan is
// the canonical fixture: 11 logical nodes (3 groups + 8 recipe stamps) but
// only 7 distinct recipes.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

import App, { pickActiveSection } from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { defaultPlan, encodePlan, validatePlan } from "./data/plan";
import { pack } from "./data/load";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function encodedDefaultHash(): Promise<string> {
  return "#" + (await encodePlan(defaultPlan(pack)));
}

async function encodedCrystalHash(): Promise<string> {
  const plan = {
    ...defaultPlan(pack),
    targets: [{ recipeId: "crystal_enr", ratePerSec: { num: "1", denom: "1" } }],
  };
  return "#" + (await encodePlan(plan));
}

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none, and
  // without the stub React 19 tears the whole tree down on mount.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

test("pickActiveSection resolves equal ratios by document order", () => {
  // Inputs reported first, both fully visible: the earlier section (targets)
  // must still win.
  expect(
    pickActiveSection([
      { id: "side-inputs", ratio: 1 },
      { id: "side-targets", ratio: 1 },
    ]),
  ).toBe("targets");
});

test("pickActiveSection does not let a later fully-visible section win", () => {
  expect(
    pickActiveSection([
      { id: "side-targets", ratio: 1 },
      { id: "side-inputs", ratio: 1 },
    ]),
  ).toBe("targets");
});

test("pickActiveSection picks the higher-ratio section", () => {
  expect(
    pickActiveSection([
      { id: "side-targets", ratio: 0.3 },
      { id: "side-inputs", ratio: 0.9 },
    ]),
  ).toBe("inputs");
});

test("pickActiveSection returns null when nothing intersects", () => {
  expect(
    pickActiveSection([
      { id: "side-targets", ratio: 0 },
      { id: "side-inputs", ratio: 0 },
    ]),
  ).toBeNull();
});

test("RECIPES chip counts distinct recipe ids, not logical nodes", async () => {
  const plan = {
    ...defaultPlan(pack),
    targets: [
      { recipeId: "crystal_enr", ratePerSec: { num: "1", denom: "1" } },
    ],
  };
  expect(validatePlan(plan, pack)).toBeNull();
  window.location.hash = "#" + (await encodePlan(plan));

  render(<App />);
  await screen.findAllByTestId("target-row");

  await waitFor(() => {
    const header = screen.getByTestId("header-strip");
    expect(header.textContent).toContain("RECIPES 7");
  });
});

test("header status chip reads READY after a successful load", async () => {
  window.location.hash = await encodedDefaultHash();
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });
});

test("header status chip reads ERROR when a navigation load fails", async () => {
  window.location.hash = await encodedDefaultHash();
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });

  window.location.hash = "#v1.this-is-not-a-valid-plan-hash";
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("ERROR");
  });
});

test("loadFromHash shows SOLVING during navigation then returns to READY", async () => {
  window.location.hash = await encodedDefaultHash();
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });

  // Hold the next layout so the SOLVING window stays open long enough to assert.
  const gate = deferred<{ nodes: []; edges: [] }>();
  vi.mocked(layoutRenderPlan).mockImplementationOnce(() => gate.promise);

  window.location.hash = await encodedCrystalHash();
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("SOLVING");
  });

  gate.resolve({ nodes: [], edges: [] });

  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });
});
