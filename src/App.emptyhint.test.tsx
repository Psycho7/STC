// @vitest-environment jsdom
//
// The canvas empty-plan hint: a plan with no targets gets a centred pointer to
// "Add target" over the canvas, and the hint goes the moment a target exists.
// The layout is mocked away; only App's overlay is under test here.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [], gaps: [] })),
  };
});

import App from "./App";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n, type Locale } from "./data/i18n";
import { cssValue } from "./canvas/cssContract.testkit";
import { pickerTile, promptInput } from "./components/panel.testkit";

const HINT_SELECTOR = ".ak-app-shell .canvas-empty-hint";

async function emptyPlanHash(): Promise<string> {
  return "#" + (await encodePlan({ ...defaultPlan(pack), targets: [] }));
}

function expectedHint(locale: Locale): string {
  const i18n = loadI18n(locale);
  return i18n.t("canvas.empty.hint", { action: i18n.t("targets.add") });
}

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

test("an empty plan shows the hint, and adding a target removes it", async () => {
  window.location.hash = await emptyPlanHash();
  render(<App />);

  const hint = await screen.findByTestId("canvas-empty-hint");
  expect(hint.textContent).toBe(expectedHint("en"));

  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  fireEvent.click(pickerTile("iron_powder")!);
  fireEvent.change(promptInput()!, { target: { value: "30" } });
  fireEvent.click(screen.getByTestId("rate-prompt-confirm"));

  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.queryByTestId("canvas-empty-hint")).toBeNull();
  });
});

test("a plan with targets never shows the hint", async () => {
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);

  await screen.findAllByTestId("target-row");
  expect(screen.queryByTestId("canvas-empty-hint")).toBeNull();
});

test("the hint reads in zh under the zh locale", async () => {
  window.localStorage.setItem("aef.locale", "zh");
  window.location.hash = await emptyPlanHash();
  render(<App />);

  const hint = await screen.findByTestId("canvas-empty-hint");
  expect(hint.textContent).toBe(expectedHint("zh"));
  expect(expectedHint("zh")).not.toBe(expectedHint("en"));
});

test("the hint overlay lets pointer events through to the canvas", () => {
  expect(cssValue(HINT_SELECTOR, "pointer-events")).toBe("none");
});
