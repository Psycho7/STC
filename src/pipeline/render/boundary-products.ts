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
import { effectiveSupply } from "../../solver/effectiveSupply";
import { toleranceScaleFloor } from "../../solver/lp";
import type { Target } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { rationalFromString, rationalToString } from "./rational";
import { REL_TOL } from "./invariants";

// When a raw item is consumed across several buckets, the renderer emits an
// aggregate input node `u:in:<item>` fanning out to per-bucket slice nodes. A
// bucket is either a real container (`u:in:<item>:<container>`) or a single
// loose consumer with no container (a "tap": `u:in:<item>:tap:<consumerUnit>`).
// Loose consumers no longer share one bucket; each gets its own tap so a later
// layout pass can pin it next to its consumer. Each slice carries its own
// consumer edges; the aggregate carries the item-level rateCap and the sum of
// slice rates. When the item is consumed within a single bucket (one container,
// or a lone loose consumer) the renderer emits one node with the `u:in:<item>`
// id (or `u:in:<item>:<ctr>` when that bucket is a real container), keeping
// unclustered plans byte-identical to the older single-node shape.
type BoundaryBucket =
  | { kind: "container"; containerId: ContainerId }
  | { kind: "tap"; consumerUnit: RenderUnitId };
const bucketFor = (
  containerId: ContainerId | undefined,
  consumerUnit: RenderUnitId,
): BoundaryBucket =>
  containerId === undefined
    ? { kind: "tap", consumerUnit }
    : { kind: "container", containerId };
const unitIdForInputAggregate = (item: ItemId): RenderUnitId => `u:in:${item}`;
const unitIdForInputFanout = (
  item: ItemId,
  bucket: BoundaryBucket,
): RenderUnitId =>
  bucket.kind === "container"
    ? `u:in:${item}:${bucket.containerId}`
    : `u:in:${item}:tap:${bucket.consumerUnit}`;
const unitIdForInputSingleBucket = (
  item: ItemId,
  bucket: BoundaryBucket,
): RenderUnitId =>
  bucket.kind === "container"
    ? `u:in:${item}:${bucket.containerId}`
    : `u:in:${item}`;
const unitIdForOutputProduct = (item: ItemId): RenderUnitId => `u:out:${item}`;
const boundaryKey = (item: ItemId, bucket: BoundaryBucket): string =>
  bucket.kind === "container"
    ? `${item}\0c\0${bucket.containerId}`
    : `${item}\0t\0${bucket.consumerUnit}`;

const FRAC_ONE = new Fraction(1);

export type DeriveBoundaryProductsInput = {
  machineGraph: MachineGraph;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<ItemOverride>;
  itemById: ReadonlyMap<ItemId, Item>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  pack: Pick<RecipePack, "items">;
  unitIdByVertex: ReadonlyMap<MachineVertexId, RenderUnitId>;
  // Per finite-capped item the LP drew from the boundary: the fraction of its
  // consumption in-graph producers cover (boundaryResidualShare). Missing
  // entries mean realized draw 0: the boundary contributes nothing and no
  // input product is emitted for the item.
  boundaryShare: ReadonlyMap<ItemId, Fraction>;
};

export type DeriveBoundaryProductsResult = {
  inputProducts: RenderUnitInputProduct[];
  outputProducts: RenderUnitOutputProduct[];
  boundaryEdges: RenderEdge[];
};

/**
 * Derives boundary input/output product units and the edges connecting them to
 * in-graph machine units. The rules once lived inline in `NoFoldRender`: target
 * items become output products (at their target rate); items consumed in the
 * plan with nonzero `effectiveSupply` become input products (with a rate cap
 * when overridden); surplus byproducts become amber output products.
 * Per-consumer flow conservation holds when a boundary input coexists with an
 * in-graph producer for the same item.
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
    pack,
    unitIdByVertex,
    boundaryShare,
  } = args;

  const boundaryEdges: RenderEdge[] = [];

  // ----- Boundary product units ----------------------------------------------
  //
  // Output products: one per distinct target item. The target item is the first
  // output of the target recipe (the solver pins execution rate via
  // recipe.out[0]). When two targets share an out-item (e.g. distinct recipes
  // both producing `carbon_mtl`), their rates sum so the output product holds
  // total demand instead of dropping the later target.
  const targetRateByItem = new Map<ItemId, Fraction>();
  for (const t of targets) {
    const recipe = recipeById.get(t.recipeId);
    if (!recipe) continue;
    const outItem = recipe.out[0]?.item;
    if (outItem === undefined) continue;
    const rate = rationalFromString(t.ratePerSec);
    const existing = targetRateByItem.get(outItem);
    targetRateByItem.set(outItem, existing ? existing.add(rate) : rate);
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
  // emits nothing (forces internal build); target items win over input products
  // of the same item. Precedence lives in `effectiveSupply`; this code never
  // inspects `raw` / `plan` directly.
  const overrideByItem = new Map<ItemId, (typeof itemOverrides)[number]>();
  for (const ov of itemOverrides) overrideByItem.set(ov.itemId, ov);

  const supplyMemo = new Map<ItemId, Fraction | typeof Infinity>();
  const supplyFor = (id: ItemId): Fraction | typeof Infinity => {
    const cached = supplyMemo.get(id);
    if (cached !== undefined) return cached;
    const v = effectiveSupply(id, pack, [...itemOverrides]);
    supplyMemo.set(id, v);
    return v;
  };

  const producedItems = new Set<ItemId>();
  for (const v of machineGraph.vertices) {
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      for (const stoich of recipe.out) producedItems.add(stoich.item);
    } else if (isMachineSccVertex(v)) {
      for (const p of v.netIO) {
        if (p.direction === "out") producedItems.add(p.item);
      }
    }
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
    vertexId: MachineVertexId;
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
    const arr = map.get(item) ?? [];
    arr.push(end);
    map.set(item, arr);
  };
  for (const v of machineGraph.vertices) {
    const unitId = unitIdByVertex.get(v.id);
    if (unitId === undefined) continue;
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      for (const o of recipe.out)
        pushRecap(recapProducers, o.item, {
          vertexId: v.id,
          unitId,
          rate: v.executionRate.mul(new Fraction(o.qty)),
        });
      for (const inp of recipe.in)
        pushRecap(recapConsumers, inp.item, {
          vertexId: v.id,
          unitId,
          rate: v.executionRate.mul(new Fraction(inp.qty)),
        });
    } else if (isMachineSccVertex(v)) {
      for (const p of v.netIO) {
        const end = { vertexId: v.id, unitId, rate: p.rate };
        if (p.direction === "out") pushRecap(recapProducers, p.item, end);
        else pushRecap(recapConsumers, p.item, end);
      }
    }
  }

  // recaptureItems: items this pass reconciles. recapturedByConsumerVertexItem:
  // demand each consumer vertex gets internally (collectConsumed draws only the
  // deficit from the boundary). recaptureSendByVertexItem: production each
  // producer vertex routes out (the surplus pass nets it instead of flagging a
  // phantom surplus).
  const recaptureItems = new Set<ItemId>();
  const recapturedByConsumerVertexItem = new Map<string, Fraction>();
  const recaptureSendByVertexItem = new Map<string, Fraction>();
  const recaptureEdges: RenderEdge[] = [];
  for (const [itemId, producers] of recapProducers) {
    if (machineEdgeItems.has(itemId)) continue;
    if (supplyFor(itemId) !== Infinity) continue;
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
      const key = `${c.vertexId}\0${itemId}`;
      const recapC = c.rate.mul(recaptured).div(totalDemand);
      recapturedByConsumerVertexItem.set(
        key,
        (recapturedByConsumerVertexItem.get(key) ?? new Fraction(0)).add(
          recapC,
        ),
      );
    }
    for (const p of producers) {
      const key = `${p.vertexId}\0${itemId}`;
      const sendP = p.rate.mul(recaptured).div(totalProd);
      recaptureSendByVertexItem.set(
        key,
        (recaptureSendByVertexItem.get(key) ?? new Fraction(0)).add(sendP),
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
  };
  const boundaryConsumers: BoundaryConsumer[] = [];
  const collectConsumed = (
    vertexId: MachineVertexId,
    itemId: ItemId,
    toUnit: RenderUnitId,
    rate: Fraction,
    containerId: ContainerId | undefined,
  ): void => {
    const item = itemById.get(itemId);
    if (!item) return;
    const supply = supplyFor(itemId);
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
        recapturedByConsumerVertexItem.get(`${vertexId}\0${itemId}`) ??
        new Fraction(0);
      const deficit = rate.sub(recap);
      if (deficit.compare(new Fraction(0)) <= 0) return;
      boundaryConsumers.push({ toUnit, item: itemId, rate: deficit, containerId });
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
  for (const v of machineGraph.vertices) {
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      const toUnit = unitIdByVertex.get(v.id);
      if (toUnit === undefined) continue;
      for (const stoich of recipe.in) {
        const rate = v.executionRate.mul(new Fraction(stoich.qty));
        collectConsumed(v.id, stoich.item, toUnit, rate, v.containerId);
      }
    } else if (isMachineSccVertex(v)) {
      // SCC vertices expose boundary I/O via netIO; a boundary item consumed
      // only by an in-loop recipe must still surface as an input product.
      const toUnit = unitIdByVertex.get(v.id);
      if (toUnit === undefined) continue;
      for (const p of v.netIO) {
        if (p.direction === "in")
          collectConsumed(v.id, p.item, toUnit, p.rate, v.containerId);
      }
    }
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
  const bucketByKey = new Map<ConsumerKey, BoundaryBucket>();
  const totalDemandByItem = new Map<ItemId, Fraction>();
  for (const c of boundaryConsumers) {
    const bucket = bucketFor(c.containerId, c.toUnit);
    const k = boundaryKey(c.item, bucket);
    const arr = consumersByKey.get(k) ?? [];
    arr.push(c);
    consumersByKey.set(k, arr);
    itemByKey.set(k, c.item);
    bucketByKey.set(k, bucket);
    totalDemandByItem.set(
      c.item,
      (totalDemandByItem.get(c.item) ?? new Fraction(0)).add(c.rate),
    );
  }

  const consumedSupplyByItem = new Map<ItemId, Fraction>();
  for (const [itemId, totalDemand] of totalDemandByItem) {
    if (totalDemand.equals(new Fraction(0))) {
      consumedSupplyByItem.set(itemId, new Fraction(0));
      continue;
    }
    const supply = supplyFor(itemId);
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

  const realizedRateByKey = new Map<ConsumerKey, Fraction>();
  for (const [key, consumers] of consumersByKey) {
    const itemId = itemByKey.get(key)!;
    const totalDemand = totalDemandByItem.get(itemId)!;
    if (totalDemand.equals(new Fraction(0))) {
      realizedRateByKey.set(key, new Fraction(0));
      continue;
    }
    const consumed = consumedSupplyByItem.get(itemId)!;
    const containerDemand = consumers.reduce(
      (acc, c) => acc.add(c.rate),
      new Fraction(0),
    );
    realizedRateByKey.set(
      key,
      consumed.mul(containerDemand).div(totalDemand),
    );
  }

  // Group keys by item so the topology decision (single bucket vs aggregate +
  // fanout slices) is made once per item.
  const keysByItem = new Map<ItemId, ConsumerKey[]>();
  for (const key of consumersByKey.keys()) {
    const itemId = itemByKey.get(key)!;
    const arr = keysByItem.get(itemId) ?? [];
    arr.push(key);
    keysByItem.set(itemId, arr);
  }

  const inputProducts: RenderUnitInputProduct[] = [];
  const emittedKeys = new Set<ConsumerKey>();
  // aggregateIdByItem[item] is set iff that item emitted an aggregate node; the
  // edge emission below uses it to wire aggregate -> fanout slices.
  const aggregateIdByItem = new Map<ItemId, RenderUnitId>();
  const sortedItems = [...keysByItem.keys()].sort();
  for (const itemId of sortedItems) {
    // Target trumps boundary, except when the item has an explicit
    // itemOverride OR a recapture deficit. In both cases the item renders BOTH
    // as an input (pinned FIRST) and a target output (pinned LAST): the
    // override path imports a capped portion, the recapture-deficit path
    // (raw-also-target) draws the demand its target-claimed production cannot
    // feed. Item-level, so it short-circuits all keys for the item.
    if (
      targetItemSet.has(itemId) &&
      !overrideByItem.has(itemId) &&
      !recaptureItems.has(itemId)
    )
      continue;
    const ov = overrideByItem.get(itemId);
    const keys = keysByItem.get(itemId)!.slice().sort();

    if (keys.length <= 1) {
      // Single bucket: emit one node with the per-bucket id, no fanout.
      const key = keys[0]!;
      const bucket = bucketByKey.get(key)!;
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      const base: Omit<RenderUnitInputProduct, "rateCap"> = {
        id: unitIdForInputSingleBucket(itemId, bucket),
        kind: "inputProduct",
        itemId,
        count: 1,
        rate: rationalToString(realizedRate),
      };
      inputProducts.push(
        ov?.ratePerSec !== undefined
          ? { ...base, rateCap: ov.ratePerSec }
          : base,
      );
      emittedKeys.add(key);
      continue;
    }

    // Multiple buckets: emit an aggregate node plus one fanout slice per bucket.
    // The aggregate carries the item-level rateCap and total realized rate; each
    // slice carries only its per-container rate, so the slice label reads as a
    // tap rather than another item-level cap.
    const aggregateId = unitIdForInputAggregate(itemId);
    aggregateIdByItem.set(itemId, aggregateId);
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
    };
    inputProducts.push(
      ov?.ratePerSec !== undefined
        ? { ...aggregateBase, rateCap: ov.ratePerSec }
        : aggregateBase,
    );
    for (const key of keys) {
      const bucket = bucketByKey.get(key)!;
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      inputProducts.push({
        id: unitIdForInputFanout(itemId, bucket),
        kind: "inputProduct",
        itemId,
        count: 1,
        rate: rationalToString(realizedRate),
        isFanout: true,
      });
      emittedKeys.add(key);
    }
  }

  // Boundary edges connect each emitted input product to its recipe/SCC
  // consumers, and each target recipe's stamps to the output product. Without
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
    const bucket = bucketByKey.get(key)!;
    const item = itemById.get(itemId);
    if (!item) continue;
    const totalDemand = totalDemandByItem.get(itemId)!;
    // Avoid 0/0 if all consumer rates collapse to zero.
    if (totalDemand.equals(new Fraction(0))) continue;
    const consumedSupply = consumedSupplyByItem.get(itemId)!;
    // With an aggregate, per-bucket consumer edges originate from the fanout
    // slice; otherwise from the single-bucket node.
    const fromUnit = aggregateIdByItem.has(itemId)
      ? unitIdForInputFanout(itemId, bucket)
      : unitIdForInputSingleBucket(itemId, bucket);
    for (const c of consumers) {
      // Multiply before divide to keep precision under exact rationals.
      const rate = c.rate.mul(consumedSupply).div(totalDemand);
      boundaryEdges.push({
        fromUnit,
        toUnit: c.toUnit,
        item: itemId,
        rate,
        transportKind: item.transportKind,
      });
    }
  }

  // Aggregate -> fanout slice edges: one per slice per aggregate-emitting item,
  // carrying the slice's realized rate. Emitted after the per-bucket consumer
  // edges so aggregate edges always trail their item's consumer edges (stable
  // ordering).
  for (const itemId of sortedItems) {
    const aggregateId = aggregateIdByItem.get(itemId);
    if (aggregateId === undefined) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const keys = keysByItem.get(itemId)!.slice().sort();
    for (const key of keys) {
      const bucket = bucketByKey.get(key)!;
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      boundaryEdges.push({
        fromUnit: aggregateId,
        toUnit: unitIdForInputFanout(itemId, bucket),
        item: itemId,
        rate: realizedRate,
        transportKind: item.transportKind,
      });
    }
  }

  // Output boundary edges: each target-recipe replica's per-item spare =
  // produced - outgoing machine edges for that item. Replicas with positive
  // spare get a target edge; the declared rate splits across them in proportion
  // to spare. For a leaf target recipe this collapses to T/N per stamp: every
  // replica has full spare, and equal spare yields equal per-edge rates. For a
  // target inside a recycling loop (or feeding internal consumers), the rule
  // routes the declared net rate to whatever spare exists; a purely-internal
  // replica (spare <= 0) emits no target edge and the surplus pass sees no
  // leftover production from it.
  //
  // outgoingRateByVertexItem is built once here and reused by the surplus pass.
  // Both passes need the post-target-emission view of outgoing flow so the same
  // production is not counted as both delivered (to the target port) and
  // surplus.
  const outgoingRateByVertexItem = new Map<string, Fraction>();
  const addOutgoing = (
    vertexId: MachineVertexId,
    item: ItemId,
    rate: Fraction,
  ): void => {
    const key = `${vertexId}\0${item}`;
    outgoingRateByVertexItem.set(
      key,
      (outgoingRateByVertexItem.get(key) ?? new Fraction(0)).add(rate),
    );
  };
  for (const e of machineGraph.edges) addOutgoing(e.from, e.item, e.rate);
  // Recapture edges route byproduct production to in-plan consumers; count them
  // as outgoing so the surplus pass nets the recaptured amount.
  for (const [key, rate] of recaptureSendByVertexItem) {
    const sep = key.indexOf("\0");
    addOutgoing(key.slice(0, sep) as MachineVertexId, key.slice(sep + 1), rate);
  }

  type TargetUnitSpare = {
    unitId: RenderUnitId;
    vertexId: MachineVertexId;
    spare: Fraction;
  };
  // Aggregate target-output produced and outgoing flow per (render unit, item)
  // BEFORE differencing, then take the spare once at the unit level. A folded
  // unit's machine vertices each carry only a per-machine slice of the unit's
  // outgoing edges, and the per-stamp consumer wiring lands offsetting +/-
  // residuals across those stamps. Differencing per machine vertex (then keeping
  // only positive residuals) discards a stamp's deficit and inflates the unit's
  // apparent spare, so the proportional split below over-feeds it past its
  // production. Aggregating to the unit -- the level a recipe is drawn at -- nets
  // the slices so only genuine whole-unit spare reaches the target output. This
  // mirrors the surplus pass directly below; the two passes must agree.
  //
  // Collect from EVERY machine vertex producing target item X, not just the
  // target-recipe stamps. When an SCC target recipe co-produces the looped item
  // with a leaf recipe (e.g. iron_nugget from both iron_nugget-iron_ore and
  // iron_nugget-iron_powder), the leaf's spare must also reach the target output
  // unit, or the target edge is under-fed and the leaf's spare becomes a phantom
  // surplus. Iterating all output stoich entries (X may be a co-product, not the
  // primary output) captures both producers; the proportional split then routes
  // the declared rate across pooled spare.
  const targetUnitItemKey = (unitId: RenderUnitId, item: ItemId): string =>
    `${unitId}\0${item}`;
  const targetProducedByUnitItem = new Map<string, Fraction>();
  const targetOutgoingByUnitItem = new Map<string, Fraction>();
  const targetVertexByUnitItem = new Map<string, MachineVertexId>();
  for (const v of machineGraph.vertices) {
    if (!isMachineRecipeVertex(v)) continue;
    const recipe = recipeById.get(v.recipeId);
    if (!recipe) continue;
    const unitId = unitIdByVertex.get(v.id);
    if (unitId === undefined) continue;
    for (const outStoich of recipe.out) {
      const outItem = outStoich.item;
      if (!targetItemSet.has(outItem)) continue;
      const produced = v.executionRate.mul(new Fraction(outStoich.qty));
      const outgoing =
        outgoingRateByVertexItem.get(`${v.id}\0${outItem}`) ?? new Fraction(0);
      const k = targetUnitItemKey(unitId, outItem);
      targetProducedByUnitItem.set(
        k,
        (targetProducedByUnitItem.get(k) ?? new Fraction(0)).add(produced),
      );
      targetOutgoingByUnitItem.set(
        k,
        (targetOutgoingByUnitItem.get(k) ?? new Fraction(0)).add(outgoing),
      );
      // Any vertex of the unit serves as the addOutgoing key: the surplus pass
      // rolls outgoingRateByVertexItem up to the unit, so only the per-unit total
      // matters there.
      if (!targetVertexByUnitItem.has(k)) targetVertexByUnitItem.set(k, v.id);
    }
  }
  const unitsByTargetOutItem = new Map<ItemId, TargetUnitSpare[]>();
  for (const [k, produced] of targetProducedByUnitItem) {
    const sep = k.indexOf("\0");
    const unitId = k.slice(0, sep) as RenderUnitId;
    const outItem = k.slice(sep + 1);
    const vertexId = targetVertexByUnitItem.get(k)!;
    const outgoing = targetOutgoingByUnitItem.get(k) ?? new Fraction(0);
    const spare = produced.sub(outgoing);
    if (spare.compare(0) <= 0) continue;
    const arr = unitsByTargetOutItem.get(outItem) ?? [];
    arr.push({ unitId, vertexId, spare });
    unitsByTargetOutItem.set(outItem, arr);
  }
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
    for (const u of units) {
      const rate = u.spare.mul(distributed).div(totalSpare);
      boundaryEdges.push({
        fromUnit: u.unitId,
        toUnit: unitIdForOutputProduct(outItem),
        item: outItem,
        rate,
        transportKind: item.transportKind,
      });
      addOutgoing(u.vertexId, outItem, rate);
    }
  }

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
  // Aggregate production and outgoing flow per (renderUnit, item) BEFORE
  // differencing. A folded unit's machine vertices each carry only a per-machine
  // slice of the unit's outgoing edges, and a split SCC member's torn-arc edges
  // land unevenly across those machines. Differencing per machine vertex (then
  // keeping only positive residuals) turns that uneven split into a phantom
  // surplus and drops the matching per-machine deficits. Aggregating to the unit
  // -- the level a recipe is drawn at -- nets the slices so only genuine
  // whole-unit overproduction surfaces.
  const producedByUnitItem = new Map<string, Fraction>();
  const unitItemKey = (unitId: RenderUnitId, item: ItemId): string =>
    `${unitId}\0${item}`;
  const addProduced = (
    unitId: RenderUnitId,
    item: ItemId,
    qty: Fraction,
  ): void => {
    const k = unitItemKey(unitId, item);
    producedByUnitItem.set(k, (producedByUnitItem.get(k) ?? new Fraction(0)).add(qty));
  };
  for (const v of machineGraph.vertices) {
    const unitId = unitIdByVertex.get(v.id);
    if (unitId === undefined) continue;
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      for (const stoich of recipe.out)
        addProduced(unitId, stoich.item, v.executionRate.mul(new Fraction(stoich.qty)));
    } else if (isMachineSccVertex(v)) {
      for (const p of v.netIO)
        if (p.direction === "out") addProduced(unitId, p.item, p.rate);
    }
  }
  // Roll per-vertex outgoing totals (machine + target + recapture edges) up to
  // their render unit, same key space.
  const outgoingByUnitItem = new Map<string, Fraction>();
  for (const [key, rate] of outgoingRateByVertexItem) {
    const sep = key.indexOf("\0");
    const vId = key.slice(0, sep) as MachineVertexId;
    const item = key.slice(sep + 1);
    const unitId = unitIdByVertex.get(vId);
    if (unitId === undefined) continue;
    const k = unitItemKey(unitId, item);
    outgoingByUnitItem.set(k, (outgoingByUnitItem.get(k) ?? new Fraction(0)).add(rate));
  }
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
  for (const [key, produced] of producedByUnitItem) {
    const sep = key.indexOf("\0");
    const unitId = key.slice(0, sep) as RenderUnitId;
    const item = key.slice(sep + 1);
    producedByItem.set(
      item,
      (producedByItem.get(item) ?? new Fraction(0)).add(produced),
    );
    const residual = produced.sub(outgoingByUnitItem.get(key) ?? new Fraction(0));
    if (residual.compare(0) > 0) {
      const arr = positivesByItem.get(item) ?? [];
      arr.push({ unitId, rate: residual });
      positivesByItem.set(item, arr);
    }
  }
  const consumedByItem = new Map<ItemId, Fraction>();
  for (const v of machineGraph.vertices) {
    if (isMachineRecipeVertex(v)) {
      const recipe = recipeById.get(v.recipeId);
      if (!recipe) continue;
      for (const inp of recipe.in)
        consumedByItem.set(
          inp.item,
          (consumedByItem.get(inp.item) ?? new Fraction(0)).add(
            v.executionRate.mul(new Fraction(inp.qty)),
          ),
        );
    } else if (isMachineSccVertex(v)) {
      for (const p of v.netIO)
        if (p.direction === "in")
          consumedByItem.set(
            p.item,
            (consumedByItem.get(p.item) ?? new Fraction(0)).add(p.rate),
          );
    }
  }
  // REL_TOL is checkBoundaryProductsJustified's tolerance: a surplus within
  // max(scaleFloor,|magnitude|)*REL_TOL of zero is a degenerate-rate / solver
  // residual, not a genuine byproduct, and the checker would flag it as an
  // RF-1 phantom. scaleFloor is the same plan-magnitude tolerance floor the
  // checkers use; suppressing with an absolute floor of 1 would swallow every
  // byproduct of a sub-unit plan and trip the production-vanish checker.
  const scaleFloor = toleranceScaleFloor(
    new Map([...targetRateByItem].map(([item, rate]) => [item, rate.valueOf()])),
  );
  for (const [item, produced] of producedByItem) {
    const genuine = produced
      .sub(consumedByItem.get(item) ?? new Fraction(0))
      .sub(targetRateByItem.get(item) ?? new Fraction(0));
    const genuineVal = genuine.valueOf();
    if (genuineVal <= Math.max(scaleFloor, Math.abs(genuineVal)) * REL_TOL)
      continue;
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
      for (const [key, prod] of producedByUnitItem) {
        const sep = key.indexOf("\0");
        if (key.slice(sep + 1) !== item) continue;
        const rate = genuine.mul(prod).div(produced);
        if (rate.compare(0) > 0)
          arr.push({ unitId: key.slice(0, sep) as RenderUnitId, rate });
      }
    }
    surplusContributors.set(item, arr);
  }
  const sortedSurplusItems = [...surplusByItem.keys()].sort();
  for (const item of sortedSurplusItems) {
    const totalSurplus = surplusByItem.get(item)!;
    const itemMeta = itemById.get(item);
    if (!itemMeta) continue;
    const surplusUnitId: RenderUnitId = `u:surplus:${item}`;
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

  return { inputProducts, outputProducts, boundaryEdges };
}
