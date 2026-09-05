import { describe, expect, test } from "vitest";
import type { Recipe, RecipePack } from "@aef/schema";
import { pack } from "../data/load";
import { buildRecipeGraphMulti } from "./graph";
import { tarjanScc } from "./scc";
import { makePack } from "./closed-form-fixtures";
import { netSelfConsumption } from "./net-self";
import type { ItemTarget } from "../data/targets";
import type { ItemOverride } from "../data/plan";

// Pack-shape guard for the replicatePerConsumer known limit (see the comment
// at the non-shared branch in replicate.ts): a multi-output producer reached
// through DIFFERENT output items is minted once per (consumer, item), and the
// bisim quotient cannot merge the copies, so its total replica rate
// double-counts the LP rate. The walk only avoids this when the producer is
// intercepted by a shared branch: SCC membership or the byproduct-supplier
// set (replicate.ts byproductSharedSources). This census scans a pack for the
// topology precondition - a producer whose consumed outputs can span two or
// more distinct items in some legal plan with neither protection holding -
// and returns the unprotected recipe ids.
//
// The candidate fan is counted from PACK CONSUMPTION (which recipes list each
// output item as an input), not from graph out-edges alone. Graph edges are
// override-sensitive: a raw-flagged co-product with no override has
// effectiveSupply Infinity, so the graph grows no edge for it, yet a legal
// {plan: true} override forces internal build and makes that reach live.
// Pack consumption is invariant under overrides, so no consumed co-product
// escapes the census.
//
// Because both the reach (which co-products carry edges) and the protections
// (SCC membership, byproduct-shared interception) depend on which raw items
// are overridden, each producer is checked once per override world: every
// subset of its raw-flagged consumed outputs forced internal via {plan: true}.
// A producer is flagged when ANY world leaves a live fan of two or more items
// with neither protection. Worlds that override raw items elsewhere in the
// pack only ADD edges, which can only grow SCCs and the shared-supplier set,
// so skipping them is conservative.
//
// byproductSharedSources protects only the plans that actually pull the
// protecting SCC: a producer whose co-product also feeds consumers outside
// the SCC can still double-mint in a plan that pulls only those outside
// consumers. So byproduct-shared credit is granted ONLY when the producer's
// residual fan - its live consumed-output items after dropping edges into
// members of the protecting multi-member SCCs and into no-output sinks -
// spans fewer than two distinct items. Sink edges are sound to drop because
// an out-empty recipe can never appear in a plan graph: the target gate
// (isSinkRecipe) rejects it as a target, and with no outputs it is never
// pulled as a producer. Articulation-point sharing also protects in many
// plans, but it is plan-dependent, so the census deliberately ignores it and
// stays conservative at the pack level.
function unprotectedCoProductFanouts(p: RecipePack): string[] {
  const rawItems = new Set(p.items.filter((i) => i.raw).map((i) => i.id));
  const consumersByItem = new Map<string, Recipe[]>();
  for (const r of p.recipes) {
    for (const inp of r.in) {
      const list = consumersByItem.get(inp.item);
      if (list) list.push(r);
      else consumersByItem.set(inp.item, [r]);
    }
  }

  // The graph (built with every produced item as a target so all reachable
  // edges exist) supplies SCC membership and the byproduct-shared trigger for
  // one override world. Cached by override set: worlds repeat across
  // producers.
  const targetItems = new Set<string>();
  for (const r of p.recipes) for (const o of r.out) targetItems.add(o.item);
  const targets: ItemTarget[] = [...targetItems].map((itemId) => ({
    itemId,
    ratePerSec: { num: "1", denom: "1" },
  }));
  const worldCache = new Map<
    string,
    { inScc: Set<string>; protectingMembers: Map<string, Set<string>> }
  >();
  function world(overrideItems: string[]) {
    const key = [...overrideItems].sort().join(",");
    const cached = worldCache.get(key);
    if (cached) return cached;

    const overrides: ItemOverride[] = overrideItems.map((itemId) => ({
      itemId,
      plan: true,
    }));
    const g = buildRecipeGraphMulti(targets, p, overrides);
    const sccs = tarjanScc(g);

    const inScc = new Set<string>();
    for (const s of sccs) {
      if (s.recipeIds.length <= 1) continue;
      for (const rid of s.recipeIds) inScc.add(rid);
    }

    // Mirror replicate.ts byproductSharedSources: producer -> members of the
    // multi-member SCCs it feeds across the boundary via a non-primary
    // output.
    const protectingMembers = new Map<string, Set<string>>();
    for (const s of sccs) {
      if (s.recipeIds.length <= 1) continue;
      const members = new Set(s.recipeIds);
      for (const memberId of s.recipeIds) {
        for (const e of g.incoming.get(memberId) ?? []) {
          if (members.has(e.source)) continue;
          const producer = g.nodes.get(e.source);
          const primaryOut = producer?.out[0]?.item;
          if (primaryOut !== undefined && e.item !== primaryOut) {
            let set = protectingMembers.get(e.source);
            if (!set) {
              set = new Set();
              protectingMembers.set(e.source, set);
            }
            for (const m of members) set.add(m);
          }
        }
      }
    }

    const w = { inScc, protectingMembers };
    worldCache.set(key, w);
    return w;
  }

  const flagged: string[] = [];
  for (const r of p.recipes) {
    const consumedOuts = new Set<string>();
    for (const o of r.out) {
      if ((consumersByItem.get(o.item) ?? []).length > 0) consumedOuts.add(o.item);
    }
    if (consumedOuts.size < 2) continue;

    const rawOuts = [...consumedOuts].filter((i) => rawItems.has(i));
    let unsafe = false;
    for (let mask = 0; mask < 1 << rawOuts.length && !unsafe; mask++) {
      const overridden = rawOuts.filter((_, idx) => (mask & (1 << idx)) !== 0);
      const overriddenSet = new Set(overridden);
      // A raw output's reach is live only when overridden in this world.
      const live = [...consumedOuts].filter(
        (i) => !rawItems.has(i) || overriddenSet.has(i),
      );
      if (new Set(live).size < 2) continue;

      const { inScc, protectingMembers } = world(overridden);
      if (inScc.has(r.id)) continue;
      const protecting = protectingMembers.get(r.id);
      if (protecting) {
        const residual = new Set<string>();
        for (const item of live) {
          for (const c of consumersByItem.get(item) ?? []) {
            if (protecting.has(c.id)) continue;
            if (c.out.length === 0) continue;
            residual.add(item);
          }
        }
        if (residual.size < 2) continue;
      }
      unsafe = true;
    }
    if (unsafe) flagged.push(r.id);
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

  // Self-test for the residual-fan rule: P's co-product b feeds an SCC
  // member M1 (the byproduct-shared trigger) AND a plain consumer C outside
  // the SCC. A plan pulling only A and C never instantiates the SCC, so the
  // shared emission cannot intercept P and it is minted via both x and b.
  // The residual fan {x, b} spans two items, so the credit must be denied.
  test("flags a byproduct-shared producer with a plain consumer outside the SCC", () => {
    const p = makePack(
      [
        { id: "P", time: 1, in: { raw: 1 }, out: { x: 1, b: 1 } },
        { id: "A", time: 1, in: { x: 1 }, out: { ax: 1 } },
        { id: "M1", time: 1, in: { b: 1, l2: 1 }, out: { l1: 1 } },
        { id: "M2", time: 1, in: { l1: 1 }, out: { l2: 1 } },
        { id: "C", time: 1, in: { b: 1 }, out: { cb: 1 } },
      ],
      [
        { id: "raw", raw: true },
        { id: "x" },
        { id: "b" },
        { id: "l1" },
        { id: "l2" },
        { id: "ax" },
        { id: "cb" },
      ],
    );
    expect(unprotectedCoProductFanouts(p)).toEqual(["P"]);
  });

  // Self-test for the override-world rule: co-product y is raw-flagged, so
  // with no override the graph grows no edge for it and a graph-edge census
  // would see a fan of one. A {plan: true} override forces y to be built
  // internally, reviving the second reach with no protection in that world,
  // so the census must still flag P.
  test("flags a producer whose second consumed co-product is raw-flagged", () => {
    const p = makePack(
      [
        { id: "P", time: 1, in: { raw: 1 }, out: { x: 1, y: 1 } },
        { id: "A", time: 1, in: { x: 1 }, out: { ax: 1 } },
        { id: "B", time: 1, in: { y: 1 }, out: { by: 1 } },
      ],
      [
        { id: "raw", raw: true },
        { id: "x" },
        { id: "y", raw: true },
        { id: "ax" },
        { id: "by" },
      ],
    );
    expect(unprotectedCoProductFanouts(p)).toEqual(["P"]);
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

// The extraction ban keys on an empty `in`, and the solver applies it to the
// NETTED pack: netSelfConsumption drops an item from `in` entirely when the
// recipe's output of it exceeds its input, so a catalyst whose only input is
// its own output would net to zero inputs and be banned silently. Nothing in
// the shipped pack does that today. This census is what makes a future one
// loud: if it fails, the new id is either a real extractor (add it here) or a
// recipe the ban would wrongly swallow (key the predicate on something other
// than the netted input count).
//
// Deliberately spells out `in.length === 0` instead of calling
// isExtractionRecipe: the census has to keep asking the concrete question even
// if the predicate is later re-keyed, which is the drift it exists to catch.
describe("extraction-recipe pack census", () => {
  const KNOWN_EXTRACTORS = [
    "gas_inert",
    "gas_xiranite",
    "iron_ore",
    "liquid_acid",
    "liquid_water",
    "originium_ore",
    "quartz_sand",
  ];

  test("netting introduces no input-less recipe beyond the known extractors", () => {
    const inputless = (p: RecipePack): string[] =>
      p.recipes
        .filter((r) => r.in.length === 0)
        .map((r) => r.id)
        .sort();
    expect(inputless(pack)).toEqual(KNOWN_EXTRACTORS);
    expect(inputless(netSelfConsumption(pack))).toEqual(KNOWN_EXTRACTORS);
  });

  test("every known extractor produces a raw item", () => {
    const rawIds = new Set(pack.items.filter((i) => i.raw).map((i) => i.id));
    for (const id of KNOWN_EXTRACTORS) {
      const r = pack.recipes.find((x) => x.id === id)!;
      expect(r.out.every((o) => rawIds.has(o.item))).toBe(true);
    }
  });
});

// The id-derived strings on the replica/render path join on `#`, `~`, `|`, `:`
// or NUL, and none of the five is escaped on the way in:
//   - replicate.ts mints a replica id as `r:<recipeId>#<n>`, and
//     logicalNodeIdForReplica swaps that `#` for `~`;
//   - outgoingEdgeKey (solver/types.ts) is `<item>|<target>`, materialize's
//     shared bucket key is `<source>|<item>`, and busRouting's flow key is
//     `<item>|<source>`;
//   - supplyShareKey and the edge-rate group key join on NUL;
//   - the render unit-id grammar under pipeline/render is `:`-separated.
// A separator character inside a recipe or item id would let two distinct
// entities mint the same string. The pipeline maps ids through the same
// constructors at every stage, so a collision does not silently drop edge
// rates - it merges two entities, which is worse and quieter.
//
// Not exhaustive over the whole codebase: tear.ts joins on spaces, assemble
// and graph on `->`, and the bisim passes on \x1F / \x1D. Those keys are
// internal to one pass and are not pinned here; extend the class if one of
// them ever leaks into an id the render layer reconstructs.
//
// Nothing validates the pack against this, so the census is the guard. The
// netted pack is checked as well because netSelfConsumption is the pack the
// solver actually runs on. If this fails, escape or reject the offending id at
// the extractor rather than loosening the assertion.
describe("id grammar pack census", () => {
  const SEPARATORS = /[#~|:\0]/;

  const offenders = (p: RecipePack): string[] =>
    [
      ...p.recipes.map((r) => r.id),
      ...p.items.map((i) => i.id),
    ]
      .filter((id) => SEPARATORS.test(id))
      .sort();

  test("no recipe or item id carries an id-grammar separator", () => {
    expect(offenders(pack)).toEqual([]);
    expect(offenders(netSelfConsumption(pack))).toEqual([]);
  });
});

// out[0] is the PRIMARY output (see the comment on Recipe.out in the extractor
// schema): shared-vs-per-consumer replica dispatch, the recipe node's title and
// the recipe-category predicates all read it, and it rests on nothing stronger
// than upstream JSON key order. Pin the pair for every multi-output recipe so a
// vendor refresh that reorders one shows up here instead of quietly moving a
// plan's topology.
//
// The netted pack is pinned too: netSelfConsumption rewrites `in` and `out`, so
// it is the second place an output could change position, and it is the pack
// the solver runs on.
describe("primary-output pack census", () => {
  const PRIMARY_OUT: Array<[string, string]> = [
    ["copper_enr", "copper_enr"],
    ["copper_nugget", "copper_nugget"],
    ["liquid_copper_enr", "liquid_copper_enr"],
    ["liquid_xiranite_poly", "liquid_xiranite_poly"],
    ["liquid_xiranite_poly-purifier", "liquid_xiranite_poly"],
    ["xiranite_poly", "xiranite_poly"],
  ];

  const primaryOuts = (p: RecipePack): Array<[string, string]> =>
    p.recipes
      .filter((r) => r.out.length > 1)
      .map((r): [string, string] => [r.id, r.out[0]!.item])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  test("multi-output recipes keep their primary output", () => {
    expect(primaryOuts(pack)).toEqual(PRIMARY_OUT);
    expect(primaryOuts(netSelfConsumption(pack))).toEqual(PRIMARY_OUT);
  });
});
