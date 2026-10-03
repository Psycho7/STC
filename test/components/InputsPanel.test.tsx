import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { RecipePack } from "@aef/schema";
import { InputsPanel } from "../../src/components/InputsPanel";
import { makePack } from "../../src/solver/closed-form-fixtures";
import { LocaleProvider } from "../../src/data/i18n-context";
import { loadI18n } from "../../src/data/i18n";
import type { ItemOverride } from "../../src/data/plan";
import {
  controlledOwner,
  pickerTile,
  promptInput,
  rateInputs,
} from "../../src/components/panel.testkit";

afterEach(() => cleanup());

// The assertions below read zh labels, so pin the locale instead of leaning on
// whatever the no-provider fallback happens to be. Passing it as a wrapper
// keeps rerender() re-applying the provider.
function ZhLocale({ children }: { children: ReactNode }) {
  return <LocaleProvider locale="zh">{children}</LocaleProvider>;
}

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: ZhLocale });
}

// The zh (default-locale) label of the Add button, from src/data/i18n.ts.
const TEXT_ADD = "添加输入";
// The default locale here is zh, so the hint copy is pinned in zh. Asserting
// the string, not just the element, is what ties the rendered hint to
// inputs.picker.listed rather than to any string the popup happened to get.
const TEXT_PICKER_HINT = "灰显的物品已在面板中 — 请直接编辑对应行";

// onChange takes a functional updater, so every assertion about what a gesture
// commits runs that updater over a starting list. The cast is the same at every
// call site and only hides the assertion under it.
function firstUpdater(
  onChange: ReturnType<typeof vi.fn>,
): (current: ItemOverride[]) => ItemOverride[] {
  return onChange.mock.calls[0]![0] as (c: ItemOverride[]) => ItemOverride[];
}

// Every override row names its trigger "物品：<name>" under the default zh
// locale, so this is the row's item picker button.
function rowTrigger(n = 0): HTMLElement {
  return screen.getAllByLabelText(/^物品/)[n]!;
}

// gas_xiranite and liquid_xiranite are cycled as catalysts; copper_ore is
// not, so it can only ever hold a general row.
const catalystPack: RecipePack = makePack(
  [
    {
      id: "transmute",
      time: 1,
      in: {},
      out: { copper_plate: 1 },
      catalyst: [
        { item: "gas_xiranite", qty: 1 },
        { item: "liquid_xiranite", qty: 1 },
      ],
    },
  ],
  [
    { id: "gas_xiranite", raw: true },
    { id: "liquid_xiranite" },
    { id: "copper_ore", raw: true },
  ],
);

const fixturePack: RecipePack = makePack(
  [
    {
      id: "assemble_one",
      category: "assembly",
      time: 1,
      in: {},
      out: { assemble_one_out: 1 },
    },
  ],
  [
    { id: "zinc", stack: 100 },
    { id: "copper_ore", raw: true, stack: 100 },
    { id: "copper_plate", stack: 100 },
    { id: "iron_ore", raw: true, stack: 100 },
  ],
);

describe("InputsPanel", () => {
  it("renders one row per override", () => {
    const onChange = vi.fn();
    const overrides: ItemOverride[] = [
      { itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } },
      { itemId: "iron_ore" },
    ];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    expect(screen.getAllByTestId("input-row").length).toBe(2);
  });

  it("Add opens the picker and commits nothing until the amount is confirmed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("picker-hint").textContent).toBe(
      TEXT_PICKER_HINT,
    );
    // The auto-row item already has a row, so its tile is dimmed here.
    expect((pickerTile("copper_ore") as HTMLButtonElement).disabled).toBe(true);
    // A pick alone still commits nothing and mounts no row: the amount prompt
    // is the next step (R5).
    await user.click(pickerTile("iron_ore")!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("input-row").length).toBe(0);
    expect(promptInput()).not.toBeNull();
  });

  it("a pick opens the prompt; confirming empty appends an uncapped override", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    await user.click(pickerTile("iron_ore")!);
    // The prompt names the picked item and carries the uncapped placeholder
    // plus the empty-means-no-limit note.
    expect(screen.getByRole("dialog").textContent).toContain("蓝铁矿");
    const rate = promptInput()!;
    expect(rate.placeholder).toBe("无限");
    expect(screen.getByTestId("rate-prompt-note").textContent).toBe(
      "留空 = 无限",
    );
    await user.click(screen.getByTestId("rate-prompt-confirm"));
    expect(onChange).toHaveBeenCalledTimes(1);
    const updater = firstUpdater(onChange);
    expect(updater([])).toEqual([{ itemId: "iron_ore" }]);
    // Racing a prop update that already inserted the row is a no-op.
    expect(updater([{ itemId: "iron_ore" }])).toEqual([{ itemId: "iron_ore" }]);
  });

  it("confirming 12 in the prompt appends { itemId, ratePerSec: 12 }", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    await user.click(pickerTile("iron_ore")!);
    const rate = promptInput()!;
    fireEvent.change(rate, { target: { value: "12" } });
    fireEvent.keyDown(rate, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    // 12/min = 1/5 per second.
    expect(firstUpdater(onChange)([])).toEqual([
      { itemId: "iron_ore", ratePerSec: { num: "1", denom: "5" } },
    ]);
  });

  it("confirming 0 in the prompt appends a zero cap", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    await user.click(pickerTile("iron_ore")!);
    const rate = promptInput()!;
    fireEvent.change(rate, { target: { value: "0" } });
    fireEvent.keyDown(rate, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    // A zero cap, not an uncapped row: the solver reads it as "nothing can be
    // drawn from the boundary for this item".
    expect(firstUpdater(onChange)([])).toEqual([
      { itemId: "iron_ore", ratePerSec: { num: "0", denom: "1" } },
    ]);
  });

  it("Escape at the prompt appends nothing and refocuses Add", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />,
    );
    const add = screen.getByText(TEXT_ADD);
    await user.click(add);
    await user.click(pickerTile("iron_ore")!);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("input-row").length).toBe(0);
    expect(document.activeElement).toBe(add);
  });

  it("the new row's rate input has focus after the prompt confirms", async () => {
    const user = userEvent.setup();
    const owner = controlledOwner<ItemOverride[]>([]);
    render(
      owner.element((overrides, onChange) => (
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={fixturePack}
        />
      )),
    );
    await user.click(screen.getByText(TEXT_ADD));
    await user.click(pickerTile("iron_ore")!);
    // Confirm empty (an uncapped override) from the prompt; the committed
    // row's rate input takes the focus, not the prompt's own input.
    fireEvent.keyDown(promptInput()!, { key: "Enter" });
    expect(owner.latest).toEqual([{ itemId: "iron_ore" }]);
    expect(document.activeElement).toBe(rateInputs()[0]);
  });

  it("the Add button is aria-disabled and inert when every item is claimed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const all = fixturePack.items.map((i) => ({ itemId: i.id }));
    render(
      <InputsPanel
        itemOverrides={all}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const add = screen.getByText(TEXT_ADD);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await user.click(add);
    expect(screen.queryByTestId("picker-tile")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a row trigger opens the picker with siblings disabled and its own item selected", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }, { itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
      />,
    );
    const triggers = screen.getAllByLabelText(/^物品/);
    await user.click(triggers[0]!);
    const own = pickerTile("copper_ore");
    const sibling = pickerTile("iron_ore");
    expect(own).not.toBeNull();
    expect(own!.disabled).toBe(false);
    expect(own!.className).toContain("selected");
    expect(sibling!.disabled).toBe(true);
  });

  it("picking a different item swaps the row and keeps its rate", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[
          { itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } },
        ]}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    await user.click(rowTrigger());
    await user.click(pickerTile("iron_ore")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updater = firstUpdater(onChange);
    expect(
      updater([{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]),
    ).toEqual([{ itemId: "iron_ore", ratePerSec: { num: "1", denom: "2" } }]);
  });

  it("a capped row's popup leaves auto-row items enabled", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[
          { itemId: "iron_ore", ratePerSec: { num: "1", denom: "2" } },
        ]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    // Open the picker from the override row, not from Add.
    await user.click(rowTrigger());
    // copper_ore has an auto-row, but this swap carries the row's cap onto it,
    // so it is a live cap move and must stay pickable. Only the Add popup and
    // the uncapped row popup dim it.
    expect(pickerTile("copper_ore")!.disabled).toBe(false);
  });

  it("an uncapped row's popup dims auto-row items and says why", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    await user.click(rowTrigger());
    // With no cap to carry, swapping onto copper_ore would trade a real row for
    // a bare override whose supply is Infinity either way, and delete the
    // iron_ore row doing it.
    expect(pickerTile("copper_ore")!.disabled).toBe(true);
    expect(screen.getByTestId("picker-hint").textContent).toBe(
      TEXT_PICKER_HINT,
    );
  });

  it("Escape returns focus to the trigger that opened the picker", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
      />,
    );
    const trigger = rowTrigger();
    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("picker-tile")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("re-picking the row's own item commits nothing and raises no alert", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const trigger = rowTrigger();
    await user.click(trigger);
    await user.click(pickerTile("copper_ore")!);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("picker-tile")).toBeNull();
    // The row never unmounts on a confirm, so focus returns to the same button.
    expect(document.activeElement).toBe(trigger);
  });

  it("a backdrop click returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const trigger = rowTrigger();
    await user.click(trigger);
    await user.click(document.querySelector(".recipe-picker-backdrop")!);
    expect(screen.queryByTestId("picker-tile")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("empty rate string commits as { itemId } (uncap sentinel)", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const overrides: ItemOverride[] = [
        { itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } },
      ];
      render(
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={fixturePack}
        />,
      );
      const input = screen.getAllByLabelText(/速率/)[0]!;
      fireEvent.change(input, { target: { value: "" } });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = firstUpdater(onChange)(overrides);
      expect(next).toEqual([{ itemId: "copper_ore" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rate edit and an item swap both keep ItemOverride.plan", async () => {
    // plan: true only ever arrives on a hand-authored hash; the rebuild sites
    // must spread the existing override so an edit does not silently strip it.
    const user = userEvent.setup();
    const onChange = vi.fn();
    const overrides: ItemOverride[] = [
      {
        itemId: "copper_ore",
        plan: true,
        ratePerSec: { num: "1", denom: "1" },
      },
    ];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const input = screen.getAllByLabelText(/速率/)[0]!;
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(firstUpdater(onChange)(overrides)).toEqual([
      {
        itemId: "copper_ore",
        plan: true,
        ratePerSec: { num: "2", denom: "1" },
      },
    ]);

    await user.click(rowTrigger());
    await user.click(pickerTile("iron_ore")!);
    expect(onChange).toHaveBeenCalledTimes(2);
    const swap = onChange.mock.calls[1]![0] as (
      current: ItemOverride[],
    ) => ItemOverride[];
    expect(swap(overrides)).toEqual([
      { itemId: "iron_ore", plan: true, ratePerSec: { num: "1", denom: "1" } },
    ]);
  });

  it("prunes a committed row's text when the override leaves by prop change", () => {
    // The override family keeps its committed text as the display value; only
    // handleRemove used to clear it, so an override dropped by any other route
    // left the text behind to resurface when the item returned.
    const onChange = vi.fn();
    const view = render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    const rate = screen.getAllByLabelText(/速率/)[0]!;
    fireEvent.change(rate, { target: { value: "60" } });
    fireEvent.blur(rate);
    expect(onChange).toHaveBeenCalledTimes(1);

    // The parent applies the cap, then later drops the override by some route
    // other than the row's X button...
    view.rerender(
      <InputsPanel
        itemOverrides={[
          { itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    view.rerender(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    // ...and when the item returns as an uncapped override, the field shows
    // the fresh prop-derived value, not the stale committed "60".
    view.rerender(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    const returned = screen.getByTestId("input-row").querySelector("input")!;
    expect(returned.value).toBe("");
  });

  it("negative rate is rejected: retains prior value, does not call onChange", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      const overrides: ItemOverride[] = [
        { itemId: "copper_ore", ratePerSec: { num: "60", denom: "1" } },
      ];
      render(
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={fixturePack}
        />,
      );
      const input = screen.getAllByLabelText(/速率/)[0]! as HTMLInputElement;
      fireEvent.change(input, { target: { value: "-5" } });
      vi.advanceTimersByTime(150);
      expect(onChange).not.toHaveBeenCalled();
      // Local edit state stays visible until the user changes it again.
      expect(input.value).toBe("-5");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Remove deletes the row at that index", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const overrides: ItemOverride[] = [
      { itemId: "copper_ore" },
      { itemId: "iron_ore" },
      { itemId: "zinc" },
    ];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const removeButtons = screen.getAllByTestId("remove-input");
    await user.click(removeButtons[1]!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = firstUpdater(onChange)(overrides);
    expect(next).toEqual([{ itemId: "copper_ore" }, { itemId: "zinc" }]);
  });

  it("shows realized rate where UNCAPPED used to render, with no 'uncapped' literal anywhere", () => {
    const onChange = vi.fn();
    const overrides: ItemOverride[] = [{ itemId: "copper_ore" }];
    const realized = new Map<string, { num: string; denom: string }>([
      // 2/s realized -> 120/min displayed.
      ["copper_ore", { num: "2", denom: "1" }],
    ]);
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
        supplyRateByItem={realized}
      />,
    );
    const realizedChip = screen.getByTestId("input-realized-rate");
    expect(realizedChip.textContent).toContain("120");
    // The deleted UNCAPPED chip text must not appear anywhere in the panel.
    expect(screen.queryByText(/UNCAPPED/i)).toBeNull();
  });

  it("omits the realized chip when no rate is supplied for the item", () => {
    const onChange = vi.fn();
    const overrides: ItemOverride[] = [{ itemId: "copper_ore" }];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
        supplyRateByItem={new Map()}
      />,
    );
    expect(screen.queryByTestId("input-realized-rate")).toBeNull();
    expect(screen.queryByText(/UNCAPPED/i)).toBeNull();
  });

  it("auto-rows: renders one input-auto-row per assumed raw item when no overrides exist", () => {
    const onChange = vi.fn();
    const assumed = ["copper_ore", "iron_ore"];
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={assumed}
      />,
    );
    const autoRows = screen.getAllByTestId("input-auto-row");
    expect(autoRows.length).toBe(2);
    expect(autoRows[0]!.getAttribute("data-item-id")).toBe("copper_ore");
    expect(autoRows[1]!.getAttribute("data-item-id")).toBe("iron_ore");
    // The empty-state string must not render alongside auto-rows.
    expect(screen.queryByText(/未配置|No declared inputs/)).toBeNull();
    // RAW/IMPORT and UNLIMITED chips were dropped from .b-tags, and an Assumed
    // row has no rate field at all: the block carries the "unlimited" claim
    // itself, and its rows offer promotion instead of a place to type.
    expect(screen.queryByTestId("input-unlimited")).toBeNull();
    expect(screen.queryByText(/^RAW$/)).toBeNull();
    expect(screen.queryAllByLabelText(/速率/).length).toBe(0);
    expect(screen.getAllByTestId("input-set-cap").length).toBe(2);
  });

  it("auto-rows: assumed-raw items without an override stay visible alongside overrides", () => {
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore", "iron_ore"]}
      />,
    );
    // copper_ore is overridden (an input-row); iron_ore has no override and
    // stays an auto-row instead of disappearing.
    const autoRows = screen.getAllByTestId("input-auto-row");
    expect(autoRows.length).toBe(1);
    expect(autoRows[0]!.getAttribute("data-item-id")).toBe("iron_ore");
    expect(screen.getAllByTestId("input-row").length).toBe(1);
  });

  it("auto-rows: empty-state still renders when both overrides and assumed are empty", () => {
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={[]}
      />,
    );
    expect(screen.queryAllByTestId("input-auto-row").length).toBe(0);
    // Default locale is zh; the empty-state string is the Chinese variant.
    expect(screen.getByText(/未配置/)).toBeInTheDocument();
  });

  it("auto-rows: shows prominent .b-needed line with localized 'needed N/min' when realized rate is supplied", () => {
    const onChange = vi.fn();
    const realized = new Map<string, { num: string; denom: string }>([
      // 2/s -> 120/min.
      ["copper_ore", { num: "2", denom: "1" }],
    ]);
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
        supplyRateByItem={realized}
      />,
    );
    const neededLine = screen.getByTestId("input-realized-rate");
    expect(neededLine.className).toContain("b-needed");
    expect(neededLine.textContent).toContain("120");
    expect(neededLine.textContent).toMatch(/需求|needed/);
  });

  it("auto-rows: set cap materialises an ItemOverride only once a rate is committed", () => {
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    fireEvent.click(screen.getByTestId("input-set-cap"));
    // The click only opens the field: nothing reaches the plan yet.
    expect(onChange).not.toHaveBeenCalled();
    const field = screen.getByTestId("input-pending-cap");
    fireEvent.change(field, { target: { value: "120" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(firstUpdater(onChange)([])).toEqual([
      { itemId: "copper_ore", ratePerSec: { num: "2", denom: "1" } },
    ]);
  });

  it("auto-rows: nothing but the button can promote a row", () => {
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    const row = screen.getByTestId("input-auto-row");
    // No rate field to type into, so the typing path that used to promote is
    // gone rather than merely unused.
    expect(row.querySelector("input[type=text]")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("override row with no ratePerSec: prominent .b-needed line + 'Unlimited' placeholder, no RAW/IMPORT chip", () => {
    const onChange = vi.fn();
    const realized = new Map<string, { num: string; denom: string }>([
      ["copper_ore", { num: "2", denom: "1" }],
    ]);
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
        supplyRateByItem={realized}
      />,
    );
    expect(screen.queryByTestId("input-unlimited")).toBeNull();
    // RAW/IMPORT chip dropped per visual-cleanup feedback. Only the icon-slot
    // styling (data-is-raw attribute) encodes the raw vs import distinction.
    expect(screen.queryByText(/^RAW$/)).toBeNull();
    expect(screen.queryByText(/^IMPORT$/)).toBeNull();
    const neededLine = screen.getByTestId("input-realized-rate");
    expect(neededLine.className).toContain("b-needed");
    expect(neededLine.textContent).toContain("120");
    expect(neededLine.textContent).toMatch(/需求|needed/);
    expect(screen.getByLabelText(/速率/).getAttribute("placeholder")).toBe(
      "无限",
    );
  });

  it("override row with ratePerSec: small .realized chip in .b-tags, no .b-needed line", () => {
    const onChange = vi.fn();
    const realized = new Map<string, { num: string; denom: string }>([
      ["copper_ore", { num: "2", denom: "1" }],
    ]);
    render(
      <InputsPanel
        itemOverrides={[
          { itemId: "copper_ore", ratePerSec: { num: "5", denom: "1" } },
        ]}
        onChange={onChange}
        pack={fixturePack}
        supplyRateByItem={realized}
      />,
    );
    expect(screen.queryByTestId("input-unlimited")).toBeNull();
    const chip = screen.getByTestId("input-realized-rate");
    // Capped rows keep the bare "120/min"-style text inside .b-tags .realized
    // (not the promoted .b-needed line).
    expect(chip.className).toContain("realized");
    expect(chip.className).not.toContain("b-needed");
    expect(chip.textContent).toBe("120/分");
  });

  it("data-is-raw and data-is-also-target reflect props per row", () => {
    const onChange = vi.fn();
    const overrides: ItemOverride[] = [
      { itemId: "copper_ore" }, // raw
      { itemId: "copper_plate" }, // non-raw, dual-listed as target
    ];
    const targetItemIds = new Set<string>(["copper_plate"]);
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
        targetItemIds={targetItemIds}
      />,
    );
    const rows = screen.getAllByTestId("input-row");
    expect(rows[0]!.getAttribute("data-is-raw")).toBe("true");
    expect(rows[0]!.getAttribute("data-is-also-target")).toBe("false");
    expect(rows[1]!.getAttribute("data-is-raw")).toBe("false");
    expect(rows[1]!.getAttribute("data-is-also-target")).toBe("true");
  });

  it("a committed swap moves focus to the swapped row's trigger", async () => {
    const user = userEvent.setup();
    const owner = controlledOwner<ItemOverride[]>([{ itemId: "copper_ore" }]);
    render(
      owner.element((overrides, onChange) => (
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={fixturePack}
        />
      )),
    );
    await user.click(rowTrigger());
    await user.click(pickerTile("iron_ore")!);
    const trigger = rowTrigger();
    // Assert the row identity by id, not by rendered text: displayName resolves
    // iron_ore to its localized name, which differs per locale.
    expect(
      trigger.closest("[data-item-id]")?.getAttribute("data-item-id"),
    ).toBe("iron_ore");
    expect(document.activeElement).toBe(trigger);
  });

  it("rate fields carry no redundant name description; only errors describe them", () => {
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    // Both rows carry a name element, but only the override row has a rate
    // field to describe: the Assumed row's cell holds the promotion button.
    for (const itemId of ["copper_ore", "iron_ore"]) {
      expect(document.getElementById(`i-name-${itemId}`)).not.toBeNull();
    }
    // The name element still renders (it is the on-screen name), but the
    // field's label already names the row, so aria-describedby omits it.
    const row = document.querySelector('[data-testid="input-row"]');
    const input = row!.querySelector("input")!;
    expect(input.getAttribute("aria-describedby")).toBeNull();
    // An invalid entry is the one thing left to describe, by its own id.
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.getAttribute("aria-describedby")).toBe("i-rate-err-iron_ore");
  });

  it("swapping a capped row onto an auto-row item carries the cap and retires the auto-row", async () => {
    const user = userEvent.setup();
    const owner = controlledOwner<ItemOverride[]>([
      { itemId: "zinc", ratePerSec: { num: "3", denom: "1" } },
    ]);
    render(
      owner.element((overrides, onChange) => (
        <InputsPanel
          itemOverrides={overrides}
          onChange={onChange}
          pack={fixturePack}
          assumedRawItemIds={["copper_ore", "iron_ore"]}
        />
      )),
    );
    // The override row's trigger is the only 物品 control; auto-rows have none.
    await user.click(rowTrigger());
    await user.click(pickerTile("copper_ore")!);
    // The swapped row keeps the cap: 3/s serializes to 180/min in the field.
    const row = document.querySelector(
      '[data-testid="input-row"][data-item-id="copper_ore"]',
    );
    expect(row).not.toBeNull();
    expect(row!.querySelector("input")!.value).toBe("180");
    // copper_ore now has an override, so its auto-row is gone and it renders
    // exactly once. iron_ore is untouched and stays an auto-row.
    expect(
      document.querySelectorAll('[data-item-id="copper_ore"]').length,
    ).toBe(1);
    const autoIds = [...screen.getAllByTestId("input-auto-row")].map((el) =>
      el.getAttribute("data-item-id"),
    );
    expect(autoIds).toEqual(["iron_ore"]);
  });

  it("Add is exhausted when overrides and auto-rows together cover the pack", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "zinc" }, { itemId: "copper_plate" }]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore", "iron_ore"]}
      />,
    );
    // Two overrides plus two auto-rows is all four fixture items. Counting only
    // the overrides would read 2 of 4 and leave Add live on an all-dimmed grid.
    const add = screen.getByText(TEXT_ADD);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await user.click(add);
    expect(screen.queryByTestId("picker-tile")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a dirty rate edit commits before the trigger opens the picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const rate = screen.getAllByLabelText(/速率/)[0]!;
    await user.click(rate);
    await user.keyboard("60");
    expect(onChange).not.toHaveBeenCalled();
    // Clicking the trigger blurs the rate field, and blur is a commit. The cap
    // must not be swallowed by the popup opening.
    await user.click(rowTrigger());
    expect(onChange).toHaveBeenCalledTimes(1);
    const updater = firstUpdater(onChange);
    expect(updater([{ itemId: "copper_ore" }])).toEqual([
      { itemId: "copper_ore", ratePerSec: { num: "1", denom: "1" } },
    ]);
    // queryAllBy, not queryBy: the open grid has a tile per fixture item and
    // the singular query throws on multiple matches.
    expect(screen.queryAllByTestId("picker-tile").length).toBeGreaterThan(0);
  });

  // Scoped deliberately: this pins that the trigger opens on Enter, that the
  // dialog autofocuses its search box, and that tiles are real buttons Enter
  // activates. It does NOT walk the tab order or the arrow-key grid; those
  // belong to the popup and are covered in ItemPickerPopup.test.tsx, which
  // owns them for both panels that mount it.
  it("the trigger opens on Enter and a focused tile picks on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const trigger = rowTrigger();
    trigger.focus();
    await user.keyboard("{Enter}");
    // The dialog autofocuses its search box, so typing narrows without a click.
    const search = document.querySelector(".recipe-picker-search");
    expect(document.activeElement).toBe(search);
    // Tiles are real buttons: focusable, and Enter activates them.
    const target = pickerTile("iron_ore")!;
    target.focus();
    expect(document.activeElement).toBe(target);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("picker-tile")).toBeNull();
  });

  it("an unapplied pick does not leave a token that steals focus later", async () => {
    const user = userEvent.setup();
    function InertOwner() {
      const [rows, setRows] = useState<ItemOverride[]>([
        { itemId: "copper_plate" },
      ]);
      return (
        <>
          <button onClick={() => setRows([{ itemId: "zinc" }])}>grow</button>
          <InputsPanel
            itemOverrides={rows}
            // Deliberately inert: the pick is armed but never applied, which is
            // what leaves a token behind.
            onChange={() => {}}
            pack={fixturePack}
          />
        </>
      );
    }
    render(<InertOwner />);
    await user.click(rowTrigger());
    await user.click(pickerTile("zinc")!);
    // Park focus somewhere unrelated, as a user would.
    const grow = screen.getByText("grow");
    grow.focus();
    expect(document.activeElement).toBe(grow);
    // A later, unrelated commit brings a zinc row into existence. The stale
    // token must not fire: focus stays where the user put it.
    await user.click(grow);
    expect(
      document.querySelector('[data-testid="input-row"][data-item-id="zinc"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(grow);
  });

  it("each row trigger is named by its own item, not the generic label", () => {
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }, { itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
      />,
    );
    // aria-label overrides the button's content, so a bare "物品" would leave
    // every row announcing identically and a screen-reader user could not tell
    // which row a trigger belongs to.
    const names = screen
      .getAllByLabelText(/^物品/)
      .map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual(["物品：赤铜矿", "物品：蓝铁矿"]);
    expect(new Set(names).size).toBe(names.length);
  });

  // A catalyst row addresses the item's catalyst pool, and only an item some
  // recipe cycles has one, so its picker cannot offer anything else.
  it("a catalyst row's picker offers catalyst-capable items only", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "gas_xiranite", role: "catalyst" }]}
        onChange={() => {}}
        pack={catalystPack}
      />,
    );
    await user.click(rowTrigger());
    expect(pickerTile("liquid_xiranite")!.disabled).toBe(false);
    expect(pickerTile("copper_ore")!.disabled).toBe(true);
    expect(screen.getByTestId("picker-hint").textContent).toBe(
      TEXT_PICKER_HINT,
    );
  });

  // The Add grid dims an item only once it has nowhere left to go: a catalyst
  // item with a general auto-row still has its catalyst pool free.
  it("Add dims a catalyst item only when both its roles are listed", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "liquid_xiranite", role: "catalyst" }]}
        onChange={onChange}
        pack={catalystPack}
        assumedRawItemIds={["gas_xiranite"]}
      />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    // gas_xiranite: auto-row on the general side, catalyst side still free.
    expect(pickerTile("gas_xiranite")!.disabled).toBe(false);
    // copper_ore cycles nowhere, so its one role is its only role.
    expect(pickerTile("copper_ore")!.disabled).toBe(false);
    // liquid_xiranite: catalyst row declared, general side still free.
    expect(pickerTile("liquid_xiranite")!.disabled).toBe(false);
  });

  it("Add gives a listed catalyst item the role it is missing, badged in the prompt", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={catalystPack}
        assumedRawItemIds={["gas_xiranite"]}
      />,
    );
    await user.click(screen.getByText(TEXT_ADD));
    await user.click(pickerTile("gas_xiranite")!);
    // The general side already has its auto-row, so the pick is bound for the
    // catalyst pool, and the prompt badges it before anything commits.
    expect(screen.getByTestId("rate-prompt-catalyst").textContent).toBe("催化");
    expect(onChange).not.toHaveBeenCalled();
    // Confirming empty commits the catalyst-pool override.
    await user.click(screen.getByTestId("rate-prompt-confirm"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(firstUpdater(onChange)([])).toEqual([
      { itemId: "gas_xiranite", role: "catalyst" },
    ]);
  });

  it("an emptied auto row's revert copy reports a discard, not a restored rate", () => {
    render(
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    fireEvent.click(screen.getByTestId("input-set-cap"));
    const input = screen.getByTestId("input-pending-cap");
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.blur(input);
    expect(screen.queryByTestId("input-pending-cap")).toBeNull();
    const status = screen.getByTestId("rate-reverted");
    expect(status.textContent).toBe(loadI18n("zh").t("rate.reverted"));
    // The row went back to Unlimited, so copy claiming a rate was restored
    // would be false on this row.
    expect(status.textContent).not.toMatch(/原速率|恢复/);
  });

  it("the catalyst toggle names its row under zh", () => {
    render(
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite" },
          { itemId: "gas_xiranite", role: "catalyst" },
        ]}
        onChange={() => {}}
        pack={catalystPack}
      />,
    );
    const i18n = loadI18n("zh");
    const name = i18n.displayName("gas_xiranite");
    const forItem = (pool: string) =>
      i18n.t("inputs.catalyst.role.forItem", { name, pool });
    expect(
      screen
        .getAllByTestId("input-catalyst-toggle")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual([
      forItem(i18n.t("inputs.pool.general")),
      forItem(i18n.t("inputs.pool.catalyst")),
    ]);
  });

  it("Add is exhausted only once every role of every item is listed", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[
          { itemId: "gas_xiranite", role: "catalyst" },
          { itemId: "liquid_xiranite" },
          { itemId: "liquid_xiranite", role: "catalyst" },
          { itemId: "copper_ore" },
        ]}
        onChange={() => {}}
        pack={catalystPack}
        assumedRawItemIds={["gas_xiranite"]}
      />,
    );
    const add = screen.getByText(TEXT_ADD);
    expect(add.getAttribute("aria-disabled")).toBe("true");
    await user.click(add);
    expect(screen.queryByTestId("picker-tile")).toBeNull();
  });
});
