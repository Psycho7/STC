import type {
  ContainerId,
  ItemId,
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
// distinguished by the word after `u:` (`scc`, `class`, `in`, `cat`, `out`,
// `surplus`). Injectivity across the families rests on exactly two clauses
// about the ids fed in:
//   1. An item id contains no `:`. Otherwise `u:in:a:b` is ambiguous between
//      the aggregate for item "a:b" and the container "b" of item "a", and
//      `u:cat:a:b` the same way for the catalyst family.
//   2. A container id is not literally "target", the one reserved container
//      slot under `u:in:<item>:`.
// The pack census in src/solver/pack-shape.test.ts pins clause 1 on the
// shipped pack; clause 2 holds because container ids are minted inside the
// pipeline, not read off the pack.

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

// The catalyst pool of an item: a boundary node feeding `cat:` ports only.
// It is a family of its own rather than another `u:in:` node because an item
// can be drawn as an ordinary reagent and cycled as a catalyst at once, and
// the two draws are accounted separately.
export const unitIdForCatalystAggregate = (item: ItemId): RenderUnitId =>
  `u:cat:${item}`;

export const unitIdForCatalystContainer = (
  item: ItemId,
  containerId: ContainerId,
): RenderUnitId => `u:cat:${item}:${containerId}`;

// Dedicated boundary import that feeds a free-supply target item's export
// passthrough; distinct from the consumer-feeding input ids so consumer
// plumbing is untouched.
export const unitIdForInputTargetFeed = (item: ItemId): RenderUnitId =>
  `u:in:${item}:target`;

export const unitIdForOutputProduct = (item: ItemId): RenderUnitId =>
  `u:out:${item}`;

export const unitIdForSurplus = (item: ItemId): RenderUnitId =>
  `u:surplus:${item}`;
