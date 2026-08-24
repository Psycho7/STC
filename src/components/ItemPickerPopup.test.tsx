// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import type { Item } from "@aef/schema";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { LocaleProvider } from "../data/i18n-context";

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
