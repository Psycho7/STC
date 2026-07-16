import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { Recipe, RecipePack } from "@aef/schema";
import { TargetsPanel } from "../../src/components/TargetsPanel";
import { LocaleProvider } from "../../src/data/i18n-context";

function renderWithLocale(ui: ReactElement) {
  return render(<LocaleProvider locale="en">{ui}</LocaleProvider>);
}

afterEach(() => cleanup());

function mkRecipe(id: string, category: string): Recipe {
  return {
    id,
    name: id,
    category,
    icon: "ico",
    row: 0,
    time: 1,
    in: [],
    out: [{ item: `${id}_out`, qty: 1 }],
    producers: [],
  };
}

const mixedPack: RecipePack = {
  schemaVersion: "0.2" as RecipePack["schemaVersion"],
  source: {
    name: "test",
    sourceRepo: "",
    sourceCommit: "0000",
    gameVersion: "",
    extractedAt: "",
  },
  categories: [],
  locations: [],
  items: [],
  machines: [],
  transports: [],
  recipes: [
    mkRecipe("smelt_one", "smelting"),
    mkRecipe("assemble_one", "assembly"),
    mkRecipe("__hidden_machinery", "__internal"),
    mkRecipe("transfer_tundra_a", "__domain_transfer"),
  ],
};

// The picker popup is portal-rendered; tiles carry data-recipe-id.
function pickerHas(recipeId: string): boolean {
  return document.querySelector(`[data-recipe-id="${recipeId}"]`) !== null;
}

describe("TargetsPanel / synthetic-category filter", () => {
  it("excludes '__internal' recipes", () => {
    const onChange = vi.fn();
    renderWithLocale(
      <TargetsPanel
        targets={[
          { recipeId: "smelt_one", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={mixedPack}
      />,
    );

    fireEvent.click(screen.getByLabelText(/recipe/i));
    expect(pickerHas("smelt_one")).toBe(true);
    expect(pickerHas("assemble_one")).toBe(true);
    expect(pickerHas("__hidden_machinery")).toBe(false);
  });

  it("excludes '__domain_transfer' recipes from the picker", () => {
    const onChange = vi.fn();
    renderWithLocale(
      <TargetsPanel
        targets={[
          { recipeId: "smelt_one", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={mixedPack}
      />,
    );
    fireEvent.click(screen.getByLabelText(/recipe/i));
    // Domain-transfer recipes are input-supply metadata, not
    // user-selectable production steps.
    expect(pickerHas("transfer_tundra_a")).toBe(false);
  });

  it("Add opens a draft whose recipe picker excludes '__domain_transfer' recipes", () => {
    const onChange = vi.fn();
    // Pack where the only un-targeted recipes are a transfer recipe and a real
    // one; the draft picker must offer only the real one, and Add alone must not
    // commit anything.
    const pack: RecipePack = {
      ...mixedPack,
      recipes: [
        mkRecipe("transfer_tundra_a", "__domain_transfer"),
        mkRecipe("real_recipe", "smelting"),
      ],
    };
    renderWithLocale(
      <TargetsPanel targets={[]} onChange={onChange} pack={pack} />,
    );
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    // Clicking Add creates a local draft only; no commit.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByTestId("target-draft-row")).getByLabelText(/recipe/i),
    );
    expect(pickerHas("transfer_tundra_a")).toBe(false);
    expect(pickerHas("real_recipe")).toBe(true);
  });
});
