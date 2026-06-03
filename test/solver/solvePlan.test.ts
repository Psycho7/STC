import { describe, it, expect } from "vitest";
import { solvePlan } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import { defaultTargets } from "../../src/data/targets";

describe("solvePlan (end-to-end on real AEF)", () => {
  it("default targets produce a plan with >= 3 recipes across >= 3 blueprint groups", () => {
    // Raw-distance ranking shortened the default-targets chain
    // because intermediate items now resolve to raw-rooted producers
    // (copper_ore, liquid_water) instead of being routed through transfer
    // or cycle recipes. Realised plan on the committed pack: 4 recipe nodes
    // across 4 blueprint groups (3 targets + 1 shared). Thresholds set just
    // below those so harmless upstream data drift does not break the smoke
    // check.
    const tConfig = loadTransportConfig(defaultTransportConfig, pack);
    const graph = solvePlan(defaultTargets(), pack, tConfig);
    const recipeNodes = graph.nodes.filter((n) => n.kind === "recipe");
    const groupNodes = graph.nodes.filter((n) => n.kind === "group");
    expect(recipeNodes.length).toBeGreaterThanOrEqual(3);
    expect(groupNodes.length).toBeGreaterThanOrEqual(3);
  });

  it("default targets land copper_powder with a positive multiplier", () => {
    const tConfig = loadTransportConfig(defaultTransportConfig, pack);
    const graph = solvePlan(defaultTargets(), pack, tConfig);
    const cp = graph.nodes.find(
      (n) => n.kind === "recipe" && n.recipe.id === "copper_powder",
    );
    expect(cp).toBeDefined();
    if (cp?.kind === "recipe") expect(cp.multiplier).toBeGreaterThan(0);
  });

  it("deterministic across two calls", () => {
    const tConfig = loadTransportConfig(defaultTransportConfig, pack);
    const g1 = solvePlan(defaultTargets(), pack, tConfig);
    const g2 = solvePlan(defaultTargets(), pack, tConfig);
    const n1 = g1.nodes.map((n) => n.id).sort();
    const n2 = g2.nodes.map((n) => n.id).sort();
    expect(JSON.stringify(n1)).toBe(JSON.stringify(n2));
  });

});
