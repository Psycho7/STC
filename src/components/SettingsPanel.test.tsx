// @vitest-environment jsdom
//
// The settings modal shell (#123's surface) with the Locale row (#123) and the
// Events section (#144):
// open and close paths (Escape, overlay, close button, focus return), the
// per-cohort switch storing exactly one override, the section reset clearing
// all, the current/past pill following the pack's own version, and the
// recipe expansion. The harness mirrors how App mounts the panel: an opener
// button flips it into the tree, and onClose unmounts it.
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { SettingsPanel } from "./SettingsPanel";
import { LocaleProvider } from "../data/i18n-context";
import { packCohortOf, type EventCohortOverrides } from "../data/availability";
import { pack as realPack } from "../data/load";
import { LOCALE_STORAGE_KEY } from "../data/storage-keys";

afterEach(cleanup);
afterEach(() => window.localStorage.removeItem(LOCALE_STORAGE_KEY));

// A pack whose provenance is a LATER version (v9.9) carrying a few v1.5 rows,
// so the cohort must read "past" and default off. Slicing the shipped pack's
// v1.5 items/recipes keeps icons and names valid without hand-writing entity
// literals; the shipped pack itself stays the "current" fixture.
const pastPack: RecipePack = {
  ...realPack,
  source: { ...realPack.source, gameVersion: "v9.9" },
  items: realPack.items.filter((i) => i.event === "v1.5").slice(0, 3),
  recipes: realPack.recipes.filter((r) => r.event === "v1.5").slice(0, 2),
};

function renderSettings({
  pack = realPack,
  overrides = {},
}: {
  pack?: RecipePack;
  overrides?: EventCohortOverrides;
} = {}) {
  const onOverridesChange = vi.fn();
  const onClose = vi.fn();
  // The controlled owner the way App is one: overrides live here, the panel's
  // emissions are applied back, and every close path unmounts the panel.
  let latest = overrides;
  function Host() {
    const [open, setOpen] = useState(false);
    const [current, setCurrent] = useState(overrides);
    return (
      <>
        <button
          type="button"
          data-testid="settings-opener"
          onClick={() => setOpen(true)}
        >
          opener
        </button>
        {open ? (
          <SettingsPanel
            pack={pack}
            packCohort={packCohortOf(pack)}
            overrides={current}
            onOverridesChange={(next) => {
              latest = next;
              onOverridesChange(next);
              setCurrent(next);
            }}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          />
        ) : null}
      </>
    );
  }
  render(
    <LocaleProvider locale="en">
      <Host />
    </LocaleProvider>,
  );
  return {
    onOverridesChange,
    onClose,
    overrides: () => latest,
  };
}

function openPanel(): void {
  fireEvent.click(screen.getByTestId("settings-opener"));
}

function switchFor(cohort: string): HTMLInputElement {
  return screen.getByRole("switch", {
    name: `Toggle the ${cohort} event`,
  }) as HTMLInputElement;
}

test("renders nothing until opened; the opener mounts a labelled dialog", () => {
  renderSettings();
  expect(screen.queryByRole("dialog")).toBeNull();
  openPanel();
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  // Opening puts focus inside the dialog, not on the page behind it.
  expect(document.activeElement).toBe(dialog);
});

test("Escape closes the panel", () => {
  const h = renderSettings();
  openPanel();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(h.onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("an overlay click closes; a click inside the dialog does not", () => {
  const h = renderSettings();
  openPanel();
  fireEvent.click(screen.getByText("Events"));
  expect(h.onClose).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".settings-backdrop")!);
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

test("the close button closes the panel", () => {
  const h = renderSettings();
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

test("focus returns to the opener button on close", () => {
  renderSettings();
  const opener = screen.getByTestId("settings-opener");
  opener.focus();
  openPanel();
  expect(document.activeElement).toBe(screen.getByRole("dialog"));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

test("the locale control lives in the dialog and persists the choice", () => {
  renderSettings();
  openPanel();
  const dialog = screen.getByRole("dialog");
  const select = screen.getByTestId("locale-switcher") as HTMLSelectElement;
  expect(dialog.contains(select)).toBe(true);
  fireEvent.change(select, { target: { value: "zh" } });
  expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh");
});

test("the shipped pack's v1.5 row reads current, defaults on, with the default tag", () => {
  renderSettings();
  openPanel();
  expect(screen.getByText("current")).toBeTruthy();
  expect(switchFor("v1.5").checked).toBe(true);
  expect(screen.getByTestId("settings-default-tag").textContent).toBe(
    "default",
  );
  expect(screen.getByText("11 items · 14 recipes")).toBeTruthy();
});

test("a cohort from a later-version pack reads past and defaults off", () => {
  renderSettings({ pack: pastPack });
  openPanel();
  expect(screen.getByText("past")).toBeTruthy();
  expect(screen.queryByText("current")).toBeNull();
  expect(switchFor("v1.5").checked).toBe(false);
  // No override anywhere: the row sits at the version-rule default.
  expect(screen.getByTestId("settings-default-tag")).toBeTruthy();
});

test("flipping the switch stores exactly one cohort boolean", () => {
  const h = renderSettings();
  openPanel();
  fireEvent.click(switchFor("v1.5"));
  expect(h.onOverridesChange).toHaveBeenCalledTimes(1);
  expect(h.onOverridesChange).toHaveBeenCalledWith({ "v1.5": false });
  expect(h.overrides()).toEqual({ "v1.5": false });
});

test("a flip merges into the existing overrides and touches nothing else", () => {
  const h = renderSettings({ overrides: { "v1.2": true } });
  openPanel();
  fireEvent.click(switchFor("v1.5"));
  expect(h.onOverridesChange).toHaveBeenCalledWith({
    "v1.2": true,
    "v1.5": false,
  });
});

test("the default tag disappears once an override exists for the row", () => {
  renderSettings();
  openPanel();
  expect(screen.getByTestId("settings-default-tag")).toBeTruthy();
  fireEvent.click(switchFor("v1.5"));
  expect(screen.queryByTestId("settings-default-tag")).toBeNull();
  // The controlled owner applied the emission, so the switch reads back off.
  expect(switchFor("v1.5").checked).toBe(false);
});

test("the section reset clears every cohort override", () => {
  const h = renderSettings({ overrides: { "v1.5": false } });
  openPanel();
  fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
  expect(h.onOverridesChange).toHaveBeenCalledTimes(1);
  expect(h.onOverridesChange).toHaveBeenCalledWith({});
  expect(h.overrides()).toEqual({});
  // Applied back through the harness: the cohort is on the default rule again.
  expect(switchFor("v1.5").checked).toBe(true);
});

test("the show-recipes expansion lists the cohort's recipes with machine and inputs", () => {
  renderSettings();
  openPanel();
  expect(
    document.querySelectorAll('[data-testid="settings-recipe-row"]').length,
  ).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Show recipes" }));
  const rows = document.querySelectorAll('[data-testid="settings-recipe-row"]');
  expect(rows).toHaveLength(14);
  // Each row carries the localized machine label and the inputs summary.
  const first = rows[0]!;
  expect(first.textContent).toContain("machine ");
  expect(first.textContent).toContain("in ");
  expect(first.textContent).toContain("×");
  // Hiding collapses the list again.
  fireEvent.click(screen.getByRole("button", { name: "Hide recipes" }));
  expect(
    document.querySelectorAll('[data-testid="settings-recipe-row"]').length,
  ).toBe(0);
});
