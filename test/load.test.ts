import { describe, it, expect } from "vitest";
import { pack } from "../src/data/load";

describe("recipe-pack data", () => {
  it("schema version is 0.2 and every entity-kind array is non-empty", () => {
    expect(pack.schemaVersion).toBe("0.2");
    expect(pack.categories.length).toBeGreaterThan(0);
    expect(pack.locations.length).toBeGreaterThan(0);
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.machines.length).toBeGreaterThan(0);
    expect(pack.transports.length).toBeGreaterThan(0);
    expect(pack.recipes.length).toBeGreaterThan(0);
  });
});
