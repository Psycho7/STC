// @vitest-environment jsdom
//
// Event-cohort overrides against the whole app (#144): the v1.5 cohort
// defaults on (it matches the pack's own version), so a plan targeting an
// event item solves; a stored `false` flips it off, and the boot validation
// failure names the cohort in the UI language (default locale zh - no
// aef.locale is seeded). A mid-session flip is driven through the `storage`
// event a second browser tab would fire, which routes through the same
// override writer the T5 settings panel will use: the committed plan must
// re-validate WITHOUT clearing the render, and flipping back must re-solve.
// A link the stored overrides block is adopted unsolved under the blocked
// banner, never the damaged-link splash: the header gear is the recovery, and
// flipping the cohort on solves the linked plan.
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
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

// A seam for the reason-only transition below: the core is left alone until a
// test arms `recast`, at which point every derived cause keeps its recipe id
// and swaps its kind. The app produces area causes on its own now (#124's
// settlement picker), but no manual ones yet (#125 owns that toggle), and the
// point of the case is precisely that the ids do not move.
const availabilitySpy = vi.hoisted(() => ({
  recast: null as null | { kind: "manual"; recipeId: string },
  lastIds: [] as string[],
}));
vi.mock("./data/availability", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./data/availability")>();
  return {
    ...orig,
    unavailableCauses: (...args: Parameters<typeof orig.unavailableCauses>) => {
      const causes = orig.unavailableCauses(...args);
      availabilitySpy.lastIds = [...causes.keys()].sort();
      const recast = availabilitySpy.recast;
      if (recast === null) return causes;
      return new Map([...causes.keys()].map((id) => [id, recast]));
    },
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

import App from "./App";
import { encodePlan } from "./data/plan";
import { loadI18n } from "./data/i18n";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";
import { LUNG_PLAN, canvasSpy, flipStoredOverrides } from "./App.testkit";
import { pickerTile } from "./components/panel.testkit";

// The localized producer-unavailable copy the banner must render: the item's
// display name plus the cohort, per the T3 string.
const zhCohortError = loadI18n("zh").t("app.error.producer-unavailable.event", {
  item: loadI18n("zh").displayName("activity_xiranite_lung"),
  cohort: "v1.5",
});

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
  // Deliberately no aef.locale: these tests run the default zh locale, which
  // is what the localized assertions below pin. Anything left from an earlier
  // test would silently switch them to English.
  window.localStorage.clear();
  canvasSpy.status = "";
  availabilitySpy.recast = null;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

test("the lung plan boots solved with no stored override (pack cohort on)", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  expect(await screen.findAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a stored on override boots the same plan solved", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": true}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  expect(await screen.findAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a stored off override boots the plan unsolved under the localized cohort banner", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  // The plan decodes, so it is adopted into the panels with the banner - not
  // the damaged-link splash - and nothing is solved for it.
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(zhCohortError);
  expect(alert.textContent).toContain("v1.5");
  expect(screen.getByTestId("side-panel")).toBeTruthy();
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
});

// T7's end-to-end flow at unit level: the blocked plan's header gear opens the
// panel, and flipping the blocking cohort on solves the linked lung plan.
test("flipping the cohort on from the settings panel solves the blocked plan", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findByRole("alert");

  // The header gear opens the panel, which shows the cohort row in its
  // stored-off state.
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.getByRole("dialog").textContent).toContain("v1.5");
  const cohortSwitch = screen.getByRole("switch", {
    name: "切换 v1.5 活动",
  }) as HTMLInputElement;
  expect(cohortSwitch.checked).toBe(false);

  fireEvent.click(cohortSwitch);

  // The availability flip re-solves the adopted plan. Close the panel the way
  // a user would before the final asserts.
  expect(await screen.findAllByTestId("target-row")).toHaveLength(1);
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.queryByRole("alert")).toBeNull();
});

// A flip that cannot unblock the plan (the blocking cohort stays off) must not
// recover: the plan stays adopted and unsolved under the same banner.
test("a flip that leaves the blocking cohort off keeps the blocked banner", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(zhCohortError);

  // Another tab flips an unrelated cohort on while v1.5 stays off.
  flipStoredOverrides('{"v1.2": true, "v1.5": false}');

  // Still blocked: the same localized banner over the adopted plan.
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(zhCohortError),
  );
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
});

test("a mid-session flip off banners without clearing the render; flipping back re-solves", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  // Another tab switches v1.5 off. The committed plan re-validates against
  // the new availability set: banner plus stale, but the last render stays.
  flipStoredOverrides('{"v1.5": false}');

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhCohortError);
  // The setting applied, so nothing was refused: not the edit wrapper.
  expect(banner.textContent).not.toContain("无法应用此更改");
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  // Flipping the cohort back re-solves the same plan: the banner clears and
  // the canvas returns to READY.
  flipStoredOverrides('{"v1.5": true}');

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
});

// Revalidation keys on the cause map, not on the id set: the same recipes can
// become unavailable for a different reason, and the banner has to follow the
// reason. Stabilizing on set membership alone would leave the event wording up
// after the switch behind it changed.
test("a reason-only availability change with an unchanged id set updates the banner", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  flipStoredOverrides('{"v1.5": false}');
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhCohortError);
  const idsUnderEvent = availabilitySpy.lastIds;

  // Same recipes, different reason. The flip that triggers the re-derivation
  // touches a cohort the pack does not carry, so the id set cannot move.
  availabilitySpy.recast = {
    kind: "manual",
    recipeId: "activity_xiranite_lung",
  };
  flipStoredOverrides('{"v1.5": false, "v1.1": true}');

  // #125 gave the manual kind its own localized sentence, so the banner now
  // reads that one; it still names the recipe the recast cause points at.
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      loadI18n("zh").t("app.error.producer-unavailable.manual", {
        item: loadI18n("zh").displayName("activity_xiranite_lung"),
        recipe: loadI18n("zh").displayName("activity_xiranite_lung"),
      }),
    ),
  );
  expect(screen.getByRole("alert").textContent).not.toContain(zhCohortError);
  expect(availabilitySpy.lastIds).toEqual(idsUnderEvent);
  expect(idsUnderEvent.length).toBeGreaterThan(0);
});

// The settings panel (T5) is the in-app writer for those overrides: the header
// gear button opens the modal, whose Events section names the cohort in the UI
// language. Escape is one of its three close paths.
test("the header gear button opens the settings panel; Escape closes it", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("v1.5");
  expect(dialog.textContent).toContain("当前");
  expect(
    (screen.getByRole("switch", { name: "切换 v1.5 活动" }) as HTMLInputElement)
      .checked,
  ).toBe(true);

  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Reopening works after a close.
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

// The pickers (T6): App derives the off-cohort item map from the stored
// overrides and hands it to both panels, so their tiles dim and the hint names
// the cohort the validation error also names - default zh locale here.
test("a stored off override dims the cohort's items in both pickers with the hint", async () => {
  window.localStorage.setItem(
    EVENT_COHORT_OVERRIDES_STORAGE_KEY,
    '{"v1.5": false}',
  );
  render(<App />);
  await screen.findByTestId("side-panel");

  // Targets picker: one click on Add target opens the picker directly (R4).
  fireEvent.click(screen.getByRole("button", { name: "添加目标" }));
  const lungTile = pickerTile("activity_xiranite_lung")!;
  expect(lungTile).not.toBeNull();
  expect(lungTile.disabled).toBe(true);
  // The target picker also carries the area line: the default settlement
  // always leaves the other one's coupon without a producer.
  const targetHint = document.querySelector('[data-testid="picker-hint"]')!;
  expect(targetHint.textContent).toContain(
    loadI18n("zh").t("picker.event.off", { cohorts: "v1.5" }),
  );
  expect(targetHint.textContent).toContain(loadI18n("zh").t("picker.area.off"));
  fireEvent.keyDown(document, { key: "Escape" });

  // Inputs picker: same cohort, same dimming, same hint line.
  fireEvent.click(screen.getByRole("button", { name: "添加输入" }));
  const polyTile = pickerTile("activity_copper_poly")!;
  expect(polyTile).not.toBeNull();
  expect(polyTile.disabled).toBe(true);
  const inputHint = document.querySelector('[data-testid="picker-hint"]')!;
  expect(inputHint.textContent).toBe(
    loadI18n("zh").t("picker.event.off", { cohorts: "v1.5" }),
  );
});
