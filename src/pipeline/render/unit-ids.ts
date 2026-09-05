import type {
  ContainerId,
  ItemId,
  MachineVertexId,
  RenderUnitId,
  ReplicaId,
  SccId,
} from "../types";

// One home for the `u:`-prefixed render unit-id grammar. Every emitter that
// mints a render unit id and every checker that reconstructs one calls these
// constructors, so the two sides cannot drift within a single render pass.
//
// Two hard rules for this file:
//  1. Id constructors only. It never reads a recipe pack, a render plan or any
//     per-edge rate data, and it exports nothing that computes a rate. Naming
//     the unit that carries item X is a selector; deriving what rate should
//     arrive there is accounting, and the checkers keep deriving that
//     independently on purpose (double entry).
//  2. It must not import invariants.ts (the render invariant module) or
//     boundary-products.ts (the boundary product emitter) in this directory.
//     The emitter already imports the checkers, so hosting these constructors
//     in either of those files would cycle. Hence a third module, importing
//     only ../types.
//
// The grammar is `u:`-prefixed and `:`-separated, and the families below are
// distinguished by the word after `u:` (`scc`, `class`, `in`, `out`,
// `surplus`) or, for a recipe unit, by the absence of one. Injectivity across
// the families rests on exactly three clauses about the ids fed in:
//   1. An item id contains no `:`. Otherwise `u:in:a:b` is ambiguous between
//      the aggregate for item "a:b" and the container "b" of item "a".
//   2. A machine vertex id does not start with a family word followed by `:`.
//      Otherwise a recipe unit collides with the family that word names.
//   3. A container id does not start with `tap:` and is not literally
//      "target", the two reserved container slots under `u:in:<item>:`.
// The pack census in src/solver/pack-shape.test.ts pins clause 1 on the
// shipped pack; clauses 2 and 3 hold because vertex and container ids are
// minted inside the pipeline, not read off the pack.

export const unitIdForRecipe = (vertexId: MachineVertexId): RenderUnitId =>
  `u:${vertexId}`;

// Every SCC vertex with the same sccId collapses to one loop unit so all
// inbound and outbound edges resolve to the same render endpoint.
export const unitIdForScc = (sccId: SccId): RenderUnitId => `u:scc:${sccId}`;

export const unitIdForClass = (replicaId: ReplicaId): RenderUnitId =>
  `u:class:${replicaId}`;

export const unitIdForInputAggregate = (item: ItemId): RenderUnitId =>
  `u:in:${item}`;

export const unitIdForInputContainer = (
  item: ItemId,
  containerId: ContainerId,
): RenderUnitId => `u:in:${item}:${containerId}`;

export const unitIdForInputTap = (
  item: ItemId,
  consumerUnit: RenderUnitId,
): RenderUnitId => `u:in:${item}:tap:${consumerUnit}`;

// Dedicated boundary import that feeds a free-supply target item's export
// passthrough; distinct from the consumer-feeding input ids so consumer
// plumbing is untouched.
export const unitIdForInputTargetFeed = (item: ItemId): RenderUnitId =>
  `u:in:${item}:target`;

export const unitIdForOutputProduct = (item: ItemId): RenderUnitId =>
  `u:out:${item}`;

export const unitIdForSurplus = (item: ItemId): RenderUnitId =>
  `u:surplus:${item}`;
