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
afterEach(() => vi.restoreAllMocks());

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

// jsdom computes no grid template, so columnsFor falls back to one column and
// Up/Down degrade into Left/Right. Every row-step test has to report a width.
// Call it after render: it also checks the live grid reports n columns, so a
// selector that drifts from the component's cannot fall back to one column
// without a word. The row-step assertions are picked to fail at one column.
function mockColumns(n: number) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(((el: Element) =>
    el.classList?.contains("recipe-picker-grid")
      ? ({
          gridTemplateColumns: "40px ".repeat(n).trim(),
        } as CSSStyleDeclaration)
      : real(el)) as typeof window.getComputedStyle);
  const grid = document.querySelector(".recipe-picker-grid");
  expect(grid).not.toBeNull();
  expect(getComputedStyle(grid!).gridTemplateColumns.split(" ")).toHaveLength(
    n,
  );
}

// items plus tierByItemId from one id -> tier map, for grids the default
// fixture cannot shape.
function tiered(tiers: Record<string, number>) {
  return {
    items: Object.keys(tiers).map(mkItem),
    tierByItemId: new Map(Object.entries(tiers)),
  };
}

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

function tiles(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="picker-tile"]',
    ),
  ];
}

// The ids of every tile Tab can reach. The grid is meant to expose exactly one,
// so asserting the whole array pins the count and the identity together.
function tabStopIds(): string[] {
  return tiles()
    .filter((t) => t.tabIndex === 0)
    .map((t) => t.getAttribute("data-item-id") ?? "");
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
  renderPopup({
    disabledIds: new Set(["bravo"]),
    disabledHint: "already in the panel",
  });
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

// The hint explains dimmed tiles, so it only shows while the filter leaves one
// on screen. "charlie" keeps only an enabled tile; clearing brings bravo back.
test("hides the hint while the search leaves no disabled tile, shows it again after", () => {
  renderPopup({
    disabledIds: new Set(["bravo"]),
    disabledHint: "already in the panel",
  });
  expect(screen.queryByTestId("picker-hint")).not.toBeNull();

  searchFor("charlie");
  expect(tile("charlie")).not.toBeNull();
  expect(screen.queryByTestId("picker-hint")).toBeNull();

  searchFor("");
  expect(tile("bravo")!.disabled).toBe(true);
  expect(screen.queryByTestId("picker-hint")?.textContent).toBe(
    "already in the panel",
  );
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

test("the grid is one tab stop, not one per tile", () => {
  renderPopup({ disabledIds: new Set(["bravo"]) });
  // A tabbable tile per item would put one stop per pack item between the
  // search box and the end of the dialog. With nothing selected that one stop
  // starts on the first enabled tile in visual order, which is alpha (tier 1,
  // name-sorted, bravo disabled).
  expect(tabStopIds()).toEqual(["alpha"]);
});

test("the tab stop starts on the selected tile when there is one", () => {
  renderPopup({ selectedId: "charlie" });
  expect(tabStopIds()).toEqual(["charlie"]);
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

test("Up and Down step a whole grid row, not one tile", () => {
  // Two columns lay tier 1 out as alpha, bravo / delta, so Down from alpha must
  // reach delta, not bravo - the drift a one-column fallback would produce.
  renderPopup();
  mockColumns(2);
  const alpha = tile("alpha")!;
  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("delta"));
  fireEvent.keyDown(tile("delta")!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(alpha);
  // Right still steps one cell, so the two axes cannot collapse into each other.
  fireEvent.keyDown(alpha, { key: "ArrowRight" });
  expect(document.activeElement).toBe(tile("bravo"));
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
  expect(tabStopIds()).toEqual(["echo"]);
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
  expect(tabStopIds()).toEqual(["bravo"]);
});

// Each tier group is its own grid, so a row step has to respect that group's
// own rows. Stepping by a flat column count over the whole tile list lands one
// cell sideways of the column it started in whenever a group's last row is
// partial, and skips whole tiles when a group is narrower than the step. The
// default fixture has no group wider than a row, where a clamp is the same as
// the one-column fallback, so these tests use a wider one: at four columns
// tier 1 is a1 a2 a3 a4 / a5 a6, tier 2 is b1 b2 b3 and the Infinity bucket
// is c1 c2. Each comment names the tile a one-column fallback would give.
const WIDE = tiered({
  a1: 1,
  a2: 1,
  a3: 1,
  a4: 1,
  a5: 1,
  a6: 1,
  b1: 2,
  b2: 2,
  b3: 2,
  c1: Number.POSITIVE_INFINITY,
  c2: Number.POSITIVE_INFINITY,
});

test("ArrowDown off a full row clamps to the group's partial last row", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // a3 sits in column 2 of the full row; the row below holds only a5 a6, so
  // Down clamps to a6 (one column: a4).
  const a3 = tile("a3")!;
  a3.focus();
  fireEvent.keyDown(a3, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("a6"));
});

test("ArrowUp into a partial last row keeps the column", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // b1 is column 0 of tier 2. Up enters tier 1 at its last row, a5 a6, in
  // column 0, so it lands on a5 (one column: a6).
  const b1 = tile("b1")!;
  b1.focus();
  fireEvent.keyDown(b1, { key: "ArrowUp" });
  expect(document.activeElement).toBe(tile("a5"));
});

test("ArrowUp past the end of a partial last row clamps to the group's last tile", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // b3 is column 2 of tier 2, and tier 1's last row a5 a6 has no column 2, so
  // Up clamps to a6 rather than overshooting (one column: b2).
  const b3 = tile("b3")!;
  b3.focus();
  fireEvent.keyDown(b3, { key: "ArrowUp" });
  expect(document.activeElement).toBe(tile("a6"));
});

test("ArrowDown off a partial last row keeps the column into the next group", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // a6 is column 1 of tier 1's partial last row. Down crosses into tier 2 at
  // the same column, landing on b2 - not b3, the clamp target a regression to
  // "last tile of the neighbour" would give (one column: b1).
  const a6 = tile("a6")!;
  a6.focus();
  fireEvent.keyDown(a6, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("b2"));
});

test("a row step into a shorter group clamps to that group's last tile", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // Down from b3 (column 2) enters the Infinity bucket, whose single row c1 c2
  // ends at column 1, so it clamps to c2 (one column: c1).
  const b3 = tile("b3")!;
  b3.focus();
  fireEvent.keyDown(b3, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("c2"));
});

test("a row step onto a disabled tile walks on in the direction of travel", () => {
  renderPopup({ ...WIDE, disabledIds: new Set(["a6"]) });
  mockColumns(4);
  // Down from a3 clamps onto a6, which takes no focus, so the walk continues
  // forward into tier 2 (one column: a4).
  const a3 = tile("a3")!;
  a3.focus();
  fireEvent.keyDown(a3, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("b1"));
});

test("row steps follow the filtered groups, not the unfiltered ones", async () => {
  const user = userEvent.setup();
  // aa1-aa4 -> tier 1; mid -> tier 2; aa8 -> Infinity. Searching "aa" empties
  // the middle group, leaving tier 1 adjacent to the Infinity bucket.
  renderPopup(
    tiered({
      aa1: 1,
      aa2: 1,
      aa3: 1,
      aa4: 1,
      mid: 2,
      aa8: Number.POSITIVE_INFINITY,
    }),
  );
  mockColumns(2);
  await user.type(screen.getByLabelText(/search/i), "aa");
  expect(tile("mid")).toBeNull();
  // Tier 1 now reads aa1 aa2 / aa3 aa4, so Up from aa8 lands on aa3 (one
  // column: aa4).
  const aa8 = tile("aa8")!;
  aa8.focus();
  fireEvent.keyDown(aa8, { key: "ArrowUp" });
  expect(document.activeElement).toBe(tile("aa3"));
});

// Off the outermost group the step stays put by returning the source index,
// so on a sole end tile the outcome is the same at any width; the width is
// only there to send the step through the multi-column branch.
test("a row step past either end stays put", () => {
  renderPopup();
  mockColumns(2);
  const echo = tile("echo")!;
  echo.focus();
  fireEvent.keyDown(echo, { key: "ArrowDown" });
  expect(document.activeElement).toBe(echo);
  const alpha = tile("alpha")!;
  alpha.focus();
  fireEvent.keyDown(alpha, { key: "ArrowUp" });
  expect(document.activeElement).toBe(alpha);
});

// The two ends of the WHOLE list, each stepped off a tile the sideways clamp
// used to reach: Up off a non-zero column of the overall first row clamped to
// tile 0, Down off a non-last column of the partial last row clamped to the
// last tile. The ruling: a step off either end stays put.
test("ArrowUp off the top from a non-zero column stays on the same tile", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // a3 is column 2 of tier 1's - and the list's - first row (pre-fix: a1).
  const a3 = tile("a3")!;
  a3.focus();
  fireEvent.keyDown(a3, { key: "ArrowUp" });
  expect(document.activeElement).toBe(a3);
});

test("ArrowDown off the bottom from a non-last column of the partial last row stays put", () => {
  renderPopup(WIDE);
  mockColumns(4);
  // The Infinity bucket's single row c1 c2 is partial at four columns, so c1
  // is a non-last column of the overall last row (pre-fix: c2).
  const c1 = tile("c1")!;
  c1.focus();
  fireEvent.keyDown(c1, { key: "ArrowDown" });
  expect(document.activeElement).toBe(c1);
});

// Upstream renames some item icons to opaque hashes; a tile that looked the
// icon up by item id would fall through to the "?" placeholder.
test("a tile whose icon id is not its item id draws its sprite, not the placeholder", () => {
  const itemId = "iron_bottle-liquid_plant_grass_1";
  const item = realPack.items.find((i) => i.id === itemId);
  // Premise guard: only meaningful while the pack keeps the two ids apart.
  expect(item?.icon).toBeDefined();
  expect(item!.icon).not.toBe(itemId);
  render(
    <LocaleProvider locale="en">
      <ItemPickerPopup
        items={realPack.items}
        disabledIds={new Set<string>()}
        tierByItemId={computeItemDepths(realPack)}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    </LocaleProvider>,
  );
  const t = tile(itemId);
  expect(t).not.toBeNull();
  expect(t!.querySelector(".ico")).not.toBeNull();
  expect(t!.querySelector(".recipe-picker-tile-empty")).toBeNull();
});

// "r" keeps bravo (tier 1) and charlie (tier 2), in that order.
function searchFor(text: string): HTMLInputElement {
  const search = screen.getByLabelText<HTMLInputElement>(/search/i);
  fireEvent.change(search, { target: { value: text } });
  return search;
}

test("Enter in the search box picks the first enabled tile in filtered order", () => {
  const props = renderPopup({ disabledIds: new Set(["bravo"]) });
  const search = searchFor("r");
  fireEvent.keyDown(search, { key: "Enter" });
  expect(props.onPick).toHaveBeenCalledTimes(1);
  expect(props.onPick).toHaveBeenCalledWith("charlie");
});

test("Enter in the search box does nothing when no enabled tile matches", () => {
  const props = renderPopup({ disabledIds: new Set(["bravo", "charlie"]) });
  fireEvent.keyDown(searchFor("r"), { key: "Enter" });
  fireEvent.keyDown(searchFor("zzz-no-match"), { key: "Enter" });
  expect(props.onPick).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

test("Enter that confirms an IME composition does not pick", () => {
  const props = renderPopup();
  fireEvent.keyDown(searchFor("r"), { key: "Enter", isComposing: true });
  expect(props.onPick).not.toHaveBeenCalled();
});

// Safari fires the committing Enter after compositionend, with isComposing
// false; keyCode 229 is the only mark that the IME owns it.
test("Enter with keyCode 229 after an IME composition does not pick", () => {
  const props = renderPopup();
  fireEvent.keyDown(searchFor("r"), { key: "Enter", keyCode: 229 });
  expect(props.onPick).not.toHaveBeenCalled();
});

test("ArrowDown in the search box focuses the first enabled tile and moves the tab stop", () => {
  renderPopup({ disabledIds: new Set(["bravo"]) });
  const search = searchFor("r");
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(tile("charlie"));
  expect(tabStopIds()).toEqual(["charlie"]);
});

test("ArrowDown in the search box stays put when no enabled tile matches", () => {
  renderPopup({ disabledIds: new Set(["bravo", "charlie"]) });
  const search = searchFor("r");
  search.focus();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(search);
});
