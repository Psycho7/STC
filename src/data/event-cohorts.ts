// The event-cohort model (#144): which recipes exist right now.
//
// Event content is tagged with a cohort (the v<major>.<minor> of the AKEData
// game version that first shipped it) by the extractor; whether a cohort is
// currently on is app-level state, not plan state, so it lives here between
// the recipe pack and localStorage rather than riding the plan wire. The
// derived unavailable-id set this module hands back is the availability seam
// the solver, plan validation, and the pickers consume.
//
// No React import on purpose: the bun CLIs can adopt the same effective-state
// rule later without pulling the app in.

import type { RecipePack } from "@aef/schema";
import type { RecipeId } from "../solver/types";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY as STORAGE_KEY } from "./storage-keys";

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

// The recipes switched off under the current overrides: every event recipe
// whose cohort is effectively disabled. Non-event recipes never appear - the
// set is exactly what the availability seam (#144, later #124/#125) consumes.
export function unavailableRecipeIds(
  pack: RecipePack,
  overrides: EventCohortOverrides,
): ReadonlySet<RecipeId> {
  const packCohort = packCohortOf(pack);
  const ids = new Set<RecipeId>();
  for (const recipe of pack.recipes) {
    if (recipe.event === undefined) continue;
    if (!effectiveCohortEnabled(recipe.event, packCohort, overrides)) {
      ids.add(recipe.id);
    }
  }
  return ids;
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
