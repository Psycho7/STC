import { describe, it, expect } from "vitest";
import {
  RECIPE_WIDTH,
  PORT_WIDTH,
  PORT_HEIGHT,
  NODE_NODE_SPACING,
  BETWEEN_LAYERS_SPACING,
  recipeHeight,
  loopBoxDimensions,
} from "../../src/canvas/dimensions";

describe("canvas/dimensions", () => {
  it("constants are non-zero", () => {
    expect(RECIPE_WIDTH).toBeGreaterThan(0);
    expect(PORT_WIDTH).toBeGreaterThan(0);
    expect(PORT_HEIGHT).toBeGreaterThan(0);
    expect(NODE_NODE_SPACING).toBeGreaterThan(0);
    expect(BETWEEN_LAYERS_SPACING).toBeGreaterThan(0);
  });

  it("recipe height grows monotonically with port count", () => {
    const h0 = recipeHeight(0, 0);
    const h1 = recipeHeight(1, 0);
    const h2 = recipeHeight(2, 3);
    expect(h1).toBeGreaterThan(h0);
    expect(h2).toBeGreaterThan(h1);
  });

  it("loopBoxDimensions adds padding around the interior", () => {
    const interior = { width: 200, height: 150 };
    const outer = loopBoxDimensions(interior);
    expect(outer.width).toBeGreaterThan(interior.width);
    expect(outer.height).toBeGreaterThan(interior.height);
    expect(outer.width - interior.width).toBe(outer.height - interior.height);
  });
});
