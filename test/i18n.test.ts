import { describe, it, expect } from "vitest";
import { loadI18n } from "../src/data/i18n";
import { pack } from "../src/data/load";

describe("loadI18n", () => {
  it("returns an index with displayName", () => {
    const i18n = loadI18n();
    expect(typeof i18n.displayName).toBe("function");
  });
  it("returns the i18n name for a known recipe id, falling back to the id", () => {
    const i18n = loadI18n();
    const someRecipe = pack.recipes[0];
    if (!someRecipe) throw new Error("pack has no recipes");
    const name = i18n.displayName(someRecipe.id);
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
  it("falls back to the input id when unknown", () => {
    const i18n = loadI18n();
    expect(i18n.displayName("__definitely_not_in_pack__")).toBe(
      "__definitely_not_in_pack__",
    );
  });
});
