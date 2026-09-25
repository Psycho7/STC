// Shared fixtures for the App suites that drive event-cohort availability
// (App.events.test.tsx, App.race.test.tsx). A plan constructor and one event
// shim only -- no assertions and no rendering.

import { fireEvent } from "@testing-library/react";
import { defaultPlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";

// The lung is v1.5 event content whose only producer is the event recipe of
// the same id: with the cohort on it solves through that recipe, with it off
// the target has no available producer at all.
export const LUNG_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "activity_xiranite_lung", ratePerSec: { num: "1", denom: "1" } },
  ],
};

// Simulate another tab flipping a cohort: same-document writes fire no
// `storage` event, so the test writes the key and then dispatches the event
// the browser would have delivered to the other windows.
export function flipStoredOverrides(json: string): void {
  window.localStorage.setItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY, json);
  fireEvent(
    window,
    new StorageEvent("storage", { key: EVENT_COHORT_OVERRIDES_STORAGE_KEY }),
  );
}
