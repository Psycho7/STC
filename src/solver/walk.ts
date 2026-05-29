import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type {
  Condensation,
  ItemId,
  RecipeGraph,
  RecipeId,
  SccId,
  TornEdgeId,
} from "./types";
import type { Target } from "../data/targets";
import type { ItemOverride } from "../data/plan";
import { pickTearEdges } from "./tear";
import { solveSccFlow } from "./flow";
import { effectiveSupply } from "./effectiveSupply";
import { MultiProducerSccCapError } from "./types";

/**
 * Walks the SCC condensation downstream-first (the reverse of the upstream-first
 * `topo` order) and assigns an execution rate to every recipe in the graph.
 *
 * The rate comes from one of three cases:
 *   - A size-1 SCC that is a target gets its boundary-converted target rate.
 *   - A size-1 non-target gets the max over its outputs of
 *     (downstream demand / out.qty).
 *   - A larger SCC is torn and flow-solved against the downstream boundary
 *     demand we already know. Targets sitting inside the SCC are pinned to
 *     their target rate, which the flow solver moves from the unknowns to the
 *     RHS.
 */
export function walkAndSolve(args: {
  g: RecipeGraph;
  condensation: Condensation;
  topo: SccId[];
  targets: Target[];
  pack: RecipePack;
  itemOverrides?: ItemOverride[];
}): { rates: Map<RecipeId, Fraction>; tornFlow: Map<TornEdgeId, Fraction> } {
  const { g, condensation, topo, targets, pack } = args;
  const itemOverrides = args.itemOverrides ?? [];

  // A target whose recipe lives inside a non-trivial SCC is treated as a net
  // external delivery rather than a pinned gross execution rate. Its rate goes
  // into `targetNetDelivery` (keyed by recipe id, then output item), and the
  // flow solver reads it as a synthetic external draw. Targets outside any SCC,
  // and the size-1 trivial-SCC target case below, keep the gross-exec meaning
  // via `targetExecRates`.
  const sccSizeOfRecipe = new Map<RecipeId, number>();
  for (const scc of condensation.sccs) {
    for (const rid of scc.recipeIds)
      sccSizeOfRecipe.set(rid, scc.recipeIds.length);
  }
  function isInNonTrivialScc(recipeId: RecipeId): boolean {
    return (sccSizeOfRecipe.get(recipeId) ?? 1) > 1;
  }

  // Convert each target's item rate into a recipe execution rate.
  const targetExecRates = new Map<RecipeId, Fraction>();
  // Net external delivery per target recipe. The inner map goes from output
  // item id to its delivery rate in items per second.
  const targetNetDelivery = new Map<RecipeId, Map<ItemId, Fraction>>();
  for (const t of targets) {
    const recipe = pack.recipes.find((r) => r.id === t.recipeId);
    if (!recipe) continue;
    const rate = new Fraction(t.ratePerSec.num).div(
      new Fraction(t.ratePerSec.denom),
    );
    if (isInNonTrivialScc(t.recipeId) && recipe.out.length > 0) {
      // Don't pin the exec rate here; hand the rate off as an external delivery
      // on the target's primary output item instead.
      const perItem = new Map<ItemId, Fraction>();
      perItem.set(recipe.out[0]!.item, rate);
      targetNetDelivery.set(t.recipeId, perItem);
      continue;
    }
    let execRate: Fraction;
    if (recipe.out.length > 0) {
      execRate = rate.div(new Fraction(recipe.out[0]!.qty));
    } else {
      // Sink recipe: convert via the first input qty instead.
      execRate = rate.div(new Fraction(recipe.in[0]!.qty));
    }
    targetExecRates.set(t.recipeId, execRate);
  }

  const rates = new Map<RecipeId, Fraction>();
  const tornFlow = new Map<TornEdgeId, Fraction>();
  const targetIds = new Set(targets.map((t) => t.recipeId));

  // Memoize effectiveSupply lookups. The inner per-output loop asks about the
  // same item across many recipes, and each call would otherwise rescan
  // itemOverrides.
  const supplyMemo = new Map<ItemId, Fraction | typeof Infinity>();
  function getSupply(itemId: ItemId): Fraction | typeof Infinity {
    let v = supplyMemo.get(itemId);
    if (v === undefined) {
      v = effectiveSupply(itemId, pack, itemOverrides);
      supplyMemo.set(itemId, v);
    }
    return v;
  }

  // `topo` is upstream-first, so walk it in reverse to go downstream-first.
  for (let i = topo.length - 1; i >= 0; i--) {
    const sccId = topo[i]!;
    const scc = condensation.sccs.find((s) => s.id === sccId);
    if (!scc) continue;

    if (scc.recipeIds.length === 1) {
      const rid = scc.recipeIds[0]!;
      if (targetIds.has(rid)) {
        rates.set(rid, targetExecRates.get(rid)!);
        continue;
      }
      const recipe = g.nodes.get(rid);
      if (!recipe) {
        rates.set(rid, new Fraction(0));
        continue;
      }
      if (recipe.out.length === 0) {
        // A sink recipe that isn't a target never runs.
        rates.set(rid, new Fraction(0));
        continue;
      }
      // Drive the rate off demand: take the max across the output items of what
      // each one needs. Any external boundary supply for an output item is
      // subtracted from that output's demand first, leaving the producer to
      // cover the residual. Infinite supply covers the item entirely, so the
      // residual (and the producer's contribution on that output) is zero. A
      // finite cap covers up to min(supply, demand), and the recipe has to
      // build whatever is left. Surplus beyond demand is just dropped.
      let maxRate = new Fraction(0);
      for (const outItem of recipe.out) {
        let demand_i = new Fraction(0);
        for (const e of g.outgoing.get(rid) ?? []) {
          if (e.item !== outItem.item) continue;
          const c_rate = rates.get(e.target) ?? new Fraction(0);
          const consumer = g.nodes.get(e.target);
          const inItem = consumer?.in.find((x) => x.item === outItem.item);
          if (inItem) {
            demand_i = demand_i.add(c_rate.mul(new Fraction(inItem.qty)));
          }
        }
        const supply = getSupply(outItem.item);
        let internalDemand_i: Fraction;
        if (typeof supply === "number") {
          // Infinity is the only number effectiveSupply ever returns: the
          // boundary is unlimited, so the entire demand is met externally.
          internalDemand_i = new Fraction(0);
        } else {
          // consumedSupply is min(supply, demand_i). Fraction has no min(), so
          // we pick the smaller via compare.
          const consumedSupply_i =
            supply.compare(demand_i) < 0 ? supply : demand_i;
          internalDemand_i = demand_i.sub(consumedSupply_i);
        }
        const rate_i = internalDemand_i.div(new Fraction(outItem.qty));
        if (rate_i.compare(maxRate) > 0) maxRate = rate_i;
      }
      rates.set(rid, maxRate);
    } else {
      // A non-trivial SCC: tear it, then flow-solve against the boundary we
      // already know. Targets inside the SCC are pinned to their exec rate.
      const tears = pickTearEdges(scc, g);
      const pinned = new Map<RecipeId, Fraction>();
      // Targets routed through targetNetDelivery do not pin; their rate feeds
      // the SCC's flow equations as an external delivery instead. Only targets
      // that kept the gross-exec meaning (those present in targetExecRates)
      // still pin.
      for (const rid of scc.recipeIds) {
        if (targetIds.has(rid) && targetExecRates.has(rid)) {
          pinned.set(rid, targetExecRates.get(rid)!);
        }
      }
      // Build the external-delivery map scoped to this SCC's members.
      const sccDelivery = new Map<RecipeId, Map<ItemId, Fraction>>();
      for (const rid of scc.recipeIds) {
        const d = targetNetDelivery.get(rid);
        if (d) sccDelivery.set(rid, d);
      }
      // Pre-subtract external supply per SCC output item. For each output item
      // that has at least one external consumer, the cap is
      // min(effectiveSupply, externalDemandSum). Items with infinite supply or
      // no external consumers are skipped, so when nothing is overridden the
      // map comes out empty and the flow solver behaves exactly as it did
      // before.
      //
      // We build item -> internal-producers first and then iterate items, so
      // externalDemandSum sums external consumers across all producers of the
      // item. Doing it the other way (deduping by item inside a per-member
      // loop) would under-count. With one producer per item this distinction
      // is a no-op.
      //
      // There is an invariant to defend here: whenever a finite cap actually
      // applies (the item has a supply override and at least one external
      // consumer), the SCC must have exactly one internal producer of that
      // item. AEF satisfies this by construction; scripts/audit-scc-multi-producer.ts
      // finds zero violations across every non-trivial SCC. The cap math in the
      // flow solver subtracts the per-item cap from each producer's equation,
      // so two internal producers of the same item would double-subtract. We
      // only throw on the cap-applies path, which keeps the no-override baseline
      // identical for any future SCC shape while still failing loudly the
      // instant an override would actually trigger the bug.
      const sccMembers = new Set(scc.recipeIds);
      const internalProducersByItem = new Map<ItemId, RecipeId[]>();
      for (const rid of scc.recipeIds) {
        const recipe = g.nodes.get(rid);
        if (!recipe) continue;
        for (const outItem of recipe.out) {
          let arr = internalProducersByItem.get(outItem.item);
          if (!arr) {
            arr = [];
            internalProducersByItem.set(outItem.item, arr);
          }
          arr.push(rid);
        }
      }
      const externalSupplyByItem = new Map<ItemId, Fraction>();
      for (const [item, producers] of internalProducersByItem) {
        // Sum external-consumer demand across all internal producers of the
        // item. buildRecipeGraph picks a single producer per item today, so
        // only one of `producers` actually has outgoing edges for it, but
        // aggregating this way states the intent plainly and survives a change
        // to the graph-builder's producer-selection policy.
        let externalDemandSum = new Fraction(0);
        let hasAnyExternalConsumer = false;
        for (const rid of producers) {
          for (const edge of g.outgoing.get(rid) ?? []) {
            if (edge.item !== item) continue;
            if (sccMembers.has(edge.target)) continue;
            const consumer = g.nodes.get(edge.target);
            if (!consumer) continue;
            const inItem = consumer.in.find((x) => x.item === item);
            if (!inItem) continue;
            const c_rate = rates.get(edge.target) ?? new Fraction(0);
            externalDemandSum = externalDemandSum.add(
              c_rate.mul(new Fraction(inItem.qty)),
            );
            hasAnyExternalConsumer = true;
          }
        }
        if (!hasAnyExternalConsumer) continue;
        if (externalDemandSum.compare(0) <= 0) continue;
        const supply = getSupply(item);
        if (typeof supply === "number") continue; // Infinity means no subtraction.
        const consumedSupply =
          supply.compare(externalDemandSum) < 0 ? supply : externalDemandSum;
        if (consumedSupply.compare(0) <= 0) continue;
        // The flow solver builds one mass-balance equation per (SCC member,
        // output item) and subtracts the cap from each one, so two members that
        // both list `item` in their outputs would subtract the cap twice. Bail
        // out before that can happen. AEF has no such SCCs, as confirmed by
        // scripts/audit-scc-multi-producer.ts. The check sits after the
        // consumedSupply > 0 gate so the no-cap baseline (no override, or supply
        // that meets demand and cancels out) never trips it.
        if (producers.length > 1) {
          throw new MultiProducerSccCapError(scc.id, item, producers);
        }
        externalSupplyByItem.set(item, consumedSupply);
      }
      const result = solveSccFlow(
        scc,
        g,
        tears,
        rates,
        pinned,
        externalSupplyByItem.size > 0 ? externalSupplyByItem : undefined,
        sccDelivery.size > 0 ? sccDelivery : undefined,
      );
      for (const [r, val] of result.rates) rates.set(r, val);
      for (const [id, val] of result.tornFlow) tornFlow.set(id, val);
    }
  }

  return { rates, tornFlow };
}
