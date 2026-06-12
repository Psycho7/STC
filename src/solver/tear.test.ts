import { describe, expect, it } from "vitest";
import type { Recipe } from "@aef/schema";
import { pickTearEdges } from "./tear";
import { tarjanScc } from "./scc";
import { buildRecipeGraphMulti } from "./graph";
import { pack } from "../data/load";
import type { RecipeEdge, RecipeGraph, Scc } from "./types";
import type { Target } from "../data/targets";

// Deterministic xorshift32 so every run exercises the same 3000 graphs.
function makeRng(initialSeed: number): () => number {
  let seed = initialSeed >>> 0;
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed / 0x100000000;
  };
}

function mkGraph(n: number, edges: Array<[number, number]>): RecipeGraph {
  const nodes = new Map<string, Recipe>();
  const outgoing = new Map<string, RecipeEdge[]>();
  const incoming = new Map<string, RecipeEdge[]>();
  for (let i = 0; i < n; i++) {
    const id = `n${i}`;
    nodes.set(id, {
      id,
      in: [],
      out: [{ item: `it${i}`, qty: 1 + (i % 3) }],
    } as unknown as Recipe);
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const [a, b] of edges) {
    const e: RecipeEdge = {
      id: `n${a}:it${a}->n${b}`,
      source: `n${a}`,
      target: `n${b}`,
      item: `it${a}`,
    };
    outgoing.get(`n${a}`)!.push(e);
    incoming.get(`n${b}`)!.push(e);
  }
  return { nodes, outgoing, incoming };
}

function hasCycle(ids: string[], out: Map<string, string[]>): boolean {
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, 0);
  for (const start of ids) {
    if (color.get(start) !== 0) continue;
    const stack: Array<{ v: string; i: number }> = [{ v: start, i: 0 }];
    color.set(start, 1);
    while (stack.length) {
      const f = stack[stack.length - 1]!;
      const nbrs = out.get(f.v) ?? [];
      if (f.i >= nbrs.length) {
        color.set(f.v, 2);
        stack.pop();
        continue;
      }
      const w = nbrs[f.i++]!;
      if (color.get(w) === 1) return true;
      if (color.get(w) === 0) {
        color.set(w, 1);
        stack.push({ v: w, i: 0 });
      }
    }
  }
  return false;
}

// Count multi-member SCCs whose internal subgraph still has a directed cycle
// after removing the torn edges.
function residualCycleSccs(g: RecipeGraph): number {
  let fails = 0;
  for (const s of tarjanScc(g)) {
    if (s.recipeIds.length < 2) continue;
    const torn = pickTearEdges(s as Scc, g);
    const tornKeys = new Set(
      torn.map((t) => `${t.edge.source}|${t.edge.item}|${t.edge.target}`),
    );
    const members = new Set(s.recipeIds);
    const out = new Map<string, string[]>();
    for (const m of s.recipeIds) out.set(m, []);
    for (const m of s.recipeIds) {
      for (const e of g.outgoing.get(m) ?? []) {
        if (!members.has(e.target)) continue;
        if (tornKeys.has(`${e.source}|${e.item}|${e.target}`)) continue;
        out.get(m)!.push(e.target);
      }
    }
    if (hasCycle([...s.recipeIds], out)) fails++;
  }
  return fails;
}

describe("pickTearEdges computes a feedback arc set", () => {
  // Property: for any digraph, removing the torn edges leaves every
  // multi-member SCC's internal subgraph acyclic. The old min-qty fundamental
  // cycle substitution failed this on 934 of these 3000 trials (chords through
  // a back edge's endpoints survived untorn).
  it("randomized: 3000 seeded digraphs leave zero residual cycles", () => {
    const rnd = makeRng(0x12345678);
    let failures = 0;
    for (let trial = 0; trial < 3000; trial++) {
      const n = 2 + Math.floor(rnd() * 7);
      const edges: Array<[number, number]> = [];
      const density = 0.1 + rnd() * 0.5;
      for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
          // Self-loops (a === b) are 90% suppressed and excluded from the
          // property by the <2-member SCC guard (intentionally under-
          // represented; singleton self-loops are the replicate guard's turf).
          if (a === b && rnd() > 0.1) continue;
          if (rnd() < density) edges.push([a, b]);
        }
      }
      failures += residualCycleSccs(mkGraph(n, edges));
    }
    expect(failures).toBe(0);
  });

  // Real-pack witnesses: the 4-member xiranite SCC used to keep a full
  // directed 3-cycle untorn on these plans.
  const WITNESS_TARGETS: ReadonlyArray<{ name: string; targets: Target[] }> = [
    {
      name: "proc_battery_5",
      targets: [
        { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
      ],
    },
    {
      name: "xiranite_enr_powder",
      targets: [
        { recipeId: "xiranite_enr_powder", ratePerSec: { num: "1", denom: "1" } },
      ],
    },
  ];

  for (const { name, targets } of WITNESS_TARGETS) {
    it(`real pack ${name}: every multi-member SCC is acyclic after tearing`, () => {
      const g = buildRecipeGraphMulti(targets, pack);
      expect(
        tarjanScc(g).some((s) => s.recipeIds.length > 1),
      ).toBe(true);
      expect(residualCycleSccs(g)).toBe(0);
    });
  }

  it("is deterministic: identical torn ids across two graph rebuilds", () => {
    const targets: Target[] = [
      { recipeId: "proc_battery_5", ratePerSec: { num: "1", denom: "1" } },
    ];
    const tornIds = (g: RecipeGraph): string[] =>
      tarjanScc(g)
        .filter((s) => s.recipeIds.length > 1)
        .flatMap((s) => pickTearEdges(s as Scc, g).map((t) => t.id));
    const ids1 = tornIds(buildRecipeGraphMulti(targets, pack));
    const ids2 = tornIds(buildRecipeGraphMulti(targets, pack));
    expect(ids1.length).toBeGreaterThan(0);
    expect(ids2).toEqual(ids1);
  });
});
