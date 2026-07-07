import { describe, expect, it } from "vitest";
import type { Item } from "@aef/schema";
import { buildPnKind } from "../../src/canvas/productNodeMetadata";
import type { ProductNodeData } from "../../src/canvas/ProductNode";
import type { ItemOverride } from "../../src/data/plan";
import { loadI18n } from "../../src/data/i18n";

// The caption words are localized; these fixtures pin the English table so the
// expectations stay the readable "In · raw" / "Out · target" strings.
const en = loadI18n("en");

function rawItem(id: string): Item {
  return {
    id,
    name: id,
    category: "intermediate",
    icon: id,
    row: 0,
    raw: true,
    transportKind: "belt",
  };
}

function nonRawItem(id: string): Item {
  return {
    id,
    name: id,
    category: "intermediate",
    icon: id,
    row: 0,
    raw: false,
    transportKind: "belt",
  };
}

describe("buildPnKind", () => {
  it("renders raw input caption without rate or uncapped slot", () => {
    const data: ProductNodeData = {
      kind: "inputProduct",
      itemId: "iron-ore",
      rate: { num: "2", denom: "1" },
    };
    expect(buildPnKind(data, rawItem("iron-ore"), [], en)).toBe("In · raw");
  });

  it("renders raw input caption identically when cap is set (cap moved out of caption)", () => {
    const data: ProductNodeData = {
      kind: "inputProduct",
      itemId: "iron-ore",
      rate: { num: "4", denom: "1" },
      rateCap: { num: "4", denom: "1" },
    };
    expect(buildPnKind(data, rawItem("iron-ore"), [], en)).toBe("In · raw");
  });

  it("renders import input caption when item is not raw", () => {
    const data: ProductNodeData = {
      kind: "inputProduct",
      itemId: "iron-plate",
      rate: { num: "2", denom: "1" },
      rateCap: { num: "2", denom: "1" },
    };
    const overrides: ItemOverride[] = [
      { itemId: "iron-plate", ratePerSec: { num: "2", denom: "1" } },
    ];
    expect(buildPnKind(data, nonRawItem("iron-plate"), overrides, en)).toBe(
      "In · import",
    );
  });

  it("renders target output at per-min rate", () => {
    const data: ProductNodeData = {
      kind: "outputProduct",
      itemId: "iron-plate",
      rate: { num: "8", denom: "5" },
      flavor: "target",
    };
    expect(buildPnKind(data, nonRawItem("iron-plate"), [], en)).toBe(
      "Out · target · 96/min",
    );
  });

  it("renders surplus output at per-min rate", () => {
    const data: ProductNodeData = {
      kind: "outputProduct",
      itemId: "iron-plate",
      rate: { num: "1", denom: "5" },
      flavor: "surplus",
    };
    expect(buildPnKind(data, nonRawItem("iron-plate"), [], en)).toBe(
      "Out · surplus · 12/min",
    );
  });
});
