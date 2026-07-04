// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { pack as realPack } from "../data/load";
import { TargetsPanel } from "./TargetsPanel";
import { LocaleProvider } from "../data/i18n-context";
import type { Target } from "../data/targets";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PACK = {
  items: [
    { id: "widget", icon: "widget" },
    { id: "gadget", icon: "gadget" },
    { id: "sprocket", icon: "sprocket" },
  ],
  recipes: [
    {
      id: "r_widget",
      category: "craft",
      in: [],
      out: [{ item: "widget", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
    {
      id: "r_gadget",
      category: "craft",
      in: [],
      out: [{ item: "gadget", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
    {
      id: "r_sprocket",
      category: "craft",
      in: [],
      out: [{ item: "sprocket", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
  ],
} as unknown as RecipePack;

function targets3(): Target[] {
  return [
    { recipeId: "r_widget", ratePerSec: { num: "2", denom: "1" } }, // 120/min
    { recipeId: "r_gadget", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    { recipeId: "r_sprocket", ratePerSec: { num: "1", denom: "4" } }, // 15/min
  ];
}

function rateInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole("textbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

// Synchronous parent harness: applies every change immediately, the best case
// for the panel. Guards the index-keying leg of the wrong-row defect.
test("pending rate edit lands on the edited target after removing a row above", () => {
  let latest: Target[] = targets3();
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  // Type 99/min into row 1 (r_gadget)...
  fireEvent.change(rateInputs()[1]!, { target: { value: "99" } });
  // ...then remove row 0 (r_widget) within the debounce window.
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  act(() => vi.advanceTimersByTime(200));

  expect(latest.map((t) => t.recipeId)).toEqual(["r_gadget", "r_sprocket"]);
  const gadget = latest.find((t) => t.recipeId === "r_gadget")!;
  const sprocket = latest.find((t) => t.recipeId === "r_sprocket")!;
  // 99/min = 33/20 per sec, on the row the user actually edited.
  expect(gadget.ratePerSec).toEqual({ num: "33", denom: "20" });
  expect(sprocket.ratePerSec).toEqual({ num: "1", denom: "4" });
});

// Removing the row that itself has a pending edit must cancel the edit: no
// commit may fire for a recipe that is gone.
test("removing the row with the pending edit cancels its debounce", () => {
  let latest: Target[] = targets3();
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return; // owner-side no-op skip, like App
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  act(() => vi.advanceTimersByTime(200));

  expect(latest.map((t) => t.recipeId)).toEqual(["r_gadget", "r_sprocket"]);
  // Exactly one emission: the removal. The orphaned rate edit never commits.
  expect(emissions.length).toBe(1);
  expect(latest.find((t) => t.recipeId === "r_gadget")!.ratePerSec).toEqual({
    num: "1",
    denom: "2",
  });
});

// Async parent harness modelling App: updaters are applied against an
// authoritative list immediately, but the prop re-render lags behind by a
// simulated solve delay. The removed row must never reappear in any applied
// state, no matter how stale the prop snapshot is when the debounce fires.
test("pending edit plus remove does not resurrect the removed row", () => {
  let authoritative: Target[] = [
    { recipeId: "r_widget", ratePerSec: { num: "1", denom: "1" } },
    { recipeId: "r_gadget", ratePerSec: { num: "2", denom: "1" } },
  ];
  const applied: string[][] = [];
  function Parent() {
    const [t, setT] = useState(authoritative);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            authoritative = update(authoritative);
            applied.push(authoritative.map((x) => x.recipeId));
            // Solve + layout latency before the prop catches up.
            setTimeout(() => setT(authoritative), 120);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  // Type into row 1, then remove row 0 before the debounce fires.
  fireEvent.change(rateInputs()[1]!, { target: { value: "600" } });
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  act(() => vi.advanceTimersByTime(1000));

  expect(authoritative).toEqual([
    { recipeId: "r_gadget", ratePerSec: { num: "10", denom: "1" } },
  ]);
  for (const ids of applied) expect(ids).not.toContain("r_widget");
});

// Unparseable in-progress text must survive the debounce: the user is mid-way
// through typing a rational and the field must not snap back to the prop.
test("invalid rate text is kept after the debounce, then commits once valid", () => {
  let latest: Target[] = [
    { recipeId: "r_widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  expect(input.value).toBe("120");
  fireEvent.change(input, { target: { value: "1/" } });
  act(() => vi.advanceTimersByTime(200));
  expect(input.value).toBe("1/");
  expect(emissions.length).toBe(0);
  // Completing the rational commits exactly once: 1/3 per min = 1/180 per sec.
  fireEvent.change(input, { target: { value: "1/3" } });
  act(() => vi.advanceTimersByTime(200));
  expect(emissions.length).toBe(1);
  expect(latest).toEqual([
    { recipeId: "r_widget", ratePerSec: { num: "1", denom: "180" } },
  ]);
  // The field keeps the committed "1/3" rather than re-serializing 1/180 per sec
  // into a 16-digit float like "0.3333333333333333".
  expect(input.value).toBe("1/3");
});

test("locale-comma rate text is kept after the debounce with no commit", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { recipeId: "r_widget", ratePerSec: { num: "2", denom: "1" } },
        ]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "1,5" } });
  act(() => vi.advanceTimersByTime(200));
  expect(input.value).toBe("1,5");
  expect(onChange).not.toHaveBeenCalled();
});

// An in-flight rate edit follows the row when the user swaps its recipe.
test("pending rate edit follows the row across a recipe swap", () => {
  let latest: Target[] = [
    { recipeId: "r_widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  fireEvent.change(rateInputs()[0]!, { target: { value: "99" } });
  const select = screen.getByLabelText(/recipe/i);
  fireEvent.change(select, { target: { value: "r_gadget" } });
  // The typed text is still shown on the swapped row.
  expect(rateInputs()[0]!.value).toBe("99");
  act(() => vi.advanceTimersByTime(200));
  expect(latest).toEqual([
    { recipeId: "r_gadget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

// Real-pack picker gate: no-output recipes (waste sinks and pure consumers
// like sewage-treat and the power_* battery burners) must never appear in the
// recipe dropdown - a target rate is undefined for a recipe with no outputs.
test("recipe picker excludes every no-output recipe in the real pack", () => {
  const firstPickable = realPack.recipes.find(
    (r) =>
      r.category !== "__internal" &&
      r.category !== "__domain_transfer" &&
      r.out.length > 0,
  )!;
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { recipeId: firstPickable.id, ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={realPack}
      />
    </LocaleProvider>,
  );
  const options = screen
    .getAllByRole("option")
    .map((o) => (o as HTMLOptionElement).value);
  for (const r of realPack.recipes.filter((x) => x.out.length === 0)) {
    expect(options, r.id).not.toContain(r.id);
  }
});

// Add must keep seeding rows while unused pickable recipes remain (a vestigial
// solver gate used to make it silently no-op far short of the pickable count)
// and its auto-pick must never land on a no-output recipe.
test("Add keeps working past 60 rows and never seeds a no-output recipe", () => {
  let latest: Target[] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={realPack}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const addButton = screen.getByRole("button", { name: "Add target" });
  for (let i = 1; i <= 60; i++) {
    fireEvent.click(addButton);
    expect(latest.length, `after click ${i}`).toBe(i);
  }
  const noOut = new Set(
    realPack.recipes.filter((r) => r.out.length === 0).map((r) => r.id),
  );
  for (const t of latest) {
    expect(noOut.has(t.recipeId), t.recipeId).toBe(false);
  }
});

// Selecting a recipe already used by another row is rejected inline: an alert
// names the duplicate recipe and no change commits.
test("duplicate recipe selection shows an inline alert and does not commit", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { recipeId: "r_widget", ratePerSec: { num: "1", denom: "1" } },
          { recipeId: "r_gadget", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const selects = screen.getAllByLabelText(/recipe/i);
  fireEvent.change(selects[1]!, { target: { value: "r_widget" } });
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toMatch(/r_widget/);
});

// Exhaustion semantics: Add no-ops only once every pickable recipe is used.
test("Add no-ops only when every pickable recipe is used", () => {
  let latest: Target[] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const addButton = screen.getByRole("button", { name: "Add target" });
  for (let i = 1; i <= 3; i++) {
    fireEvent.click(addButton);
    expect(latest.length, `after click ${i}`).toBe(i);
  }
  fireEvent.click(addButton);
  expect(latest.length).toBe(3);
});
