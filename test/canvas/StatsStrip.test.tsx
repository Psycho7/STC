import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import StatsStrip from "../../src/canvas/StatsStrip";
import type { Plan } from "../../src/data/plan";

afterEach(() => cleanup());

function makePlan(targetCount: number, supplyCount: number): Plan {
  return {
    version: 1,
    pack: { id: "test", schemaVersion: "0.2", submoduleSha: "sha" },
    title: "",
    targets: Array.from({ length: targetCount }, (_, i) => ({
      itemId: `r${i}`,
      ratePerSec: { num: "1", denom: "1" },
    })),
    itemOverrides: Array.from({ length: supplyCount }, (_, i) => ({
      itemId: `item-${i}`,
      plan: true as const,
    })),
  };
}

describe("StatsStrip", () => {
  it("renders the target slot before the supply slot with their counts", () => {
    const { container } = render(<StatsStrip plan={makePlan(2, 4)} />);

    const slots = container.querySelectorAll(".strip-stat");
    expect(slots.length).toBeGreaterThanOrEqual(2);

    const targetSlot = slots[0]!;
    expect(targetSlot.querySelector(".lbl")?.textContent).toBe("输出");
    expect(targetSlot.querySelector(".val")?.textContent).toBe("2目标");
    expect(targetSlot.querySelector(".val .unit")?.textContent).toBe("目标");

    const supplySlot = slots[1]!;
    expect(supplySlot.querySelector(".lbl")?.textContent).toBe("输入");
    expect(supplySlot.querySelector(".val")?.textContent).toBe("4供给");
    expect(supplySlot.querySelector(".val .unit")?.textContent).toBe("供给");
  });

  it("shows zero counts for a plan with no targets and no overrides", () => {
    const empty: Plan = {
      version: 1,
      pack: { id: "test", schemaVersion: "0.2", submoduleSha: "sha" },
      title: "",
      targets: [],
    };
    const { container } = render(<StatsStrip plan={empty} />);
    const slots = container.querySelectorAll(".strip-stat");
    expect(slots[0]?.querySelector(".val")?.textContent).toBe("0目标");
    expect(slots[1]?.querySelector(".val")?.textContent).toBe("0供给");
  });
});
