// @vitest-environment jsdom
//
// The manual recipe toggles against the whole app (#125): the disabled set is
// read once at boot, written by the one writer the settings panel drives, and
// re-read through the `storage` event a second tab fires. The plan under test
// targets an item with a single producer, so switching that recipe off is the
// acceptance line - a validation banner naming the item and the toggle, not a
// solver throw.
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

import App from "./App";
import { defaultPlan, encodePlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { DISABLED_RECIPES_STORAGE_KEY } from "./data/storage-keys";

// The bottle has exactly one producer, the recipe of the same id, so the
// toggle below is the only thing standing between the plan and a validation
// error.
const BOTTLE_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } }],
};

// The blue-iron nugget has two producers, so one toggle leaves the target
// buildable and the second one strands it: the two halves of the notice rule.
const IRON_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "iron_nugget", ratePerSec: { num: "1", denom: "1" } }],
};
const IRON_PRODUCERS = ["iron_nugget-iron_ore", "iron_nugget-iron_powder"];

const i18n = loadI18n("zh");
// The localized banner: the item by id, the toggle by the name the panel shows.
const zhManualError = i18n.t("app.error.producer-unavailable.manual", {
  itemId: "copper_bottle",
  recipe: i18n.displayName("copper_bottle"),
});

function zhNotice(...itemIds: string[]): string {
  return i18n.t("settings.recipes.notice", {
    items: itemIds.map((id) => i18n.displayName(id)).join(" · "),
  });
}

function openSettings(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  return screen.getByRole("dialog");
}

function recipeCheckbox(recipeId: string): HTMLInputElement {
  const row = screen
    .getByRole("dialog")
    .querySelector<HTMLElement>(
      `[data-testid="settings-recipe-toggle"][data-recipe="${recipeId}"]`,
    )!;
  return row.querySelector<HTMLInputElement>(
    '[data-testid="settings-recipe-checkbox"]',
  )!;
}

function noticeText(): string {
  return screen.getByTestId("settings-recipe-notice").textContent ?? "";
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

test("a stored disable boots the bottle plan to the localized manual error", async () => {
  window.localStorage.setItem(
    DISABLED_RECIPES_STORAGE_KEY,
    '["copper_bottle"]',
  );
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(zhManualError);
  expect(screen.queryByTestId("target-row")).toBeNull();
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

  fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  const dialog = screen.getByRole("dialog");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("settings.recipes.showAll") }),
  );
  const row = dialog.querySelector<HTMLElement>(
    '[data-testid="settings-recipe-toggle"][data-recipe="copper_bottle"]',
  )!;
  fireEvent.click(
    row.querySelector<HTMLInputElement>(
      '[data-testid="settings-recipe-checkbox"]',
    )!,
  );

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

// The notice (R1): switching off the last producer of a committed target is
// allowed, so the Recipes section says which target it just stranded while the
// modal is still open. The line reads off the COMMITTED plan, so an unrelated
// toggle leaves it empty.
test("disabling a committed target's last producer names it in the panel notice", async () => {
  window.location.hash = "#" + (await encodePlan(BOTTLE_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  openSettings();
  expect(noticeText()).toBe("");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("settings.recipes.showAll") }),
  );
  fireEvent.click(recipeCheckbox("copper_bottle"));

  expect(noticeText()).toBe(zhNotice("copper_bottle"));
  // The target is still in the plan: the toggle was allowed, not refused.
  expect(screen.getAllByTestId("target-row")).toHaveLength(1);
});

test("disabling one of several producers leaves the notice empty", async () => {
  window.location.hash = "#" + (await encodePlan(IRON_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  openSettings();
  fireEvent.click(recipeCheckbox(IRON_PRODUCERS[0]!));

  expect(noticeText()).toBe("");
});

test("re-enabling a producer clears the notice", async () => {
  window.location.hash = "#" + (await encodePlan(IRON_PLAN));
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(canvasSpy.status).toBe("READY"));

  openSettings();
  fireEvent.click(recipeCheckbox(IRON_PRODUCERS[0]!));
  fireEvent.click(recipeCheckbox(IRON_PRODUCERS[1]!));
  expect(noticeText()).toBe(zhNotice("iron_nugget"));

  fireEvent.click(recipeCheckbox(IRON_PRODUCERS[1]!));
  expect(noticeText()).toBe("");
});
