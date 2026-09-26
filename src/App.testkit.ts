// Shared fixtures for the App suites: plan constructors, storage-event shims,
// a deferred promise and the Canvas status spy. No assertions and no
// rendering.

import { fireEvent } from "@testing-library/react";
import { defaultPlan, type Plan } from "./data/plan";
import { pack } from "./data/load";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY,
} from "./data/storage-keys";

// The lung is v1.5 event content whose only producer is the event recipe of
// the same id: with the cohort on it solves through that recipe, with it off
// the target has no available producer at all.
export const LUNG_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "activity_xiranite_lung", ratePerSec: { num: "1", denom: "1" } },
  ],
};

// Solves in full under either area, so it can stand as a drawn plan.
export const POWDER_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "iron_powder", ratePerSec: { num: "1", denom: "1" } }],
};

// copper_nugget is Wuling-only, so under Valley IV this plan is blocked.
export const NUGGET_AND_POWDER_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "copper_nugget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "iron_powder", ratePerSec: { num: "1", denom: "1" } },
  ],
};

// Valley IV: the area under which copper_nugget has no buildable producer.
export const VALLEY = "tundra";

// The last status App handed the mocked Canvas. A vi.mock factory cannot
// import this statically (it is hoisted above the imports), so each suite's
// factory reaches it through `await import("./App.testkit")`.
export const canvasSpy = { status: "" };

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

// The same cross-tab shim for the area setting; undefined clears the key.
export function flipStoredArea(area: string | undefined): void {
  if (area === undefined) window.localStorage.removeItem(AREA_STORAGE_KEY);
  else window.localStorage.setItem(AREA_STORAGE_KEY, area);
  fireEvent(window, new StorageEvent("storage", { key: AREA_STORAGE_KEY }));
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
