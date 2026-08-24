import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Item, Recipe, RecipePack } from "@aef/schema";
import { InputsPanel } from "../../src/components/InputsPanel";
import type { ItemOverride } from "../../src/data/plan";

afterEach(() => cleanup());

function mkItem(id: string, raw: boolean): Item {
  return {
    id,
    name: id,
    category: "cat",
    stack: 100,
    icon: "ico",
    row: 0,
    raw,
    transportKind: "belt" as Item["transportKind"],
  };
}

function mkRecipe(id: string): Recipe {
  return {
    id,
    name: id,
    category: "assembly",
    icon: "ico",
    row: 0,
    time: 1,
    in: [],
    out: [{ item: `${id}_out`, qty: 1 }],
    producers: [],
  };
}

// data-item-id appears on picker tiles, on auto-rows and on override rows, and
// the popup portals to document.body alongside the Testing Library container,
// so a bare [data-item-id] query can resolve to a row instead of a tile.
function pickerTile(itemId: string): HTMLButtonElement | null {
  return document.querySelector(
    `[data-testid="picker-tile"][data-item-id="${itemId}"]`,
  );
}

// Fixture pack: items intentionally out of lex order in the array so the
// "first unused (sorted lex)" picker has something to do.
const fixturePack: RecipePack = {
  schemaVersion: "0.2" as RecipePack["schemaVersion"],
  source: {
    name: "test",
    sourceRepo: "",
    sourceCommit: "0000",
    gameVersion: "",
    extractedAt: "",
  },
  categories: [],
  locations: [],
  items: [
    mkItem("zinc", false),
    mkItem("copper_ore", true),
    mkItem("copper_plate", false),
    mkItem("iron_ore", true),
  ],
  machines: [],
  transports: [],
  recipes: [mkRecipe("assemble_one")],
};

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

  it("Add input button appends a new row with first unused item by display name", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    // The picker orders by localized (zh, the default) display name, not id:
    // copper_ore ("赤铜矿"), iron_ore ("蓝铁矿"), then copper_plate / zinc (which
    // fall back to their ids). copper_ore is taken, so the first unused is
    // "iron_ore".
    const overrides: ItemOverride[] = [{ itemId: "copper_ore" }];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    await user.click(screen.getByRole("button", { name: /添加输入/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = (
      onChange.mock.calls[0]![0] as (c: ItemOverride[]) => ItemOverride[]
    )(overrides);
    expect(next.length).toBe(2);
    expect(next[1]).toEqual({ itemId: "iron_ore" });
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
    const triggers = screen.getAllByLabelText("物品");
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
    await user.click(screen.getAllByLabelText("物品")[0]!);
    await user.click(pickerTile("iron_ore")!);
    expect(onChange).toHaveBeenCalledTimes(1);
    const updater = onChange.mock.calls[0]![0] as (
      c: ItemOverride[],
    ) => ItemOverride[];
    expect(
      updater([{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]),
    ).toEqual([{ itemId: "iron_ore", ratePerSec: { num: "1", denom: "2" } }]);
  });

  it("a row popup leaves auto-row items enabled and shows no hint", async () => {
    const user = userEvent.setup();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />,
    );
    // Open the picker from the override row, not from Add.
    await user.click(screen.getAllByLabelText("物品")[0]!);
    // copper_ore has an auto-row, but a row swap carries the row's rate onto it,
    // so it is a live cap move and must stay pickable here. Only the Add popup
    // dims it.
    expect(pickerTile("copper_ore")!.disabled).toBe(false);
    expect(screen.queryByTestId("picker-hint")).toBeNull();
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
    const trigger = screen.getAllByLabelText("物品")[0]!;
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
    const trigger = screen.getAllByLabelText("物品")[0]!;
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
    const trigger = screen.getAllByLabelText("物品")[0]!;
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
      const input = screen.getAllByLabelText("速率")[0]!;
      fireEvent.change(input, { target: { value: "" } });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = (
        onChange.mock.calls[0]![0] as (c: ItemOverride[]) => ItemOverride[]
      )(overrides);
      expect(next).toEqual([{ itemId: "copper_ore" }]);
    } finally {
      vi.useRealTimers();
    }
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
      const input = screen.getAllByLabelText("速率")[0]! as HTMLInputElement;
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
    const next = (
      onChange.mock.calls[0]![0] as (c: ItemOverride[]) => ItemOverride[]
    )(overrides);
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
        realizedRateByItem={realized}
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
        realizedRateByItem={new Map()}
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
    // RAW/IMPORT and UNLIMITED chips were dropped from .b-tags - the only
    // Unlimited indicator left is the rate-input placeholder.
    expect(screen.queryByTestId("input-unlimited")).toBeNull();
    expect(screen.queryByText(/^RAW$/)).toBeNull();
    const rateInputs = screen.getAllByLabelText("速率");
    expect(rateInputs[0]!.getAttribute("placeholder")).toBe("无限");
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
        realizedRateByItem={realized}
      />,
    );
    const neededLine = screen.getByTestId("input-realized-rate");
    expect(neededLine.className).toContain("b-needed");
    expect(neededLine.textContent).toContain("120");
    expect(neededLine.textContent).toMatch(/需求|needed/);
  });

  it("auto-rows: typing a cap materialises a new ItemOverride entry", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(
        <InputsPanel
          itemOverrides={[]}
          onChange={onChange}
          pack={fixturePack}
          assumedRawItemIds={["copper_ore"]}
        />,
      );
      const input = screen.getAllByLabelText("速率")[0]!;
      fireEvent.change(input, { target: { value: "180" } });
      fireEvent.blur(input);
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = (
        onChange.mock.calls[0]![0] as (c: ItemOverride[]) => ItemOverride[]
      )([]);
      // 180/min -> 3/s = "3/1".
      expect(next).toEqual([
        { itemId: "copper_ore", ratePerSec: { num: "3", denom: "1" } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-rows: typing empty string does NOT materialise (stays as auto)", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(
        <InputsPanel
          itemOverrides={[]}
          onChange={onChange}
          pack={fixturePack}
          assumedRawItemIds={["copper_ore"]}
        />,
      );
      const input = screen.getAllByLabelText("速率")[0]!;
      // The input starts empty; firing change with "" should be a no-op since
      // an empty value on an auto-row is the natural "Unlimited" state.
      fireEvent.change(input, { target: { value: "" } });
      vi.advanceTimersByTime(150);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
        realizedRateByItem={realized}
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
    expect(screen.getByLabelText("速率").getAttribute("placeholder")).toBe(
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
        realizedRateByItem={realized}
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
});
