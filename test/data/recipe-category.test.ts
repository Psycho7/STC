import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import {
  isExcludedProducer,
  isExtractionRecipe,
  isInputSupplyRecipe,
} from "../../src/data/recipe-category";

// Defaults describe an ordinary recipe, inputs included: an empty `in` is what
// isExtractionRecipe keys on, so the cases that want an extractor say so.
function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "r1",
    name: "r1",
    category: "chem",
    icon: "",
    row: 0,
    time: 1,
    in: [{ item: "ore", qty: 1 }],
    out: [{ item: "ingot", qty: 1 }],
    producers: [],
    ...overrides,
  };
}

describe("data/recipe-category", () => {
  describe("isInputSupplyRecipe", () => {
    it("returns true for category === '__domain_transfer'", () => {
      expect(
        isInputSupplyRecipe(makeRecipe({ category: "__domain_transfer" })),
      ).toBe(true);
    });

    it("returns false for category === '__internal'", () => {
      expect(isInputSupplyRecipe(makeRecipe({ category: "__internal" }))).toBe(
        false,
      );
    });

    it("returns false for an empty-string category", () => {
      expect(isInputSupplyRecipe(makeRecipe({ category: "" }))).toBe(false);
    });

    it("returns false for an ordinary 'chem' category", () => {
      expect(isInputSupplyRecipe(makeRecipe({ category: "chem" }))).toBe(false);
    });
  });

  describe("isExtractionRecipe", () => {
    it("returns true for a recipe with no inputs", () => {
      expect(
        isExtractionRecipe(
          makeRecipe({ in: [], out: [{ item: "iron_ore", qty: 1 }] }),
        ),
      ).toBe(true);
    });

    it("returns false as soon as one input is listed", () => {
      expect(isExtractionRecipe(makeRecipe())).toBe(false);
    });
  });

  describe("isExcludedProducer", () => {
    it("returns true when isExtractionRecipe is true", () => {
      expect(
        isExcludedProducer(
          makeRecipe({ in: [], out: [{ item: "iron_ore", qty: 1 }] }),
        ),
      ).toBe(true);
    });

    it("returns true when isInputSupplyRecipe is true", () => {
      expect(
        isExcludedProducer(makeRecipe({ category: "__domain_transfer" })),
      ).toBe(true);
    });

    it("returns true for cost === -1 regardless of category", () => {
      expect(isExcludedProducer(makeRecipe({ cost: -1 }))).toBe(true);
      expect(
        isExcludedProducer(makeRecipe({ category: "smelting", cost: -1 })),
      ).toBe(true);
    });

    it("returns false for an ordinary recipe with cost > 0", () => {
      expect(
        isExcludedProducer(makeRecipe({ category: "chem", cost: 1 })),
      ).toBe(false);
    });
  });
});
