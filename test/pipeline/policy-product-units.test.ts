import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { buildRenderPlan } from "../../src/pipeline/driver";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import type { Target } from "../../src/data/targets";
import type { ItemOverride } from "../../src/data/plan";
import { NoFoldRender } from "../../src/pipeline/render/policy";
import {
  isInputProductUnit,
  isOutputProductUnit,
} from "../../src/pipeline/types";
import type {
  MachineEdge,
  MachineRecipeVertex,
  RenderUnitInputProduct,
  RenderUnitOutputProduct,
} from "../../src/pipeline/types";
import type { Item, Recipe } from "@aef/schema";

// Helper: run the full pipeline end-to-end for a given targets+overrides
// combo and return the input/output product units the policy emitted along
// with the full render plan so callers can also assert on edges/units.
function emitProducts(
  targets: Target[],
  itemOverrides: ItemOverride[],
): {
  inputs: RenderUnitInputProduct[];
  outputs: RenderUnitOutputProduct[];
  plan: ReturnType<typeof buildRenderPlan>["plan"];
  recipeById: ReadonlyMap<string, Recipe>;
} {
  const tConfig = loadTransportConfig(defaultTransportConfig, pack);
  const full = solvePlanWithIntermediates(
    targets,
    pack,
    tConfig,
    itemOverrides,
  );
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const { plan } = buildRenderPlan({
    logical: full.logical,
    replicas: full.replicas,
    multipliers: full.multipliers,
    idealCount: full.idealCount,
    classByReplicaId: full.classByReplicaId,
    classToQuotient: full.classToQuotient,
    condensation: full.condensation,
    torn: full.torn,
    recipeById: full.recipeById,
    rates: full.rates,
    itemById,
    machineById,
    itemOverrides,
    targets,
    pack,
  });
  const inputs = plan.units.filter(isInputProductUnit);
  const outputs = plan.units.filter(isOutputProductUnit);
  return { inputs, outputs, plan, recipeById: full.recipeById };
}

describe("render policy / boundary product units", () => {
  it("target = copper_nugget, no overrides: emits input products for copper_ore AND liquid_water, output product for copper_nugget", () => {
    const { inputs, outputs } = emitProducts(
      [{ recipeId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } }],
      [],
    );
    const inputItems = new Set(inputs.map((u) => u.itemId));
    const outputItems = new Set(outputs.map((u) => u.itemId));
    // copper_nugget consumes both copper_ore and liquid_water; both are raw
    // and must surface as input boundary products.
    expect(inputItems).toContain("copper_ore");
    expect(inputItems).toContain("liquid_water");
    // copper_nugget is the target output. copper_nugget also produces
    // liquid_sewage as a byproduct, which surfaces as an amber surplus
    // output. Assert flavor-by-itemId rather than total count so future
    // byproduct surplus emissions don't break this test.
    expect(outputItems).toContain("copper_nugget");
    const flavorByItem = new Map(outputs.map((u) => [u.itemId, u.flavor]));
    expect(flavorByItem.get("copper_nugget")).toBe("target");
    expect(flavorByItem.get("liquid_sewage")).toBe("surplus");
    // No rateCap when no ItemOverride.ratePerSec is supplied.
    for (const u of inputs) expect(u.rateCap).toBeUndefined();
  });

  it("target = copper_ore (raw): emits output product only, suppresses input product for same item (target wins)", () => {
    const { inputs, outputs } = emitProducts(
      [
        {
          recipeId: "copper_ore-liquid_water",
          ratePerSec: { num: "1", denom: "1" },
        },
      ],
      [],
    );
    // The recipe producing copper_ore is `copper_ore-liquid_water`. Its first
    // output is `copper_ore`, so the target output product is copper_ore.
    const outputItems = new Set(outputs.map((u) => u.itemId));
    expect(outputItems).toContain("copper_ore");
    // copper_ore is raw, but it's the user's target -- no boundary input for it.
    const inputItems = new Set(inputs.map((u) => u.itemId));
    expect(inputItems.has("copper_ore")).toBe(false);
  });

  it("target = copper_nugget, override copper_ore: plan=true: drops copper_ore boundary; liquid_water surfaces as new input boundary", () => {
    const { inputs } = emitProducts(
      [{ recipeId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } }],
      [{ itemId: "copper_ore", plan: true }],
    );
    const inputItems = new Set(inputs.map((u) => u.itemId));
    expect(inputItems.has("copper_ore")).toBe(false);
    // The recipe `copper_ore-liquid_water` is now in the plan, surfacing
    // liquid_water as the new raw-input boundary.
    expect(inputItems).toContain("liquid_water");
  });

  it("two targets sharing the same output item: rates are summed on the output product", () => {
    // Drive the policy directly with a synthetic two-target input to avoid
    // depending on which real-pack recipes happen to form an SCC. Both targets
    // resolve to the same out[0].item; the policy must emit one output product
    // whose rate is the sum.
    const itemById = new Map<string, Item>([
      [
        "x",
        {
          id: "x",
          name: "x",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r1",
        {
          id: "r1",
          name: "r1",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "x", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
      [
        "r2",
        {
          id: "r2",
          name: "r2",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "x", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [], edges: [] },
      targets: [
        { recipeId: "r1", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "r2", ratePerSec: { num: "2", denom: "1" } },
      ],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const outputs = plan.units.filter(isOutputProductUnit);
    expect(outputs.length).toBe(1);
    expect(outputs[0]!.itemId).toBe("x");
    const rate = outputs[0]!.rate;
    expect(Number(rate.num) / Number(rate.denom)).toBe(3);
  });

  // ---- Task 7: render gate widening via effectiveSupply --------------------

  it("non-raw item with finite ratePerSec cap surfaces as an inputProduct with rateCap", () => {
    // Synthetic plan: one recipe `r_cons` consumes one non-raw item `built`.
    // No producer for `built` is in the machine graph (Layer 1 pre-subtracted
    // by the override cap), so the policy must surface `built` as a boundary
    // input product carrying the cap.
    const itemById = new Map<string, Item>([
      [
        "built",
        {
          id: "built",
          name: "built",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "built", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [consumer], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "built", ratePerSec: { num: "1", denom: "2" } },
      ],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const built = inputs.find((u) => u.itemId === "built");
    expect(built).toBeDefined();
    expect(built!.rateCap).toEqual({ num: "1", denom: "2" });
  });

  it("non-raw item with ratePerSec=0 does not emit an inputProduct (forces internal build)", () => {
    const itemById = new Map<string, Item>([
      [
        "built",
        {
          id: "built",
          name: "built",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "built", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [consumer], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "built", ratePerSec: { num: "0", denom: "1" } },
      ],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    expect(inputs.find((u) => u.itemId === "built")).toBeUndefined();
  });

  it("raw item with no override still emits an inputProduct (regression guard)", () => {
    const itemById = new Map<string, Item>([
      [
        "raw_in",
        {
          id: "raw_in",
          name: "raw_in",
          category: "c",
          icon: "x",
          row: 0,
          raw: true,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "raw_in", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [consumer], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const rawIn = inputs.find((u) => u.itemId === "raw_in");
    expect(rawIn).toBeDefined();
    expect(rawIn!.rateCap).toBeUndefined();
  });

  it("target = copper_nugget, override copper_ore: ratePerSec=1/2: walk continues through copper_ore so liquid_water surfaces as a new boundary input AND copper_ore re-surfaces as a capped input", () => {
    // With a finite rate cap the walk no longer terminates at the raw input;
    // producers for copper_ore enter the graph (the `copper_ore-liquid_water`
    // recipe) and liquid_water becomes the next boundary. The capped raw
    // boundary product also re-surfaces alongside the internal producer
    // (dual-emission); both assertions hold simultaneously.
    const { inputs } = emitProducts(
      [{ recipeId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } }],
      [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }],
    );
    const inputItems = new Set(inputs.map((u) => u.itemId));
    expect(inputItems).toContain("liquid_water");
    const copperOre = inputs.find((u) => u.itemId === "copper_ore");
    expect(copperOre).toBeDefined();
    expect(copperOre!.rateCap).toEqual({ num: "1", denom: "2" });
  });

  // ---- Task 8: dual-emission for partial-cap items ------------------------

  // Helpers for synthetic producer+consumer machine graphs used by the
  // dual-emission cases below. We build an item, a producer recipe, a
  // consumer recipe, two machine vertices, and one edge between them; then
  // override the produced item with a finite ratePerSec to verify both the
  // producer's edge AND the boundary input product survive.
  const dualEmissionItems = new Map<string, Item>([
    [
      "shared",
      {
        id: "shared",
        name: "shared",
        category: "c",
        icon: "x",
        row: 0,
        raw: false,
        transportKind: "belt",
      } as Item,
    ],
    [
      "out",
      {
        id: "out",
        name: "out",
        category: "c",
        icon: "x",
        row: 0,
        raw: false,
        transportKind: "belt",
      } as Item,
    ],
  ]);
  const dualEmissionRecipes = new Map<string, Recipe>([
    [
      "r_prod",
      {
        id: "r_prod",
        name: "r_prod",
        category: "c",
        icon: "x",
        row: 0,
        time: 1,
        in: [],
        out: [{ item: "shared", qty: 1 }],
        producers: ["m"],
      } as unknown as Recipe,
    ],
    [
      "r_cons",
      {
        id: "r_cons",
        name: "r_cons",
        category: "c",
        icon: "x",
        row: 0,
        time: 1,
        in: [{ item: "shared", qty: 1 }],
        out: [{ item: "out", qty: 1 }],
        producers: ["m"],
      } as unknown as Recipe,
    ],
  ]);
  function dualEmissionFixture() {
    const producer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_prod",
      replicaId: "r_prod#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_prod",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const edge: MachineEdge = {
      from: "v_prod",
      to: "v_cons",
      item: "shared",
      rate: new Fraction(1),
      transportKind: "belt",
    };
    return { producer, consumer, edge };
  }

  it("non-raw item with finite cap AND in-graph producer emits BOTH the inputProduct and the producer's machine edge (dual-emission)", () => {
    const { producer, consumer, edge } = dualEmissionFixture();
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [producer, consumer], edges: [edge] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "shared", ratePerSec: { num: "1", denom: "2" } },
      ],
      itemById: dualEmissionItems,
      recipeById: dualEmissionRecipes,
      pack: { items: [...dualEmissionItems.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const shared = inputs.find((u) => u.itemId === "shared");
    // (a) The boundary input product is emitted.
    expect(shared).toBeDefined();
    // (b) The rateCap reflects the override's exact rational.
    expect(shared!.rateCap).toEqual({ num: "1", denom: "2" });
    // The producer's machine edge to the consumer is preserved alongside
    // the input product (boundary edge is additive, not replacing).
    const producerEdge = plan.edges.find(
      (e) =>
        e.fromUnit === "u:v_prod" &&
        e.toUnit === "u:v_cons" &&
        e.item === "shared",
    );
    expect(producerEdge).toBeDefined();
    // And the boundary edge from input product to consumer is also there.
    const boundaryEdge = plan.edges.find(
      (e) =>
        e.fromUnit === "u:in:shared" &&
        e.toUnit === "u:v_cons" &&
        e.item === "shared",
    );
    expect(boundaryEdge).toBeDefined();
  });

  it("non-raw item with Infinity-equivalent override (no ratePerSec, no plan) emits inputProduct but producer is NOT in graph", () => {
    // Layer 1 terminates at this item, so callers never construct a
    // producer for it. Simulate that by passing only the consumer in the
    // machine graph and asserting the input unit is present but no producer
    // machine vertex / edge exists.
    const { consumer } = dualEmissionFixture();
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [consumer], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [{ itemId: "shared" }],
      itemById: dualEmissionItems,
      recipeById: dualEmissionRecipes,
      pack: { items: [...dualEmissionItems.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const shared = inputs.find((u) => u.itemId === "shared");
    expect(shared).toBeDefined();
    expect(shared!.rateCap).toBeUndefined();
    // No producer vertex emitted, hence no producer->consumer edge.
    const producerEdge = plan.edges.find(
      (e) => e.fromUnit === "u:v_prod" && e.toUnit === "u:v_cons",
    );
    expect(producerEdge).toBeUndefined();
  });

  it("raw item with finite ratePerSec AND producer in graph (end-to-end) emits BOTH inputProduct with rateCap and producer's outgoing edge", () => {
    // End-to-end regression for the raw + ratePerSec case Task 3 widened.
    // copper_ore's `copper_ore-liquid_water` producer should appear in the
    // machine graph; the rateCap=1/2 boundary input must surface in parallel.
    const {
      inputs,
      plan,
      recipeById: rById,
    } = emitProducts(
      [{ recipeId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } }],
      [{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }],
    );
    // (d.1) The capped boundary input is present.
    const copperOre = inputs.find((u) => u.itemId === "copper_ore");
    expect(copperOre).toBeDefined();
    expect(copperOre!.rateCap).toEqual({ num: "1", denom: "2" });
    // (d.2) A machine edge carrying copper_ore from the
    // `copper_ore-liquid_water` producer to the `copper_nugget` consumer is
    // present in the render plan. Lookup is by recipeId-on-unit since
    // `u:<vertexId>` ids contain the replica id, not the recipe id.
    const recipeProduces = (recipeId: string, item: string): boolean => {
      const r = rById.get(recipeId);
      return !!r?.out.find((s) => s.item === item);
    };
    const recipeConsumes = (recipeId: string, item: string): boolean => {
      const r = rById.get(recipeId);
      return !!r?.in.find((s) => s.item === item);
    };
    // Build a unit-id -> recipeId map for the recipe units we care about.
    const recipeByUnit = new Map<string, string>();
    for (const u of plan.units) {
      if (u.kind === "recipe") recipeByUnit.set(u.id, u.recipeId);
    }
    const producerEdge = plan.edges.find((e) => {
      const fromR = recipeByUnit.get(e.fromUnit);
      const toR = recipeByUnit.get(e.toUnit);
      return (
        e.item === "copper_ore" &&
        fromR !== undefined &&
        toR !== undefined &&
        recipeProduces(fromR, "copper_ore") &&
        recipeConsumes(toR, "copper_ore")
      );
    });
    expect(producerEdge).toBeDefined();
  });

  // ---- Per-consumer flow conservation under finite caps -------------------
  //
  // For any item `i` with finite cap and multiple consumers, the boundary
  // edge to each consumer must carry the consumer's prorated share of the
  // cap (not the full cap), so that
  //   sum(producer edges -> c for i) + (boundary edge -> c for i) == c_demand
  // holds for every consumer independently. The naive single-rate emission
  // overshoots demand on each consumer (each gets the full cap added on top
  // of producer flow).

  it("multi-consumer per-input flow conservation: boundary edge prorates the cap across consumers", () => {
    // Synthetic shape: two producer machines for `shared` (each making 1/s),
    // two consumer machines for `out` (each demanding 1/s of `shared`), with
    // producer-to-consumer edges of 1/2 each. Override `shared` with a finite
    // cap of 1/1 (i.e. external supply covers the remaining 1/s of total
    // demand of 2/s, so each consumer gets a 1/2 boundary share).
    const itemById = new Map<string, Item>([
      [
        "shared",
        {
          id: "shared",
          name: "shared",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_prod",
        {
          id: "r_prod",
          name: "r_prod",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "shared", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "shared", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const prod0: MachineRecipeVertex = {
      kind: "machine",
      id: "v_prod_0",
      replicaId: "r_prod#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_prod",
      stampIndex: 0,
      executionRate: new Fraction(1, 2),
    };
    const prod1: MachineRecipeVertex = {
      kind: "machine",
      id: "v_prod_1",
      replicaId: "r_prod#1" as MachineRecipeVertex["replicaId"],
      recipeId: "r_prod",
      stampIndex: 1,
      executionRate: new Fraction(1, 2),
    };
    const cons0: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons_0",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const cons1: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons_1",
      replicaId: "r_cons#1" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 1,
      executionRate: new Fraction(1),
    };
    // Producer-side already pre-subtracted by Layer 2: each producer emits
    // 1/2 of `shared` (total 1/s of producer rate) split across the two
    // consumers as 1/4 + 1/4 each. Consumer demand is 1/s each (2/s total);
    // cap = 1/s; so cap covers the residual 1/s, boundary share per consumer
    // is 1/2.
    const edges: MachineEdge[] = [
      {
        from: "v_prod_0",
        to: "v_cons_0",
        item: "shared",
        rate: new Fraction(1, 4),
        transportKind: "belt",
      },
      {
        from: "v_prod_0",
        to: "v_cons_1",
        item: "shared",
        rate: new Fraction(1, 4),
        transportKind: "belt",
      },
      {
        from: "v_prod_1",
        to: "v_cons_0",
        item: "shared",
        rate: new Fraction(1, 4),
        transportKind: "belt",
      },
      {
        from: "v_prod_1",
        to: "v_cons_1",
        item: "shared",
        rate: new Fraction(1, 4),
        transportKind: "belt",
      },
    ];
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: {
        vertices: [prod0, prod1, cons0, cons1],
        edges,
      },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "shared", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    // For each consumer, sum all incoming edges carrying `shared` and assert
    // the total equals the consumer's per-input demand (1/s here).
    const consumerIds = ["u:v_cons_0", "u:v_cons_1"] as const;
    for (const cid of consumerIds) {
      const incoming = plan.edges.filter(
        (e) => e.toUnit === cid && e.item === "shared",
      );
      const total = incoming.reduce(
        (acc, e) => acc.add(e.rate as unknown as Fraction),
        new Fraction(0),
      );
      // Demand for each consumer = executionRate * qty = 1 * 1 = 1.
      expect(total.equals(new Fraction(1))).toBe(true);
    }
  });

  // ---- Dual-listed item (target + itemOverride) --------------------------
  //
  // The InputsPanel emits both products for items that are both a user-selected
  // target AND have an explicit itemOverride. The "target trumps raw boundary"
  // rule should only suppress the input product when there is no override --
  // i.e. the user has not explicitly declared the item as a boundary supply.

  it("dual-listed: target item with finite itemOverride.ratePerSec emits BOTH inputProduct and outputProduct", () => {
    // Synthetic: a single producer recipe `r_make` whose only output is
    // `dual`. `r_make` is the user's target AND `dual` is overridden with a
    // finite ratePerSec. Per the InputsPanel spec, both surfaces render.
    const itemById = new Map<string, Item>([
      [
        "dual",
        {
          id: "dual",
          name: "dual",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_make",
        {
          id: "r_make",
          name: "r_make",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "dual", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    // Add a consumer so `dual` is genuinely consumed in the plan and would
    // otherwise be a boundary-input candidate.
    const consumerRecipeId = "r_use";
    recipeById.set(consumerRecipeId, {
      id: consumerRecipeId,
      name: consumerRecipeId,
      category: "c",
      icon: "x",
      row: 0,
      time: 1,
      in: [{ item: "dual", qty: 1 }],
      out: [],
      producers: ["m"],
    } as unknown as Recipe);
    const producer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_make",
      replicaId: "r_make#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_make",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_use",
      replicaId: "r_use#0" as MachineRecipeVertex["replicaId"],
      recipeId: consumerRecipeId,
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [producer, consumer], edges: [] },
      targets: [{ recipeId: "r_make", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [{ itemId: "dual", ratePerSec: { num: "1", denom: "2" } }],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const outputs = plan.units.filter(isOutputProductUnit);
    // Both surfaces present for `dual`.
    const dualIn = inputs.find((u) => u.itemId === "dual");
    expect(dualIn).toBeDefined();
    expect(dualIn!.rateCap).toEqual({ num: "1", denom: "2" });
    const dualOut = outputs.find(
      (u) => u.itemId === "dual" && u.flavor === "target",
    );
    expect(dualOut).toBeDefined();
  });

  it("dual-listed regression: target item with NO override still suppresses the input product", () => {
    // The narrowing of the suppression check must not regress the original
    // behavior: when the user selects a raw item as a target and declares no
    // override, the boundary input for the same item is still suppressed.
    const itemById = new Map<string, Item>([
      [
        "raw_target",
        {
          id: "raw_target",
          name: "raw_target",
          category: "c",
          icon: "x",
          row: 0,
          raw: true,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_make",
        {
          id: "r_make",
          name: "r_make",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [],
          out: [{ item: "raw_target", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
      [
        "r_use",
        {
          id: "r_use",
          name: "r_use",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "raw_target", qty: 1 }],
          out: [],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const producer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_make",
      replicaId: "r_make#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_make",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const consumer: MachineRecipeVertex = {
      kind: "machine",
      id: "v_use",
      replicaId: "r_use#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_use",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [producer, consumer], edges: [] },
      targets: [{ recipeId: "r_make", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    expect(inputs.find((u) => u.itemId === "raw_target")).toBeUndefined();
    const outputs = plan.units.filter(isOutputProductUnit);
    expect(
      outputs.find((u) => u.itemId === "raw_target" && u.flavor === "target"),
    ).toBeDefined();
  });

  it("single-consumer flow conservation: cap fully proration yields c.rate on the boundary edge", () => {
    // Sanity check the formula degenerates correctly when there's exactly
    // one consumer. With cap = 1/2 and consumer demand = 1, the boundary
    // edge should carry exactly 1/2, and the producer edge carries 1/2.
    const { producer, consumer, edge } = dualEmissionFixture();
    const producerWithHalfRate: MachineRecipeVertex = {
      ...producer,
      executionRate: new Fraction(1, 2),
    };
    const edgeAtHalf: MachineEdge = { ...edge, rate: new Fraction(1, 2) };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: {
        vertices: [producerWithHalfRate, consumer],
        edges: [edgeAtHalf],
      },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "shared", ratePerSec: { num: "1", denom: "2" } },
      ],
      itemById: dualEmissionItems,
      recipeById: dualEmissionRecipes,
      pack: { items: [...dualEmissionItems.values()] },
    });
    const incoming = plan.edges.filter(
      (e) => e.toUnit === "u:v_cons" && e.item === "shared",
    );
    const total = incoming.reduce(
      (acc, e) => acc.add(e.rate as unknown as Fraction),
      new Fraction(0),
    );
    expect(total.equals(new Fraction(1))).toBe(true);
    // Boundary edge carries exactly the cap (no other consumer to share with).
    const boundaryEdge = plan.edges.find(
      (e) =>
        e.fromUnit === "u:in:shared" &&
        e.toUnit === "u:v_cons" &&
        e.item === "shared",
    );
    expect(boundaryEdge).toBeDefined();
    expect(
      (boundaryEdge!.rate as unknown as Fraction).equals(new Fraction(1, 2)),
    ).toBe(true);
  });

  // ---- realized rate on RenderUnitInputProduct ---------------------------

  it("RenderUnitInputProduct.rate equals the sum of outbound boundary-edge rates (uncapped)", () => {
    // Two consumers for `raw_in` with demands 1/s and 2/s. With no override
    // (effectiveSupply = Infinity for a raw item), consumedSupply == total
    // demand == 3/s. The emitted input unit's `rate` must match the sum of
    // the two boundary edges (3/s).
    const itemById = new Map<string, Item>([
      [
        "raw_in",
        {
          id: "raw_in",
          name: "raw_in",
          category: "c",
          icon: "x",
          row: 0,
          raw: true,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "raw_in", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const cons0: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons_0",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const cons1: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons_1",
      replicaId: "r_cons#1" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 1,
      executionRate: new Fraction(2),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [cons0, cons1], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "3", denom: "1" } }],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const rawInUnit = inputs.find((u) => u.itemId === "raw_in");
    expect(rawInUnit).toBeDefined();
    // Boundary edges from the input unit to the two consumers.
    const boundaryEdges = plan.edges.filter(
      (e) => e.fromUnit === rawInUnit!.id && e.item === "raw_in",
    );
    expect(boundaryEdges.length).toBe(2);
    const edgeSum = boundaryEdges.reduce(
      (acc, e) => acc.add(e.rate as unknown as Fraction),
      new Fraction(0),
    );
    // sum of edges = 3/s; unit's serialized rate decodes to the same value.
    const unitRate = new Fraction(
      `${rawInUnit!.rate.num}/${rawInUnit!.rate.denom}`,
    );
    expect(unitRate.equals(edgeSum)).toBe(true);
    expect(unitRate.equals(new Fraction(3))).toBe(true);
  });

  it("RenderUnitInputProduct.rate reflects the cap when supply < total demand", () => {
    // Single consumer demanding 1/s of `built` (non-raw). Cap = 1/2.
    // Consumed supply = min(1/2, 1) = 1/2. Boundary edge rate = 1/2.
    // Unit `rate` must equal 1/2 too.
    const itemById = new Map<string, Item>([
      [
        "built",
        {
          id: "built",
          name: "built",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
      [
        "out",
        {
          id: "out",
          name: "out",
          category: "c",
          icon: "x",
          row: 0,
          raw: false,
          transportKind: "belt",
        } as Item,
      ],
    ]);
    const recipeById = new Map<string, Recipe>([
      [
        "r_cons",
        {
          id: "r_cons",
          name: "r_cons",
          category: "c",
          icon: "x",
          row: 0,
          time: 1,
          in: [{ item: "built", qty: 1 }],
          out: [{ item: "out", qty: 1 }],
          producers: ["m"],
        } as unknown as Recipe,
      ],
    ]);
    const cons: MachineRecipeVertex = {
      kind: "machine",
      id: "v_cons",
      replicaId: "r_cons#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_cons",
      stampIndex: 0,
      executionRate: new Fraction(1),
    };
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [cons], edges: [] },
      targets: [{ recipeId: "r_cons", ratePerSec: { num: "1", denom: "1" } }],
      itemOverrides: [
        { itemId: "built", ratePerSec: { num: "1", denom: "2" } },
      ],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units.filter(isInputProductUnit);
    const built = inputs.find((u) => u.itemId === "built");
    expect(built).toBeDefined();
    const boundaryEdges = plan.edges.filter(
      (e) => e.fromUnit === built!.id && e.item === "built",
    );
    const edgeSum = boundaryEdges.reduce(
      (acc, e) => acc.add(e.rate as unknown as Fraction),
      new Fraction(0),
    );
    const unitRate = new Fraction(`${built!.rate.num}/${built!.rate.denom}`);
    expect(unitRate.equals(edgeSum)).toBe(true);
    expect(unitRate.equals(new Fraction(1, 2))).toBe(true);
  });
});

// ----- input ProductNode fan-out per blueprint group ------------------------
//
// Verifies that consumers in distinct containers each get their own input
// ProductNode, while consumers in a single container (or loose / unclustered
// plans) keep the single-input behavior. Mass-balance invariant: per-container
// rates sum to the pre-split single-input rate.

describe("render policy / input fan-out per container", () => {
  const itemById = new Map<string, Item>([
    [
      "water",
      {
        id: "water",
        name: "water",
        category: "c",
        icon: "x",
        row: 0,
        raw: true,
        transportKind: "pipe",
      } as Item,
    ],
    [
      "out_a",
      {
        id: "out_a",
        name: "out_a",
        category: "c",
        icon: "x",
        row: 0,
        raw: false,
        transportKind: "belt",
      } as Item,
    ],
    [
      "out_b",
      {
        id: "out_b",
        name: "out_b",
        category: "c",
        icon: "x",
        row: 0,
        raw: false,
        transportKind: "belt",
      } as Item,
    ],
  ]);
  const recipeById = new Map<string, Recipe>([
    [
      "r_a",
      {
        id: "r_a",
        name: "r_a",
        category: "c",
        icon: "x",
        row: 0,
        time: 1,
        in: [{ item: "water", qty: 1 }],
        out: [{ item: "out_a", qty: 1 }],
        producers: ["m"],
      } as unknown as Recipe,
    ],
    [
      "r_b",
      {
        id: "r_b",
        name: "r_b",
        category: "c",
        icon: "x",
        row: 0,
        time: 1,
        in: [{ item: "water", qty: 1 }],
        out: [{ item: "out_b", qty: 1 }],
        producers: ["m"],
      } as unknown as Recipe,
    ],
  ]);

  function makeConsumers(opts: {
    containerA?: string;
    containerB?: string;
    rateA?: Fraction;
    rateB?: Fraction;
  }): MachineRecipeVertex[] {
    const v_a: MachineRecipeVertex = {
      kind: "machine",
      id: "v_a",
      replicaId: "r_a#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_a",
      stampIndex: 0,
      executionRate: opts.rateA ?? new Fraction(1),
    };
    if (opts.containerA !== undefined) v_a.containerId = opts.containerA;
    const v_b: MachineRecipeVertex = {
      kind: "machine",
      id: "v_b",
      replicaId: "r_b#0" as MachineRecipeVertex["replicaId"],
      recipeId: "r_b",
      stampIndex: 0,
      executionRate: opts.rateB ?? new Fraction(1),
    };
    if (opts.containerB !== undefined) v_b.containerId = opts.containerB;
    return [v_a, v_b];
  }

  it("Infinity supply, consumers in distinct containers: emits aggregate + per-container fanout slices with chained edges", () => {
    const [v_a, v_b] = makeConsumers({
      containerA: "grp:A",
      containerB: "grp:B",
    });
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [v_a!, v_b!], edges: [] },
      targets: [
        { recipeId: "r_a", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "r_b", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units
      .filter(isInputProductUnit)
      .filter((u) => u.itemId === "water");
    const ids = inputs.map((u) => u.id).sort();
    expect(ids).toEqual([
      "u:in:water",
      "u:in:water:grp:A",
      "u:in:water:grp:B",
    ]);
    const byId = new Map(inputs.map((u) => [u.id, u]));
    // Aggregate carries the summed rate; fanout slices carry per-bucket rate.
    expect(byId.get("u:in:water")!.rate).toEqual({ num: "2", denom: "1" });
    expect(byId.get("u:in:water")!.isFanout).toBeUndefined();
    expect(byId.get("u:in:water:grp:A")!.rate).toEqual({ num: "1", denom: "1" });
    expect(byId.get("u:in:water:grp:A")!.isFanout).toBe(true);
    expect(byId.get("u:in:water:grp:B")!.rate).toEqual({ num: "1", denom: "1" });
    expect(byId.get("u:in:water:grp:B")!.isFanout).toBe(true);
    // Aggregate -> fanout edges (one per slice).
    const aggregateOut = plan.edges.filter(
      (e) => e.fromUnit === "u:in:water" && e.item === "water",
    );
    expect(aggregateOut.map((e) => e.toUnit).sort()).toEqual([
      "u:in:water:grp:A",
      "u:in:water:grp:B",
    ]);
    // Fanout slice -> consumer edges (one per slice; consumer scoped to bucket).
    const aEdges = plan.edges.filter(
      (e) => e.fromUnit === "u:in:water:grp:A" && e.item === "water",
    );
    const bEdges = plan.edges.filter(
      (e) => e.fromUnit === "u:in:water:grp:B" && e.item === "water",
    );
    expect(aEdges.map((e) => e.toUnit)).toEqual(["u:v_a"]);
    expect(bEdges.map((e) => e.toUnit)).toEqual(["u:v_b"]);
  });

  it("regression: consumers in a single container collapse to one input node", () => {
    const [v_a, v_b] = makeConsumers({
      containerA: "grp:shared",
      containerB: "grp:shared",
    });
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [v_a!, v_b!], edges: [] },
      targets: [
        { recipeId: "r_a", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "r_b", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units
      .filter(isInputProductUnit)
      .filter((u) => u.itemId === "water");
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.id).toBe("u:in:water:grp:shared");
    expect(inputs[0]!.rate).toEqual({ num: "2", denom: "1" });
  });

  it("regression: loose consumers (no containerId) keep the legacy u:in:<item> id and collapse to one node", () => {
    const [v_a, v_b] = makeConsumers({}); // both undefined containerId
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [v_a!, v_b!], edges: [] },
      targets: [
        { recipeId: "r_a", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "r_b", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units
      .filter(isInputProductUnit)
      .filter((u) => u.itemId === "water");
    expect(inputs.length).toBe(1);
    expect(inputs[0]!.id).toBe("u:in:water");
  });

  it("mixed grouped + loose consumer: aggregate + grouped fanout + loose fanout (loose carries explicit 'loose' suffix)", () => {
    const [v_a, v_b] = makeConsumers({ containerA: "grp:A" }); // B undefined
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [v_a!, v_b!], edges: [] },
      targets: [
        { recipeId: "r_a", ratePerSec: { num: "1", denom: "1" } },
        { recipeId: "r_b", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemOverrides: [],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units
      .filter(isInputProductUnit)
      .filter((u) => u.itemId === "water");
    const ids = inputs.map((u) => u.id).sort();
    // Aggregate keeps the bare `u:in:water` id; loose bucket gets the
    // explicit `:loose` suffix to avoid colliding with the aggregate.
    expect(ids).toEqual([
      "u:in:water",
      "u:in:water:grp:A",
      "u:in:water:loose",
    ]);
    const byId = new Map(inputs.map((u) => [u.id, u]));
    expect(byId.get("u:in:water")!.isFanout).toBeUndefined();
    expect(byId.get("u:in:water:grp:A")!.isFanout).toBe(true);
    expect(byId.get("u:in:water:loose")!.isFanout).toBe(true);
    // Loose fanout carries the loose consumer's edge.
    const looseEdges = plan.edges.filter(
      (e) => e.fromUnit === "u:in:water:loose" && e.item === "water",
    );
    expect(looseEdges.map((e) => e.toUnit)).toEqual(["u:v_b"]);
  });

  it("finite cap below total demand: aggregate carries cap + total rate; fanouts prorate (mass-balance invariant)", () => {
    const [v_a, v_b] = makeConsumers({
      containerA: "grp:A",
      containerB: "grp:B",
      rateA: new Fraction(3),
      rateB: new Fraction(1),
    });
    // Cap is 2/sec; total demand is 4/sec. Per-container realized rates
    // should be (3/4)*2 = 3/2 and (1/4)*2 = 1/2 respectively. The aggregate
    // carries the item-level cap and the sum (=2).
    const plan = NoFoldRender({
      containers: { containers: [], containerByMember: new Map() },
      idealCount: new Map(),
      machineGraph: { vertices: [v_a!, v_b!], edges: [] },
      targets: [
        { recipeId: "r_a", ratePerSec: { num: "3", denom: "1" } },
        { recipeId: "r_b", ratePerSec: { num: "1", denom: "1" } },
      ],
      itemOverrides: [{ itemId: "water", ratePerSec: { num: "2", denom: "1" } }],
      itemById,
      recipeById,
      pack: { items: [...itemById.values()] },
    });
    const inputs = plan.units
      .filter(isInputProductUnit)
      .filter((u) => u.itemId === "water");
    const byId = new Map(inputs.map((u) => [u.id, u]));
    const aggregate = byId.get("u:in:water")!;
    const a = byId.get("u:in:water:grp:A")!;
    const b = byId.get("u:in:water:grp:B")!;
    expect(aggregate).toBeDefined();
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Aggregate carries the item-level cap.
    expect(aggregate.rateCap).toEqual({ num: "2", denom: "1" });
    expect(aggregate.isFanout).toBeUndefined();
    expect(
      new Fraction(`${aggregate.rate.num}/${aggregate.rate.denom}`).equals(
        new Fraction(2),
      ),
    ).toBe(true);
    // Fanouts carry per-slice rate; no rateCap on slices (the cap is item-level).
    expect(a.isFanout).toBe(true);
    expect(b.isFanout).toBe(true);
    expect(a.rateCap).toBeUndefined();
    expect(b.rateCap).toBeUndefined();
    expect(
      new Fraction(`${a.rate.num}/${a.rate.denom}`).equals(new Fraction(3, 2)),
    ).toBe(true);
    expect(
      new Fraction(`${b.rate.num}/${b.rate.denom}`).equals(new Fraction(1, 2)),
    ).toBe(true);
    // Sum of fanout realized rates equals the cap.
    const sum = new Fraction(`${a.rate.num}/${a.rate.denom}`).add(
      new Fraction(`${b.rate.num}/${b.rate.denom}`),
    );
    expect(sum.equals(new Fraction(2))).toBe(true);
    // Aggregate -> fanout edges carry the fanout's rate.
    const aggEdges = plan.edges.filter(
      (e) => e.fromUnit === "u:in:water" && e.item === "water",
    );
    const aggEdgeByTo = new Map(aggEdges.map((e) => [e.toUnit, e]));
    expect(
      aggEdgeByTo.get("u:in:water:grp:A")!.rate.equals(new Fraction(3, 2)),
    ).toBe(true);
    expect(
      aggEdgeByTo.get("u:in:water:grp:B")!.rate.equals(new Fraction(1, 2)),
    ).toBe(true);
  });
});
