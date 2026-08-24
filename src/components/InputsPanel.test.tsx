// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { InputsPanel, displayedInputCount } from "./InputsPanel";
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

// The supply counters must count the rows the panel actually renders: with no
// overrides, the assumed-raw auto-rows are on screen, so a count of 0 lies.
test("supply head count includes assumed-raw auto rows, not just overrides", () => {
  const { container } = render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={PACK3}
        assumedRawItemIds={["widget", "gadget"]}
        realizedRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  const v = container.querySelector(".side-section-head .count .v");
  expect(v?.textContent).toBe("2");
});

test("displayedInputCount counts overrides plus non-overridden auto rows", () => {
  expect(displayedInputCount([], ["a", "b", "c"])).toBe(3);
  // "a" is overridden, so it counts once (as an override), and b + c stay as
  // auto rows: 1 override + 2 auto = 3.
  expect(displayedInputCount([{ itemId: "a" }], ["a", "b", "c"])).toBe(3);
  // A non-raw override adds to the three auto rows: 1 + 3 = 4.
  expect(displayedInputCount([{ itemId: "z" }], ["a", "b", "c"])).toBe(4);
  expect(displayedInputCount([], [])).toBe(0);
});

// D5: an override on one item must not hide the assumed-raw auto-rows for the
// items that still have no explicit override.
test("assumed-raw items without an override stay visible alongside an override", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK3}
        assumedRawItemIds={["widget", "gadget", "sprocket"]}
        realizedRateByItem={
          new Map([
            ["gadget", { num: "1", denom: "1" }],
            ["sprocket", { num: "2", denom: "1" }],
          ])
        }
      />
    </LocaleProvider>,
  );
  const autoRows = screen.getAllByTestId("input-auto-row");
  // widget is the override; gadget + sprocket remain auto-rows with demand.
  expect(autoRows.map((r) => r.getAttribute("data-item-id"))).toEqual([
    "gadget",
    "sprocket",
  ]);
  expect(screen.getAllByTestId("input-row").length).toBe(1);
  // Counter reflects the union (1 override + 2 auto = 3).
  const { container } = render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK3}
        assumedRawItemIds={["widget", "gadget", "sprocket"]}
        realizedRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  expect(
    container.querySelector(".side-section-head .count .v")?.textContent,
  ).toBe("3");
});

// 40/27 per sec * 60 = 800/9 = 88.888.../min. The realized-demand readout now
// shares the canvas chip's decimal formatter, so it shows "88.89" -- never a
// vulgar fraction next to decimals, never the raw 88.8888888888889 float.
test("realized input demand renders as the shared decimal, not a fraction", () => {
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
  expect(readout.textContent).toContain("88.89");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// The override-row readout is a separate JSX path from the auto-row above, so
// cover both override flavors.
test("realized demand on an uncapped override row renders as the shared decimal", () => {
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
  expect(readout.textContent).toContain("88.89");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// Typing a cap does not commit until blur.
test("typing a cap does not commit; blur commits it", () => {
  let latest: ItemOverride[] = [{ itemId: "widget" }];
  const emissions: ItemOverride[][] = [];
  function Parent() {
    const [o, setO] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={o}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setO(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "120" } });
  expect(emissions.length).toBe(0);
  fireEvent.blur(input);
  // 120/min = 2/1 per sec.
  expect(latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
});

// Blur with an empty cap uncaps the override (empty means Unlimited here).
test("blurring an emptied cap uncaps the override", () => {
  let latest: ItemOverride[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  function Parent() {
    const [o, setO] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={o}
          onChange={(update) => {
            latest = update(latest);
            setO(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(latest).toEqual([{ itemId: "widget" }]);
});

// Removing a row with an uncommitted cap edit must never commit that edit.
test("removing a row with an uncommitted edit does not commit it", () => {
  vi.useFakeTimers();
  let latest: ItemOverride[] = [
    { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "gadget", ratePerSec: { num: "2", denom: "1" } },
    { itemId: "sprocket", ratePerSec: { num: "3", denom: "1" } },
  ];
  const emissions: ItemOverride[][] = [];
  function Parent() {
    const [o, setO] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={o}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setO(latest);
          }}
          pack={PACK3}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  // Type into row 0 (widget) but never blur; then remove it.
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-input")[0]!);
  expect(latest.map((o) => o.itemId)).toEqual(["gadget", "sprocket"]);
  expect(emissions.length).toBe(1);
});

// A cap typed into an auto-row promotes it to an override on blur; when that
// override is later removed, the reborn auto-row must be back to Unlimited, not
// show the stale typed text.
test("orphaned auto-row text does not resurrect after override removal", () => {
  const updaters: Array<(cur: ItemOverride[]) => ItemOverride[]> = [];
  const ui = (overrides: ItemOverride[]) => (
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={overrides}
        onChange={(u) => updaters.push(u)}
        pack={PACK}
        assumedRawItemIds={["widget"]}
        realizedRateByItem={new Map()}
      />
    </LocaleProvider>
  );
  const { rerender } = render(ui([]));
  const input = screen.getByTestId("input-auto-row").querySelector("input")!;
  fireEvent.change(input, { target: { value: "100" } });
  fireEvent.blur(input);
  // The commit emits an updater adding the override: 100/min = 5/3 per sec.
  expect(updaters.length).toBe(1);
  expect(updaters[0]!([])).toEqual([
    { itemId: "widget", ratePerSec: { num: "5", denom: "3" } },
  ]);
  // Solve lands; the override row replaces the auto-row.
  rerender(ui([{ itemId: "widget", ratePerSec: { num: "5", denom: "3" } }]));
  // The override is removed elsewhere; the auto-row is reborn.
  rerender(ui([]));
  const reborn = screen.getByTestId("input-auto-row").querySelector("input")!;
  expect(reborn.value).toBe("");
  expect(reborn.placeholder).toMatch(/unlimited/i);
});

// INVALID text in an auto-row surfaces the invalid cue on Enter and stays
// visible so the user can fix the typo; nothing is committed.
test("Enter on invalid auto-row text shows the cue and keeps the text", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={PACK}
        assumedRawItemIds={["widget"]}
        realizedRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  const input = screen.getByTestId("input-auto-row").querySelector("input")!;
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("1/");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(onChange).not.toHaveBeenCalled();
});

// Blur on an invalid cap reverts the field to the last-good value.
test("blur on invalid cap reverts an override row to its last-good value", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  expect(input.value).toBe("60");
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.blur(input);
  expect(input.value).toBe("60");
  expect(input.getAttribute("aria-invalid")).toBeNull();
});

// An empty auto-row is the Unlimited state, not an error: blur leaves it empty
// and un-flagged, and the placeholder explains the default.
test("an empty auto-row stays Unlimited with no invalid cue", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={PACK}
        assumedRawItemIds={["widget"]}
        realizedRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  const input = screen.getByTestId("input-auto-row").querySelector("input")!;
  expect(input.placeholder).toMatch(/unlimited/i);
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(input.value).toBe("");
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

// Navigation remounts the panel via a plan-identity key, discarding an
// uncommitted cap edit.
test("uncommitted cap edit is discarded when the plan changes", () => {
  function Parent() {
    const [epoch, setEpoch] = useState(0);
    const [o, setO] = useState<ItemOverride[]>([
      { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
    ]);
    return (
      <LocaleProvider locale="en">
        <button
          data-testid="navigate"
          onClick={() => {
            setO([{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]);
            setEpoch((e) => e + 1);
          }}
        />
        <InputsPanel
          key={epoch}
          itemOverrides={o}
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
  fireEvent.click(screen.getByTestId("navigate"));
  expect(rateInputs()[0]!.value).toBe("60");
});

test("realized demand on a capped override row renders as the shared decimal", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={PACK}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("88.89");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});
