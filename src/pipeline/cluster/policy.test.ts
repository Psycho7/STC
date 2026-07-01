import { describe, expect, test } from "vitest";
import Fraction from "fraction.js";
import { PillarsOnly } from "./policy";
import type { ClusteringPolicyInput } from "../types";
import type { Condensation, Replica } from "../../solver/types";
import type { LogicalGraph } from "../../canvas/layout";
import { pack } from "../../data/load";
import { solvePlanWithIntermediates } from "../../solver/index";
import { defaultTransportConfig } from "../../data/transport-config";
import { renderPlanFromSolve } from "../../pipeline/driver";
import type { Target } from "../../data/targets";

// PillarsOnly ignores the logical graph entirely; an empty one keeps the
// synthetic cases honest about what the policy actually reads.
const emptyLogical = { nodes: [], edges: [] } as unknown as LogicalGraph;

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

  test("keeps the loop box when two distinct recipes survive", () => {
    const input: ClusteringPolicyInput = {
      logical: emptyLogical,
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
    const targets: Target[] = [
      { recipeId, ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    const { plan } = renderPlanFromSolve(full, pack, targets, []);
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
