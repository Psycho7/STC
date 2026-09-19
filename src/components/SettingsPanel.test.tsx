// @vitest-environment jsdom
//
// The settings modal shell (#123's surface) with the Locale row (#123), the
// Area group (#124), the Recipes section (#125) and the Events section (#144):
// open and close paths (Escape, overlay, close button, focus return), the
// per-cohort switch storing exactly one override, the section reset clearing
// all, the current/past pill following the pack's own version, the recipe
// expansion, and the recipe toggles over the shipped pack. The harness mirrors
// how App mounts the panel: an opener button flips it into the tree, and
// onClose unmounts it.
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { SettingsPanel } from "./SettingsPanel";
import { LocaleProvider } from "../data/i18n-context";
import {
  packCohortOf,
  readStoredArea,
  readStoredDisabledRecipes,
  unavailableCauses,
  writeStoredArea,
  writeStoredDisabledRecipes,
  type EventCohortOverrides,
} from "../data/availability";
import { pack as realPack } from "../data/load";
import type { Locale } from "../data/i18n";
import {
  AREA_STORAGE_KEY,
  DISABLED_RECIPES_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
} from "../data/storage-keys";

afterEach(cleanup);
afterEach(() => window.localStorage.clear());

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
  locale = "en",
}: {
  pack?: RecipePack;
  overrides?: EventCohortOverrides;
  locale?: Locale;
} = {}) {
  const onOverridesChange = vi.fn();
  const onClose = vi.fn();
  // The controlled owner the way App is one: overrides live here, the panel's
  // emissions are applied back, and every close path unmounts the panel.
  let latest = overrides;
  function Host() {
    const [open, setOpen] = useState(false);
    const [current, setCurrent] = useState(overrides);
    // The area is owned exactly the way App owns it: read from storage once,
    // and every change applied to memory and storage by one writer. That is
    // what makes the persistence assertions below about the real seam rather
    // than about a mock the test wrote.
    const [area, setArea] = useState(() => readStoredArea(pack));
    // #125's set, owned on the same terms: read once, and one writer applying
    // memory and storage together.
    const [disabled, setDisabled] = useState(() =>
      readStoredDisabledRecipes(pack),
    );
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
            area={area}
            onAreaChange={(next) => {
              setArea(next);
              writeStoredArea(next);
            }}
            disabledRecipeIds={disabled}
            onDisabledRecipesChange={(next) => {
              setDisabled(next);
              writeStoredDisabledRecipes(next);
            }}
            unavailableCauses={unavailableCauses(pack, {
              eventOverrides: current,
              ...(area !== undefined ? { area } : {}),
              disabledRecipeIds: disabled,
            })}
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
    <LocaleProvider locale={locale}>
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

// #124's Area section. Labels come from the pack's i18n sidecar, so the en
// harness reads the English settlement names.
function areaOption(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

test("the area group offers all areas plus one option per settlement", () => {
  renderSettings();
  openPanel();
  const options = screen.getAllByRole("radio");
  expect(options.map((o) => o.textContent)).toEqual([
    "All areas",
    "Valley IV",
    "Wuling",
  ]);
  // Nothing stored: the plan spans every area.
  expect(areaOption("All areas").getAttribute("aria-checked")).toBe("true");
});

test("choosing an area persists it and checks exactly that option", () => {
  renderSettings();
  openPanel();
  fireEvent.click(areaOption("Valley IV"));
  expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBe("tundra");
  expect(areaOption("Valley IV").getAttribute("aria-checked")).toBe("true");
  expect(areaOption("All areas").getAttribute("aria-checked")).toBe("false");
  // Back to all areas: the key goes away rather than storing a sentinel.
  fireEvent.click(areaOption("All areas"));
  expect(window.localStorage.getItem(AREA_STORAGE_KEY)).toBeNull();
  expect(areaOption("All areas").getAttribute("aria-checked")).toBe("true");
});

test("the panel opens on the stored area, not the default", () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "jinlong");
  renderSettings();
  openPanel();
  expect(areaOption("Wuling").getAttribute("aria-checked")).toBe("true");
  expect(areaOption("All areas").getAttribute("aria-checked")).toBe("false");
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

// #125's Recipes section. The counts below are measured against the shipped
// pack and are meant to move only when the pack does: 28 items have more than
// one producer, carrying 98 producer rows between them, and the 197 non-supply
// recipes sit on 29 machines (ten of them listed twice, once per producer).
const MULTI_PRODUCER_ITEMS = 28;
const PRODUCER_ROWS = 98;
const MACHINE_GROUPS = 29;

function itemGroups(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[data-testid="settings-item-group"]');
}

function machineGroups(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[data-testid="settings-machine-group"]');
}

function recipeCheckboxes(root: ParentNode = document): HTMLInputElement[] {
  return [
    ...root.querySelectorAll<HTMLInputElement>(
      '[data-testid="settings-recipe-checkbox"]',
    ),
  ];
}

function expandAllRecipes(): void {
  fireEvent.click(screen.getByRole("button", { name: "Show all recipes" }));
}

function filterRecipes(value: string): void {
  fireEvent.change(screen.getByTestId("settings-recipe-filter"), {
    target: { value },
  });
}

test("the panel's sections read Locale, Area, Recipes, Events", () => {
  renderSettings();
  openPanel();
  const labels = [
    ...document.querySelectorAll<HTMLElement>(".settings-section"),
  ].map((s) => s.getAttribute("aria-label"));
  expect(labels).toEqual(["Language", "Area", "Recipes", "Events"]);
});

test("the default recipe view is the multi-producer items, one row per producer", () => {
  renderSettings();
  openPanel();
  expect(itemGroups()).toHaveLength(MULTI_PRODUCER_ITEMS);
  expect(recipeCheckboxes()).toHaveLength(PRODUCER_ROWS);
  // The full list is collapsed on open: no machine group is in the DOM.
  expect(machineGroups()).toHaveLength(0);
  // Nothing stored, so every row reads enabled.
  expect(recipeCheckboxes().every((c) => c.checked)).toBe(true);
  // Each row carries its machine and its inputs, the way the events expansion
  // does.
  const liquidCopper = document.querySelector<HTMLElement>(
    '[data-testid="settings-item-group"][data-item="liquid_copper"]',
  )!;
  expect(liquidCopper.textContent).toContain("Cuprium Solution");
  expect(liquidCopper.textContent).toContain("machine ");
  expect(liquidCopper.textContent).toContain("in ");
});

test("a toggle stores the recipe id and reads back off", () => {
  renderSettings();
  openPanel();
  const row = document.querySelector<HTMLElement>(
    '[data-testid="settings-recipe-toggle"][data-recipe="phase_trans_1-liquid_copper"]',
  )!;
  const box = recipeCheckboxes(row)[0]!;
  fireEvent.click(box);

  expect(window.localStorage.getItem(DISABLED_RECIPES_STORAGE_KEY)).toBe(
    '["phase_trans_1-liquid_copper"]',
  );
  expect(recipeCheckboxes(row)[0]!.checked).toBe(false);

  // And back on: the id leaves the stored set rather than lingering as false.
  fireEvent.click(recipeCheckboxes(row)[0]!);
  expect(window.localStorage.getItem(DISABLED_RECIPES_STORAGE_KEY)).toBe("[]");
  expect(recipeCheckboxes(row)[0]!.checked).toBe(true);
});

test("the expansion groups every recipe by machine, listing a two-producer recipe under both", () => {
  renderSettings();
  openPanel();
  expandAllRecipes();
  expect(machineGroups()).toHaveLength(MACHINE_GROUPS);

  const rowsFor = (machine: string) =>
    document.querySelectorAll<HTMLElement>(
      `[data-testid="settings-machine-group"][data-machine="${machine}"] [data-recipe="liquid_copper"]`,
    );
  expect(rowsFor("mix_pool_1")).toHaveLength(1);
  expect(rowsFor("mix_pool_2")).toHaveLength(1);

  // One toggle, two rows: the checkbox is keyed on the recipe id, so flipping
  // either seat moves both.
  fireEvent.click(recipeCheckboxes(rowsFor("mix_pool_1")[0]!)[0]!);
  expect(recipeCheckboxes(rowsFor("mix_pool_1")[0]!)[0]!.checked).toBe(false);
  expect(recipeCheckboxes(rowsFor("mix_pool_2")[0]!)[0]!.checked).toBe(false);
  expect(window.localStorage.getItem(DISABLED_RECIPES_STORAGE_KEY)).toBe(
    '["liquid_copper"]',
  );

  // Collapsing hides the machine groups and leaves the item view standing.
  fireEvent.click(screen.getByRole("button", { name: "Hide all recipes" }));
  expect(machineGroups()).toHaveLength(0);
  expect(itemGroups()).toHaveLength(MULTI_PRODUCER_ITEMS);
});

test("the filter matches a zh name under the en locale", () => {
  renderSettings();
  openPanel();
  filterRecipes("赤铜溶液");
  expect([...itemGroups()].map((g) => g.dataset.item)).toEqual([
    "liquid_copper",
  ]);
  // The same needle carries into the expansion, which keeps both of that
  // item's producers under their own machines.
  expandAllRecipes();
  const shown = new Set(
    [
      ...document.querySelectorAll('[data-testid="settings-recipe-toggle"]'),
    ].map((r) => r.getAttribute("data-recipe")),
  );
  expect([...shown].sort()).toEqual([
    "liquid_copper",
    "phase_trans_1-liquid_copper",
  ]);
});

test("the filter matches an en name under the zh locale", () => {
  renderSettings({ locale: "zh" });
  openPanel();
  fireEvent.change(screen.getByTestId("settings-recipe-filter"), {
    target: { value: "Cuprium Solution" },
  });
  expect([...itemGroups()].map((g) => g.dataset.item)).toEqual([
    "liquid_copper",
  ]);
});

test("an area-hidden recipe is a disabled row carrying its reason", () => {
  window.localStorage.setItem(AREA_STORAGE_KEY, "tundra");
  renderSettings();
  openPanel();
  // copper_nugget is tagged for 武陵; under the tundra it is not a choice the
  // user has, so the row states the reason instead of offering a toggle.
  const row = document.querySelector<HTMLElement>(
    '[data-testid="settings-recipe-toggle"][data-recipe="copper_nugget"]',
  )!;
  expect(recipeCheckboxes(row)[0]!.disabled).toBe(true);
  expect(row.textContent).toContain("Valley IV");

  // A recipe the area keeps is still a live toggle in the same view.
  const live = document.querySelector<HTMLElement>(
    '[data-testid="settings-recipe-toggle"][data-recipe="carbon_enr_powder-carbon_powder"]',
  )!;
  expect(recipeCheckboxes(live)[0]!.disabled).toBe(false);
});
