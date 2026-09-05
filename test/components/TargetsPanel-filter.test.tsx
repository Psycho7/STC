import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
import type { RecipePack } from "@aef/schema";
import { TargetsPanel } from "../../src/components/TargetsPanel";
import {
  makePack,
  type MicroRecipe,
} from "../../src/solver/closed-form-fixtures";
import { LocaleProvider } from "../../src/data/i18n-context";

function renderWithLocale(ui: ReactElement) {
  return render(<LocaleProvider locale="en">{ui}</LocaleProvider>);
}

afterEach(() => cleanup());

function mkRecipe(id: string, category: string): MicroRecipe {
  return { id, category, time: 1, in: {}, out: { [`${id}_out`]: 1 } };
}

// Every recipe's output item exists, so the only thing keeping an item out of
// the picker is its producer's category, not a missing item entry.
const mixedPack: RecipePack = makePack(
  [
    mkRecipe("smelt_one", "smelting"),
    mkRecipe("assemble_one", "assembly"),
    mkRecipe("__hidden_machinery", "__internal"),
    mkRecipe("transfer_tundra_a", "__domain_transfer"),
  ],
  [
    { id: "smelt_one_out" },
    { id: "assemble_one_out" },
    { id: "__hidden_machinery_out" },
    { id: "transfer_tundra_a_out" },
  ],
);

// The picker popup is portal-rendered; tiles carry data-item-id.
function pickerHas(itemId: string): boolean {
  return document.querySelector(`[data-item-id="${itemId}"]`) !== null;
}

describe("TargetsPanel / synthetic-category filter", () => {
  it("excludes items produced only by '__internal' recipes", () => {
    const onChange = vi.fn();
    renderWithLocale(
      <TargetsPanel
        targets={[
          { itemId: "smelt_one_out", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={mixedPack}
      />,
    );

    fireEvent.click(screen.getByLabelText(/item/i));
    expect(pickerHas("smelt_one_out")).toBe(true);
    expect(pickerHas("assemble_one_out")).toBe(true);
    expect(pickerHas("__hidden_machinery_out")).toBe(false);
  });

  it("excludes items produced only by '__domain_transfer' recipes", () => {
    const onChange = vi.fn();
    renderWithLocale(
      <TargetsPanel
        targets={[
          { itemId: "smelt_one_out", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={mixedPack}
      />,
    );
    fireEvent.click(screen.getByLabelText(/item/i));
    // Domain-transfer recipes are input-supply metadata, so the items they
    // import are not user-selectable production targets.
    expect(pickerHas("transfer_tundra_a_out")).toBe(false);
  });

  it("Add opens a draft whose item picker excludes '__domain_transfer' items", () => {
    const onChange = vi.fn();
    // Pack where the only recipes are a transfer recipe and a real one; the
    // draft picker must offer only the real one's output, and Add alone must not
    // commit anything.
    const pack: RecipePack = makePack(
      [
        mkRecipe("transfer_tundra_a", "__domain_transfer"),
        mkRecipe("real_recipe", "smelting"),
      ],
      [{ id: "transfer_tundra_a_out" }, { id: "real_recipe_out" }],
    );
    renderWithLocale(
      <TargetsPanel targets={[]} onChange={onChange} pack={pack} />,
    );
    const addButton = screen.getByRole("button", { name: /add/i });
    fireEvent.click(addButton);
    // Clicking Add creates a local draft only; no commit.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByTestId("target-draft-row")).getByLabelText(/item/i),
    );
    expect(pickerHas("transfer_tundra_a_out")).toBe(false);
    expect(pickerHas("real_recipe_out")).toBe(true);
  });
});
