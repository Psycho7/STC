import { describe, expect, test } from "vitest";
import type { RecipePack } from "@aef/schema";
import { pack } from "../data/load";
import { buildRecipeGraphMulti } from "./graph";
import { tarjanScc } from "./scc";
import { makePack } from "./closed-form-fixtures";
import type { Target } from "../data/targets";

// Pack-shape guard for the replicatePerConsumer known limit (see the comment
// at the non-shared branch in replicate.ts): a multi-output producer reached
// through DIFFERENT output items is minted once per (consumer, item), and the
// bisim quotient cannot merge the copies, so its total replica rate
// double-counts the LP rate. The walk only avoids this when the producer is
// intercepted by a shared branch: SCC membership or the byproduct-supplier
// set (replicate.ts byproductSharedSources). This census scans a pack for the
// topology precondition - a producer fanning two or more distinct output
// items across recipe-graph edges with neither protection - and returns the
// unprotected recipe ids.
//
// The graph is built with every recipe as a target so all reachable edges
// exist. Counting graph out-edge items (not raw pack consumption) matters:
// an output whose item has unlimited boundary supply grows no edge, so it can
// never carry a per-consumer reach (liquid_copper_enr's liquid_acid today).
// Articulation-point sharing also protects in many plans, but it is
// plan-dependent, so the census deliberately ignores it and stays
// conservative at the pack level.
function unprotectedCoProductFanouts(p: RecipePack): string[] {
  const targets: Target[] = p.recipes.map((r) => ({
    recipeId: r.id,
    ratePerSec: { num: "1", denom: "1" },
  }));
  const g = buildRecipeGraphMulti(targets, p, []);
  const sccs = tarjanScc(g);

  const inNonTrivialScc = new Set<string>();
  for (const s of sccs) {
    if (s.recipeIds.length <= 1) continue;
    for (const rid of s.recipeIds) inNonTrivialScc.add(rid);
  }

  // Mirror replicate.ts byproductSharedSources: a producer that feeds a
  // multi-member SCC member across the boundary for a non-primary output is
  // emitted once at full LP rate, so it cannot double-mint.
  const byproductShared = new Set<string>();
  for (const s of sccs) {
    if (s.recipeIds.length <= 1) continue;
    const members = new Set(s.recipeIds);
    for (const memberId of s.recipeIds) {
      for (const e of g.incoming.get(memberId) ?? []) {
        if (members.has(e.source)) continue;
        const producer = g.nodes.get(e.source);
        const primaryOut = producer?.out[0]?.item;
        if (primaryOut !== undefined && e.item !== primaryOut) {
          byproductShared.add(e.source);
        }
      }
    }
  }

  const flagged: string[] = [];
  for (const [rid] of g.nodes) {
    const outItems = new Set((g.outgoing.get(rid) ?? []).map((e) => e.item));
    if (outItems.size < 2) continue;
    if (inNonTrivialScc.has(rid)) continue;
    if (byproductShared.has(rid)) continue;
    flagged.push(rid);
  }
  return flagged.sort();
}

describe("co-product fan-out pack census", () => {
  // Self-test: the census must trip on the minimal diamond that reproduces
  // the double-mint (P(raw -> x+y), A(x -> mid_a), B(y -> mid_b)).
  test("flags the unprotected diamond fixture", () => {
    const diamond = makePack(
      [
        { id: "P", time: 1, in: { raw: 1 }, out: { x: 1, y: 1 } },
        { id: "A", time: 1, in: { x: 1 }, out: { mid_a: 1 } },
        { id: "B", time: 1, in: { y: 1 }, out: { mid_b: 1 } },
      ],
      [
        { id: "raw", raw: true },
        { id: "x" },
        { id: "y" },
        { id: "mid_a" },
        { id: "mid_b" },
      ],
    );
    expect(unprotectedCoProductFanouts(diamond)).toEqual(["P"]);
  });

  // The shipped pack has no unprotected pair, which is the only reason the
  // latent double-mint cannot trigger. If a pack update makes this fail, do
  // NOT relax the assertion: generalize the co-product sharing in
  // replicate.ts (byproductSharedSources) to non-SCC fan-outs instead, then
  // delete the known-limit comment at the non-shared branch.
  test("shipped pack has no unprotected co-product fan-out", () => {
    expect(unprotectedCoProductFanouts(pack)).toEqual([]);
  });
});
