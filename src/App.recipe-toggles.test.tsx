// @vitest-environment jsdom
//
// The manual recipe toggles against the whole app (#125): the disabled set is
// read once at boot, written by the one writer the settings panel drives, and
// re-read through the `storage` event a second tab fires. The plan under test
// targets an item with a single producer, so switching that recipe off is the
// acceptance line: the plan stays adopted under the blocked banner, which names
// the item by display name and the toggle, never the damaged-link splash, the
// edit rejection or a solver throw.
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

const canvasSpy = vi.hoisted(() => ({ status: "" }));
vi.mock("./canvas/Canvas", () => ({
  default: (props: { status?: string }) => {
    canvasSpy.status = props.status ?? "";
    return null;
  },
}));

import App, { describeBlockedTarget } from "./App";
import { defaultPlan, encodePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { DISABLED_RECIPES_STORAGE_KEY } from "./data/storage-keys";

// The bottle has exactly one producer, the recipe of the same id, so the
// toggle below is the only thing standing between the plan and a blocked
// target.
const BOTTLE_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } }],
};

const i18n = loadI18n("zh");
// The localized banner sentence: the item and the toggle both by the names the
// panels show.
const zhManualError = describeBlockedTarget(
  {
    itemId: "copper_bottle",
    cause: { kind: "manual", recipeId: "copper_bottle" },
  },
  i18n,
);

// The texts of the other outcomes, which a blocked plan must never show: the
// damaged-link splash and the edit rejection wrapper.
function expectNoRejection(): void {
  const text = document.body.textContent ?? "";
  expect(text).not.toContain(i18n.t("app.error.corrupt"));
  expect(text).not.toContain(i18n.t("app.error.edit", { message: "" }).trim());
}

// Clicks the bottle's checkbox in the settings panel's full recipe list,
// opening the panel and its disclosure first when they are not up yet.
function clickBottleToggle(): void {
  if (!screen.queryByRole("dialog")) {
    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  }
  const dialog = screen.getByRole("dialog");
  const showAll = screen.queryByRole("button", {
    name: i18n.t("settings.recipes.showAll"),
  });
  if (showAll) {
    fireEvent.click(showAll);
  }
  const row = dialog.querySelector<HTMLElement>(
    '[data-testid="settings-recipe-toggle"][data-recipe="copper_bottle"]',
  )!;
  fireEvent.click(
    row.querySelector<HTMLInputElement>(
      '[data-testid="settings-recipe-checkbox"]',
    )!,
  );
}

// Another tab flipping the set: same-document writes fire no `storage` event,
// so the test writes the key and dispatches the event the browser would have
// delivered to the other windows.
function flipStoredDisabled(json: string): void {
  window.localStorage.setItem(DISABLED_RECIPES_STORAGE_KEY, json);
  fireEvent(
    window,
    new StorageEvent("storage", { key: DISABLED_RECIPES_STORAGE_KEY }),
  );
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
  // No aef.locale: the default zh locale is what the localized assertions pin.
  window.localStorage.clear();
  canvasSpy.status = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
  window.localStorage.clear();
});

test("a stored disable boots the bottle plan adopted under the blocked banner", async () => {
  window.localStorage.setItem(
    DISABLED_RECIPES_STORAGE_KEY,
    '["copper_bottle"]',
  );
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);

  const rows = await screen.findAllByTestId("target-row");
  expect(rows).toHaveLength(1);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(zhManualError);
  expect(alert.textContent).toContain(i18n.displayName("copper_bottle"));
  expect(alert.textContent).not.toContain("copper_bottle");
  expectNoRejection();
  // Nothing was solved for it: the empty canvas reads as stale.
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));
});

test("a cross-tab flip banners the committed plan, and flipping back re-solves", async () => {
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  flipStoredDisabled('["copper_bottle"]');

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhManualError);
  // The render stays up behind the banner, the way an event flip leaves it.
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);

  flipStoredDisabled("[]");

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
});

test("a toggle flipped in the panel lands in storage and survives a remount", async () => {
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  clickBottleToggle();

  // The one writer persisted it, and the committed plan revalidated against
  // the new set without any storage event: this is the same-document path.
  expect(window.localStorage.getItem(DISABLED_RECIPES_STORAGE_KEY)).toBe(
    '["copper_bottle"]',
  );
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhManualError);

  // A fresh mount reads the set back off storage rather than starting clean.
  cleanup();
  render(<App />);
  expect((await screen.findByRole("alert")).textContent).toContain(
    zhManualError,
  );
});

test("disabling the last producer in the panel banners the adopted plan; re-enabling re-solves", async () => {
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  clickBottleToggle();

  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toContain(zhManualError);
  expect(banner.textContent).toContain(i18n.displayName("copper_bottle"));
  expect(banner.textContent).not.toContain("copper_bottle");
  expect(banner.textContent).toContain(i18n.t("app.error.blocked.settings"));
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
  expectNoRejection();
  await waitFor(() => expect(canvasSpy.status).toBe("ERROR"));

  clickBottleToggle();

  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));
  expect(window.localStorage.getItem(DISABLED_RECIPES_STORAGE_KEY)).toBe("[]");
});
