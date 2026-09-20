// @vitest-environment jsdom
//
// End-to-end guard that App commits plan state synchronously: a second rate
// edit (committed on blur) made while the first edit's solve is still in flight
// must not revert the first edit, and both edits must reach the encoded URL
// hash. A second guard proves the debounce race is gone: an uncommitted edit
// left in a field when the plan is navigated away is discarded, never applied
// to the newly loaded plan. A third guard covers the other half of that
// contract: committing one row must NOT remount the panel, so an uncommitted
// edit sitting in another row survives. A fourth covers the reverse ordering:
// an edit or a view-toggle started while a hash navigation is still landing is
// refused outright rather than winning the race and rewriting the URL back to
// the plan the user just navigated away from. A fifth pair covers the other
// rejection site: when an availability flip (from another tab or from this
// tab's settings panel) rejects the committed plan, the solve already in flight
// for that plan must not land - it would clear the banner and rewrite the URL
// to a plan that fails to load.
//
// The solve window is made deterministic by mocking layoutRenderPlan with a
// manually resolved deferred, so no real-timing race window is involved.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const layoutGate = vi.hoisted(() => ({
  pending: [] as Array<() => void>,
}));

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(
      () =>
        new Promise((resolve) => {
          layoutGate.pending.push(() => resolve({ nodes: [], edges: [] }));
        }),
    ),
  };
});

import App from "./App";
import {
  defaultPlan,
  encodePlan,
  loadPlan,
  validatePlan,
  type Plan,
} from "./data/plan";
import { pack } from "./data/load";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";

// Plan B: the default plan minus its last target, distinguishable by row count.
async function encodePlanB(): Promise<string> {
  const a = defaultPlan(pack);
  const b = { ...a, targets: a.targets.slice(0, a.targets.length - 1) };
  if (validatePlan(b, pack)) throw new Error("plan B unexpectedly invalid");
  return "#" + (await encodePlan(b));
}

// The lung is v1.5 event content whose only producer is the event recipe of the
// same id, so switching the cohort off is a plan-rejecting availability change.
const LUNG_PLAN: Plan = {
  ...defaultPlan(pack),
  targets: [
    { itemId: "activity_xiranite_lung", ratePerSec: { num: "1", denom: "1" } },
  ],
};

// Another tab flipping a cohort: a same-document write fires no `storage`
// event, so write the key and dispatch the event the browser would deliver.
function flipStoredOverridesInAnotherTab(json: string): void {
  window.localStorage.setItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY, json);
  fireEvent(
    window,
    new StorageEvent("storage", { key: EVENT_COHORT_OVERRIDES_STORAGE_KEY }),
  );
}

// The header status chip, read off the one chip whose whole text is a status.
function statusChip(): string {
  const chip = Array.from(document.querySelectorAll(".stat-chip")).find((c) =>
    /^(READY|SOLVING|ERROR)$/.test(c.textContent ?? ""),
  );
  if (!chip) throw new Error("no status chip rendered");
  return chip.textContent!;
}

// Commit a rate edit on the single-target lung plan and leave its solve held by
// the layout gate. Returns the hash as it stood before the edit.
async function commitHeldRateEdit(): Promise<string> {
  const hashBeforeEdit = window.location.hash;
  const input = within(screen.getByTestId("targets-section")).getByLabelText(
    /rate/i,
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "600" } });
  fireEvent.blur(input);
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  return hashBeforeEdit;
}

// Release the held solve and assert it was dropped. The drain gives the stale
// generation every turn it needs to encode and write its hash, so the negative
// assertions below are not just winning a race: on the unfixed app the solve
// lands inside this window.
async function releaseAndExpectInvalidated(
  hashBeforeEdit: string,
): Promise<void> {
  await act(async () => {
    layoutGate.pending.shift()!();
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });

  expect(window.location.hash).toBe(hashBeforeEdit);
  expect(statusChip()).toBe("ERROR");
  expect(screen.getByRole("alert")).toBeTruthy();
}

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none, and
  // without the stub React 19 tears the whole tree down on mount.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  // Pin the locale; App's LocaleProvider defaults to zh otherwise.
  window.localStorage.setItem("aef.locale", "en");
  // The availability cases below store cohort overrides; start from the pack's
  // own defaults so a leftover key cannot reject another test's plan at boot.
  window.localStorage.removeItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  layoutGate.pending.length = 0;
  window.location.hash = "";
});

test("second edit during an in-flight solve keeps both edits and the hash", async () => {
  render(<App />);

  // Initial load of the seeded default plan; release its layout.
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  const hashAfterLoad = window.location.hash;

  const targetsSection = screen.getByTestId("targets-section");
  const inputs = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  expect(inputs.length).toBe(3);
  expect(inputs[0]!.value).toBe("120"); // copper_bottle 2/s
  expect(inputs[1]!.value).toBe("30"); // copper_powder 1/2 per sec

  // Edit 1: row 0 -> 600/min, committed on blur. The commit must land in plan
  // state synchronously, while the solve (gated layout) is still pending.
  fireEvent.change(inputs[0]!, { target: { value: "600" } });
  fireEvent.blur(inputs[0]!);
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  expect(inputs[0]!.value).toBe("600");

  // Edit 2: row 1 -> 99/min while solve 1 has not landed.
  fireEvent.change(inputs[1]!, { target: { value: "99" } });
  fireEvent.blur(inputs[1]!);
  await waitFor(() => expect(layoutGate.pending.length).toBe(2));
  expect(inputs[0]!.value).toBe("600");
  expect(inputs[1]!.value).toBe("99");

  // Release both solves in order; the newest generation wins. The shift order
  // (solve 1 before solve 2) is what makes the solveGen guard deterministic
  // here - reordering would silently invert the stale-result scenario.
  layoutGate.pending.shift()!();
  layoutGate.pending.shift()!();

  await waitFor(() => expect(window.location.hash).not.toBe(hashAfterLoad));
  const outcome = await loadPlan(window.location.hash, pack);
  expect(outcome.kind).toBe("loaded");
  if (outcome.kind !== "loaded") return;
  const byId = new Map(
    outcome.plan.targets.map((t) => [t.itemId, t.ratePerSec]),
  );
  expect(byId.get("copper_bottle")).toEqual({ num: "10", denom: "1" });
  expect(byId.get("copper_powder")).toEqual({ num: "33", denom: "20" });
  expect(byId.get("iron_powder")).toEqual({ num: "1", denom: "4" });
  expect(inputs[0]!.value).toBe("600");
  expect(inputs[1]!.value).toBe("99");
});

test("an uncommitted edit is discarded when the plan is navigated away", async () => {
  render(<App />);

  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  const targetsSection = screen.getByTestId("targets-section");
  const before = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  expect(before.length).toBe(3);
  expect(before[0]!.value).toBe("120");

  // Type an uncommitted edit into row 0 (no blur, so nothing commits).
  fireEvent.change(before[0]!, { target: { value: "999" } });
  expect(before[0]!.value).toBe("999");
  // No solve was triggered by typing alone.
  expect(layoutGate.pending.length).toBe(0);

  // Navigate to plan B via hash. The stale "999" must not reach the new plan.
  window.location.hash = await encodePlanB();
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();

  await waitFor(() =>
    expect(
      within(screen.getByTestId("targets-section")).getAllByTestId("target-row")
        .length,
    ).toBe(2),
  );
  const after = within(screen.getByTestId("targets-section")).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  // Plan B's own first target rate, not the discarded "999".
  expect(after[0]!.value).toBe("120");
  // The navigation solve encoded plan B (2 targets), untouched by the edit.
  const outcome = await loadPlan(window.location.hash, pack);
  expect(outcome.kind).toBe("loaded");
  if (outcome.kind !== "loaded") return;
  expect(outcome.plan.targets.length).toBe(2);
});

test("an uncommitted edit survives a commit in another row", async () => {
  render(<App />);

  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));
  const hashAfterLoad = window.location.hash;

  const targetsSection = screen.getByTestId("targets-section");
  const inputs = within(targetsSection).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  expect(inputs.length).toBe(3);
  expect(inputs[0]!.value).toBe("120");
  expect(inputs[1]!.value).toBe("30");

  // Row 1: typed but never blurred, so nothing commits and no solve runs.
  fireEvent.change(inputs[1]!, { target: { value: "777" } });
  expect(inputs[1]!.value).toBe("777");
  expect(layoutGate.pending.length).toBe(0);

  // Row 0: a real blur commit. It replaces the plan, but a mutation commit must
  // not bump planEpoch, so the panel keeps its identity.
  fireEvent.change(inputs[0]!, { target: { value: "600" } });
  fireEvent.blur(inputs[0]!);
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await waitFor(() => expect(window.location.hash).not.toBe(hashAfterLoad));

  // Re-query rather than reusing the captured elements: a remount swaps in new
  // input nodes, and the detached originals would keep their old values and
  // hide the regression.
  const after = within(screen.getByTestId("targets-section")).getAllByLabelText(
    /rate/i,
  ) as HTMLInputElement[];
  expect(after.length).toBe(3);
  // The commit landed...
  expect(after[0]!.value).toBe("600");
  // ...and row 1's uncommitted text was not wiped by a panel remount ("30" here
  // means the panel remounted and dropped the in-flight edit).
  expect(after[1]!.value).toBe("777");
});

test("an edit made while a hash navigation is landing is refused", async () => {
  render(<App />);

  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(window.location.hash).not.toBe(""));

  // Navigate to plan B and hold its layout, so the navigation is in flight for
  // the whole edit below.
  window.location.hash = await encodePlanB();
  await waitFor(() => expect(layoutGate.pending.length).toBe(1));

  const inputs = within(
    screen.getByTestId("targets-section"),
  ).getAllByLabelText(/rate/i) as HTMLInputElement[];
  fireEvent.change(inputs[0]!, { target: { value: "600" } });
  fireEvent.blur(inputs[0]!);

  // Refused with a reason, and no second solve was started.
  const banner = await screen.findByRole("alert");
  expect(banner.textContent).toMatch(/loading/i);
  expect(layoutGate.pending.length).toBe(1);

  // The navigation lands as plan B and clears the banner; the refused edit
  // reached neither the plan nor the URL.
  layoutGate.pending.shift()!();
  await waitFor(() =>
    expect(
      within(screen.getByTestId("targets-section")).getAllByTestId("target-row")
        .length,
    ).toBe(2),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  const outcome = await loadPlan(window.location.hash, pack);
  expect(outcome.kind).toBe("loaded");
  if (outcome.kind !== "loaded") return;
  expect(outcome.plan.targets.length).toBe(2);
  const byId = new Map(
    outcome.plan.targets.map((t) => [t.itemId, t.ratePerSec]),
  );
  expect(byId.get("copper_bottle")).toEqual({ num: "2", denom: "1" });
});

// The availability rejection is not a refusal like the one above: the edit has
// already committed and its solve is running. Letting it land would clear the
// banner the rejection just raised and write the URL of a plan that no longer
// validates, so reloading that URL errors.
test("a cross-tab availability flip invalidates the in-flight solve", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(statusChip()).toBe("READY"));

  const hashBeforeEdit = await commitHeldRateEdit();

  // Another tab switches the cohort the committed target depends on off. The
  // re-validation rejects the plan while its solve is still held.
  flipStoredOverridesInAnotherTab('{"v1.5": false}');
  await screen.findByRole("alert");

  await releaseAndExpectInvalidated(hashBeforeEdit);
});

test("a settings-panel availability flip invalidates the in-flight solve", async () => {
  window.location.hash = "#" + (await encodePlan(LUNG_PLAN));
  render(<App />);

  await waitFor(() => expect(layoutGate.pending.length).toBe(1));
  layoutGate.pending.shift()!();
  await screen.findAllByTestId("target-row");
  await waitFor(() => expect(statusChip()).toBe("READY"));

  const hashBeforeEdit = await commitHeldRateEdit();

  // Same tab, no storage event: the gear's own switch writes the override.
  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  fireEvent.click(
    screen.getByRole("switch", { name: "Toggle the v1.5 event" }),
  );
  await screen.findByRole("alert");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  await releaseAndExpectInvalidated(hashBeforeEdit);
});
