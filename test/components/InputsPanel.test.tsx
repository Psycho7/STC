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

  it("Add input button appends a new row with first unused itemId (lex-sorted)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    // Existing: copper_ore. Lex-sorted items: copper_ore, copper_plate, iron_ore, zinc.
    // First unused -> "copper_plate".
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
    const next = onChange.mock.calls[0]![0] as ItemOverride[];
    expect(next.length).toBe(2);
    expect(next[1]).toEqual({ itemId: "copper_plate" });
  });

  it("duplicate itemId selection surfaces per-row error and does not call onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const overrides: ItemOverride[] = [
      { itemId: "copper_ore" },
      { itemId: "iron_ore" },
    ];
    render(
      <InputsPanel
        itemOverrides={overrides}
        onChange={onChange}
        pack={fixturePack}
      />,
    );
    const selects = screen.getAllByLabelText("物品");
    await user.selectOptions(selects[1]!, "copper_ore");
    expect(onChange).not.toHaveBeenCalled();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/已声明/);
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
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0]![0] as ItemOverride[];
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
    const next = onChange.mock.calls[0]![0] as ItemOverride[];
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

  it("auto-rows: hidden when itemOverrides is non-empty (explicit overrides win)", () => {
    const onChange = vi.fn();
    render(
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["iron_ore"]}
      />,
    );
    expect(screen.queryAllByTestId("input-auto-row").length).toBe(0);
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
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledTimes(1);
      const next = onChange.mock.calls[0]![0] as ItemOverride[];
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
