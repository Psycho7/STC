// Render-level regression for the assemble re-route edge drop. The synthetic
// SCC fixture (see the matching logical-graph test in src/solver/index.test.ts)
// splits item x across two producers, P1 capped to 1/2 via raw1 and P2 (cost 2,
// so the split is unique-optimal) carrying the residual 1/2. The dropped P2
// edge used to bill B's whole x demand to P1: checkRenderPlan failed with an
// over-billed producer edge and DEV builds died in capProducerInputOutflow.
import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemTarget } from "../../data/targets";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import { renderPlanFromSolve } from "../driver";
import { checkRenderPlan } from "./invariants";
import { isMachineRecipeVertex } from "../types";

const mkPack = (recipes: object[], items: object[]): RecipePack =>
  ({
    recipes: recipes.map((r) => ({ producers: ["m"], ...r })),
    items: items.map((i) => ({ transportKind: "belt", ...i })),
    machines: [{ id: "m", speed: 1 }],
  }) as unknown as RecipePack;

const pack = mkPack(
  [
    {
      id: "tgt",
      category: "material",
      time: 1,
      in: [{ item: "out_b", qty: 1 }],
      out: [{ item: "final", qty: 1 }],
    },
    {
      id: "B",
      category: "material",
      time: 1,
      in: [
        { item: "x", qty: 1 },
        { item: "loop_t", qty: 1 },
      ],
      out: [
        { item: "out_b", qty: 1 },
        { item: "loop_m", qty: 1 },
      ],
    },
    {
      id: "A",
      category: "material",
      time: 1,
      in: [
        { item: "loop_m", qty: 1 },
        { item: "scarce", qty: 1 },
      ],
      out: [{ item: "loop_t", qty: 1 }],
    },
    {
      id: "E",
      category: "material",
      time: 1,
      in: [{ item: "raw_e", qty: 1 }],
      out: [{ item: "loop_t", qty: 1 }],
    },
    {
      id: "P1",
      category: "material",
      time: 1,
      in: [{ item: "raw1", qty: 1 }],
      out: [{ item: "x", qty: 1 }],
    },
    {
      id: "P2",
      category: "material",
      time: 1,
      in: [{ item: "raw2", qty: 1 }],
      out: [{ item: "x", qty: 1 }],
    },
  ],
  [
    { id: "final", raw: false },
    { id: "out_b", raw: false },
    { id: "x", raw: false },
    { id: "loop_t", raw: false },
    { id: "loop_m", raw: false },
    { id: "scarce", raw: true },
    { id: "raw_e", raw: true },
    { id: "raw1", raw: true },
    { id: "raw2", raw: true },
  ],
);
const targets: ItemTarget[] = [
  { itemId: "final", ratePerSec: { num: "1", denom: "1" } },
];
const itemOverrides = [
  { itemId: "scarce", ratePerSec: { num: "0", denom: "1" } },
  { itemId: "raw1", ratePerSec: { num: "1", denom: "2" } },
];
const recipeCosts = new Map([["P2", 2]]);

describe("render: deferred re-route keeps every producer's machine edge", () => {
  it("renders the P2->B edge at rate 1/2 and passes every render checker", () => {
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      itemOverrides,
      recipeCosts,
    );
    const out = renderPlanFromSolve(full, pack, targets, itemOverrides);

    // Machine edge P2 -> B carrying x at exactly 1/2.
    const vertexRecipe = new Map(
      out.machineGraph.vertices
        .filter(isMachineRecipeVertex)
        .map((v) => [v.id, v.recipeId]),
    );
    const p2Edges = out.machineGraph.edges.filter(
      (e) =>
        e.item === "x" &&
        vertexRecipe.get(e.from) === "P2" &&
        vertexRecipe.get(e.to) === "B",
    );
    expect(p2Edges).toHaveLength(1);
    expect(p2Edges[0]!.rate.equals(new Fraction(1, 2))).toBe(true);

    // No checker violation; in particular no over-billed P1 producer edge.
    const results = checkRenderPlan({
      plan: out.plan,
      rates: full.rates,
      pack,
      targets,
      itemOverrides,
    });
    const violations = results.flatMap((r) => (r.ok ? [] : r.violations));
    expect(violations).toEqual([]);
  });
});
