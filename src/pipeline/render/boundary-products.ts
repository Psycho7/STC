import Fraction from "fraction.js";
import type {
  ContainerId,
  ItemId,
  MachineGraph,
  MachineRecipeVertex,
  MachineVertexId,
  RecipeId,
  RenderEdge,
  RenderUnitId,
  RenderUnitInputProduct,
  RenderUnitOutputProduct,
} from "../types";
import { isMachineRecipeVertex, isMachineSccVertex } from "../types";
import { effectiveSupply } from "../../solver/effectiveSupply";
import type { Target } from "../../data/targets";
import type { ItemOverride } from "../../data/plan";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { rationalFromString, rationalToString } from "./rational";

// When a raw item is consumed across multiple distinct containers, the
// renderer emits an aggregate input node `u:in:<item>` that fans out to
// per-container slice nodes (`u:in:<item>:<container>` for clustered consumers;
// `u:in:<item>:loose` for consumers with no container). Each slice carries the
// edges to its own consumers; the aggregate carries the item-level rateCap and
// the sum of slice rates. When the item is consumed within a single bucket
// (one container only, or all loose) the renderer emits one node with the
// legacy `u:in:<item>` id (or `u:in:<item>:<ctr>` when that single bucket is a
// real container), which keeps unclustered plans byte-identical to the older
// single-node shape.
const unitIdForInputAggregate = (item: ItemId): RenderUnitId => `u:in:${item}`;
const unitIdForInputFanout = (
  item: ItemId,
  containerId: ContainerId | undefined,
): RenderUnitId =>
  containerId === undefined
    ? `u:in:${item}:loose`
    : `u:in:${item}:${containerId}`;
const unitIdForInputSingleBucket = (
  item: ItemId,
  containerId: ContainerId | undefined,
): RenderUnitId =>
  containerId === undefined ? `u:in:${item}` : `u:in:${item}:${containerId}`;
const unitIdForOutputProduct = (item: ItemId): RenderUnitId => `u:out:${item}`;
const boundaryKey = (item: ItemId, containerId: ContainerId | undefined): string =>
  `${item}\0${containerId ?? ""}`;

export type DeriveBoundaryProductsInput = {
  machineGraph: MachineGraph;
  targets: ReadonlyArray<Target>;
  itemOverrides: ReadonlyArray<ItemOverride>;
  itemById: ReadonlyMap<ItemId, Item>;
  recipeById: ReadonlyMap<RecipeId, Recipe>;
  pack: Pick<RecipePack, "items">;
  unitIdByVertex: ReadonlyMap<MachineVertexId, RenderUnitId>;
};

export type DeriveBoundaryProductsResult = {
  inputProducts: RenderUnitInputProduct[];
  outputProducts: RenderUnitOutputProduct[];
  boundaryEdges: RenderEdge[];
};

/**
 * Derives boundary input/output product units and the edges that connect them
 * to in-graph machine units. The rules used to live inline in `NoFoldRender`:
 * target items become output products (with their target rate); items consumed
 * in the plan with nonzero `effectiveSupply` become input products (with rate
 * cap when overridden); surplus byproducts become amber output products.
 * Per-consumer flow conservation is preserved when a boundary input coexists
 * with an in-graph producer for the same item.
 *
 * The function is pure: it never mutates its arguments. `unitIdByVertex` MUST
 * map every machine vertex in `machineGraph` to a render unit id; the caller
 * is responsible for emitting those vertex-level units before calling this
 * helper (since the boundary edges target them by id).
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
  } = args;

  const boundaryEdges: RenderEdge[] = [];

  // ----- Boundary product units ----------------------------------------------
  //
  // Output products: one per distinct target item. The target item is the
  // first output of the target recipe (the solver pins its execution rate via
  // recipe.out[0]). When two targets share the same out-item (e.g., distinct
  // recipes that both produce `carbon_mtl`), their rates are summed so the
  // output product reflects total demand on that item rather than silently
  // dropping the later target.
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
  // `effectiveSupply` is nonzero (Infinity or a positive Fraction). Zero
  // supply emits nothing (forces internal build); target items always win
  // over input products of the same item. The precedence policy lives in
  // `effectiveSupply`; this policy never inspects `raw` / `plan` directly.
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
  // The recipe graph never wires a producer->consumer edge for an item whose
  // boundary supply is unlimited (graph.ts stops expanding such inputs), so a
  // raw item that an in-plan recipe ALSO emits as a byproduct reaches the
  // render with no machine edge at all: its byproduct production would surface
  // as a phantom surplus while its in-plan consumers are fed from nothing.
  // Reconcile by routing the internal byproduct flow to those consumers and
  // drawing only the remaining demand from the boundary. Scoped to
  // unlimited-supply items that carry no machine edge, so every graph-wired
  // item is left untouched.
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

  // recaptureItems: items the pass reconciles. recapturedByConsumerVertexItem:
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
    if (targetItemSet.has(itemId)) continue;
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
    // Recaptured = min(production, demand); any excess production stays surplus,
    // any excess demand still draws from the boundary.
    const recaptured =
      totalProd.compare(totalDemand) <= 0 ? totalProd : totalDemand;
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
      // share. Sum over c gives sendP; sum over p gives each consumer's
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

  // Boundary item := consumed by a machine, not produced by any machine
  // in the plan, and surfaced by `effectiveSupply` (Infinity or positive
  // Fraction). Items produced upstream by another in-plan recipe stay
  // internal. Track each consumer along with the per-consumer rate so the
  // render policy can later emit a boundary edge from the input product to
  // that consumer (boundary items have no MachineEdge in the graph since the
  // solver walk terminated upstream of them).
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
    // Infinity supply combined with an in-plan producer means the consumer
    // gets all of its supply internally; the override only marks the item as
    // a boundary if the planner ever needs to surface it (no in-graph
    // producer). Skip the boundary input in that case -- unless this is a
    // recapture item, where the byproduct only partially covers demand and the
    // deficit must still be drawn from the boundary.
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
    // imported portion alongside the in-graph producer's residual edge.
    // Infinity supply with no in-graph producer -> single-emit (boundary).
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
      // SCC vertices expose their boundary I/O via netIO; a boundary item
      // consumed only by an in-loop recipe must still surface as an input
      // product.
      const toUnit = unitIdByVertex.get(v.id);
      if (toUnit === undefined) continue;
      for (const p of v.netIO) {
        if (p.direction === "in")
          collectConsumed(v.id, p.item, toUnit, p.rate, v.containerId);
      }
    }
  }

  // Precompute realized rates before emitting product units. Each input
  // ProductNode renders its rate as primary chrome, and the keying is
  // `(itemId, containerId)` so a high-fan-out raw consumed across multiple
  // blueprint-group containers emits one node per container, each pinned near
  // its consumers.
  //
  // The supply cap is item-level (effectiveSupply is keyed by item). To
  // preserve the mass-balance invariant -- "split input-rate sums equal the
  // pre-split single-input rate" -- the cap is computed once per item, then
  // each (item, container) ProductNode receives the per-container slice
  //   realizedRate(item, ctr) = consumedSupply(item) * containerDemand(item, ctr)
  //                                                     / totalDemand(item)
  // Per-edge rate inside a container is `c.rate * consumedSupply(item) /
  // totalDemand(item)`, identical to the single-node formula; the split only
  // redistributes the same total across more ProductNodes.
  type ConsumerKey = string;
  const consumersByKey = new Map<ConsumerKey, BoundaryConsumer[]>();
  const itemByKey = new Map<ConsumerKey, ItemId>();
  const containerByKey = new Map<ConsumerKey, ContainerId | undefined>();
  const totalDemandByItem = new Map<ItemId, Fraction>();
  for (const c of boundaryConsumers) {
    const k = boundaryKey(c.item, c.containerId);
    const arr = consumersByKey.get(k) ?? [];
    arr.push(c);
    consumersByKey.set(k, arr);
    itemByKey.set(k, c.item);
    containerByKey.set(k, c.containerId);
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
    } else if ((supply as Fraction).compare(totalDemand) >= 0) {
      consumed = totalDemand;
    } else {
      consumed = supply as Fraction;
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

  // Group keys by item so the per-item topology decision (single bucket vs
  // aggregate + fanout slices) is made once per item.
  const keysByItem = new Map<ItemId, ConsumerKey[]>();
  for (const key of consumersByKey.keys()) {
    const itemId = itemByKey.get(key)!;
    const arr = keysByItem.get(itemId) ?? [];
    arr.push(key);
    keysByItem.set(itemId, arr);
  }

  const inputProducts: RenderUnitInputProduct[] = [];
  const emittedKeys = new Set<ConsumerKey>();
  // aggregateIdByItem[item] is set iff that item emitted an aggregate node;
  // used by the edge emission below to wire aggregate -> fanout slices.
  const aggregateIdByItem = new Map<ItemId, RenderUnitId>();
  const sortedItems = [...keysByItem.keys()].sort();
  for (const itemId of sortedItems) {
    // Target trumps boundary, but only when the user has NOT explicitly
    // declared an itemOverride for the same item. With an explicit override,
    // the item must render BOTH as an input (pinned to the FIRST layer) and as
    // a target output (pinned to the LAST layer). The original rule still
    // applies to un-overridden raw targets: the item the user picked as a
    // target does not also double as a raw boundary input. The rule is
    // item-level, so it short-circuits all keys for an item uniformly.
    if (targetItemSet.has(itemId) && !overrideByItem.has(itemId)) continue;
    const ov = overrideByItem.get(itemId);
    const keys = keysByItem.get(itemId)!.slice().sort();

    if (keys.length <= 1) {
      // Single bucket -- emit one node with the legacy/per-container id.
      // No aggregate fanout needed.
      const key = keys[0]!;
      const containerId = containerByKey.get(key);
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      const base: Omit<RenderUnitInputProduct, "rateCap"> = {
        id: unitIdForInputSingleBucket(itemId, containerId),
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

    // Multiple buckets -- emit an aggregate node + one fanout slice per
    // bucket. The aggregate carries the item-level rateCap and total
    // realized rate; each slice carries only its per-container rate so the
    // node label reads as a tap rather than another item-level cap.
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
      const containerId = containerByKey.get(key);
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      inputProducts.push({
        id: unitIdForInputFanout(itemId, containerId),
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
  // consumers, and each target's recipe stamps to the output product. Without
  // these edges ELK has no signal that product nodes are upstream or downstream
  // of recipes, so layerConstraint=FIRST/LAST collapses them into shared layers
  // with the recipes (visible as boundary nodes overlapping the
  // leftmost/rightmost recipe column).
  //
  // Per-consumer flow conservation: when both an in-graph producer and a
  // boundary input feed the same item, the boundary edge to each consumer
  // must carry the consumer's prorated share of the cap, not the full demand.
  // Otherwise sum(producer edges -> c) + (boundary edge -> c) overshoots
  // c's per-input demand.
  //
  // Edge rate per consumer = c.rate * (consumedSupply / totalDemand), using
  // the same per-item consumedSupply that drove the per-container realized
  // rate above. Special cases:
  //  - effectiveSupply === Infinity: producer is not in graph, consumedSupply
  //    collapses to totalDemand, edge rate = c.rate (single-emit preserved).
  //  - effectiveSupply >= totalDemand (finite cap covers entire demand):
  //    consumedSupply = totalDemand, edge rate = c.rate; producer's residual
  //    is 0 (already filtered by the residual-supply pass + zero-rate gate).
  //  - effectiveSupply == 0: gated upstream (no input product emitted at all).
  for (const [key, consumers] of consumersByKey) {
    if (!emittedKeys.has(key)) continue;
    const itemId = itemByKey.get(key)!;
    const containerId = containerByKey.get(key);
    const item = itemById.get(itemId);
    if (!item) continue;
    const totalDemand = totalDemandByItem.get(itemId)!;
    // Defensive: avoid 0/0 if all consumer rates collapse to zero.
    if (totalDemand.equals(new Fraction(0))) continue;
    const consumedSupply = consumedSupplyByItem.get(itemId)!;
    // When an aggregate exists for this item, the per-bucket consumer edges
    // originate from the fanout slice; otherwise they originate from the
    // single-bucket node (which carries the legacy id).
    const fromUnit = aggregateIdByItem.has(itemId)
      ? unitIdForInputFanout(itemId, containerId)
      : unitIdForInputSingleBucket(itemId, containerId);
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

  // Aggregate -> fanout slice edges: one edge per slice per aggregate-emitting
  // item, carrying the slice's realized rate. Emitted after the per-bucket
  // consumer edges so the boundary-edge ordering stays stable (aggregate edges
  // always trail their item's consumer edges).
  for (const itemId of sortedItems) {
    const aggregateId = aggregateIdByItem.get(itemId);
    if (aggregateId === undefined) continue;
    const item = itemById.get(itemId);
    if (!item) continue;
    const keys = keysByItem.get(itemId)!.slice().sort();
    for (const key of keys) {
      const containerId = containerByKey.get(key);
      const realizedRate = realizedRateByKey.get(key) ?? new Fraction(0);
      boundaryEdges.push({
        fromUnit: aggregateId,
        toUnit: unitIdForInputFanout(itemId, containerId),
        item: itemId,
        rate: realizedRate,
        transportKind: item.transportKind,
      });
    }
  }

  // Output boundary edges: each target-recipe replica's per-item spare =
  // produced - outgoing machine edges for that item. Replicas with positive
  // spare get a target edge; the declared rate is distributed across them
  // proportionally to spare. The rule collapses to the simpler "T/N per stamp"
  // behavior whenever the target recipe is a leaf - every replica then has full
  // spare, and equal spare yields equal per-edge rates.
  // For a target inside a recycling loop (or otherwise feeding internal
  // consumers), the rule routes the declared net rate to whatever spare
  // exists. A purely-internal replica (spare <= 0) emits no target edge and
  // the surplus pass below sees no leftover production from it.
  //
  // outgoingRateByVertexItem is initialized once here and reused by the
  // surplus pass below. Both passes need the post-target-emission view of
  // outgoing flow to avoid double-counting the same production as both
  // delivered (to the target port) and surplus.
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
  // Recapture edges route byproduct production to in-plan consumers; count
  // them as outgoing so the surplus pass nets the recaptured amount.
  for (const [key, rate] of recaptureSendByVertexItem) {
    const sep = key.indexOf("\0");
    addOutgoing(key.slice(0, sep) as MachineVertexId, key.slice(sep + 1), rate);
  }

  type TargetStamp = { vertex: MachineRecipeVertex; spare: Fraction };
  const stampsByTargetOutItem = new Map<ItemId, TargetStamp[]>();
  // Collect target-output spare from EVERY machine vertex that produces a target
  // item X, not just the target-recipe stamps. When an SCC target recipe
  // co-produces the looped item with a leaf recipe (e.g. iron_nugget produced by
  // both iron_nugget-iron_ore and iron_nugget-iron_powder), the leaf's spare
  // must also reach the target output unit, otherwise the target edge is
  // under-fed and the leaf's spare surfaces as a phantom surplus. Iterating all
  // output stoich entries (X may be a co-product, not the primary output)
  // captures both producers; the proportional distribution below then routes the
  // declared target rate across their pooled spare.
  for (const v of machineGraph.vertices) {
    if (!isMachineRecipeVertex(v)) continue;
    const recipe = recipeById.get(v.recipeId);
    if (!recipe) continue;
    for (const outStoich of recipe.out) {
      const outItem = outStoich.item;
      if (!targetItemSet.has(outItem)) continue;
      const produced = v.executionRate.mul(new Fraction(outStoich.qty));
      const outgoing =
        outgoingRateByVertexItem.get(`${v.id}\0${outItem}`) ?? new Fraction(0);
      const spare = produced.sub(outgoing);
      if (spare.compare(0) <= 0) continue;
      const arr = stampsByTargetOutItem.get(outItem) ?? [];
      arr.push({ vertex: v, spare });
      stampsByTargetOutItem.set(outItem, arr);
    }
  }
  for (const [outItem, stamps] of stampsByTargetOutItem) {
    const total = targetRateByItem.get(outItem);
    if (!total || stamps.length === 0) continue;
    const item = itemById.get(outItem);
    if (!item) continue;
    const totalSpare = stamps.reduce(
      (acc, s) => acc.add(s.spare),
      new Fraction(0),
    );
    if (totalSpare.equals(new Fraction(0))) continue;
    // Cap distributed at totalSpare so a defensive under-production by the
    // solver never invents rate downstream. In practice an correct solve
    // produces totalSpare >= total for any target whose recipe is reachable.
    const distributed = total.compare(totalSpare) > 0 ? totalSpare : total;
    for (const s of stamps) {
      const fromUnit = unitIdByVertex.get(s.vertex.id);
      if (fromUnit === undefined) continue;
      const rate = s.spare.mul(distributed).div(totalSpare);
      boundaryEdges.push({
        fromUnit,
        toUnit: unitIdForOutputProduct(outItem),
        item: outItem,
        rate,
        transportKind: item.transportKind,
      });
      addOutgoing(s.vertex.id, outItem, rate);
    }
  }

  // Surplus output products: any item a vertex produces beyond its outgoing
  // consumption (internal MachineEdges + target output edges emitted above)
  // surfaces as an amber outputProduct on the rightmost layer. This is the
  // case the pack hits whenever a recipe ships byproducts (e.g.
  // copper_nugget's liquid_sewage). Without surplus emission, byproducts
  // silently disappear from the canvas.
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
  // surplus while the matching per-machine deficits are silently dropped.
  // Aggregating to the unit -- the level a recipe is actually drawn at -- nets
  // the slices so only genuine whole-unit overproduction surfaces.
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
  // Roll the per-vertex outgoing totals (machine edges + target + recapture
  // edges) up to their render unit using the same key space.
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
  for (const [key, produced] of producedByUnitItem) {
    const sep = key.indexOf("\0");
    const unitId = key.slice(0, sep) as RenderUnitId;
    const item = key.slice(sep + 1);
    const outgoing = outgoingByUnitItem.get(key) ?? new Fraction(0);
    const surplus = produced.sub(outgoing);
    if (surplus.compare(0) <= 0) continue;
    surplusByItem.set(
      item,
      (surplusByItem.get(item) ?? new Fraction(0)).add(surplus),
    );
    const arr = surplusContributors.get(item) ?? [];
    arr.push({ unitId, rate: surplus });
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
