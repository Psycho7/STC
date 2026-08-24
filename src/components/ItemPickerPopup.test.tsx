// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import type { Item } from "@aef/schema";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { LocaleProvider } from "../data/i18n-context";
import { pack as realPack } from "../data/load";
import { computeItemDepths } from "../data/recipe-depth";

afterEach(cleanup);

function mkItem(id: string): Item {
  return { id, category: "cat", icon: id } as unknown as Item;
}

// Tier 1 is deliberately NOT in name order in the array, so a within-group
// ordering assertion fails if the popup stops sorting.
const ITEMS = [
  mkItem("delta"),
  mkItem("bravo"),
  mkItem("alpha"),
  mkItem("charlie"),
  mkItem("echo"),
];

// alpha, bravo, delta -> tier 1; charlie -> tier 2; echo -> Infinity.
const TIERS = new Map<string, number>([
  ["alpha", 1],
  ["bravo", 1],
  ["delta", 1],
  ["charlie", 2],
  ["echo", Number.POSITIVE_INFINITY],
]);

function renderPopup(
  overrides: Partial<ComponentProps<typeof ItemPickerPopup>> = {},
) {
  const props: ComponentProps<typeof ItemPickerPopup> = {
    items: ITEMS,
    disabledIds: new Set<string>(),
    tierByItemId: TIERS,
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <LocaleProvider locale="en">
      <ItemPickerPopup {...props} />
    </LocaleProvider>,
  );
  return props;
}

function tile(itemId: string): HTMLButtonElement | null {
  return document.querySelector(`[data-item-id="${itemId}"]`);
}

function groupHeads(): string[] {
  return [...document.querySelectorAll(".recipe-picker-group-head")].map(
    (el) => el.textContent ?? "",
  );
}

test("renders tier groups in ascending order with the Infinity bucket last", () => {
  renderPopup();
  expect(groupHeads()).toEqual(["Tier 1", "Tier 2", "Cyclic / unranked"]);
});

test("search filters tiles and hides emptied groups", async () => {
  const user = userEvent.setup();
  renderPopup();
  await user.type(screen.getByLabelText(/search/i), "charlie");
  expect(tile("charlie")).not.toBeNull();
  expect(tile("alpha")).toBeNull();
  expect(tile("delta")).toBeNull();
  // Only the tier-2 group survives.
  expect(groupHeads()).toEqual(["Tier 2"]);
});

test("shows the empty-state message when nothing matches", async () => {
  const user = userEvent.setup();
  renderPopup();
  await user.type(screen.getByLabelText(/search/i), "zzz-no-match");
  expect(screen.getByTestId("picker-empty")).toBeTruthy();
  expect(document.querySelectorAll('[data-testid="picker-tile"]').length).toBe(
    0,
  );
});

test("a disabled tile is not clickable and does not fire onPick", () => {
  const props = renderPopup({ disabledIds: new Set(["bravo"]) });
  const disabled = tile("bravo")!;
  expect(disabled.disabled).toBe(true);
  fireEvent.click(disabled);
  expect(props.onPick).not.toHaveBeenCalled();
});

test("clicking a tile fires onPick with its item id", () => {
  const props = renderPopup();
  fireEvent.click(tile("charlie")!);
  expect(props.onPick).toHaveBeenCalledWith("charlie");
});

test("Escape fires onClose", () => {
  const props = renderPopup();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});

test("backdrop click fires onClose; a click inside the panel does not", () => {
  const props = renderPopup();
  fireEvent.click(screen.getByText("Select item"));
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".recipe-picker-backdrop")!);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test("renders the disabled hint line when the prop is set", () => {
  renderPopup({ disabledHint: "already in the panel" });
  const hint = screen.getByTestId("picker-hint");
  expect(hint.textContent).toBe("already in the panel");
  // The hint is a sibling of the scroll body, not inside it, so it never
  // scrolls out of view.
  expect(hint.parentElement?.className).toBe("recipe-picker");
});

test("renders no hint line when the prop is absent", () => {
  renderPopup();
  expect(screen.queryByTestId("picker-hint")).toBeNull();
});

test("sorts tiles by localized name within each group, not by array order", () => {
  renderPopup();
  const groups = [...document.querySelectorAll(".recipe-picker-group")];
  const namesPerGroup = groups.map((g) =>
    [...g.querySelectorAll(".recipe-picker-tile-label")].map(
      (el) => el.textContent ?? "",
    ),
  );
  const collator = new Intl.Collator("en");
  for (const names of namesPerGroup) {
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
  }
  // Tier 1 specifically: array order was delta, bravo, alpha.
  expect(namesPerGroup[0]).toEqual(["alpha", "bravo", "delta"]);
});

// The fixture above cannot pin this: its ids have no i18n entries, so
// displayName falls back to the id and a name sort is indistinguishable from an
// id sort. Only the real pack in a non-latin locale separates the two, which is
// what the retired InputsPanel option-order test used to guarantee.
test("sorts by localized name rather than by id, on the real pack in zh", () => {
  render(
    <LocaleProvider locale="zh">
      <ItemPickerPopup
        items={realPack.items}
        disabledIds={new Set<string>()}
        tierByItemId={computeItemDepths(realPack)}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    </LocaleProvider>,
  );
  const collator = new Intl.Collator("zh");
  const groups = [...document.querySelectorAll(".recipe-picker-group")];
  expect(groups.length).toBeGreaterThan(1);
  let sawDivergence = false;
  for (const g of groups) {
    const tiles = [...g.querySelectorAll('[data-testid="picker-tile"]')];
    const names = tiles.map(
      (t) => t.querySelector(".recipe-picker-tile-label")?.textContent ?? "",
    );
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
    // And the result differs from an id sort somewhere, which is the half that
    // proves the key is the name and not the id.
    const ids = tiles.map((t) => t.getAttribute("data-item-id") ?? "");
    if (ids.join() !== [...ids].sort().join()) sawDivergence = true;
  }
  expect(sawDivergence).toBe(true);
});

function tiles(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="picker-tile"]',
    ),
  ];
}

test("the grid is one tab stop, not one per tile", () => {
  renderPopup({ disabledIds: new Set(["bravo"]) });
  const tabbable = tiles().filter((t) => t.tabIndex === 0);
  // A tabbable tile per item would put one stop per pack item between the
  // search box and the end of the dialog.
  expect(tabbable.length).toBe(1);
  // With nothing selected the stop starts on the first enabled tile in visual
  // order, which is alpha (tier 1, name-sorted, bravo disabled).
  expect(tabbable[0]!.getAttribute("data-item-id")).toBe("alpha");
});

test("the tab stop starts on the selected tile when there is one", () => {
  renderPopup({ selectedId: "charlie" });
  const tabbable = tiles().filter((t) => t.tabIndex === 0);
  expect(tabbable.map((t) => t.getAttribute("data-item-id"))).toEqual([
    "charlie",
  ]);
});

test("arrow keys walk the grid and skip disabled tiles", () => {
  renderPopup({ disabledIds: new Set(["bravo"]) });
  const alpha = tile("alpha")!;
  alpha.focus();
  // Tier 1 is alpha, bravo, delta by name; bravo is disabled and takes no
  // focus, so Right from alpha lands on delta.
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tile("delta"));
  fireEvent.keyDown(tile("delta")!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(alpha);
  // End crosses group boundaries to the last enabled tile overall.
  fireEvent.keyDown(alpha, { key: "End" });
  expect(document.activeElement).toBe(tile("echo"));
  fireEvent.keyDown(tile("echo")!, { key: "Home" });
  expect(document.activeElement).toBe(alpha);
});

test("arrow movement clamps at both ends instead of wrapping", () => {
  renderPopup();
  const alpha = tile("alpha")!;
  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(alpha);
  const echo = tile("echo")!;
  echo.focus();
  fireEvent.keyDown(echo, { key: "ArrowRight" });
  expect(document.activeElement).toBe(echo);
});

test("moving the tab stop leaves exactly one tabbable tile behind", () => {
  renderPopup();
  const alpha = tile("alpha")!;
  alpha.focus();
  fireEvent.keyDown(alpha, { key: "End" });
  const tabbable = tiles().filter((t) => t.tabIndex === 0);
  expect(tabbable.map((t) => t.getAttribute("data-item-id"))).toEqual(["echo"]);
});

test("Tab is trapped inside the dialog at both ends", () => {
  renderPopup();
  const close = screen.getByLabelText(/close/i);
  const stop = tiles().find((t) => t.tabIndex === 0)!;
  // Forward off the last stop comes back to the first, rather than leaving for
  // the page behind the backdrop.
  stop.focus();
  fireEvent.keyDown(stop, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  // And backward off the first goes to the last.
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(stop);
});

test("Tab in the middle of the ring is left to the browser", () => {
  const props = renderPopup();
  const search = screen.getByLabelText(/search/i) as HTMLInputElement;
  search.focus();
  const handled = fireEvent.keyDown(search, { key: "Tab" });
  // fireEvent returns false when a handler called preventDefault. The search
  // box is neither end of the ring, so nothing intercepts it.
  expect(handled).toBe(true);
  expect(document.activeElement).toBe(search);
  expect(props.onClose).not.toHaveBeenCalled();
});

test("a move with no enabled tile beyond it stays put", () => {
  // Everything after alpha in visual order is disabled, so Right, Down and End
  // all have nowhere to land.
  renderPopup({ disabledIds: new Set(["bravo", "delta", "charlie", "echo"]) });
  const alpha = tile("alpha")!;
  alpha.focus();
  for (const key of ["ArrowRight", "ArrowDown", "End"]) {
    fireEvent.keyDown(alpha, { key });
    expect(document.activeElement).toBe(alpha);
  }
});

test("the roving stop never lands on a disabled tile", () => {
  // alpha is both the selected id and disabled: the stop has to fall through to
  // the first enabled tile rather than park somewhere unfocusable.
  renderPopup({ selectedId: "alpha", disabledIds: new Set(["alpha"]) });
  const tabbable = tiles().filter((t) => t.tabIndex === 0);
  expect(tabbable.map((t) => t.getAttribute("data-item-id"))).toEqual([
    "bravo",
  ]);
});
