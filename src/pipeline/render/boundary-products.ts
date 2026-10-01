import Fraction from "fraction.js";
import type {
  ContainerId,
  ItemId,
  MachineGraph,
  MachineVertexId,
  RecipeId,
  RenderEdge,
  RenderUnitId,
  RenderUnitInputProduct,
  RenderUnitOutputProduct,
} from "../types";
import { isMachineRecipeVertex, isMachineSccVertex } from "../types";
import type { SupplyTable } from "../../solver/effectiveSupply";
import { relSlack, toleranceScaleFloor } from "../../solver/lp";
import type { ItemTarget } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";
import type { Item, Recipe } from "@aef/schema";
import { pushInto } from "../../util/multimap";
import { rationalFromString, rationalToString } from "./rational";
import { targetOutputShortfalls } from "./invariants";
import {
  unitIdForCatalystAggregate,
  unitIdForCatalystContainer,
  unitIdForInputAggregate,
  unitIdForInputContainer,
  unitIdForOutputProduct,
  unitIdForSurplus,
} from "./unit-ids";

// A boundary item's consumers are grouped per pool and then into buckets: one
// bucket per real container (an SCC loop or blueprint group,
// `u:in:<item>:<container>`) plus a single shared "loose" bucket holding every
// consumer that sits in no container. Only a container bucket ever gets its own
// card, because an edge must enter a compound node once; loose consumers draw
// straight from the item's input card and their per-branch rate chip already
// states the amount.
//
// The pool is the consumer's role: ordinary consumption draws from the `u:in:`
// family, a cycled catalyst charge from the `u:cat:` family. The two are
// accounted apart end to end, so an item consumed as a reagent AND cycled as a
// catalyst emits one node of each rather than one node carrying both draws.
//
// Topology per (item, role), decided once:
//   - Loose bucket only: one node `u:in:<item>`, consumer edges direct.
//   - One container bucket and nothing loose: one node `u:in:<item>:<ctr>`.
//   - Otherwise: an aggregate node `u:in:<item>` carrying the pool's rateCap
//     and the sum of all bucket rates (loose included), one `isFanout` slice
//     per container bucket, and the loose consumers' edges straight off the
//     aggregate.
type BoundaryRole = "ordinary" | "catalyst";
type BoundaryBucket =
  | { kind: "container"; containerId: ContainerId }
  | { kind: "loose" };
const LOOSE_BUCKET: BoundaryBucket = { kind: "loose" };
const bucketFor = (containerId: ContainerId | undefined): BoundaryBucket =>
  containerId === undefined ? LOOSE_BUCKET : { kind: "container", containerId };
// BoundaryBucket is local to this file, so these stay here as thin dispatchers
// over the shared constructors.
const unitIdForAggregate = (item: ItemId, role: BoundaryRole): RenderUnitId =>
  role === "catalyst"
    ? unitIdForCatalystAggregate(item)
    : unitIdForInputAggregate(item);
const unitIdForContainer = (
  item: ItemId,
  role: BoundaryRole,
  containerId: ContainerId,
): RenderUnitId =>
  role === "catalyst"
    ? unitIdForCatalystContainer(item, containerId)
    : unitIdForInputContainer(item, containerId);
const unitIdForInputBucket = (
  item: ItemId,
  role: BoundaryRole,
  bucket: BoundaryBucket,
): RenderUnitId =>
  bucket.kind === "container"
    ? unitIdForContainer(item, role, bucket.containerId)
    : unitIdForAggregate(item, role);
// The pool an item's consumers are grouped under, and the key both the
// per-bucket and the per-pool maps below hang off. `\0` sorts below every id
// character, so sorting pool keys keeps an item's ordinary pool next to its
// catalyst pool and the items themselves in id order.
type PoolKey = string;
const poolKey = (item: ItemId, role: BoundaryRole): PoolKey =>
  role === "catalyst" ? `${item}\0cat` : item;
const boundaryKey = (
  item: ItemId,
  role: BoundaryRole,
  bucket: BoundaryBucket,
): string =>
  bucket.kind === "container"
    ? `${poolKey(item, role)}\0c\0${bucket.containerId}`
    : `${poolKey(item, role)}\0loose`;

const FRAC_ONE = new Fraction(1);

export type DeriveBoundaryProductsInput = {
  machineGraph: MachineGraph;
  targets: ReadonlyArray<ItemTarget>;
  itemOverrides: ReadonlyArray<ItemOverride>;
  itemById: ReadonlyMap<ItemId, Item>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  // Effective supply per item, resolved once by the caller. Built from the RAW
  // pack's items and the same overrides as `itemOverrides`.
  supply: SupplyTable;
  unitIdByVertex: ReadonlyMap<MachineVertexId, RenderUnitId>;
  // Per finite-capped item the LP drew from the boundary: the fraction of its
  // consumption in-graph producers cover (boundaryResidualShare). Missing
  // entries mean realized draw 0: the boundary contributes nothing and no
  // input product is emitted for the item.
  boundaryShare: ReadonlyMap<ItemId, Fraction>;
  // The LP's boundary draw per finite-capped item. A capped target's export
  // takes what the draw has left after the item's in-plan consumers.
  draws: ReadonlyMap<ItemId, Fraction>;
};

export type DeriveBoundaryProductsResult = {
  inputProducts: RenderUnitInputProduct[];
  outputProducts: RenderUnitOutputProduct[];
  boundaryEdges: RenderEdge[];
};

/**
 * Derives boundary input/output product units and the edges connecting them to
 * in-graph machine units. The rules once lived inline in the render policy:
 * target
 * items become output products (at their target rate); items consumed in the
 * plan with nonzero `effectiveSupply` become input products (with a rate cap
 * when overridden); surplus byproducts become amber output products; a
 * target item's export draws the slice of its declared rate that in-plan
 * production spare does not cover from the item's own input card (for a capped
 * item, no more than the LP draw has left).
 * Per-consumer flow conservation holds when a boundary input coexists with an
 * in-graph producer for the same item.
 *
 * Every quantity is accounted per render UNIT, not per machine vertex: the
 * rollup below is the one place the vertex-to-unit mapping is read.
 *
 * Pure: never mutates its arguments. `unitIdByVertex` MUST map every machine
 * vertex in `machineGraph` to a render unit id, since boundary edges target
 * those units by id; the caller emits them before calling this.
 */
export function deriveBoundaryProducts(
  args: DeriveBoundaryProductsInput,
): DeriveBoundaryProductsResult {
  const {
    machineGraph,
    targets,
    itemOverrides,
    itemById,
    recipeById,
    supply: supplyTable,
    unitIdByVertex,
    boundaryShare,
    draws,
  } = args;

  const boundaryEdges: RenderEdge[] = [];

  // ----- Boundary product units ----------------------------------------------
  //
  // Output products: one per distinct target item. Duplicate targets on the
  // same item sum their rates so the output product holds total demand instead
  // of dropping the later target.
  const targetRateByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const rate = rationalFromString(t.ratePerSec);
    const existing = targetRateByItem.get(t.itemId);
    targetRateByItem.set(t.itemId, existing ? existing.add(rate) : rate);
  }
  const targetItemSet = new Set<ItemId>(targetRateByItem.keys());
  const outputProducts: RenderUnitOutputProduct[] = [];
  const sortedTargetItems = [...targetRateByItem.keys()].sort();
  for (const outItem of sortedTargetItems) {
    outputProducts.push({
      id: unitIdForOutputProduct(outItem),
      kind: "outputProduct",
      itemId: outItem,
      count: 1,
      rate: rationalToString(targetRateByItem.get(outItem)!),
      flavor: "target",
    });
  }

  // Input products: one per distinct item consumed in the plan whose
  // `effectiveSupply` is nonzero (Infinity or positive Fraction). Zero supply
  // emits nothing (forces internal build); a target item that is also
  // boundary-fed keeps both surfaces. Precedence lives in `effectiveSupply`;
  // this code never inspects `raw` / `plan` directly.
  //
  // An override is keyed by (item, role), so the two pools take their caps
  // from two maps: an ordinary node never picks up a C row's cap and vice
  // versa.
  const overrideByItem = new Map<ItemId, (typeof itemOverrides)[number]>();
  const catalystOverrideByItem = new Map<
    ItemId,
    (typeof itemOverrides)[number]
  >();
  for (const ov of itemOverrides) {
    const target =
      ov.role === "catalyst" ? catalystOverrideByItem : overrideByItem;
    target.set(ov.itemId, ov);
  }

  // ----- Per-unit rollup ------------------------------------------------------
  //
  // Every pass below accounts at the render-unit level, because a unit is what
  // the plan draws: its flow chips, its boundary edges and its surplus all state
  // whole-unit quantities. Roll production, consumption and catalyst charge up
  // to the unit once here, so no pass has to difference per machine vertex and
  // re-aggregate afterwards (differencing first dropped a vertex's deficit
  // against its sibling's spare and surfaced phantom surplus).
  //
  // `unitIdByVertex` maps every vertex by contract; a vertex it does not name has
  // nothing to attach a boundary edge to and is skipped.
  type UnitFacts = {
    // What the unit draws as: a recipe class or an SCC stand-in. Only a recipe
    // unit can feed a target output edge, so the two are told apart here rather
    // than by re-reading the vertices further down. No unit mixes the two: a
    // class collects the vertices of one replica, a loop those of one sccId.
    kind: "recipe" | "loop";
    containerId: ContainerId | undefined;
    produced: Map<ItemId, Fraction>;
    consumed: Map<ItemId, Fraction>;
    /** Cycled catalyst charge, held per machine rather than consumed per cycle. */
    catalyst: Map<ItemId, Fraction>;
  };
  const unitFacts = new Map<RenderUnitId, UnitFacts>();
  const addRate = (
    into: Map<ItemId, Fraction>,
    item: ItemId,
    rate: Fraction,
  ): void => {
    into.set(item, (into.get(item) ?? new Fraction(0)).add(rate));
  };
  for (const v of machineGraph.vertices) {
    const unitId = unitIdByVertex.get(v.id);
    if (unitId === undefined) continue;
    let facts = unitFacts.get(unitId);
    if (!facts) {
      facts = {
        kind: isMachineRecipeVertex(v) ? "recipe" : "loop",
        containerId: v.containerId,
        produced: new Map(),
        consumed: new Map(),
        catalyst: new Map(),
      };
      unitFacts.set(unitId, facts);
    }
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      for (const stoich of recipe.out) {
        addRate(
          facts.produced,
          stoich.item,
          v.executionRate.mul(new Fraction(stoich.qty)),
        );
      }
      for (const stoich of recipe.in) {
        addRate(
          facts.consumed,
          stoich.item,
          v.executionRate.mul(new Fraction(stoich.qty)),
        );
      }
      // A catalyst on a recipe folded into an SCC vertex is out of scope: an
      // scc-box vertex exposes netIO only, so that charge draws no edge.
      for (const charge of v.catalystCharge ?? []) {
        addRate(facts.catalyst, charge.item, charge.rate);
      }
    } else if (isMachineSccVertex(v)) {
      for (const p of v.netIO) {
        addRate(
          p.direction === "out" ? facts.produced : facts.consumed,
          p.item,
          p.rate,
        );
      }
    }
  }

  const producedItems = new Set<ItemId>();
  for (const facts of unitFacts.values()) {
    for (const item of facts.produced.keys()) producedItems.add(item);
  }

  // ----- Byproduct recapture for unlimited-supply items ----------------------
  //
  // The recipe graph never wires a producer->consumer edge for an item with
  // unlimited boundary supply (graph.ts stops expanding such inputs), so a raw
  // item an in-plan recipe ALSO emits as a byproduct reaches the render with no
  // machine edge: its byproduct production surfaces as a phantom surplus while
  // its in-plan consumers are fed from nothing. Reconcile by routing the
  // internal byproduct flow to those consumers and drawing only the remaining
  // demand from the boundary. Scoped to unlimited-supply items with no machine
  // edge, so every graph-wired item stays untouched.
  const machineEdgeItems = new Set<ItemId>();
  for (const e of machineGraph.edges) machineEdgeItems.add(e.item);

  type RecapEnd = {
    unitId: RenderUnitId;
    rate: Fraction;
  };
  const recapProducers = new Map<ItemId, RecapEnd[]>();
  const recapConsumers = new Map<ItemId, RecapEnd[]>();
  const pushRecap = (
    map: Map<ItemId, RecapEnd[]>,
    item: ItemId,
    end: RecapEnd,
  ): void => {
    if (end.rate.compare(new Fraction(0)) <= 0) return;
    pushInto(map, item, end);
  };
  for (const [unitId, facts] of unitFacts) {
    for (const [item, rate] of facts.produced) {
      pushRecap(recapProducers, item, { unitId, rate });
    }
    for (const [item, rate] of facts.consumed) {
      pushRecap(recapConsumers, item, { unitId, rate });
    }
  }

  // recaptureItems: items this pass reconciles. recapturedByConsumerUnitItem:
  // demand each consumer unit gets internally (collectConsumed draws only the
  // deficit from the boundary). recaptureSendByUnitItem: production each
  // producer unit routes out (the surplus pass nets it instead of flagging a
  // phantom surplus).
  const recaptureItems = new Set<ItemId>();
  const recapturedByConsumerUnitItem = new Map<string, Fraction>();
  const recaptureSendByUnitItem = new Map<string, Fraction>();
  const recaptureEdges: RenderEdge[] = [];
  for (const [itemId, producers] of recapProducers) {
    if (machineEdgeItems.has(itemId)) continue;
    if (!supplyTable.isFree(itemId)) continue;
    const consumers = recapConsumers.get(itemId);
    if (!consumers || consumers.length === 0) continue;
    const itemMeta = itemById.get(itemId);
    if (!itemMeta) continue;
    const totalProd = producers.reduce(
      (a, p) => a.add(p.rate),
      new Fraction(0),
    );
    const totalDemand = consumers.reduce(
      (a, c) => a.add(c.rate),
      new Fraction(0),
    );
    if (totalProd.equals(0) || totalDemand.equals(0)) continue;
    // Production claimed by a declared target output is unavailable for
    // internal routing; only the remainder recaptures. Non-target items deduct
    // zero, so their behavior is unchanged. A fully target-claimed item
    // recaptures 0 and still registers, so collectConsumed bills each
    // consumer's full demand to the boundary instead of dropping it.
    const targetDemand = targetRateByItem.get(itemId) ?? new Fraction(0);
    const availRaw = totalProd.sub(targetDemand);
    const availProd =
      availRaw.compare(new Fraction(0)) > 0 ? availRaw : new Fraction(0);
    // Recaptured = min(available production, demand); any excess production
    // stays with the target/surplus passes, any excess demand still draws from
    // the boundary.
    const recaptured =
      availProd.compare(totalDemand) <= 0 ? availProd : totalDemand;
    recaptureItems.add(itemId);
    for (const c of consumers) {
      const key = `${c.unitId}\0${itemId}`;
      const recapC = c.rate.mul(recaptured).div(totalDemand);
      recapturedByConsumerUnitItem.set(
        key,
        (recapturedByConsumerUnitItem.get(key) ?? new Fraction(0)).add(recapC),
      );
    }
    for (const p of producers) {
      const key = `${p.unitId}\0${itemId}`;
      const sendP = p.rate.mul(recaptured).div(totalProd);
      recaptureSendByUnitItem.set(
        key,
        (recaptureSendByUnitItem.get(key) ?? new Fraction(0)).add(sendP),
      );
      // Bipartite split: edge(p,c) routes p's share of the recapture to c's
      // share. Summing over c gives sendP; over p gives each consumer's
      // recaptured demand. Both endpoints are in-plan recipe/loop units.
      for (const c of consumers) {
        const rate = p.rate
          .mul(c.rate)
          .mul(recaptured)
          .div(totalProd)
          .div(totalDemand);
        if (rate.compare(new Fraction(0)) <= 0) continue;
        recaptureEdges.push({
          fromUnit: p.unitId,
          toUnit: c.unitId,
          item: itemId,
          rate,
          transportKind: itemMeta.transportKind,
        });
      }
    }
  }
  for (const e of recaptureEdges) boundaryEdges.push(e);

  // Output boundary edges: each target-recipe unit's per-item spare = produced -
  // outgoing machine edges for that item. Units with positive spare get a target
  // edge; the declared rate splits across them in proportion to spare. For a
  // single leaf target recipe this collapses to the whole declared rate on one
  // edge. For a target inside a recycling loop (or feeding internal consumers),
  // the rule routes the declared net rate to whatever spare exists; a
  // purely-internal unit (spare <= 0) emits no target edge and the surplus pass
  // sees no leftover production from it.
  //
  // outgoingByUnitItem is built once here and reused by the surplus pass. Both
  // passes need the post-target-emission view of outgoing flow so the same
  // production is not counted as both delivered (to the target port) and
  // surplus.
  //
  // This pass runs before the input pools are grouped because the part of a
  // free-supply target that in-plan spare leaves uncovered is boundary draw:
  // the export joins its item's pool as a consumer (see below). Its edges are
  // held back and appended after the input edges, their original order.
  const targetEdges: RenderEdge[] = [];
  const outgoingByUnitItem = new Map<string, Fraction>();
  const unitItemKey = (unitId: RenderUnitId, item: ItemId): string =>
    `${unitId}\0${item}`;
  const addOutgoing = (
    unitId: RenderUnitId,
    item: ItemId,
    rate: Fraction,
  ): void => {
    const key = unitItemKey(unitId, item);
    outgoingByUnitItem.set(
      key,
      (outgoingByUnitItem.get(key) ?? new Fraction(0)).add(rate),
    );
  };
  for (const e of machineGraph.edges) {
    const fromUnit = unitIdByVertex.get(e.from);
    if (fromUnit === undefined) continue;
    addOutgoing(fromUnit, e.item, e.rate);
  }
  // Recapture edges route byproduct production to in-plan consumers; count them
  // as outgoing so the surplus pass nets the recaptured amount.
  for (const [key, rate] of recaptureSendByUnitItem) {
    const sep = key.indexOf("\0");
    addOutgoing(key.slice(0, sep) as RenderUnitId, key.slice(sep + 1), rate);
  }

  type TargetUnitSpare = {
    unitId: RenderUnitId;
    spare: Fraction;
  };
  // Produced and outgoing are both whole-unit quantities, and the spare is taken
  // once at that level. Differencing per machine vertex instead discarded one
  // vertex's deficit against its sibling's spare and inflated the unit's apparent
  // spare, so the proportional split below over-fed it past its production. This
  // mirrors the surplus pass further down; the two passes must agree.
  //
  // Collect from EVERY recipe unit producing target item X, not just the one the
  // target seeded. When an SCC target recipe co-produces the looped item with a
  // leaf recipe (e.g. iron_nugget from both iron_nugget-iron_ore and
  // iron_nugget-iron_powder), the leaf's spare must also reach the target output
  // unit, or the target edge is under-fed and the leaf's spare becomes a phantom
  // surplus. The rollup holds every output item, not just a recipe's primary
  // one, so a co-produced target is captured too; the proportional split then
  // routes the declared rate across pooled spare.
  //
  // Loop units are excluded: an SCC stand-in states net I/O, and its net output
  // is already what its members failed to consume internally, so it feeds the
  // surplus pass rather than a target edge.
  const unitsByTargetOutItem = new Map<ItemId, TargetUnitSpare[]>();
  for (const [unitId, facts] of unitFacts) {
    if (facts.kind !== "recipe") continue;
    for (const [outItem, produced] of facts.produced) {
      if (!targetItemSet.has(outItem)) continue;
      const outgoing =
        outgoingByUnitItem.get(unitItemKey(unitId, outItem)) ?? new Fraction(0);
      const spare = produced.sub(outgoing);
      if (spare.compare(0) <= 0) continue;
      pushInto(unitsByTargetOutItem, outItem, { unitId, spare });
    }
  }
  const targetBilledByItem = new Map<ItemId, Fraction>();
  for (const [outItem, units] of unitsByTargetOutItem) {
    const total = targetRateByItem.get(outItem);
    if (!total || units.length === 0) continue;
    const item = itemById.get(outItem);
    if (!item) continue;
    const totalSpare = units.reduce(
      (acc, u) => acc.add(u.spare),
      new Fraction(0),
    );
    if (totalSpare.equals(new Fraction(0))) continue;
    // Cap at totalSpare so a solver under-production never invents rate
    // downstream. A correct solve produces totalSpare >= total for any
    // reachable target recipe.
    const distributed = total.compare(totalSpare) > 0 ? totalSpare : total;
    targetBilledByItem.set(outItem, distributed);
    for (const u of units) {
      const rate = u.spare.mul(distributed).div(totalSpare);
      targetEdges.push({
        fromUnit: u.unitId,
        toUnit: unitIdForOutputProduct(outItem),
        item: outItem,
        rate,
        transportKind: item.transportKind,
      });
      addOutgoing(u.unitId, outItem, rate);
    }
  }

  // Boundary item := consumed by a machine, produced by no machine in the plan,
  // and surfaced by `effectiveSupply` (Infinity or positive Fraction). Items an
  // in-plan recipe produces upstream stay internal. Track each consumer with
  // its per-consumer rate so the render policy can emit a boundary edge from the
  // input product to that consumer (boundary items have no MachineEdge, since
  // the solver walk terminated upstream of them).
  type BoundaryConsumer = {
    toUnit: RenderUnitId;
    item: ItemId;
    rate: Fraction;
    containerId: ContainerId | undefined;
    // A cycled catalyst charge rather than ordinary consumption. It bypasses
    // every skip rule collectConsumed applies and never takes part in the
    // share split below: the plan draws the whole charge from the boundary.
    catalyst?: true;
    // A target's export: its rate is already the boundary's part, so it is
    // drawn whole too and never takes part in the share split.
    targetExport?: true;
  };
  const drawnWhole = (c: BoundaryConsumer): boolean =>
    c.catalyst === true || c.targetExport === true;
  const boundaryConsumers: BoundaryConsumer[] = [];
  const collectConsumed = (
    toUnit: RenderUnitId,
    itemId: ItemId,
    rate: Fraction,
    containerId: ContainerId | undefined,
  ): void => {
    const item = itemById.get(itemId);
    if (!item) return;
    const supply = supplyTable.supplyOf(itemId);
    // Zero finite supply -> emit nothing (item is fully built internally).
    if (supply !== Infinity && (supply as Fraction).equals(new Fraction(0))) {
      return;
    }
    // Infinity supply with an in-plan producer means the consumer is fed
    // internally; skip the boundary input. Exception: a recapture item, whose
    // byproduct only partially covers demand, so the deficit still draws from
    // the boundary.
    if (supply === Infinity && producedItems.has(itemId)) {
      if (!recaptureItems.has(itemId)) return;
      const recap =
        recapturedByConsumerUnitItem.get(`${toUnit}\0${itemId}`) ??
        new Fraction(0);
      const deficit = rate.sub(recap);
      if (deficit.compare(new Fraction(0)) <= 0) return;
      boundaryConsumers.push({
        toUnit,
        item: itemId,
        rate: deficit,
        containerId,
      });
      return;
    }
    // Finite positive supply -> dual-emit: the boundary input carries the
    // LP-drawn portion (1 - share of demand) alongside the in-graph producer's
    // residual edges. A finite cap whose realized draw is 0 (no boundaryShare
    // entry, or a degenerate share of 1) emits neither the input product nor
    // its boundary edges: forced byproduct production covers the consumption
    // and the unit would be an unjustified zero-rate import.
    // Infinity supply with no in-graph producer -> single boundary emit.
    if (supply !== Infinity) {
      const share = boundaryShare.get(itemId);
      if (share === undefined || share.compare(FRAC_ONE) >= 0) return;
    }
    boundaryConsumers.push({ toUnit, item: itemId, rate, containerId });
  };
  // An SCC unit's consumption comes from its netIO, a recipe unit's from its
  // inputs; the rollup above already holds both, so one loop covers them. A
  // boundary item consumed only by an in-loop recipe still surfaces as an input
  // product this way.
  for (const [unitId, facts] of unitFacts) {
    for (const [item, rate] of facts.consumed) {
      collectConsumed(unitId, item, rate, facts.containerId);
    }
    // Catalysts are boundary supply unconditionally: the machine holds the
    // charge and hands it back, so no producer is ever expanded for it and none
    // of collectConsumed's rules (zero supply, an in-plan producer, a finite cap
    // with no realized draw) can suppress the draw. The rate is the unit's
    // `catalystCharge`, which is per machine rather than per cycle; a unit with
    // no charge (a catalyst-free recipe, or a materialisation with no machine
    // speed to compute one from) draws nothing.
    for (const [item, rate] of facts.catalyst) {
      if (!itemById.has(item)) continue;
      if (rate.compare(new Fraction(0)) <= 0) continue;
      boundaryConsumers.push({
        toUnit: unitId,
        item,
        rate,
        containerId: facts.containerId,
        catalyst: true,
      });
    }
  }

  // What a capped item's LP draw has left once its in-plan consumers take
  // their boundary part, (1 - share) of their demand.
  const drawLeftAfterConsumers = (itemId: ItemId): Fraction => {
    const share = boundaryShare.get(itemId) ?? FRAC_ONE;
    let left = draws.get(itemId) ?? new Fraction(0);
    for (const c of boundaryConsumers) {
      if (c.item !== itemId || drawnWhole(c)) continue;
      left = left.sub(c.rate.mul(FRAC_ONE.sub(share)));
    }
    return left;
  };

  // Boundary target export. The slice of the declared rate that in-plan spare
  // did not cover above arrives from the boundary, so the export is one more
  // loose consumer of the item's ordinary pool. It then draws from the same
  // card as every other consumer (one boundary card per imported item) and the
  // pool topology below applies to it unchanged.
  //
  // A free item (raw:true, or plan:true via an override) builds no LP row, and
  // the solver meets the declared rate with a reported free draw, so the whole
  // slice arrives. A capped item has a row with a bounded draw: the export gets
  // what that draw has left after the in-plan consumers' boundary part, and
  // whatever the draw cannot cover is the LP's deficit, left undelivered.
  //
  //   gas_inert cap 1/2, copper_jar draws 1/4, target 1/4 -> export 1/4
  for (const [outItem, total] of targetRateByItem) {
    if (!itemById.has(outItem)) continue;
    const billed = targetBilledByItem.get(outItem) ?? new Fraction(0);
    let rate = total.sub(billed);
    if (!supplyTable.isFree(outItem)) {
      const left = drawLeftAfterConsumers(outItem);
      if (left.compare(rate) < 0) rate = left;
    }
    if (rate.compare(0) <= 0) continue;
    boundaryConsumers.push({
      toUnit: unitIdForOutputProduct(outItem),
      item: outItem,
      rate,
      containerId: undefined,
      targetExport: true,
    });
  }

  // Precompute realized rates before emitting product units. Each input
  // ProductNode shows its rate as primary chrome; keying is `(itemId,
  // containerId)` so a high-fan-out raw consumed across several blueprint-group
  // containers emits one node per container, each pinned near its consumers.
  //
  // The supply cap is item-level (effectiveSupply is keyed by item). To keep
  // the mass-balance invariant -- split input-rate sums equal the pre-split
  // single-input rate -- compute the cap once per item, then give each
  // (item, container) ProductNode the per-container slice
  //   realizedRate(item, ctr) = consumedSupply(item) * containerDemand(item, ctr)
  //                                                     / totalDemand(item)
  // Per-edge rate inside a container is `c.rate * consumedSupply(item) /
  // totalDemand(item)`, same as the single-node formula; the split just
  // redistributes the same total across more ProductNodes.
  type ConsumerKey = string;
  const consumersByKey = new Map<ConsumerKey, BoundaryConsumer[]>();
  const itemByKey = new Map<ConsumerKey, ItemId>();
  const roleByKey = new Map<ConsumerKey, BoundaryRole>();
  const bucketByKey = new Map<ConsumerKey, BoundaryBucket>();
  // Ordinary consumption and the cycled catalyst charge are accounted
  // separately: only ordinary demand takes the boundary share split, while a
  // catalyst charge is drawn whole. Every rate below (per-edge, per-bucket
  // node, aggregate) is a sum over the same per-consumer rule, so the node
  // chip and its outbound edges can never disagree.
  const ordinaryDemandByItem = new Map<ItemId, Fraction>();
  for (const c of boundaryConsumers) {
    const bucket = bucketFor(c.containerId);
    const role: BoundaryRole = c.catalyst ? "catalyst" : "ordinary";
    const k = boundaryKey(c.item, role, bucket);
    pushInto(consumersByKey, k, c);
    itemByKey.set(k, c.item);
    roleByKey.set(k, role);
    bucketByKey.set(k, bucket);
    if (drawnWhole(c)) continue;
    ordinaryDemandByItem.set(
      c.item,
      (ordinaryDemandByItem.get(c.item) ?? new Fraction(0)).add(c.rate),
    );
  }

  const consumedSupplyByItem = new Map<ItemId, Fraction>();
  for (const [itemId, totalDemand] of ordinaryDemandByItem) {
    if (totalDemand.equals(new Fraction(0))) {
      consumedSupplyByItem.set(itemId, new Fraction(0));
      continue;
    }
    const supply = supplyTable.supplyOf(itemId);
    let consumed: Fraction;
    if (supply === Infinity) {
      consumed = totalDemand;
    } else {
      // Finite positive cap: the boundary supplies exactly the LP draw's
      // fraction of demand, (1 - share). min(cap, totalDemand) is wrong
      // whenever forced internal byproduct production makes the LP draw less
      // than the cap. Items with no share entry (draw 0) never reach here:
      // collectConsumed gates them out of boundaryConsumers.
      const share = boundaryShare.get(itemId) ?? FRAC_ONE;
      consumed = totalDemand.mul(FRAC_ONE.sub(share));
    }
    consumedSupplyByItem.set(itemId, consumed);
  }

  // The rate one consumer's boundary edge carries: a catalyst charge or a
  // target export whole, an ordinary consumer its prorated slice of the
  // realized draw. Multiply before divide to keep precision under exact
  // rationals.
  const edgeRateOf = (c: BoundaryConsumer): Fraction => {
    if (drawnWhole(c)) return c.rate;
    const ordinaryDemand = ordinaryDemandByItem.get(c.item) ?? new Fraction(0);
    if (ordinaryDemand.equals(new Fraction(0))) return new Fraction(0);
    const consumed = consumedSupplyByItem.get(c.item) ?? new Fraction(0);
    return c.rate.mul(consumed).div(ordinaryDemand);
  };

  const realizedRateByKey = new Map<ConsumerKey, Fraction>();
  for (const [key, consumers] of consumersByKey) {
    realizedRateByKey.set(
      key,
      consumers.reduce((acc, c) => acc.add(edgeRateOf(c)), new Fraction(0)),
    );
  }

  // Group keys by pool so the topology decision (single bucket vs aggregate +
  // container fanout slices) is made once per (item, role). An item with one
  // ordinary bucket and one catalyst bucket has one bucket in each pool, so it
  // emits two single-bucket nodes and no aggregate.
  const keysByPool = new Map<PoolKey, ConsumerKey[]>();
  const poolItem = new Map<PoolKey, ItemId>();
  const poolRole = new Map<PoolKey, BoundaryRole>();
  for (const key of consumersByKey.keys()) {
    const itemId = itemByKey.get(key)!;
    const role = roleByKey.get(key)!;
    const pool = poolKey(itemId, role);
    pushInto(keysByPool, pool, key);
    poolItem.set(pool, itemId);
    poolRole.set(pool, role);
  }

  const inputProducts: RenderUnitInputProduct[] = [];
  const emittedKeys = new Set<ConsumerKey>();
  // aggregateIdByPool[pool] is set iff that pool emitted an aggregate node; the
  // edge emission below uses it to wire aggregate -> fanout slices.
  const aggregateIdByPool = new Map<PoolKey, RenderUnitId>();
  const sortedPools = [...keysByPool.keys()].sort();
  for (const pool of sortedPools) {
    const itemId = poolItem.get(pool)!;
    const role = poolRole.get(pool)!;
    const roleField = role === "catalyst" ? ({ role } as const) : {};
    // No target gating here. A target item never suppresses its own input
    // product: every item that reaches this loop was admitted by
    // collectConsumed, which drops zero supply outright, so a target item with
    // no override is raw with unlimited supply and its consumers stay
    // boundary-fed like any other free item (the declared export is one more
    // loose consumer of this pool). An overridden or recapture-deficit target
    // renders BOTH as an input (pinned FIRST) and a target output (pinned
    // LAST): the override path imports a capped portion, the
    // recapture-deficit path draws the demand its target-claimed production
    // cannot feed.
    const ov =
      role === "catalyst"
        ? catalystOverrideByItem.get(itemId)
        : overrideByItem.get(itemId);
    const keys = keysByPool.get(pool)!.slice().sort();

    if (keys.length <= 1) {
      // Single bucket: emit one node with the per-bucket id, no fanout.
      const key = keys[0]!;
      const bucket = bucketByKey.get(key)!;
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      const base: Omit<RenderUnitInputProduct, "rateCap"> = {
        id: unitIdForInputBucket(itemId, role, bucket),
        kind: "inputProduct",
        itemId,
        count: 1,
        rate: rationalToString(realizedRate),
        ...roleField,
      };
      inputProducts.push(
        ov?.ratePerSec !== undefined
          ? { ...base, rateCap: ov.ratePerSec }
          : base,
      );
      emittedKeys.add(key);
      continue;
    }

    // Multiple buckets: emit an aggregate node plus one fanout slice per
    // container bucket. The aggregate carries the pool's rateCap and the
    // total realized rate (loose share included); each slice carries only its
    // per-container rate, so the slice label reads as a tap rather than another
    // item-level cap.
    const aggregateId = unitIdForAggregate(itemId, role);
    aggregateIdByPool.set(pool, aggregateId);
    const aggregateRate = keys.reduce(
      (acc, k) => acc.add(realizedRateByKey.get(k) ?? new Fraction(0)),
      new Fraction(0),
    );
    const aggregateBase: Omit<RenderUnitInputProduct, "rateCap"> = {
      id: aggregateId,
      kind: "inputProduct",
      itemId,
      count: 1,
      rate: rationalToString(aggregateRate),
      isAggregate: true,
      ...roleField,
    };
    inputProducts.push(
      ov?.ratePerSec !== undefined
        ? { ...aggregateBase, rateCap: ov.ratePerSec }
        : aggregateBase,
    );
    for (const key of keys) {
      const bucket = bucketByKey.get(key)!;
      emittedKeys.add(key);
      // The loose bucket gets no card of its own: its consumers hang off the
      // aggregate directly.
      if (bucket.kind !== "container") continue;

      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      inputProducts.push({
        id: unitIdForContainer(itemId, role, bucket.containerId),
        kind: "inputProduct",
        itemId,
        count: 1,
        rate: rationalToString(realizedRate),
        isFanout: true,
        parentRate: rationalToString(aggregateRate),
        ...roleField,
      });
    }
  }

  // Boundary edges connect each emitted input product to its recipe/SCC
  // consumers, and each target recipe unit to the output product. Without
  // them ELK has no signal that product nodes sit upstream or downstream of
  // recipes, so layerConstraint=FIRST/LAST collapses them into the recipes'
  // layers (boundary nodes overlap the leftmost/rightmost recipe column).
  //
  // Per-consumer flow conservation: when an in-graph producer and a boundary
  // input feed the same item, the boundary edge to each consumer carries the
  // consumer's prorated share of the cap, not the full demand. Otherwise
  // sum(producer edges -> c) + (boundary edge -> c) overshoots c's per-input
  // demand.
  //
  // Edge rate per consumer = c.rate * (consumedSupply / totalDemand), reusing
  // the per-item consumedSupply from the realized-rate pass above. Cases:
  //  - effectiveSupply === Infinity: producer not in graph, consumedSupply
  //    collapses to totalDemand, edge rate = c.rate (single emit preserved).
  //  - finite cap, LP draw covers all demand (share 0): consumedSupply =
  //    totalDemand, edge rate = c.rate; the in-graph producer runs at 0 and
  //    emits no unit.
  //  - finite cap, partial draw (0 < share < 1): consumedSupply =
  //    totalDemand * (1 - share); each consumer's boundary edge plus its
  //    residual producer edges (computeEdgeRates nets demand by share) sum to
  //    its full per-item demand as exact rationals.
  //  - finite cap, draw 0: gated in collectConsumed (no input product, no
  //    boundary edges).
  //  - effectiveSupply == 0: gated upstream (no input product emitted).
  for (const [key, consumers] of consumersByKey) {
    if (!emittedKeys.has(key)) continue;
    const itemId = itemByKey.get(key)!;
    const role = roleByKey.get(key)!;
    const bucket = bucketByKey.get(key)!;
    const item = itemById.get(itemId);
    if (!item) continue;
    // With an aggregate, a container bucket's consumer edges originate from its
    // fanout slice and the loose bucket's originate from the aggregate itself;
    // without one, from the single-bucket node (which is either the container
    // card or the bare `u:in:<item>` / `u:cat:<item>` card). Every catalyst
    // edge leaves the catalyst pool's node, never the ordinary one.
    const fromUnit = unitIdForInputBucket(itemId, role, bucket);
    // Avoid 0/0 when every ordinary consumer's rate collapses to zero. A
    // catalyst consumer or a target export takes no share of that demand, so
    // it is still drawn (both are pushed only at a positive rate).
    const noOrdinaryDemand = (
      ordinaryDemandByItem.get(itemId) ?? new Fraction(0)
    ).equals(new Fraction(0));
    for (const c of consumers) {
      if (noOrdinaryDemand && !drawnWhole(c)) continue;
      const rate = edgeRateOf(c);
      boundaryEdges.push({
        fromUnit,
        toUnit: c.toUnit,
        item: itemId,
        rate,
        transportKind: item.transportKind,
        ...(c.catalyst ? { toPortKind: "catalyst" as const } : {}),
        ...(role === "catalyst" ? { fromPool: "catalyst" as const } : {}),
      });
    }
  }

  // Aggregate -> fanout slice edges: one per slice per aggregate-emitting pool,
  // carrying the slice's realized rate. Emitted after the per-bucket consumer
  // edges so aggregate edges always trail their pool's consumer edges (stable
  // ordering).
  for (const pool of sortedPools) {
    const aggregateId = aggregateIdByPool.get(pool);
    if (aggregateId === undefined) continue;
    const itemId = poolItem.get(pool)!;
    const role = poolRole.get(pool)!;
    const item = itemById.get(itemId);
    if (!item) continue;
    const keys = keysByPool.get(pool)!.slice().sort();
    for (const key of keys) {
      const bucket = bucketByKey.get(key)!;
      if (bucket.kind !== "container") continue;

      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      boundaryEdges.push({
        fromUnit: aggregateId,
        toUnit: unitIdForContainer(itemId, role, bucket.containerId),
        item: itemId,
        rate: realizedRate,
        transportKind: item.transportKind,
        ...(role === "catalyst" ? { fromPool: "catalyst" as const } : {}),
      });
    }
  }

  for (const e of targetEdges) boundaryEdges.push(e);

  // Surplus output products: any item produced beyond its outgoing consumption
  // (internal MachineEdges + the target output edges above) surfaces as an amber
  // outputProduct on the rightmost layer. Hit whenever a recipe ships byproducts
  // (e.g. copper_nugget's liquid_sewage). Without it, byproducts vanish from the
  // canvas.
  const surplusByItem = new Map<ItemId, Fraction>();
  const surplusContributors = new Map<
    ItemId,
    Array<{ unitId: RenderUnitId; rate: Fraction }>
  >();
  // Production and outgoing flow are both whole-unit quantities already -- the
  // rollup at the top of this function and outgoingByUnitItem above -- and the
  // difference is taken at that level on purpose. Differencing per machine vertex
  // and keeping only positive residuals turned an uneven split of a unit's
  // outgoing edges (a split SCC member's torn arcs, a per-machine consumer
  // wiring) into a phantom surplus and clamped away the matching deficits.
  //
  // Emit surplus = the genuine overproduction per item, exactly what
  // checkBoundaryProductsJustified validates: production - consumption - demand
  // over the whole plan. Vertex execution rates sum to the LP rates per the
  // machine-count invariant, so this matches the checker's LP-based formula.
  // Differencing per render unit and keeping only positive residuals overstated
  // this whenever an item's production is split across units -- a loop recipe
  // torn across SCC sibling units, or a target item co-produced by an SCC and a
  // separate leaf recipe -- because the matching per-unit deficit was clamped
  // away, surfacing a phantom amber surplus. Per-unit positive residuals now only
  // pick which producing units the surplus edges emanate from; the emitted total
  // can never exceed the genuine surplus.
  const producedByItem = new Map<ItemId, Fraction>();
  const positivesByItem = new Map<
    ItemId,
    Array<{ unitId: RenderUnitId; rate: Fraction }>
  >();
  for (const [unitId, facts] of unitFacts) {
    for (const [item, produced] of facts.produced) {
      addRate(producedByItem, item, produced);
      const residual = produced.sub(
        outgoingByUnitItem.get(unitItemKey(unitId, item)) ?? new Fraction(0),
      );
      if (residual.compare(0) > 0) {
        pushInto(positivesByItem, item, { unitId, rate: residual });
      }
    }
  }
  const consumedByItem = new Map<ItemId, Fraction>();
  for (const facts of unitFacts.values()) {
    for (const [item, rate] of facts.consumed) {
      addRate(consumedByItem, item, rate);
    }
  }
  // REL_TOL is checkBoundaryProductsJustified's tolerance: a surplus within
  // max(scaleFloor,|magnitude|)*REL_TOL of zero is a degenerate-rate / solver
  // residual, not a genuine byproduct, and the checker would flag it as an
  // RF-1 phantom. scaleFloor is the same plan-magnitude tolerance floor the
  // checkers use; suppressing with an absolute floor of 1 would swallow every
  // byproduct of a sub-unit plan and trip the production-vanish checker.
  const scaleFloor = toleranceScaleFloor(
    new Map(
      [...targetRateByItem].map(([item, rate]) => [item, rate.valueOf()]),
    ),
  );
  for (const [item, produced] of producedByItem) {
    const genuine = produced
      .sub(consumedByItem.get(item) ?? new Fraction(0))
      .sub(targetRateByItem.get(item) ?? new Fraction(0));
    const genuineVal = genuine.valueOf();
    if (genuineVal <= relSlack(scaleFloor, Math.abs(genuineVal))) continue;
    const positives = positivesByItem.get(item) ?? [];
    const positiveSum = positives.reduce(
      (acc, p) => acc.add(p.rate),
      new Fraction(0),
    );
    surplusByItem.set(item, genuine);
    const arr = surplusContributors.get(item) ?? [];
    // Attribute the surplus edges to the over-producing units (positive
    // residual), scaled to sum to the genuine surplus. A genuine surplus has at
    // least one such unit; recapture-netted items can have none, so fall back to
    // producer share.
    if (positiveSum.compare(0) > 0) {
      for (const p of positives) {
        const rate = genuine.mul(p.rate).div(positiveSum);
        if (rate.compare(0) > 0) arr.push({ unitId: p.unitId, rate });
      }
    } else {
      for (const [unitId, facts] of unitFacts) {
        const prod = facts.produced.get(item);
        if (prod === undefined) continue;
        const rate = genuine.mul(prod).div(produced);
        if (rate.compare(0) > 0) arr.push({ unitId, rate });
      }
    }
    surplusContributors.set(item, arr);
  }
  const sortedSurplusItems = [...surplusByItem.keys()].sort();
  for (const item of sortedSurplusItems) {
    const totalSurplus = surplusByItem.get(item)!;
    const itemMeta = itemById.get(item);
    if (!itemMeta) continue;
    const surplusUnitId = unitIdForSurplus(item);
    outputProducts.push({
      id: surplusUnitId,
      kind: "outputProduct",
      itemId: item,
      count: 1,
      rate: rationalToString(totalSurplus),
      flavor: "surplus",
    });
    for (const c of surplusContributors.get(item) ?? []) {
      boundaryEdges.push({
        fromUnit: c.unitId,
        toUnit: surplusUnitId,
        item,
        rate: c.rate,
        transportKind: itemMeta.transportKind,
      });
    }
  }

  // An under-delivered target card states what actually arrives beside its
  // declared rate. The flag is the shortfall strip's own predicate, so the card
  // and the strip always name the same items; a fed target carries nothing.
  const shortItems = new Set(
    targetOutputShortfalls({ edges: boundaryEdges }, targets).map(
      (s) => s.item,
    ),
  );
  for (const out of outputProducts) {
    if (out.flavor !== "target" || !shortItems.has(out.itemId)) continue;
    const delivered = boundaryEdges
      .filter((e) => e.toUnit === out.id && e.item === out.itemId)
      .reduce((acc, e) => acc.add(e.rate), new Fraction(0));
    out.delivered = rationalToString(delivered);
  }

  return { inputProducts, outputProducts, boundaryEdges };
}
