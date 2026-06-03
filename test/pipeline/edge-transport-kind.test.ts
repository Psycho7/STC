import { describe, expect, it } from "vitest";
import Fraction from "fraction.js";
import type { Item, Recipe, Stoich, TransportKindId } from "@aef/schema";
import { buildRenderPlan } from "../../src/pipeline/driver";
import { expandMultipliers } from "../../src/pipeline/expand";
import type {
  LogicalEdge,
  LogicalGraph,
  LogicalRecipeNode,
} from "../../src/canvas/layout";
import type { ItemId } from "../../src/pipeline/types";
import type { Replica } from "../../src/solver/types";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import { defaultTargets } from "../../src/data/targets";

// ---------------------------------------------------------------------------
// Helpers (kept local to avoid coupling to materialize.test.ts internals).
// ---------------------------------------------------------------------------

function makeRecipe(id: string, inItems: string[], outItems: string[]): Recipe {
  const toStoich = (item: string): Stoich => ({ item, qty: 1 });
  return {
    id,
    name: id,
    category: "c",
    icon: id,
    row: 0,
    time: 1,
    in: inItems.map(toStoich),
    out: outItems.map(toStoich),
    producers: ["m:any"],
  };
}

function makeNode(opts: {
  id: string;
  recipe: Recipe;
  multiplier: number;
}): LogicalRecipeNode {
  return {
    kind: "recipe",
    id: opts.id,
    recipe: opts.recipe,
    multiplier: opts.multiplier,
    expanded: false,
  };
}

function makeReplica(opts: {
  id: string;
  recipeId: string;
  executionRate: Fraction;
  consumerPath?: ReadonlyArray<string>;
}): Replica {
  return {
    id: opts.id,
    recipeId: opts.recipeId,
    executionRate: opts.executionRate,
    consumerPath: opts.consumerPath ?? [],
    blueprintGroupId: "target:" + opts.recipeId,
    sharedAtArticulation: false,
  };
}

function makeEdge(opts: {
  id?: string;
  source: string;
  target: string;
  item: string;
}): LogicalEdge {
  return {
    id: opts.id ?? `${opts.source}->${opts.target}:${opts.item}`,
    source: opts.source,
    target: opts.target,
    sourcePort: `out:${opts.item}`,
    targetPort: `in:${opts.item}`,
  };
}

function makeItem(id: string, transportKind: TransportKindId): Item {
  return {
    id,
    name: id,
    category: "c",
    icon: id,
    row: 0,
    raw: false,
    transportKind,
  };
}

// ---------------------------------------------------------------------------
// Edge transport-kind threading (expand stage).
// ---------------------------------------------------------------------------

describe("expandMultipliers / MachineEdge.transportKind", () => {
  it("stamps each edge with the item's transportKind (belt vs pipe)", () => {
    const rP = makeRecipe("r:P", [], ["i:solid", "i:fluid"]);
    const rC = makeRecipe("r:C", ["i:solid", "i:fluid"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 1 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 1 });
    const eSolid = makeEdge({
      id: "e:solid",
      source: "rP0",
      target: "rC0",
      item: "i:solid",
    });
    const eFluid = makeEdge({
      id: "e:fluid",
      source: "rP0",
      target: "rC0",
      item: "i:fluid",
    });
    const logical: LogicalGraph = {
      nodes: [nodeP, nodeC],
      edges: [eSolid, eFluid],
    };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(1),
        consumerPath: ["rC0"],
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(1),
      }),
    ];
    const rates = new Map([
      [eSolid.id, new Fraction(1)],
      [eFluid.id, new Fraction(1)],
    ]);
    const itemById = new Map<ItemId, Item>([
      ["i:solid", makeItem("i:solid", "belt")],
      ["i:fluid", makeItem("i:fluid", "pipe")],
    ]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById,
    });

    expect(out.edges).toHaveLength(2);
    const solidEdge = out.edges.find((e) => e.item === "i:solid")!;
    const fluidEdge = out.edges.find((e) => e.item === "i:fluid")!;
    expect(solidEdge.transportKind).toBe("belt");
    expect(fluidEdge.transportKind).toBe("pipe");
  });

  it("assigns the same transportKind to every parallel edge of the same item", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 2 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 2 });
    const e1 = makeEdge({
      id: "e:1",
      source: "rP0",
      target: "rC0",
      item: "i:x",
    });
    const e2 = makeEdge({
      id: "e:2",
      source: "rP0",
      target: "rC0",
      item: "i:x",
    });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [e1, e2] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(2),
        consumerPath: ["rC0"],
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(2),
      }),
    ];
    const rates = new Map([
      [e1.id, new Fraction(2)],
      [e2.id, new Fraction(2)],
    ]);
    const itemById = new Map<ItemId, Item>([["i:x", makeItem("i:x", "pipe")]]);

    const out = expandMultipliers({
      logical,
      replicas,
      edgeRatesByLogicalEdgeId: rates,
      itemById,
    });

    // Two logical parallel edges, each with two stamp pairs -> four MachineEdges.
    expect(out.edges).toHaveLength(4);
    for (const e of out.edges) {
      expect(e.transportKind).toBe("pipe");
    }
  });

  it("throws when an edge's item is missing from itemById", () => {
    const rP = makeRecipe("r:P", [], ["i:x"]);
    const rC = makeRecipe("r:C", ["i:x"], []);
    const nodeP = makeNode({ id: "rP0", recipe: rP, multiplier: 1 });
    const nodeC = makeNode({ id: "rC0", recipe: rC, multiplier: 1 });
    const edge = makeEdge({ source: "rP0", target: "rC0", item: "i:x" });
    const logical: LogicalGraph = { nodes: [nodeP, nodeC], edges: [edge] };
    const replicas: Replica[] = [
      makeReplica({
        id: "rP0",
        recipeId: "r:P",
        executionRate: new Fraction(1),
        consumerPath: ["rC0"],
      }),
      makeReplica({
        id: "rC0",
        recipeId: "r:C",
        executionRate: new Fraction(1),
      }),
    ];
    const rates = new Map([[edge.id, new Fraction(1)]]);
    const itemById = new Map<ItemId, Item>(); // intentionally empty

    expect(() =>
      expandMultipliers({
        logical,
        replicas,
        edgeRatesByLogicalEdgeId: rates,
        itemById,
      }),
    ).toThrow(/i:x/);
  });
});

// ---------------------------------------------------------------------------
// RenderEdge.transportKind / driver threading.
// ---------------------------------------------------------------------------

describe("buildRenderPlan / RenderEdge.transportKind end-to-end", () => {
  it("propagates pack-derived transportKind onto every RenderEdge", () => {
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const itemById = new Map(pack.items.map((i) => [i.id, i]));
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
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
      itemOverrides: [],
      targets: defaultTargets(),
      pack,
    });
    expect(plan.edges.length).toBeGreaterThan(0);
    for (const e of plan.edges) {
      const item = itemById.get(e.item);
      expect(item).toBeDefined();
      expect(e.transportKind).toBe(item!.transportKind);
    }
    // The default AEF plan should exercise both transport phases.
    const kinds = new Set(plan.edges.map((e) => e.transportKind));
    expect(kinds.has("belt")).toBe(true);
    expect(kinds.has("pipe")).toBe(true);
  });
});
