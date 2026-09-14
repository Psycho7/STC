import { describe, expect, test } from "vitest";
import Fraction from "fraction.js";
import { PillarsOnly } from "./policy";
import type { ClusteringPolicyInput } from "../types";
import type { Condensation, Replica } from "../../solver/types";
import type { LogicalGraph } from "../../canvas/layout";
import { pack } from "../../data/load";
import { solveForRender } from "../solveForRender";
import type { ItemTarget } from "../../data/targets";

// The policy reads only the edges, so the node list stays empty.
function logicalOf(edges: [string, string][]): LogicalGraph {
  return {
    nodes: [],
    edges: edges.map(([source, target]) => ({
      id: `${source}->${target}:x`,
      source,
      target,
      sourcePort: "out:x",
      targetPort: "in:x",
    })),
  } as unknown as LogicalGraph;
}

const emptyLogical = logicalOf([]);

function replica(id: string, recipeId: string): Replica {
  return {
    id,
    recipeId,
    executionRate: new Fraction(1),
    consumerPath: [],
    blueprintGroupId: `g:${id}`,
    sharedAtArticulation: false,
  };
}

function condensationOf(sccs: { id: string; recipeIds: string[] }[]) {
  const sccOfRecipe = new Map<string, string>();
  for (const s of sccs) for (const r of s.recipeIds) sccOfRecipe.set(r, s.id);
  const c: Condensation = {
    sccs,
    sccOfRecipe,
    outgoing: new Map(),
    incoming: new Map(),
  };
  return c;
}

describe("PillarsOnly surviving-member filter", () => {
  const condensation = condensationOf([
    { id: "scc:loop", recipeIds: ["a", "b"] },
    { id: "scc:solo", recipeIds: ["c"] },
  ]);

  test("emits no loop box when only one distinct recipe of a static SCC survives", () => {
    const input: ClusteringPolicyInput = {
      logical: emptyLogical,
      replicas: [replica("r:a:0", "a"), replica("r:c:0", "c")],
      condensation,
    };
    const { containers, containerByMember } = PillarsOnly(input);
    expect(containers).toEqual([]);
    expect(containerByMember.size).toBe(0);
  });

  test("emits no loop box when two survivors share no solved edge", () => {
    const input: ClusteringPolicyInput = {
      logical: emptyLogical,
      replicas: [replica("r:a:0", "a"), replica("r:b:0", "b")],
      condensation,
    };
    const { containers, containerByMember } = PillarsOnly(input);
    expect(containers).toEqual([]);
    expect(containerByMember.size).toBe(0);
  });

  test("keeps the loop box when two survivors are joined by a solved cycle", () => {
    const input: ClusteringPolicyInput = {
      logical: logicalOf([
        ["r:a:0", "r:b:0"],
        ["r:b:0", "r:a:0"],
      ]),
      replicas: [
        replica("r:a:0", "a"),
        replica("r:b:0", "b"),
        replica("r:c:0", "c"),
      ],
      condensation,
    };
    const { containers, containerByMember } = PillarsOnly(input);
    expect(containers).toHaveLength(1);
    const box = containers[0]!;
    expect(box.kind).toBe("loop-box");
    expect([...box.members].sort()).toEqual(["r:a:0", "r:b:0"]);
    expect(containerByMember.get("r:a:0")).toBe(box.id);
    expect(containerByMember.get("r:b:0")).toBe(box.id);
    expect(containerByMember.has("r:c:0")).toBe(false);
  });

  test("multiple replicas of one recipe alone do not form a loop box", () => {
    const input: ClusteringPolicyInput = {
      logical: emptyLogical,
      replicas: [replica("r:a:0", "a"), replica("r:a:1", "a")],
      condensation,
    };
    const { containers } = PillarsOnly(input);
    expect(containers).toEqual([]);
  });
});

// End-to-end: the LP may deactivate all but one member of a static SCC. The
// surviving single node participates in no rendered cycle and must not be
// boxed; a genuinely multi-survivor SCC keeps its box.
describe("loop boxes against the shipped pack", () => {
  function loopBoxes(recipeId: string) {
    const recipe = pack.recipes.find((r) => r.id === recipeId)!;
    const targets: ItemTarget[] = [
      {
        itemId: recipe.out[0]!.item,
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    const { plan } = solveForRender({ targets, pack });
    return plan.containers
      .filter((c) => c.kind === "loop-box")
      .map((c) => ({
        id: c.id,
        recipeIds: new Set(
          plan.units
            .filter((u) => u.kind === "recipe" && u.containerId === c.id)
            .map((u) => (u.kind === "recipe" ? u.recipeId : "")),
        ),
      }));
  }

  test("iron_powder target draws no box around the single surviving SCC member", () => {
    const boxes = loopBoxes("iron_powder");
    expect(boxes).toEqual([]);
  });

  // The reported three-target plan: the static SCC around `copper_powder`
  // survives with two recipes, but the recipes that closed the cycle solve to
  // rate 0 and the two survivors share no edge. No box, and no per-container
  // boundary tap minted beside the loose gas_xiranite one.
  test("the copper_powder plan boxes nothing and mints no loop tap", () => {
    const targets: ItemTarget[] = [
      { itemId: "copper_powder", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "equip_script_4_3", ratePerSec: { num: "2", denom: "1" } },
      { itemId: "iron_powder", ratePerSec: { num: "1", denom: "4" } },
    ];
    const { plan } = solveForRender({ targets, pack });
    expect(plan.containers).toEqual([]);
    expect(
      plan.units
        .map((u) => u.id)
        .filter((id) => id.startsWith("u:in:gas_xiranite:loop:")),
    ).toEqual([]);
  });

  test("xiranite_poly target keeps multi-survivor boxes and sheds single-survivor ones", () => {
    const boxes = loopBoxes("xiranite_poly");
    const poly = boxes.find((b) => b.id === "loop:liquid_xiranite_poly");
    expect(poly).toBeDefined();
    expect(poly!.recipeIds.size).toBeGreaterThanOrEqual(2);
    for (const b of boxes) {
      expect(b.recipeIds.size).toBeGreaterThanOrEqual(2);
    }
  });
});
