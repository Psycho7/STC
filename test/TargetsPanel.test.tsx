import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TargetsPanel } from "../src/components/TargetsPanel";
import { defaultTargets } from "../src/data/targets";
import { pack } from "../src/data/load";

afterEach(() => cleanup());

describe("TargetsPanel", () => {
  it("renders one row per target", () => {
    const onChange = vi.fn();
    render(
      <TargetsPanel
        targets={defaultTargets()}
        onChange={onChange}
        pack={pack}
      />,
    );
    expect(screen.getAllByTestId("target-row").length).toBe(3);
  });

  it("Add target button appends a new target", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TargetsPanel targets={[]} onChange={onChange} pack={pack} />);
    await user.click(screen.getByRole("button", { name: /添加目标/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0];
    expect(next.length).toBe(1);
  });

  it("Remove button removes a target", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <TargetsPanel
        targets={defaultTargets()}
        onChange={onChange}
        pack={pack}
      />,
    );
    const removeButtons = screen.getAllByTestId("remove-target");
    await user.click(removeButtons[0]!);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0].length).toBe(2);
  });

  it("rate edit calls onChange after 150ms debounce", () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(
        <TargetsPanel
          targets={defaultTargets()}
          onChange={onChange}
          pack={pack}
        />,
      );
      const inputs = screen.getAllByLabelText("速率");
      fireEvent.change(inputs[0]!, { target: { value: "240" } });
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("duplicate recipeId selection shows inline alert and does not call onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const ts = [
      { recipeId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
      { recipeId: "copper_powder", ratePerSec: { num: "1", denom: "1" } },
    ];
    render(<TargetsPanel targets={ts} onChange={onChange} pack={pack} />);
    const selects = screen.getAllByLabelText("配方");
    await user.selectOptions(selects[1]!, "copper_bottle");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/copper_bottle/);
  });

  it("excludes cost=-1 treatment recipes from the picker dropdown", () => {
    // The liquid_cleaner_1-* sink recipes consume waste and produce nothing.
    // They must not appear as pickable targets even though their category is
    // "material". At least one non-sink "material" recipe must still be
    // reachable through the picker.
    const onChange = vi.fn();
    render(
      <TargetsPanel
        targets={defaultTargets()}
        onChange={onChange}
        pack={pack}
      />,
    );
    const sinkIds = [
      "liquid_cleaner_1-sewage",
      "liquid_cleaner_1-xiranite_poly",
      "liquid_cleaner_1-xiranite_lowpoly",
    ];
    const selects = screen.getAllByLabelText("配方");
    const optionValues = Array.from(selects[0]!.querySelectorAll("option")).map(
      (o) => o.getAttribute("value"),
    );
    for (const id of sinkIds) {
      expect(optionValues).not.toContain(id);
    }
    const positiveCases = pack.recipes.filter(
      (r) => r.category === "material" && r.cost !== -1,
    );
    expect(positiveCases.length).toBeGreaterThan(0);
    expect(optionValues).toContain(positiveCases[0]!.id);
  });

  it("does not render the legacy 'SCC' tag for unsafeRecipes entries", () => {
    // The old UI rendered <span class="dual">SCC</span> for any recipe in
    // unsafeRecipes. Those targets now solve cleanly, so the warning chip was
    // dropped. The prop itself stays - handleAdd still uses it to skip
    // land-mines during auto-pick.
    const onChange = vi.fn();
    const targets = defaultTargets();
    const firstRecipeId = targets[0]!.recipeId;
    render(
      <TargetsPanel
        targets={targets}
        onChange={onChange}
        pack={pack}
        unsafeRecipes={new Set([firstRecipeId])}
      />,
    );
    expect(screen.queryByText(/^SCC$/)).toBeNull();
  });
});
