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

// Typing alone must never commit: the whole point of moving off the debounce is
// that no half-typed magnitude reaches the solver.
test("typing a rate does not commit, even after time passes", () => {
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
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.change(input, { target: { value: "0." } });
  fireEvent.change(input, { target: { value: "0.5" } });
  act(() => vi.advanceTimersByTime(1000));
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe("0.5");
});

test("blur commits the parsed value exactly once", () => {
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
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  expect(emissions.length).toBe(1);
  // 99/min = 33/20 per sec.
  expect(latest).toEqual([
    { recipeId: "r_widget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

test("Enter commits the parsed value", () => {
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
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // 45/min = 3/4 per sec.
  expect(latest).toEqual([
    { recipeId: "r_widget", ratePerSec: { num: "3", denom: "4" } },
  ]);
});

// The committed text is kept verbatim: a valid "1/3" is not re-serialized into a
// 16-digit float, and an invalid in-progress "1/" survives a blur without
// committing so the user can keep typing.
test("invalid text stays put on blur; a valid rational commits and keeps its text", () => {
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
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.blur(input);
  expect(input.value).toBe("1/");
  expect(emissions.length).toBe(0);
  fireEvent.change(input, { target: { value: "1/3" } });
  fireEvent.blur(input);
  expect(emissions.length).toBe(1);
  // 1/3 per min = 1/180 per sec.
  expect(latest).toEqual([
    { recipeId: "r_widget", ratePerSec: { num: "1", denom: "180" } },
  ]);
  // Field keeps "1/3", not "0.3333333333333333".
  expect(input.value).toBe("1/3");
});

// A re-blur without a fresh edit does not re-commit: exactly one solve per edit.
test("blurring again without editing does not emit a second commit", () => {
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
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  fireEvent.blur(input);
  expect(emissions.length).toBe(1);
});

// An in-flight (uncommitted) rate edit follows the row when the user swaps its
// recipe, then commits to the new id on blur.
test("uncommitted rate edit follows the row across a recipe swap", () => {
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
  fireEvent.blur(rateInputs()[0]!);
  expect(latest).toEqual([
    { recipeId: "r_gadget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

// Removing a row that has an uncommitted edit must never commit that edit.
test("removing a row with an uncommitted edit does not commit it", () => {
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
  // Type into row 0 but never blur; then remove it.
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  expect(latest.map((t) => t.recipeId)).toEqual(["r_gadget", "r_sprocket"]);
  // Exactly one emission: the removal. The orphaned edit never commits.
  expect(emissions.length).toBe(1);
});

// Replacing the plan (navigation) remounts the panel via a plan-identity key,
// discarding any uncommitted local edit: the field falls back to the newly
// loaded value rather than showing leftover text.
test("uncommitted edit is discarded when the plan changes", () => {
  function Parent() {
    const [epoch, setEpoch] = useState(0);
    const [t, setT] = useState<Target[]>([
      { recipeId: "r_widget", ratePerSec: { num: "2", denom: "1" } },
    ]);
    return (
      <LocaleProvider locale="en">
        <button
          data-testid="navigate"
          onClick={() => {
            setT([{ recipeId: "r_widget", ratePerSec: { num: "1", denom: "1" } }]);
            setEpoch((e) => e + 1);
          }}
        />
        <TargetsPanel
          key={epoch}
          targets={t}
          onChange={() => {}}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "777" } });
  expect(input.value).toBe("777");
  // Navigate: new plan value is 60/min (1/s), and the stale "777" is dropped.
  fireEvent.click(screen.getByTestId("navigate"));
  expect(rateInputs()[0]!.value).toBe("60");
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
    .map((o) => (o as HTMLOptionElement).value)
    .filter((v) => v !== "");
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
