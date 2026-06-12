// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
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
