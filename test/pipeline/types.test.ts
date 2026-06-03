import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  isLoopUnit,
  isRecipeUnit,
  isMachineRecipeVertex,
  isMachineSccVertex,
  isBlueprintGroupContainer,
  isLoopBoxContainer,
  type RenderUnit,
  type MachineVertex,
  type Container,
} from "../../src/pipeline/types";

describe("pipeline/types discriminators", () => {
  it("narrows RenderUnit by kind", () => {
    const recipe: RenderUnit = {
      id: "u1",
      kind: "recipe",
      recipeId: "r:smelt",
      count: 1,
      multiplicity: { num: "1", denom: "1" },
    };
    const loop: RenderUnit = {
      id: "u4",
      kind: "loop",
      sccId: "scc:1",
      count: 1,
      netIO: [],
    };

    expect(isRecipeUnit(recipe)).toBe(true);
    expect(isLoopUnit(loop)).toBe(true);
    expect(isRecipeUnit(loop)).toBe(false);
    expect(isLoopUnit(recipe)).toBe(false);
  });

  it("narrows MachineVertex by kind", () => {
    const m: MachineVertex = {
      kind: "machine",
      id: "m1",
      replicaId: "r1",
      recipeId: "r:smelt",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const s: MachineVertex = {
      kind: "scc-box",
      id: "s1",
      sccId: "scc:1",
      netIO: [],
    };
    expect(isMachineRecipeVertex(m)).toBe(true);
    expect(isMachineSccVertex(s)).toBe(true);
    expect(isMachineSccVertex(m)).toBe(false);
  });

  it("narrows Container by kind", () => {
    const bp: Container = {
      kind: "blueprint-group",
      id: "bp1",
      members: ["r1"],
    };
    const loop: Container = {
      kind: "loop-box",
      id: "loop1",
      members: ["r2"],
      sccId: "scc:1",
    };
    expect(isBlueprintGroupContainer(bp)).toBe(true);
    expect(isLoopBoxContainer(loop)).toBe(true);
    expect(isBlueprintGroupContainer(loop)).toBe(false);
  });
});
