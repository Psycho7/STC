import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

    const select = screen.getByRole("combobox");
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );

    expect(optionValues).toContain("smelt_one");
    expect(optionValues).toContain("assemble_one");
    expect(optionValues).not.toContain("__hidden_machinery");
  });

  it("excludes '__domain_transfer' recipes from the dropdown", () => {
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
    const select = screen.getByRole("combobox");
    const optionValues = Array.from(select.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    // Domain-transfer recipes are input-supply metadata, not
    // user-selectable production steps.
    expect(optionValues).not.toContain("transfer_tundra_a");
  });

  it("does not auto-pick a '__domain_transfer' recipe as a default add target", () => {
    const onChange = vi.fn();
    // Pack where the only un-targeted recipes are a transfer recipe and a real
    // one; the auto-pick must land on the real one.
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
    addButton.click();
    expect(onChange).toHaveBeenCalledTimes(1);
    const nextTargets = onChange.mock.calls[0]![0] as Array<{
      recipeId: string;
    }>;
    expect(nextTargets[0]!.recipeId).toBe("real_recipe");
  });
});
