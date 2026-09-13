// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InputsPanel, displayedInputCount } from "./InputsPanel";
import { makePack } from "../solver/closed-form-fixtures";
import { LocaleProvider } from "../data/i18n-context";
import type { ItemOverride } from "../data/plan";
import { controlledOwner, rateInputs } from "./panel.testkit";

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

const PACK = makePack([], [{ id: "widget" }]);

const PACK3 = makePack(
  [],
  [{ id: "widget" }, { id: "gadget" }, { id: "sprocket" }],
);

// The two transmuter catalysts: liquid_xiranite is not a raw item and only
// ever reaches the panel through the catalyst draw, gas_xiranite is raw and
// can carry a balanced draw as well.
const CATALYST_PACK = makePack(
  [],
  [{ id: "liquid_xiranite" }, { id: "gas_xiranite", raw: true }],
);
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
        supplyRateByItem={new Map()}
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
        supplyRateByItem={
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
        supplyRateByItem={new Map()}
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
        supplyRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
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
        supplyRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("88.89");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// Typing a cap does not commit until blur.
test("typing a cap does not commit; blur commits it", () => {
  const owner = controlledOwner<ItemOverride[]>([{ itemId: "widget" }]);
  render(
    owner.element((overrides, onChange) => (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={PACK}
        />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "120" } });
  expect(owner.emissions.length).toBe(0);
  fireEvent.blur(input);
  // 120/min = 2/1 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
});

// Blur with an empty cap uncaps a RAW override (empty means Unlimited here).
// A raw item with no cap is unlimited boundary supply either way, so the
// field-less override survives; the non-raw case below is the one that differs.
test("blurring an emptied cap on a raw row keeps the field-less override", () => {
  const owner = controlledOwner<ItemOverride[]>([
    { itemId: "gas_xiranite", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((overrides, onChange) => (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={CATALYST_PACK}
        />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(owner.latest).toEqual([{ itemId: "gas_xiranite" }]);
});

// Removing a row with an uncommitted cap edit must never commit that edit.
test("removing a row with an uncommitted edit does not commit it", () => {
  vi.useFakeTimers();
  const owner = controlledOwner<ItemOverride[]>([
    { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
    { itemId: "gadget", ratePerSec: { num: "2", denom: "1" } },
    { itemId: "sprocket", ratePerSec: { num: "3", denom: "1" } },
  ]);
  render(
    owner.element((overrides, onChange) => (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={PACK3}
        />
      </LocaleProvider>
    )),
  );
  // Type into row 0 (widget) but never blur; then remove it.
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-input")[0]!);
  expect(owner.latest.map((o) => o.itemId)).toEqual(["gadget", "sprocket"]);
  expect(owner.emissions.length).toBe(1);
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
        supplyRateByItem={new Map()}
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
        supplyRateByItem={new Map()}
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
        supplyRateByItem={new Map()}
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
  function PlanSwapOwner() {
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
  render(<PlanSwapOwner />);
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
        supplyRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("88.89");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// A catalyst draw folds into the item's ordinary supply row, so the panel must
// take the auto-row set as given instead of re-deriving it from item.raw: the
// non-raw liquid_xiranite only ever reaches the panel through a catalyst draw.
// The row is an ordinary auto-row; only data-is-raw follows the item.
test("a non-raw catalyst item renders as a plain auto-row with its draw", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        assumedRawItemIds={["gas_xiranite", "liquid_xiranite"]}
        supplyRateByItem={
          new Map([
            ["liquid_xiranite", { num: "1", denom: "10" }],
            ["gas_xiranite", { num: "3", denom: "5" }],
          ])
        }
      />
    </LocaleProvider>,
  );
  const rows = screen.getAllByTestId("input-auto-row");
  expect(rows.map((r) => r.getAttribute("data-item-id"))).toEqual([
    "gas_xiranite",
    "liquid_xiranite",
  ]);
  const readouts = rows.map(
    (r) => r.querySelector('[data-testid="input-realized-rate"]')?.textContent,
  );
  expect(readouts).toEqual(["needed 36/min", "needed 6/min"]);
  expect(rows[0]!.getAttribute("data-is-raw")).toBe("true");
  expect(rows[1]!.getAttribute("data-is-raw")).toBe("false");
});

// Capping a catalyst row is the shared-cap gesture: the auto-row promotes to a
// real override exactly as a raw row does.
test("typing a cap on a non-raw catalyst auto-row promotes it to an override", () => {
  const updaters: Array<(cur: ItemOverride[]) => ItemOverride[]> = [];
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={(u) => updaters.push(u)}
        pack={CATALYST_PACK}
        assumedRawItemIds={["liquid_xiranite"]}
        supplyRateByItem={
          new Map([["liquid_xiranite", { num: "1", denom: "10" }]])
        }
      />
    </LocaleProvider>,
  );
  const input = screen.getByTestId("input-auto-row").querySelector("input")!;
  fireEvent.change(input, { target: { value: "30" } });
  fireEvent.blur(input);
  expect(updaters.length).toBe(1);
  // 30/min = 1/2 per sec.
  expect(updaters[0]!([])).toEqual([
    { itemId: "liquid_xiranite", ratePerSec: { num: "1", denom: "2" } },
  ]);
});

// Clearing the cap on a NON-RAW row drops the override entirely instead of
// leaving a field-less one: for a non-raw item that override reads as free
// boundary import, which would make its balanced uses free as well. The row
// falls back to the catalyst auto-row.
test("clearing the cap on a non-raw row removes the override", () => {
  let latest: ItemOverride[] = [
    { itemId: "liquid_xiranite", ratePerSec: { num: "1", denom: "2" } },
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
          pack={CATALYST_PACK}
          assumedRawItemIds={["liquid_xiranite"]}
          supplyRateByItem={
            new Map([["liquid_xiranite", { num: "1", denom: "10" }]])
          }
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(latest).toEqual([]);
  // The item is back to an auto-row, not gone from the panel.
  expect(
    screen.getByTestId("input-auto-row").getAttribute("data-item-id"),
  ).toBe("liquid_xiranite");
});

// A catalyst item that also carries an explicit override is one row, not two:
// the override replaces its auto-row, exactly as for a raw item.
test("a catalyst row counts once whether it is auto or overridden", () => {
  expect(displayedInputCount([], ["gas_xiranite", "liquid_xiranite"])).toBe(2);
  expect(
    displayedInputCount(
      [{ itemId: "liquid_xiranite" }],
      ["gas_xiranite", "liquid_xiranite"],
    ),
  ).toBe(2);
});

// The clear-cap drop is scoped to auto-rows. A non-raw item that is NOT in the
// boundary-supply set has no auto-row to fall back to, so dropping its override
// would flip it to a forced internal build instead of the free import the
// picker added. Its cleared cap leaves a field-less override, as a raw row's
// does.
test("clearing the cap on a non-raw row outside the auto-row set keeps the override", () => {
  let latest: ItemOverride[] = [
    { itemId: "liquid_xiranite", ratePerSec: { num: "1", denom: "2" } },
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
          pack={CATALYST_PACK}
          assumedRawItemIds={[]}
          supplyRateByItem={new Map()}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.blur(input);
  expect(latest).toEqual([{ itemId: "liquid_xiranite" }]);
});
