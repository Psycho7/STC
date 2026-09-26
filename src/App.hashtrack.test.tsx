// @vitest-environment jsdom
//
// The URL hash tracks the committed plan, not the last successful solve. An
// infeasible edit, a blocked edit and a blocked settings flip each write the
// panels' plan into the URL, through the same replaceState a successful edit
// uses, so a reload reproduces what the panels show, banner included. A commit
// superseded while its plan encodes writes nothing.
import {
  afterEach,
  beforeEach,
  expect,
  test,
  vi,
  type MockInstance,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// Layout resolves at once unless a test holds it, which keeps an edit's solve
// in flight until the test releases it.
const layoutGate = vi.hoisted(() => ({
  hold: false,
  pending: [] as Array<() => void>,
}));
vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(
      () =>
        new Promise((resolve) => {
          const done = () => resolve({ nodes: [], edges: [] });
          if (layoutGate.hold) {
            layoutGate.pending.push(done);
          } else {
            done();
          }
        }),
    ),
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

// Real packs never go infeasible: throw on demand, for every solve while set,
// so a reload of the written hash fails the same way the edit did.
const solverGate = vi.hoisted(() => ({ throwAll: false }));
vi.mock("./solver", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./solver")>();
  return {
    ...orig,
    solvePlanWithIntermediates: (
      ...args: Parameters<typeof orig.solvePlanWithIntermediates>
    ) => {
      if (solverGate.throwAll) {
        throw new orig.LpInfeasibleError([], ["iron_powder"]);
      }
      return orig.solvePlanWithIntermediates(...args);
    },
  };
});

import App from "./App";
import { encodePlan, loadPlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { AREA_STORAGE_KEY, LOCALE_STORAGE_KEY } from "./data/storage-keys";
import {
  LUNG_PLAN,
  NUGGET_AND_POWDER_PLAN,
  POWDER_PLAN,
  VALLEY,
  canvasSpy,
  flipStoredOverrides,
} from "./App.testkit";

const en = loadI18n("en");
const zh = loadI18n("zh");
// 600 per minute, as the rate field commits it.
const TEN = { num: "10", denom: "1" };

function withRate(
  plan: Plan,
  itemId: string,
  rate: Plan["targets"][0]["ratePerSec"],
): Plan {
  return {
    ...plan,
    targets: plan.targets.map((t) =>
      t.itemId === itemId ? { ...t, ratePerSec: rate } : t,
    ),
  };
}

function editRate(displayName: string, perMinute: string): void {
  const input = screen.getByLabelText(
    `Rate for ${displayName}`,
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: perMinute } });
  fireEvent.blur(input);
}

function rateField(displayName: string): string {
  return (screen.getByLabelText(`Rate for ${displayName}`) as HTMLInputElement)
    .value;
}

async function bootOn(plan: Plan): Promise<void> {
  window.location.hash = "#" + (await encodePlan(plan));
  render(<App />);
  await screen.findAllByTestId("target-row");
}

// Unmount and boot a fresh app on the URL as it stands, the way a reload does.
async function reload(): Promise<void> {
  cleanup();
  canvasSpy.status = "";
  render(<App />);
  await screen.findAllByTestId("target-row");
}

// Give any encode still in flight every turn it needs to land its write.
async function drain(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
}

let pushSpy: MockInstance<History["pushState"]>;
let replaceSpy: MockInstance<History["replaceState"]>;

// The hashes the app wrote through replaceState since the spies were reset.
function replacedHashes(): string[] {
  return replaceSpy.mock.calls.map((call) => String(call[2]));
}

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
  window.localStorage.clear();
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  canvasSpy.status = "";
  solverGate.throwAll = false;
  layoutGate.hold = false;
  layoutGate.pending.length = 0;
  pushSpy = vi.spyOn(history, "pushState");
  replaceSpy = vi.spyOn(history, "replaceState");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  solverGate.throwAll = false;
  layoutGate.hold = false;
  layoutGate.pending.length = 0;
  window.location.hash = "";
  window.localStorage.clear();
});

// The baseline every other case is held to: one replaceState of the new hash,
// no pushState, and no growth in the history stack.
test("a successful edit replaces the hash in place", async () => {
  await bootOn(POWDER_PLAN);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  const lengthBefore = history.length;
  replaceSpy.mockClear();

  editRate(en.displayName("iron_powder"), "600");

  const expected =
    "#" + (await encodePlan(withRate(POWDER_PLAN, "iron_powder", TEN)));
  await waitFor(() => expect(window.location.hash).toBe(expected));
  expect(replacedHashes()).toEqual([expected]);
  expect(pushSpy).not.toHaveBeenCalled();
  expect(history.length).toBe(lengthBefore);
});

test("(a) an infeasible edit writes the panels' plan; a reload shows it under the solver banner", async () => {
  await bootOn(POWDER_PLAN);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  const lengthBefore = history.length;
  replaceSpy.mockClear();

  solverGate.throwAll = true;
  editRate(en.displayName("iron_powder"), "600");
  await screen.findByRole("alert");

  const expected =
    "#" + (await encodePlan(withRate(POWDER_PLAN, "iron_powder", TEN)));
  await waitFor(() => expect(window.location.hash).toBe(expected));
  expect(replacedHashes()).toEqual([expected]);
  expect(pushSpy).not.toHaveBeenCalled();
  expect(history.length).toBe(lengthBefore);

  await reload();
  expect(rateField(en.displayName("iron_powder"))).toBe("600");
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(en.displayName("iron_powder"));
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
  expect(window.location.hash).toBe(expected);
});

test("(b) a blocked edit writes the panels' plan; a reload shows it under the blocked banner", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY);
  await bootOn(NUGGET_AND_POWDER_PLAN);
  await screen.findByRole("alert");
  const lengthBefore = history.length;
  replaceSpy.mockClear();

  editRate(en.displayName("iron_powder"), "600");

  const expected =
    "#" +
    (await encodePlan(withRate(NUGGET_AND_POWDER_PLAN, "iron_powder", TEN)));
  await waitFor(() => expect(window.location.hash).toBe(expected));
  expect(replacedHashes()).toEqual([expected]);
  expect(pushSpy).not.toHaveBeenCalled();
  expect(history.length).toBe(lengthBefore);

  await reload();
  expect(rateField(en.displayName("iron_powder"))).toBe("600");
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(en.displayName("copper_nugget"));
  expect(banner.textContent).toContain(en.displayName(VALLEY));
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
  expect(window.location.hash).toBe(expected);
});

// The flip lands while the edit's solve is still held, so before the fix the
// URL still carries the pre-edit plan: the held solve that would have written
// the edit is dropped by the flip.
test("(c) a blocked settings flip writes the panels' plan; a reload shows it under the blocked banner", async () => {
  await bootOn(LUNG_PLAN);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  const lengthBefore = history.length;
  const lung = en.displayName("activity_xiranite_lung");

  layoutGate.hold = true;
  editRate(lung, "600");
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  replaceSpy.mockClear();

  flipStoredOverrides('{"v1.5": false}');
  await screen.findByRole("alert");
  await act(async () => {
    layoutGate.pending.shift()!();
  });
  layoutGate.hold = false;
  await drain();

  const expected =
    "#" +
    (await encodePlan(withRate(LUNG_PLAN, "activity_xiranite_lung", TEN)));
  expect(window.location.hash).toBe(expected);
  expect(replacedHashes()).toEqual([expected]);
  expect(pushSpy).not.toHaveBeenCalled();
  expect(history.length).toBe(lengthBefore);
  expect(canvasSpy.status).toBe("ERROR");

  await reload();
  expect(rateField(lung)).toBe("600");
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(lung);
  expect(banner.textContent).toContain("v1.5");
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
  expect(window.location.hash).toBe(expected);
});

// Two commits back to back: the first is still encoding when the second bumps
// the generation, so only the second may reach the URL.
test("a superseded blocked commit writes no hash", async () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY);
  await bootOn(NUGGET_AND_POWDER_PLAN);
  await screen.findByRole("alert");
  replaceSpy.mockClear();

  editRate(en.displayName("iron_powder"), "600");
  editRate(en.displayName("copper_nugget"), "600");
  await drain();

  const first = withRate(NUGGET_AND_POWDER_PLAN, "iron_powder", TEN);
  const second = withRate(first, "copper_nugget", TEN);
  const expected = "#" + (await encodePlan(second));
  expect(window.location.hash).toBe(expected);
  expect(replacedHashes()).toEqual([expected]);
});

test("a superseded infeasible commit writes no hash", async () => {
  await bootOn(NUGGET_AND_POWDER_PLAN);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  replaceSpy.mockClear();

  solverGate.throwAll = true;
  editRate(en.displayName("iron_powder"), "600");
  editRate(en.displayName("copper_nugget"), "600");
  await screen.findByRole("alert");
  await drain();

  const first = withRate(NUGGET_AND_POWDER_PLAN, "iron_powder", TEN);
  const second = withRate(first, "copper_nugget", TEN);
  const expected = "#" + (await encodePlan(second));
  expect(window.location.hash).toBe(expected);
  expect(replacedHashes()).toEqual([expected]);
  const written = await loadPlan(window.location.hash, pack);
  expect(written.kind).toBe("loaded");
});

// The blocked banner joins its sentences through the shared helper: zh runs
// the settings pointer straight on after the full-width full stop, en keeps
// the single space.
test.each([
  { locale: "en" as const, i18n: en, gap: ". " },
  { locale: "zh" as const, i18n: zh, gap: "。" },
])(
  "the blocked banner joins sentences by locale ($locale)",
  async ({ locale, i18n, gap }) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    window.localStorage.setItem(AREA_STORAGE_KEY, VALLEY);
    await bootOn(NUGGET_AND_POWDER_PLAN);

    const banner = await screen.findByRole("alert");
    const text = banner.textContent ?? "";
    expect(text).toContain(gap + i18n.t("app.error.blocked.settings"));
    expect(text).not.toContain("。 ");
  },
);
