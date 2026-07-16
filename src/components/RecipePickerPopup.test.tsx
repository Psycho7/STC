// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import type { Recipe } from "@aef/schema";
import { RecipePickerPopup } from "./RecipePickerPopup";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

function mkRecipe(id: string): Recipe {
  return {
    id,
    category: "craft",
    in: [],
    out: [{ item: `${id}_out`, qty: 1 }],
    icon: id,
    producers: [],
    cost: 1,
  } as unknown as Recipe;
}

const RECIPES = [
  mkRecipe("r_alpha"),
  mkRecipe("r_bravo"),
  mkRecipe("r_charlie"),
  mkRecipe("r_delta"),
];

// r_alpha, r_bravo -> tier 1; r_charlie -> tier 2; r_delta -> Infinity.
const DEPTHS = new Map<string, number>([
  ["r_alpha", 1],
  ["r_bravo", 1],
  ["r_charlie", 2],
  ["r_delta", Number.POSITIVE_INFINITY],
]);

function renderPopup(
  overrides: Partial<ComponentProps<typeof RecipePickerPopup>> = {},
) {
  const props: ComponentProps<typeof RecipePickerPopup> = {
    recipes: RECIPES,
    disabledIds: new Set<string>(),
    depthByRecipeId: DEPTHS,
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(
    <LocaleProvider locale="en">
      <RecipePickerPopup {...props} />
    </LocaleProvider>,
  );
  return props;
}

function tile(recipeId: string): HTMLButtonElement | null {
  return document.querySelector(`[data-recipe-id="${recipeId}"]`);
}

function groupHeads(): string[] {
  return [...document.querySelectorAll(".recipe-picker-group-head")].map(
    (el) => el.textContent ?? "",
  );
}

test("renders depth groups in ascending order with the Infinity bucket last", () => {
  renderPopup();
  expect(groupHeads()).toEqual(["Tier 1", "Tier 2", "Cyclic / unranked"]);
});

test("search filters tiles and hides emptied groups", async () => {
  const user = userEvent.setup();
  renderPopup();
  await user.type(screen.getByLabelText(/search/i), "charlie");
  expect(tile("r_charlie")).not.toBeNull();
  expect(tile("r_alpha")).toBeNull();
  expect(tile("r_delta")).toBeNull();
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
  const props = renderPopup({ disabledIds: new Set(["r_bravo"]) });
  const disabled = tile("r_bravo")!;
  expect(disabled.disabled).toBe(true);
  fireEvent.click(disabled);
  expect(props.onPick).not.toHaveBeenCalled();
});

test("clicking a tile fires onPick with its recipe id", () => {
  const props = renderPopup();
  fireEvent.click(tile("r_charlie")!);
  expect(props.onPick).toHaveBeenCalledWith("r_charlie");
});

test("Escape fires onClose", () => {
  const props = renderPopup();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});

test("backdrop click fires onClose; a click inside the panel does not", () => {
  const props = renderPopup();
  fireEvent.click(screen.getByText("Select recipe"));
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".recipe-picker-backdrop")!);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
