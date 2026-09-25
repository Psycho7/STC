// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import Fraction from "fraction.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InputsPanel, displayedInputCount } from "./InputsPanel";
import { makePack } from "../solver/closed-form-fixtures";
import type { CatalystAccount } from "../solver/catalyst";
import { LocaleProvider } from "../data/i18n-context";
import { loadI18n } from "../data/i18n";
import { pack as realPack } from "../data/load";
import {
  unavailableEventItems,
  unavailableItems,
  type AvailabilitySettings,
} from "../data/availability";
import type { ItemOverride } from "../data/plan";
import { controlledOwner, pickerTile, rateInputs } from "./panel.testkit";

afterEach(cleanup);
afterEach(() => vi.useRealTimers());

const PACK = makePack([], [{ id: "widget" }]);

const PACK3 = makePack(
  [],
  [{ id: "widget" }, { id: "gadget" }, { id: "sprocket" }],
);

// The two transmuter catalysts: liquid_xiranite is not a raw item and only
// ever reaches the panel through the catalyst draw, gas_xiranite is raw and
// can carry a balanced draw as well. widget is in the pack but no recipe
// cycles it, so it is outside the catalyst set.
const CATALYST_PACK = makePack(
  [
    {
      id: "transmute",
      time: 1,
      in: {},
      out: { widget: 1 },
      catalyst: [
        { item: "gas_xiranite", qty: 1 },
        { item: "liquid_xiranite", qty: 1 },
      ],
    },
  ],
  [
    { id: "liquid_xiranite" },
    { id: "gas_xiranite", raw: true },
    { id: "widget" },
  ],
);

// One account entry, in items per SECOND like the solver's: 1/10 per second is
// the 6 per minute one machine cycles.
function account(
  itemId: string,
  parts: {
    need: string;
    fromCatalyst?: string;
    fromGeneral?: string;
    unmet?: string;
  },
): CatalystAccount {
  return new Map([
    [
      itemId,
      {
        need: new Fraction(parts.need),
        fromCatalyst: new Fraction(parts.fromCatalyst ?? 0),
        fromGeneral: new Fraction(parts.fromGeneral ?? 0),
        unmet: new Fraction(parts.unmet ?? 0),
      },
    ],
  ]);
}

// Rows carry the item on data-item-id and the pool on data-role, so a split
// item's two rows are told apart by role, never by DOM order.
function rowFor(itemId: string, role?: "catalyst"): HTMLElement {
  const found = screen
    .getAllByTestId("input-row")
    .find(
      (r) =>
        r.getAttribute("data-item-id") === itemId &&
        (r.getAttribute("data-role") ?? undefined) === role,
    );
  if (found === undefined) throw new Error(`no ${role ?? "general"} row`);
  return found;
}

function toggleIn(row: HTMLElement): HTMLInputElement | null {
  return row.querySelector('[data-testid="input-catalyst-toggle"]');
}

function rateText(row: HTMLElement): string | undefined {
  return (
    row.querySelector('[data-testid="input-realized-rate"]')?.textContent ??
    undefined
  );
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
// shares the canvas chip's decimal formatter, so it shows "88.9" -- never a
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
  expect(readout.textContent).toContain("88.9");
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
  expect(readout.textContent).toContain("88.9");
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
  expect(readout.textContent).toContain("88.9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// A catalyst charge billed to the general pool is shown on the item's G row,
// added to whatever ordinary draw that row already carries. The panel takes
// the auto-row set as given instead of re-deriving it from item.raw: the
// non-raw liquid_xiranite only ever reaches the panel through a catalyst
// charge. The row is an ordinary auto-row; only data-is-raw follows the item.
test("a non-raw catalyst item renders as a plain auto-row with its draw", () => {
  const accounts: CatalystAccount = new Map([
    ...account("gas_xiranite", { need: "1/10", fromGeneral: "1/10" }),
    ...account("liquid_xiranite", { need: "1/10", fromGeneral: "1/10" }),
  ]);
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        assumedRawItemIds={["gas_xiranite", "liquid_xiranite"]}
        catalystAccount={accounts}
        supplyRateByItem={new Map([["gas_xiranite", { num: "1", denom: "2" }]])}
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
  // The row leads with the pool checkbox, so take the rate field by type.
  const input = screen
    .getByTestId("input-auto-row")
    .querySelector('input[type="text"]')! as HTMLInputElement;
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

// ---------------------------------------------------------------------------
// Off-cohort event items in the inputs picker (#144's T6).

// The shipped pack's v1.5 cohort forced off through the real helper - the same
// map App derives from its stored overrides.
const V15_OFF = unavailableItems(realPack, {
  eventOverrides: { "v1.5": false },
});
// The tundra with the v1.5 cohort off: both dimming causes are live at once,
// so the map below can be told apart from the target picker's.
const TUNDRA: AvailabilitySettings = {
  eventOverrides: { "v1.5": false },
  area: "tundra",
};
const TUNDRA_INPUTS = unavailableEventItems(realPack, TUNDRA);
const firstCause = V15_OFF.values().next().value!;
const COHORT = firstCause.kind === "event" ? firstCause.cohort : "";

function pickerHintText(): string | null {
  return (
    document.querySelector('[data-testid="picker-hint"]')?.textContent ?? null
  );
}

// Open the Add-input picker under the given locale.
function openAddPicker(
  locale: "en" | "zh",
  props: Partial<Parameters<typeof InputsPanel>[0]> = {},
) {
  render(
    <LocaleProvider locale={locale}>
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={realPack}
        {...props}
      />
    </LocaleProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: locale === "zh" ? "添加输入" : "Add input",
    }),
  );
}

test("off-cohort event items render as disabled tiles with the cohort hint (inputs picker)", () => {
  openAddPicker("en", { unavailableItems: V15_OFF });
  for (const id of V15_OFF.keys()) {
    expect(pickerTile(id)).not.toBeNull();
    expect(pickerTile(id)!.disabled).toBe(true);
  }
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(true);
  expect(pickerTile("iron_powder")!.disabled).toBe(false);
  const hint = pickerHintText();
  expect(hint).toBe(loadI18n("en").t("picker.event.off", { cohorts: COHORT }));
  // Parity with the validation message: both carry the same raw cohort token.
  const validation = loadI18n("en").t("app.error.producer-unavailable.event", {
    itemId: "activity_xiranite_lung",
    cohort: COHORT,
  });
  expect(validation).toContain(COHORT);
  expect(hint).toContain(COHORT);
});

test("the inputs picker's cohort hint localizes under zh with the same token parity", () => {
  openAddPicker("zh", { unavailableItems: V15_OFF });
  const hint = pickerHintText();
  expect(hint).toBe(loadI18n("zh").t("picker.event.off", { cohorts: COHORT }));
  expect(hint).not.toBe(
    loadI18n("en").t("picker.event.off", { cohorts: COHORT }),
  );
  const validation = loadI18n("zh").t("app.error.producer-unavailable.event", {
    itemId: "activity_xiranite_lung",
    cohort: COHORT,
  });
  expect(validation).toContain(COHORT);
  expect(hint).toContain(COHORT);
});

// An area restriction says where a recipe can be BUILT, which is no statement
// about whether the item can be brought in: an input with no local producer is
// exactly the case imports exist for. So the map the owner hands this panel
// carries event causes only, and an area-blocked item stays pickable.
test("an item with no producer in the selected area stays pickable as an input", () => {
  openAddPicker("en", { unavailableItems: TUNDRA_INPUTS });
  // copper_nugget is jinlong-tagged, so under the tundra nothing produces it.
  expect(pickerTile("copper_nugget")!.disabled).toBe(false);
  // Its cause is real, it just belongs to the target picker, not this one.
  expect(unavailableItems(realPack, TUNDRA).get("copper_nugget")).toEqual({
    kind: "area",
    area: "tundra",
  });
  // The off-cohort item still dims: the event pass is the one that survives.
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(true);
});

// Without the map no tile dims for cohort reasons and the hint line is absent
// (the prop defaults empty), which is what every pre-T6 caller still sees.
test("without unavailableItems the inputs picker shows no hint", () => {
  openAddPicker("en");
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(false);
  expect(document.querySelector('[data-testid="picker-hint"]')).toBeNull();
});

// The hint now covers up to two dimming causes. Both present: the listed
// sentence and the event sentence render together, joined with the panel's
// " · " separator.
test("the hint joins the listed and event sentences when both causes apply", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK3}
        unavailableItems={
          new Map([["gadget", { kind: "event", cohort: "v1.5" } as const]])
        }
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add input" }));
  // widget is dimmed because it is listed; gadget because its cohort is off;
  // sprocket for neither.
  expect(pickerTile("widget")!.disabled).toBe(true);
  expect(pickerTile("gadget")!.disabled).toBe(true);
  expect(pickerTile("sprocket")!.disabled).toBe(false);
  expect(pickerHintText()).toBe(
    [
      loadI18n("en").t("inputs.picker.listed"),
      loadI18n("en").t("picker.event.off", { cohorts: "v1.5" }),
    ].join(" · "),
  );
});

// Single cause, listed only: exactly the pre-T6 hint, unchanged.
test("the hint is the listed sentence alone when only listed items are dimmed", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK3}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add input" }));
  expect(pickerHintText()).toBe(loadI18n("en").t("inputs.picker.listed"));
});

// Single cause, event only: the event sentence alone, no listed sentence.
test("the hint is the event sentence alone when only event items are dimmed", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={PACK3}
        unavailableItems={
          new Map([["gadget", { kind: "event", cohort: "v1.5" } as const]])
        }
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add input" }));
  expect(pickerHintText()).toBe(
    loadI18n("en").t("picker.event.off", { cohorts: "v1.5" }),
  );
});

// ---------------------------------------------------------------------------
// Catalyst (C) rows: a second pool per item, keyed (itemId, role).
// ---------------------------------------------------------------------------

// The checkbox is the only way to move a row between the two pools, so it
// appears exactly on the rows that can hold a catalyst charge.
test("the catalyst checkbox shows on catalyst-capable rows only", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
          { itemId: "widget" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
      />
    </LocaleProvider>,
  );
  expect(toggleIn(rowFor("gas_xiranite"))?.checked).toBe(false);
  expect(toggleIn(rowFor("gas_xiranite", "catalyst"))?.checked).toBe(true);
  expect(toggleIn(rowFor("widget"))).toBeNull();
});

// Checking the box moves the row to pool C: the cap follows it, and the
// wire-only plan flag does not (a C row can never carry one).
test("checking the box converts a G row, carrying the cap and dropping plan", () => {
  const owner = controlledOwner<ItemOverride[]>([
    {
      itemId: "gas_xiranite",
      ratePerSec: { num: "1", denom: "2" },
      plan: true,
    },
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
  fireEvent.click(toggleIn(rowFor("gas_xiranite"))!);
  expect(owner.latest).toEqual([
    {
      itemId: "gas_xiranite",
      ratePerSec: { num: "1", denom: "2" },
      role: "catalyst",
    },
  ]);
});

test("unchecking the box converts a C row back and keeps the cap", () => {
  const owner = controlledOwner<ItemOverride[]>([
    {
      itemId: "gas_xiranite",
      ratePerSec: { num: "1", denom: "2" },
      role: "catalyst",
    },
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
  fireEvent.click(toggleIn(rowFor("gas_xiranite", "catalyst"))!);
  expect(owner.latest).toEqual([
    { itemId: "gas_xiranite", ratePerSec: { num: "1", denom: "2" } },
  ]);
});

// A conversion is an identity change, like an item swap: an uncommitted edit
// on the row is dropped rather than applied to the row that replaces it.
test("a conversion discards a pending uncommitted rate edit", () => {
  const owner = controlledOwner<ItemOverride[]>([
    { itemId: "gas_xiranite", ratePerSec: { num: "1", denom: "1" } },
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
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(toggleIn(rowFor("gas_xiranite"))!);
  // Only the conversion committed, and the C row shows the carried cap.
  expect(owner.emissions.length).toBe(1);
  expect(owner.latest).toEqual([
    {
      itemId: "gas_xiranite",
      ratePerSec: { num: "1", denom: "1" },
      role: "catalyst",
    },
  ]);
  expect(rateInputs()[0]!.value).toBe("60");
});

test("a conversion is refused when the other role already exists", () => {
  const owner = controlledOwner<ItemOverride[]>([
    { itemId: "gas_xiranite" },
    { itemId: "gas_xiranite", role: "catalyst" },
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
  fireEvent.click(toggleIn(rowFor("gas_xiranite"))!);
  expect(owner.emissions.length).toBe(0);
  expect(screen.getByRole("alert").textContent).toBe("Item already declared");
  // And the same refusal from the C side.
  fireEvent.click(toggleIn(rowFor("gas_xiranite", "catalyst"))!);
  expect(owner.emissions.length).toBe(0);
});

// The two rows show two different quantities: C holds what the catalyst pool
// is asked for (need less whatever the general pool covered), G holds its own
// ordinary draw plus the part of the charge billed to it.
test("the C row shows need less fromGeneral, the G row its draw plus fromGeneral", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          fromCatalyst: "1/20",
          fromGeneral: "1/20",
        })}
        supplyRateByItem={new Map([["gas_xiranite", { num: "1", denom: "2" }]])}
      />
    </LocaleProvider>,
  );
  // need 6/min less the 3/min the general pool covered.
  expect(rateText(rowFor("gas_xiranite", "catalyst"))).toBe("needed 3/min");
  // 30/min of ordinary draw plus that same 3/min.
  expect(rateText(rowFor("gas_xiranite"))).toBe("needed 33/min");
  expect(
    rowFor("gas_xiranite").querySelector('[data-testid="input-catalyst-part"]')
      ?.textContent,
  ).toBe("3/min catalyst");
  // The C row is not double-counting the general share as its own.
  expect(
    rowFor("gas_xiranite", "catalyst").querySelector(
      '[data-testid="input-catalyst-part"]',
    ),
  ).toBeNull();
});

test("a C row whose item the plan cycles none of reads zero need", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "gas_xiranite", role: "catalyst" }]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        catalystAccount={new Map()}
        supplyRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  expect(rateText(rowFor("gas_xiranite", "catalyst"))).toBe("needed 0/min");
});

test("no catalyst tag on a G row whose charge is billed elsewhere", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          fromCatalyst: "1/10",
        })}
        supplyRateByItem={new Map([["gas_xiranite", { num: "1", denom: "2" }]])}
      />
    </LocaleProvider>,
  );
  expect(rateText(rowFor("gas_xiranite"))).toBe("needed 30/min");
  expect(screen.queryByTestId("input-catalyst-part")).toBeNull();
});

// The shortage is a report on the row that was asked to hold the charge.
test("an unmet charge is reported on the C row when there is one", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          fromCatalyst: "1/20",
          unmet: "1/20",
        })}
        supplyRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  const shortage = rowFor("gas_xiranite", "catalyst").querySelector(
    ".b-rate-err",
  );
  expect(shortage?.textContent).toBe("catalyst short by 3/min");
  expect(rowFor("gas_xiranite").querySelector(".b-rate-err")).toBeNull();
});

test("an unmet charge falls to the G row when the item has no C row", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        assumedRawItemIds={["gas_xiranite"]}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          unmet: "1/10",
        })}
        supplyRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  expect(
    screen.getByTestId("input-auto-row").querySelector(".b-rate-err")
      ?.textContent,
  ).toBe("catalyst short by 6/min");
});

// One .b-rate-err slot, two claimants: while the field is unparseable the user
// needs the parse error, not the accounting report.
test("the invalid-rate message takes precedence over the shortage", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "gas_xiranite", role: "catalyst" }]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          unmet: "1/10",
        })}
        supplyRateByItem={new Map()}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const slots = rowFor("gas_xiranite", "catalyst").querySelectorAll(
    ".b-rate-err",
  );
  expect(slots.length).toBe(1);
  expect(slots[0]!.getAttribute("data-testid")).toBe("rate-invalid");
});

// Auto-rows are per side: the C override does not retire the item's G
// auto-row, and there is no C auto-row to go with it.
test("a G auto-row coexists with a C override on the same item", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "gas_xiranite", role: "catalyst" }]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        assumedRawItemIds={["gas_xiranite"]}
        catalystAccount={account("gas_xiranite", {
          need: "1/10",
          fromCatalyst: "1/10",
        })}
        supplyRateByItem={new Map([["gas_xiranite", { num: "1", denom: "2" }]])}
      />
    </LocaleProvider>,
  );
  const autos = screen.getAllByTestId("input-auto-row");
  expect(autos.length).toBe(1);
  expect(autos[0]!.getAttribute("data-role")).toBeNull();
  expect(screen.getAllByTestId("input-row").length).toBe(1);
  expect(rowFor("gas_xiranite", "catalyst")).toBeDefined();
});

test("converting an auto-row adds the C override and leaves the G auto-row", () => {
  const owner = controlledOwner<ItemOverride[]>([]);
  render(
    owner.element((overrides, onChange) => (
      <LocaleProvider locale="en">
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={CATALYST_PACK}
          assumedRawItemIds={["gas_xiranite"]}
          supplyRateByItem={
            new Map([["gas_xiranite", { num: "1", denom: "2" }]])
          }
        />
      </LocaleProvider>
    )),
  );
  const auto = screen.getByTestId("input-auto-row");
  fireEvent.click(toggleIn(auto)!);
  expect(owner.latest).toEqual([{ itemId: "gas_xiranite", role: "catalyst" }]);
  // The G side still has its ordinary draw, so it auto-rows itself again.
  expect(screen.getAllByTestId("input-auto-row").length).toBe(1);
  expect(rowFor("gas_xiranite", "catalyst")).toBeDefined();
});

// The two rows of a split item must not collide in the DOM: aria-describedby
// and every id query would otherwise resolve to whichever row rendered first.
test("a split item's rows carry distinct DOM ids and a role attribute", () => {
  // React logs an error when two siblings share a key, so a row key that was
  // still the bare item id would fail here rather than silently reuse state.
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const { container } = render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
      />
    </LocaleProvider>,
  );
  expect(consoleError).not.toHaveBeenCalled();
  consoleError.mockRestore();
  expect(container.querySelectorAll("#i-name-gas_xiranite").length).toBe(1);
  expect(container.querySelectorAll("#i-name-gas_xiranite-cat").length).toBe(1);
  expect(rowFor("gas_xiranite").getAttribute("data-role")).toBeNull();
  expect(rowFor("gas_xiranite", "catalyst").getAttribute("data-role")).toBe(
    "catalyst",
  );
  // Each row's rate input points at its own name.
  expect(
    rowFor("gas_xiranite", "catalyst")
      .querySelector("input[type=text]")
      ?.getAttribute("aria-describedby"),
  ).toBe("i-name-gas_xiranite-cat");
});

// The counters denominate against pack.items.length, so a split item has to
// count as the one item it is.
test("counters count a split item once", () => {
  expect(
    displayedInputCount(
      [
        { itemId: "gas_xiranite" },
        { itemId: "gas_xiranite", role: "catalyst" },
      ],
      ["gas_xiranite"],
    ),
  ).toBe(1);
  const { container } = render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite", role: "catalyst" },
          { itemId: "widget" },
        ]}
        onChange={() => {}}
        pack={CATALYST_PACK}
        assumedRawItemIds={["gas_xiranite"]}
        supplyRateByItem={new Map([["gas_xiranite", { num: "1", denom: "2" }]])}
      />
    </LocaleProvider>,
  );
  // gas_xiranite (C row + G auto-row) plus widget: two items, three rows.
  expect(
    container.querySelector(".side-section-head .count .v")?.textContent,
  ).toBe("2");
});
