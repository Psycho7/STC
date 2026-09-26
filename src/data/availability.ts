// The availability model: which recipes exist right now, and why not.
//
// Three independent predicates decide it - the settlement a recipe can be
// built in (#124), the event cohort it belongs to (#144), and a hand toggle
// (#125) - composed in one place so every surface reads the same answer. The
// product is a cause map, recipe id -> why it is off; the unavailable-id set
// the solver seam takes is a derivation over its keys, which keeps recipe
// ordering (lp.ts's lexRank) blind to the reason.
//
// Event content is tagged with a cohort (the v<major>.<minor> of the AKEData
// game version that first shipped it) by the extractor; whether a cohort is
// currently on is app-level state, not plan state, so it lives here between
// the recipe pack and localStorage rather than riding the plan wire.
//
// No React import on purpose: the bun CLIs can adopt the same effective-state
// rule later without pulling the app in.

import type { Recipe, RecipePack } from "@aef/schema";
import type { RecipeId } from "../solver/types";
import type { ProducerUnavailableCause } from "./plan";
import { producerUnavailableCause } from "./plan";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY as STORAGE_KEY,
} from "./storage-keys";

// User override per cohort: true = forced on, false = forced off, absent =
// follow the default rule (on iff the cohort matches the pack's own version).
// Only booleans ever ride the wire; readStoredEventOverrides drops anything
// else under the key.
export type EventCohortOverrides = Record<string, boolean>;

// The pack's own cohort: v<major>.<minor> of the game version it was cut from
// ("v1.5.3" -> "v1.5"). The extractor owns the string and every retained
// AKEData version matches this shape, so anything else is a build error in our
// own artifact rather than a runtime condition - hence the throw, which fails
// loudly at boot instead of silently mistagging every cohort off.
export function packCohortOf(pack: RecipePack): string {
  const match = pack.source.gameVersion.match(/^v(\d+)\.(\d+)(\.\d+)?$/);
  if (!match) {
    throw new Error(
      `pack source.gameVersion is not a game version: ${JSON.stringify(pack.source.gameVersion)}`,
    );
  }
  return `v${match[1]}.${match[2]}`;
}

// Every cohort the pack carries, across items and recipes, sorted. Rows only
// ever agree with their items (the extractor's mixed-cohort guard), but the
// union is walked anyway so an item-only or recipe-only tag still surfaces -
// the panel lists cohorts, not tag sites.
export function eventCohortsOf(pack: RecipePack): string[] {
  const cohorts = new Set<string>();
  for (const item of pack.items) {
    if (item.event !== undefined) cohorts.add(item.event);
  }
  for (const recipe of pack.recipes) {
    if (recipe.event !== undefined) cohorts.add(recipe.event);
  }
  return [...cohorts].sort();
}

// The effective-state rule: an explicit override wins in both directions;
// without one, the cohort is on exactly when it matches the pack's own
// version. A fresh browser stores nothing, so every shipped cohort is on.
export function effectiveCohortEnabled(
  cohort: string,
  packCohort: string,
  overrides: EventCohortOverrides,
): boolean {
  return overrides[cohort] ?? cohort === packCohort;
}

// Everything the predicates read, as one value the app owns and threads in.
// Each field is its own storage key with its own writer; an absent field means
// the predicate it drives passes, which is why a fresh browser sees exactly
// the event rule and nothing else.
export type AvailabilitySettings = {
  eventOverrides: EventCohortOverrides;
  // The settlement the plan is built in (#124). The app always sets one; absent
  // means no area filter, which only tests of the other predicates rely on.
  area?: string | undefined;
  // Recipes switched off by hand (#125). Stored independently of the other
  // two, so re-enabling an area never resurrects one.
  disabledRecipeIds?: ReadonlySet<RecipeId> | undefined;
};

// A recipe stands in an area when the recipe itself is not tagged for some
// other one AND at least one of its producer machines can be built there.
// Both carriers are needed: the location-tagged recipes sit on untagged
// machines, and untagged recipes sit on location-tagged ones. No `locations`
// means everywhere.
function inArea(
  recipe: Recipe,
  machineLocations: ReadonlyMap<string, readonly string[] | undefined>,
  area: string,
): boolean {
  if (recipe.locations !== undefined && !recipe.locations.includes(area)) {
    return false;
  }
  return recipe.producers.some((id) => {
    const locations = machineLocations.get(id);
    return locations === undefined || locations.includes(area);
  });
}

function eventEnabled(
  recipe: Recipe,
  packCohort: string,
  overrides: EventCohortOverrides,
): boolean {
  if (recipe.event === undefined) return true;
  return effectiveCohortEnabled(recipe.event, packCohort, overrides);
}

function manuallyDisabled(
  recipe: Recipe,
  disabled: ReadonlySet<RecipeId> | undefined,
): boolean {
  return disabled?.has(recipe.id) ?? false;
}

// Why a recipe is off, or null when it is available. Precedence when more than
// one predicate fails: area, then event, then manual - the outermost reason
// first, so the message points at the switch that the user has to flip before
// any of the others would even matter.
function unavailableCauseOf(
  recipe: Recipe,
  packCohort: string,
  machineLocations: ReadonlyMap<string, readonly string[] | undefined>,
  settings: AvailabilitySettings,
): ProducerUnavailableCause | null {
  const area = settings.area;
  if (area !== undefined && !inArea(recipe, machineLocations, area)) {
    return { kind: "area", area };
  }
  if (!eventEnabled(recipe, packCohort, settings.eventOverrides)) {
    return { kind: "event", cohort: recipe.event ?? "" };
  }
  if (manuallyDisabled(recipe, settings.disabledRecipeIds)) {
    return { kind: "manual", recipeId: recipe.id };
  }
  return null;
}

// The core's product: every unavailable recipe mapped to its cause. Plan
// validation reads the cause; the solver seam reads only the keys.
export function unavailableCauses(
  pack: RecipePack,
  settings: AvailabilitySettings,
): ReadonlyMap<RecipeId, ProducerUnavailableCause> {
  const packCohort = packCohortOf(pack);
  const machineLocations = new Map(
    pack.machines.map((m) => [m.id, m.locations]),
  );
  const causes = new Map<RecipeId, ProducerUnavailableCause>();
  for (const recipe of pack.recipes) {
    const cause = unavailableCauseOf(
      recipe,
      packCohort,
      machineLocations,
      settings,
    );
    if (cause !== null) causes.set(recipe.id, cause);
  }
  return causes;
}

// The availability seam the solver consumes: the cause map's keys and nothing
// else. Taking the map rather than the settings keeps the set in step with the
// exact map the app stabilized, so a no-op settings change cannot hand the
// solve path a fresh Set identity.
export function unavailableRecipeIds(
  causes: ReadonlyMap<RecipeId, ProducerUnavailableCause>,
): ReadonlySet<RecipeId> {
  return new Set(causes.keys());
}

// A deterministic digest of the cause map, for consumers that must react to a
// reason-only change (the same ids, a different switch behind them) and must
// NOT react to a re-derivation that says the same thing.
export function availabilityKey(
  causes: ReadonlyMap<RecipeId, ProducerUnavailableCause>,
): string {
  return [...causes]
    .map(([id, cause]) => `${id}:${cause.kind}:${causeDetail(cause)}`)
    .sort()
    .join("|");
}

function causeDetail(cause: ProducerUnavailableCause): string {
  switch (cause.kind) {
    case "area":
      return cause.area;
    case "event":
      return cause.cohort;
    case "manual":
      return cause.recipeId;
  }
}

// The ITEMS an off cohort removes from the game outright, each mapped to its
// own tag: an item's tag is what its tiles and validation errors speak of, and
// the extractor's mixed-cohort guard keeps a row's tag in agreement with its
// items, so this walks pack.items directly rather than reasoning over recipes.
//
// This is also the whole of what the INPUTS picker may dim. An area or a hand
// toggle says where a recipe can be built, which is no statement about the
// item: an input with no local producer is exactly the case an import covers.
// An off cohort is different in kind - the item does not exist to import.
export function unavailableEventItems(
  pack: RecipePack,
  settings: AvailabilitySettings,
): ReadonlyMap<string /*itemId*/, ProducerUnavailableCause> {
  const packCohort = packCohortOf(pack);
  const causes = new Map<string, ProducerUnavailableCause>();
  for (const item of pack.items) {
    if (item.event === undefined) continue;
    if (
      !effectiveCohortEnabled(item.event, packCohort, settings.eventOverrides)
    ) {
      causes.set(item.id, { kind: "event", cohort: item.event });
    }
  }
  return causes;
}

// Everything a picker of things to MAKE must dim: the cohort pass above plus a
// producer pass - an item every one of whose producers is off, by area, by
// cohort, or by hand, cannot be produced here, so it carries the outermost of
// their causes. An item claimed by the cohort pass keeps that cause; an item
// with no producers at all is not this seam's business (the plan loader reports
// it as not producible).
export function unavailableItems(
  pack: RecipePack,
  settings: AvailabilitySettings,
): ReadonlyMap<string /*itemId*/, ProducerUnavailableCause> {
  const causes = new Map(unavailableEventItems(pack, settings));

  const recipeCauses = unavailableCauses(pack, settings);
  if (recipeCauses.size === 0) return causes;

  for (const item of pack.items) {
    if (causes.has(item.id)) continue;
    const cause = producerUnavailableCause(pack, item.id, recipeCauses);
    if (cause) causes.set(item.id, cause);
  }
  return causes;
}

// The stored value is trusted exactly as far as the locale is: malformed JSON,
// a non-object, or non-boolean values fall back to the default rule ({}),
// because a damaged key should degrade to a fresh browser, not a broken boot.
export function readStoredEventOverrides(): EventCohortOverrides {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const overrides: EventCohortOverrides = {};
    for (const [cohort, value] of Object.entries(parsed)) {
      if (typeof value === "boolean") overrides[cohort] = value;
    }
    return overrides;
  } catch {
    // Some private-mode browsers throw on localStorage access, so just give up
    // and fall through.
  }
  return {};
}

export function writeStoredEventOverrides(next: EventCohortOverrides): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // If we can't persist the choice it's no big deal; the in-memory state
    // still drives the rest of the session.
  }
}

// The settlement a fresh browser starts in: the newest one. The pack carries no
// release field on a location, so recency is its list order - upstream appends
// each settlement as the game opens it (tundra, then jinlong), and the extractor
// copies that order verbatim. A pack with no settlement is a broken extract.
export function latestArea(pack: RecipePack): string {
  const latest = pack.locations.at(-1);
  if (latest === undefined) throw new Error("recipe pack lists no locations");
  return latest.id;
}

// The stored settlement (#124), validated against the pack's own location list.
// An absent key or an unknown id - hand-edited storage, or an area a pack bump
// retired - reads as the latest settlement. The key stays absent until the user
// picks one, so a pack that adds a settlement moves a fresh browser onto it.
export function readStoredArea(pack: RecipePack): string {
  if (typeof window === "undefined") return latestArea(pack);
  try {
    const raw = window.localStorage?.getItem(AREA_STORAGE_KEY);
    if (raw && pack.locations.some((l) => l.id === raw)) return raw;
  } catch {
    // Same private-mode fall-through as the overrides read above.
  }
  return latestArea(pack);
}

export function writeStoredArea(next: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(AREA_STORAGE_KEY, next);
  } catch {
    // As above: an unpersisted choice still drives this session.
  }
}
