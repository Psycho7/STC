// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { InputsPanel } from "./InputsPanel";
import { LocaleProvider } from "../data/i18n-context";
import type { ItemOverride } from "../data/plan";

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

const PACK = {
  items: [{ id: "widget", icon: "widget" }],
  recipes: [],
} as unknown as RecipePack;

const PACK3 = {
  items: [
    { id: "widget", icon: "widget" },
    { id: "gadget", icon: "gadget" },
    { id: "sprocket", icon: "sprocket" },
  ],
  recipes: [],
} as unknown as RecipePack;

function rateInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole("textbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

// 40/27 per sec * 60 = 800/9 per min, a non-terminating decimal. The
// realized-demand readout shows the exact fraction (matching the canvas
// ProductNode), never the raw 88.8888888888889 float.
test("realized input demand renders as an exact fraction, not a raw float", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={PACK}
        assumedRawItemIds={["widget"]}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// The override-row readout is a separate JSX path from the auto-row above, so
// cover both override flavors.
test("realized demand on an uncapped override row renders as an exact fraction", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// Synchronous parent harness: a pending cap edit must land on the item the
// user edited, not whatever row slid into that index after a removal.
test("pending cap edit lands on the edited item after removing a row above", () => {
  vi.useFakeTimers();
  let latest: ItemOverride[] = [
    { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "gadget", ratePerSec: { num: "2", denom: "1" } },
    { itemId: "sprocket", ratePerSec: { num: "3", denom: "1" } },
  ];
  function Parent() {
    const [o, setO] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={o}
          onChange={(next) => {
            latest = next;
            setO(next);
          }}
          pack={PACK3}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  // Type 99/min into row 1 (gadget)...
  fireEvent.change(rateInputs()[1]!, { target: { value: "99" } });
  // ...then remove row 0 (widget) within the debounce window.
  fireEvent.click(screen.getAllByTestId("remove-input")[0]!);
  act(() => vi.advanceTimersByTime(200));

  expect(latest.map((o) => o.itemId)).toEqual(["gadget", "sprocket"]);
  expect(latest.find((o) => o.itemId === "gadget")!.ratePerSec).toEqual({
    num: "33",
    denom: "20",
  });
  expect(latest.find((o) => o.itemId === "sprocket")!.ratePerSec).toEqual({
    num: "3",
    denom: "1",
  });
});

// Pin: the keep-on-INVALID behavior of override rows must survive the rekeying.
test("invalid cap text in an override row is kept after the debounce", () => {
  vi.useFakeTimers();
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  expect(input.value).toBe("60");
  fireEvent.change(input, { target: { value: "1/" } });
  act(() => vi.advanceTimersByTime(200));
  expect(input.value).toBe("1/");
});

test("realized demand on a capped override row renders as an exact fraction", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});
