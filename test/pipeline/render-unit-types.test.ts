import { describe, it, expect } from "vitest";
import {
  RENDER_UNIT_KINDS,
  isInputProductUnit,
  isOutputProductUnit,
  isLoopUnit,
  isRecipeUnit,
  type RenderUnit,
  type RenderUnitInputProduct,
  type RenderUnitOutputProduct,
} from "../../src/pipeline/types";

// Exhaustiveness check: switching on `kind` and returning never on any
// unhandled case forces TypeScript to fail if a new RenderUnit member is
// added without updating this switch. The test is contract-only: the runtime
// assertion exercises the new kinds, but the load-bearing check is at
// compile time via the `never` return path.
function classify(u: RenderUnit): string {
  switch (u.kind) {
    case "recipe":
      return `recipe:${u.recipeId}`;
    case "loop":
      return `loop:${u.sccId}`;
    case "inputProduct":
      return `inputProduct:${u.itemId}`;
    case "outputProduct":
      return `outputProduct:${u.itemId}`;
    default: {
      const _exhaustive: never = u;
      return _exhaustive;
    }
  }
}

describe("RenderUnit / inputProduct + outputProduct", () => {
  it("the kinds constant carries the new boundary kinds", () => {
    expect(RENDER_UNIT_KINDS).toContain("inputProduct");
    expect(RENDER_UNIT_KINDS).toContain("outputProduct");
    expect(RENDER_UNIT_KINDS).toContain("recipe");
    expect(RENDER_UNIT_KINDS).toContain("loop");
    expect(RENDER_UNIT_KINDS.length).toBe(4);
  });

  it("RenderUnitInputProduct narrows by kind, requires rate, and accepts an optional rateCap", () => {
    const uncapped: RenderUnitInputProduct = {
      id: "u:in:copper_ore",
      kind: "inputProduct",
      itemId: "copper_ore",
      count: 1,
      rate: { num: "1", denom: "1" },
    };
    const capped: RenderUnitInputProduct = {
      id: "u:in:liquid_water",
      kind: "inputProduct",
      itemId: "liquid_water",
      count: 1,
      rate: { num: "1", denom: "2" },
      rateCap: { num: "1", denom: "2" },
    };
    expect(isInputProductUnit(uncapped)).toBe(true);
    expect(isInputProductUnit(capped)).toBe(true);
    expect(classify(uncapped)).toBe("inputProduct:copper_ore");
    expect(classify(capped)).toBe("inputProduct:liquid_water");
  });

  it("RenderUnitOutputProduct narrows by kind and pins flavor to 'target'", () => {
    const out: RenderUnitOutputProduct = {
      id: "u:out:copper_nugget",
      kind: "outputProduct",
      itemId: "copper_nugget",
      count: 1,
      rate: { num: "2", denom: "1" },
      flavor: "target",
    };
    expect(isOutputProductUnit(out)).toBe(true);
    expect(out.flavor).toBe("target");
    expect(classify(out)).toBe("outputProduct:copper_nugget");
  });

  it("the boundary guards exclude recipe/loop units", () => {
    const recipe: RenderUnit = {
      id: "u:m1",
      kind: "recipe",
      recipeId: "r:smelt",
      count: 1,
      multiplicity: { num: "1", denom: "1" },
    };
    const loop: RenderUnit = {
      id: "u:scc:1",
      kind: "loop",
      sccId: "scc:1",
      count: 1,
      netIO: [],
    };
    expect(isInputProductUnit(recipe)).toBe(false);
    expect(isOutputProductUnit(recipe)).toBe(false);
    expect(isInputProductUnit(loop)).toBe(false);
    expect(isOutputProductUnit(loop)).toBe(false);
    expect(isRecipeUnit(recipe)).toBe(true);
    expect(isLoopUnit(loop)).toBe(true);
  });
});
