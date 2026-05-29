import Fraction from "fraction.js";
import type { Item, TransportKindId } from "@aef/schema";
import type {
  LogicalEdge,
  LogicalGraph,
  LogicalRecipeNode,
} from "../../canvas/layout";
import type { Replica } from "../../solver/types";
import type {
  ItemId,
  MachineEdge,
  MachineGraph,
  MachineRecipeVertex,
  MachineSccVertex,
  MachineVertex,
  MachineVertexId,
  NetIOPort,
  ReplicaId,
  SccId,
} from "../types";

/**
 * Input shape for ExpandMultipliers. The stage consumes the post-assembly
 * LogicalGraph plus enough solver metadata to decide paired vs shared
 * distribution per producer replica, the per-logical-edge total rate, and
 * an optional SCC stand-in declaration for logical nodes that represent a
 * non-trivial SCC (those materialize to a single typed vertex). The shape
 * is internal to the pipeline; upstream stages assemble it before calling.
 */
export type ExpandMultipliersInput = {
  logical: LogicalGraph;
  replicas: ReadonlyArray<Replica>;
  edgeRatesByLogicalEdgeId: ReadonlyMap<string, Fraction>;
  sccByLogicalNodeId?: ReadonlyMap<
    string,
    { sccId: SccId; netIO: ReadonlyArray<NetIOPort> }
  >;
  // Item lookup used to stamp `transportKind` on every emitted MachineEdge.
  // Referential integrity is the pack's job (every edge item is in
  // pack.items); the stage throws if an item is missing.
  itemById: ReadonlyMap<ItemId, Item>;
  /** Rational ideal count per replica; decomposed into N_full + partial. */
  idealCount?: ReadonlyMap<string, Fraction>;
  /** Needed to compute per-stamp max executionRate = machine.speed / recipe.time. */
  machineById?: ReadonlyMap<string, { speed: number }>;
};

const STAMP_SEP = "~~m";

function safeId(replicaId: ReplicaId): string {
  return replicaId.replace(/#/g, "~");
}

function machineVertexId(
  logicalNodeId: string,
  stampIndex: number,
): MachineVertexId {
  return `${logicalNodeId}${STAMP_SEP}${stampIndex}`;
}

function itemFromPort(port: string, prefix: "in:" | "out:"): ItemId {
  return port.startsWith(prefix) ? port.slice(prefix.length) : port;
}

function compareEdges(a: MachineEdge, b: MachineEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  if (a.item !== b.item) return a.item < b.item ? -1 : 1;
  const ar = a.rate.toFraction();
  const br = b.rate.toFraction();
  if (ar !== br) return ar < br ? -1 : 1;
  return 0;
}

/**
 * ExpandMultipliers: materialize each non-SCC LogicalRecipeNode of multiplier N
 * into N MachineRecipeVertex stamps, materialize SCC stand-ins into a single
 * MachineSccVertex, and distribute logical edges three ways: paired by
 * stampIndex for per-consumer producers, greedy-by-demand for
 * shared-at-articulation producers, and parallel edges preserved one-for-one
 * per logical edge.
 *
 * Pure: same input yields the same MachineGraph; output arrays are sorted by
 * stable keys for deterministic iteration.
 */
export function expandMultipliers(input: ExpandMultipliersInput): MachineGraph {
  const {
    logical,
    replicas,
    edgeRatesByLogicalEdgeId,
    sccByLogicalNodeId,
    itemById,
  } = input;
  const sccMap =
    sccByLogicalNodeId ??
    new Map<string, { sccId: SccId; netIO: ReadonlyArray<NetIOPort> }>();

  // idealCount and machineById together gate the N_full + partial
  // decomposition, so either both must be present or both absent. Accepting one
  // without the other would silently disable fractional emission, which throws
  // off stamp counts and per-stamp rates for any caller that believed it had
  // wired both.
  if ((input.idealCount === undefined) !== (input.machineById === undefined)) {
    throw new Error(
      "expandMultipliers: idealCount and machineById must be provided together (or both omitted); one without the other silently disables N_full + partial decomposition",
    );
  }

  // Resolve the transport kind for `item`. Because the pack guarantees every
  // edge item exists, a missing item is a programming error rather than bad
  // user input, so we throw instead of silently emitting an empty kind.
  function transportKindFor(item: ItemId): TransportKindId {
    const entry = itemById.get(item);
    if (!entry) {
      throw new Error(
        `expandMultipliers: item ${item} missing from itemById; pack referential integrity broken`,
      );
    }
    return entry.transportKind;
  }

  // Index logical recipe nodes by id, and replicas by their safeId-form id so we
  // can recover consumerPath/sharedAtArticulation from a logical-node id.
  const recipeNodes: LogicalRecipeNode[] = logical.nodes.filter(
    (n): n is LogicalRecipeNode => n.kind === "recipe",
  );
  const nodeById = new Map<string, LogicalRecipeNode>();
  for (const n of recipeNodes) nodeById.set(n.id, n);

  const replicaByLogicalId = new Map<string, Replica>();
  for (const r of replicas) replicaByLogicalId.set(safeId(r.id), r);

  // Build vertices. SCC stand-in nodes become a single MachineSccVertex; other
  // nodes materialize into `multiplier` MachineRecipeVertex stamps.
  const vertices: MachineVertex[] = [];
  // Map: logicalNodeId -> ordered list of machine vertex ids representing its stamps
  // (singleton list for SCC vertices).
  const stampsByNodeId = new Map<string, MachineVertexId[]>();

  for (const n of recipeNodes) {
    const scc = sccMap.get(n.id);
    if (scc) {
      const v: MachineSccVertex = {
        kind: "scc-box",
        id: machineVertexId(n.id, 0),
        sccId: scc.sccId,
        netIO: scc.netIO,
      };
      vertices.push(v);
      stampsByNodeId.set(n.id, [v.id]);
      continue;
    }
    const replica = replicaByLogicalId.get(n.id);
    const replicaId: ReplicaId = replica ? replica.id : n.id;
    const fallbackMult = Math.max(1, n.multiplier | 0);
    const idealOpt = input.idealCount?.get(replicaId);
    const machineSpeed = (() => {
      if (!replica) return undefined;
      const recipe = n.recipe;
      const machine = input.machineById?.get(recipe.producers[0] ?? "");
      if (!machine) return undefined;
      return new Fraction(machine.speed).div(new Fraction(recipe.time));
    })();

    const stamps: MachineVertexId[] = [];
    if (idealOpt && machineSpeed) {
      // Exact-rational floor: Fraction.floor(0) returns the Fraction floored
      // to an integer value (matches the ceil(0) idiom in assignMultipliers).
      const nFullFrac = idealOpt.floor(0);
      const nFull = Number(nFullFrac.valueOf()); // integer-valued, fits in JS number for AEF-scale plans
      const partial = idealOpt.sub(nFullFrac);
      // Emit N_full full stamps.
      for (let i = 0; i < nFull; i++) {
        const v: MachineRecipeVertex = {
          kind: "machine",
          id: machineVertexId(n.id, i),
          replicaId,
          recipeId: n.recipe.id,
          stampIndex: i,
          executionRate: machineSpeed,
        };
        vertices.push(v);
        stamps.push(v.id);
      }
      // Emit 1 partial stamp iff partial > 0.
      if (partial.compare(0) > 0) {
        const v: MachineRecipeVertex = {
          kind: "machine",
          id: machineVertexId(n.id, nFull),
          replicaId,
          recipeId: n.recipe.id,
          stampIndex: nFull,
          executionRate: partial.mul(machineSpeed),
          partial: true,
        };
        vertices.push(v);
        stamps.push(v.id);
      }
      // Defensive: if both N_full and partial are zero, fall back to one stamp.
      if (stamps.length === 0) {
        const v: MachineRecipeVertex = {
          kind: "machine",
          id: machineVertexId(n.id, 0),
          replicaId,
          recipeId: n.recipe.id,
          stampIndex: 0,
          executionRate: new Fraction(0),
        };
        vertices.push(v);
        stamps.push(v.id);
      }
    } else {
      // Legacy path: integer multiplier, uniform per-stamp rate = replica.rate / multiplier.
      const replicaExecutionRate = replica?.executionRate ?? new Fraction(0);
      const perStampRate = replicaExecutionRate.div(fallbackMult);
      for (let i = 0; i < fallbackMult; i++) {
        const v: MachineRecipeVertex = {
          kind: "machine",
          id: machineVertexId(n.id, i),
          replicaId,
          recipeId: n.recipe.id,
          stampIndex: i,
          executionRate: perStampRate,
        };
        vertices.push(v);
        stamps.push(v.id);
      }
    }
    stampsByNodeId.set(n.id, stamps);
  }

  // Bucket logical edges by producer to drive shared-utility distribution.
  // For paired distribution and SCC endpoints, we process edges individually.
  // For shared producers, we need to see all outgoing edges of the same item
  // together to enumerate consumer machines in demand-sorted order.
  const edges: MachineEdge[] = [];

  // Partition logical edges into "scc-touching" (handled 1:1) and the rest.
  type GroupedEdge = { edge: LogicalEdge; item: ItemId; rateTotal: Fraction };
  const sharedBuckets = new Map<string, GroupedEdge[]>(); // key: producerNodeId + "|" + item
  const pairedEdges: GroupedEdge[] = [];
  const sccTouchingEdges: GroupedEdge[] = [];

  for (const e of logical.edges) {
    const item: ItemId = itemFromPort(e.sourcePort, "out:");
    const rateTotal = edgeRatesByLogicalEdgeId.get(e.id) ?? new Fraction(0);
    const grouped: GroupedEdge = { edge: e, item, rateTotal };

    const sourceIsScc = sccMap.has(e.source);
    const targetIsScc = sccMap.has(e.target);
    if (sourceIsScc || targetIsScc) {
      sccTouchingEdges.push(grouped);
      continue;
    }

    const producer = replicaByLogicalId.get(e.source);
    if (producer && producer.sharedAtArticulation) {
      const key = `${e.source}|${item}`;
      const arr = sharedBuckets.get(key) ?? [];
      arr.push(grouped);
      sharedBuckets.set(key, arr);
    } else {
      pairedEdges.push(grouped);
    }
  }

  // Round-robin fan-out against max(fromStamps, toStamps) so every machine on
  // both sides has at least one edge (no isolated producers in the render
  // plan). Per-edge rate = rateTotal / edgeCount preserves total flow and
  // matches per-producer throughput when the producer side is the larger one.
  //
  // Paired edges: paired distribution assumes the two sides have equal
  // multipliers, but the replicator can produce unequal counts when per-machine
  // throughput differs across the pair (e.g., 6 miners at 1/3/s feeding 4
  // smelters at 0.5/s each, both totalling 2/s). Parallel logical edges (same
  // source/target/item, distinct ids) each emit their own per-stamp-pair
  // edges; rates are per-edge.
  //
  // SCC-touching edges: an SCC stays a single typed vertex, so at least one
  // side has length 1; when both sides are SCC singletons this collapses to
  // one edge. The SCC interior renderer can still re-route boundary edges
  // independently.
  const emitFanout = (g: GroupedEdge): void => {
    const fromStamps = stampsByNodeId.get(g.edge.source) ?? [];
    const toStamps = stampsByNodeId.get(g.edge.target) ?? [];
    if (fromStamps.length === 0 || toStamps.length === 0) return;
    const edgeCount = Math.max(fromStamps.length, toStamps.length);
    const perEdgeRate = g.rateTotal.div(edgeCount);
    const transportKind = transportKindFor(g.item);
    for (let i = 0; i < edgeCount; i++) {
      edges.push({
        from: fromStamps[i % fromStamps.length]!,
        to: toStamps[i % toStamps.length]!,
        item: g.item,
        rate: perEdgeRate,
        transportKind,
      });
    }
  };
  for (const g of sccTouchingEdges) emitFanout(g);
  for (const g of pairedEdges) emitFanout(g);

  // Shared-utility distribution: greedy-by-consumer-demand. For each bucket
  // (producer logical node + item), enumerate consumer machines in descending
  // order of their owning logical-edge rateTotal (the consumer-replica demand
  // for this item), then walk producer machines in stampIndex order and assign
  // each one to the next consumer machine in line. Per-edge rate is the
  // per-machine consumer demand: consumerEdgeRate / mult(consumerReplica).
  const sortedSharedKeys = [...sharedBuckets.keys()].sort();
  for (const key of sortedSharedKeys) {
    const bucket = sharedBuckets.get(key)!;
    const producerNodeId = bucket[0]!.edge.source;
    const item = bucket[0]!.item;
    const producerStamps = stampsByNodeId.get(producerNodeId) ?? [];
    if (producerStamps.length === 0) continue;

    // Sort consumer logical edges by demand desc, ties broken by target node id
    // for determinism. Then expand each to its consumer machines in stamp order.
    const sortedConsumers = [...bucket].sort((a, b) => {
      const ar = a.rateTotal;
      const br = b.rateTotal;
      // Fraction.compare returns -1/0/1; descending means swap arguments.
      const cmp = br.compare(ar);
      if (cmp !== 0) return cmp;
      return a.edge.target < b.edge.target
        ? -1
        : a.edge.target > b.edge.target
          ? 1
          : 0;
    });

    type Slot = {
      vertexId: MachineVertexId;
      perMachineRate: Fraction;
      item: ItemId;
    };
    const slots: Slot[] = [];
    for (const c of sortedConsumers) {
      const consumerStamps = stampsByNodeId.get(c.edge.target) ?? [];
      if (consumerStamps.length === 0) continue;
      const perMachineRate = c.rateTotal.div(consumerStamps.length);
      for (const cs of consumerStamps) {
        slots.push({ vertexId: cs, perMachineRate, item });
      }
    }

    // Round-robin against the larger side so no machine is isolated. When
    // producers and slots are equal this collapses to the original 1:1
    // assignment; when they differ, extras wrap modulo the smaller side.
    // Mass conservation requires the SUM of edges into a single consumer slot
    // to equal its `perMachineRate`, so when multiple producers wrap to the
    // same slot we split the slot's demand equally among them. Without this
    // split, each wrap-around edge carried the full per-machine demand and
    // total flow inflated by the fan-in factor (a 9 -> 1 fan-in produced 9x
    // the actual demand at the aggregated class edge).
    const edgeCount = Math.max(producerStamps.length, slots.length);
    const transportKind = transportKindFor(item);
    const fanInPerSlot = new Array<number>(slots.length).fill(0);
    for (let i = 0; i < edgeCount; i++) {
      fanInPerSlot[i % slots.length]!++;
    }
    for (let i = 0; i < edgeCount; i++) {
      const slotIdx = i % slots.length;
      const slot = slots[slotIdx]!;
      const fanIn = fanInPerSlot[slotIdx]!;
      const perEdgeRate =
        fanIn > 1 ? slot.perMachineRate.div(fanIn) : slot.perMachineRate;
      edges.push({
        from: producerStamps[i % producerStamps.length]!,
        to: slot.vertexId,
        item: slot.item,
        rate: perEdgeRate,
        transportKind,
      });
    }
  }

  // Sort outputs by stable keys for deterministic iteration. Vertices: by id.
  // Edges: by (from, to, item, rate).
  const sortedVertices = [...vertices].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const sortedEdges = [...edges].sort(compareEdges);

  return { vertices: sortedVertices, edges: sortedEdges };
}
