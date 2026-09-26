// @vitest-environment jsdom
//
// Error-surface behaviour: a solver exception during a mutation maps to a
// localized banner that names the implicated item (not raw dev-speak), and the
// stale-canvas ERROR status persists after the banner is dismissed until the
// next successful solve. layoutRenderPlan is mocked to resolve instantly and
// Canvas is stubbed to expose the status prop.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

vi.mock("./canvas/Canvas", async () => {
  const { canvasSpy } = await import("./App.testkit");
  return {
    default: (props: { status?: string }) => {
      canvasSpy.status = props.status ?? "";
      return null;
    },
  };
});

// Delegate to the real solver, but throw an LpInfeasibleError on demand so a
// mutation can fail deterministically (real packs never go infeasible).
const solverGate = vi.hoisted(() => ({
  throwNext: false,
  cappedIds: ["liquid_water"] as string[],
}));
vi.mock("./solver", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./solver")>();
  return {
    ...orig,
    solvePlanWithIntermediates: (
      ...args: Parameters<typeof orig.solvePlanWithIntermediates>
    ) => {
      if (solverGate.throwNext) {
        throw new orig.LpInfeasibleError(solverGate.cappedIds, [
          "copper_bottle",
        ]);
      }
      return orig.solvePlanWithIntermediates(...args);
    },
  };
});

import App from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { loadI18n } from "./data/i18n";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";
import { canvasSpy, deferred } from "./App.testkit";

beforeEach(() => {
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
  solverGate.throwNext = false;
  solverGate.cappedIds = ["liquid_water"];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  solverGate.throwNext = false;
  window.location.hash = "";
});

function editFirstTargetRate(value: string) {
  const targetsSection = screen.getByTestId("targets-section");
  const inputs = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  fireEvent.change(inputs[0]!, { target: { value } });
  fireEvent.blur(inputs[0]!);
}

test("an infeasible mutation banner names the implicated item, not dev-speak", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  solverGate.throwNext = true;
  editFirstTargetRate("240");

  const banner = await screen.findByRole("alert");
  const waterName = loadI18n("en").displayName("liquid_water");
  expect(banner.textContent).toContain(waterName);
  // No raw solver dev-speak leaks through.
  expect(banner.textContent).not.toContain("LP solver");
  expect(banner.textContent).not.toContain("infeasible problem");
  // A cap is set, so raising it is advice worth giving.
  expect(banner.textContent).toContain("Raise the supply caps");
});

test("an infeasible mutation with no supply cap set gives no raise-caps advice", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  solverGate.cappedIds = [];
  solverGate.throwNext = true;
  editFirstTargetRate("240");

  const banner = await screen.findByRole("alert");
  const bottleName = loadI18n("en").displayName("copper_bottle");
  expect(banner.textContent).toContain(bottleName);
  expect(banner.textContent).not.toMatch(/supply cap/i);
});

test("the zh infeasible banner lists items with the ideographic comma", async () => {
  window.localStorage.setItem("aef.locale", "zh");
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  solverGate.cappedIds = ["liquid_water", "iron_powder"];
  solverGate.throwNext = true;
  // The rate field's label is localized, so reach it by role here.
  const input = within(screen.getByTestId("targets-section")).getAllByRole(
    "textbox",
  )[0]!;
  fireEvent.change(input, { target: { value: "240" } });
  fireEvent.blur(input);

  const banner = await screen.findByRole("alert");
  const zh = loadI18n("zh");
  expect(banner.textContent).toContain(
    `${zh.displayName("liquid_water")}、${zh.displayName("iron_powder")}`,
  );
});

test("stale ERROR status persists after dismiss, then clears on a successful solve", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  solverGate.throwNext = true;
  editFirstTargetRate("240");

  await screen.findByRole("alert");
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  // Dismiss the banner: it disappears but the stale ERROR marker remains.
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(canvasSpy.status).toBe("ERROR");
  expect(screen.getByTestId("header-strip").textContent).toContain("ERROR");

  // A successful solve clears the stale marker back to READY.
  solverGate.throwNext = false;
  editFirstTargetRate("120");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a load failure routes through the load wrapper, not the solver wrapper", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  window.location.hash = "#v1.%%%not-base64%%%";
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  const banner = await screen.findByRole("alert");
  // The load wrapper ("Failed to load plan: ...") - never the solver wrapper.
  expect(banner.textContent).toContain("Failed to load plan");
  expect(banner.textContent).not.toContain("Solver error");
});

async function encodedCrystalHash(): Promise<string> {
  const plan = {
    ...defaultPlan(pack),
    targets: [{ itemId: "crystal_enr", ratePerSec: { num: "1", denom: "1" } }],
  };
  return "#" + (await encodePlan(plan));
}

function expectSolverBannerText(text: string | null, advice: boolean) {
  expect(text).not.toContain("damaged");
  expect(text).not.toContain("LP solver");
  expect(text).not.toContain("infeasible problem");
  expect(text).toMatch(/no feasible plan/i);
  if (advice) expect(text).toContain("Raise the supply caps");
  else expect(text).not.toMatch(/supply cap/i);
}

const CAP_CASES = [
  { name: "no supply cap set", cappedIds: [] as string[], advice: false },
  { name: "a supply cap set", cappedIds: ["liquid_water"], advice: true },
];

// A link that decodes is valid plan state even when it has no solution: the
// panels adopt it, the solver banner explains, and the damaged-link splash
// (reserved for links that fail to decode) never shows.
test.each(CAP_CASES)(
  "a share link that decodes but fails to solve on first load, $name",
  async ({ cappedIds, advice }) => {
    const hash = await encodedCrystalHash();
    window.location.hash = hash;
    solverGate.cappedIds = cappedIds;
    solverGate.throwNext = true;
    render(<App />);

    const rows = await screen.findAllByTestId("target-row");
    expect(rows.length).toBe(1);
    const crystalName = loadI18n("en").displayName("crystal_enr");
    expect(rows[0]!.innerHTML).toContain(crystalName);
    expect(screen.getByTestId("header-strip")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /fresh plan/i })).toBeNull();
    const banner = screen.getByRole("alert");
    expect(banner.className).toContain("app-error-banner");
    expectSolverBannerText(banner.textContent, advice);
    expect(window.location.hash).toBe(hash);
  },
);

test.each(CAP_CASES)(
  "a decodable hash that fails to solve over a drawn plan adopts the new plan, $name",
  async ({ cappedIds, advice }) => {
    render(<App />);
    await screen.findAllByTestId("target-row");
    await waitFor(() => expect(window.location.hash).not.toBe(""));
    await waitFor(() => expect(canvasSpy.status).toBe("READY"));
    expect(screen.getAllByTestId("target-row").length).toBe(3);

    const hash = await encodedCrystalHash();
    solverGate.cappedIds = cappedIds;
    solverGate.throwNext = true;
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    const banner = await screen.findByRole("alert");
    expectSolverBannerText(banner.textContent, advice);
    await waitFor(() =>
      expect(screen.getAllByTestId("target-row").length).toBe(1),
    );
    const crystalName = loadI18n("en").displayName("crystal_enr");
    expect(screen.getAllByTestId("target-row")[0]!.innerHTML).toContain(
      crystalName,
    );
    await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
    // No restore: the URL keeps the adopted plan's hash.
    await new Promise((r) => setTimeout(r, 25));
    expect(window.location.hash).toBe(hash);
  },
);

test("a superseded navigation whose solve fails adopts nothing", async () => {
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  // Navigation A (the crystal plan) holds in layout, then fails after a newer
  // navigation B (the default plan) has already landed.
  const gate = deferred<never>();
  vi.mocked(layoutRenderPlan).mockImplementationOnce(() => gate.promise);
  window.location.hash = await encodedCrystalHash();
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() =>
    expect(screen.getByTestId("header-strip").textContent).toContain("SOLVING"),
  );

  const hashB = "#" + (await encodePlan(defaultPlan(pack)));
  window.location.hash = hashB;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  gate.reject(new Error("superseded layout failed"));
  await new Promise((r) => setTimeout(r, 25));
  expect(screen.getAllByTestId("target-row").length).toBe(3);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(canvasSpy.status).toBe("READY");
  expect(window.location.hash).toBe(hashB);
});
