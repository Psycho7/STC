// What the strip is allowed to say, per kind of evidence. The inputs here are
// the facts the app hands over: the unmet items of a solve, the item-level
// cause map the pickers dim from, and the explicitly capped items the drawn
// plan exhausted. Every case asserts both the structure and the localized
// sentence, because the wording is the whole point of the attribution rules.
import { describe, expect, it } from "vitest";
import { attributeShortfall, shortfallText } from "./shortfall";
import type { ProducerUnavailableCause } from "./plan";
import { loadI18n } from "./i18n";

const en = loadI18n("en");
const zh = loadI18n("zh");

const NO_CAUSES: ReadonlyMap<string, ProducerUnavailableCause> = new Map();

function facts(over: {
  underDelivered?: string[];
  deficitItemIds?: string[];
  itemCauses?: ReadonlyMap<string, ProducerUnavailableCause>;
  cappedAtLimit?: string[];
}) {
  return {
    underDelivered: over.underDelivered ?? [],
    deficitItemIds: over.deficitItemIds ?? [],
    itemCauses: over.itemCauses ?? NO_CAUSES,
    cappedAtLimit: over.cappedAtLimit ?? [],
  };
}

describe("attributeShortfall", () => {
  it("reports nothing when no demand is unmet", () => {
    const report = attributeShortfall(facts({}));

    expect(report.unmetItemIds).toEqual([]);
    expect(report.clauses).toEqual([]);
  });

  it("names the settlement for an unmet item whose direct producers are all area-blocked", () => {
    const report = attributeShortfall(
      facts({
        underDelivered: ["copper_nugget"],
        deficitItemIds: ["copper_nugget"],
        itemCauses: new Map([
          ["copper_nugget", { kind: "area", area: "tundra" }],
        ]),
      }),
    );

    expect(report.clauses).toEqual([
      { kind: "area", detail: "tundra", itemIds: ["copper_nugget"] },
    ]);
    expect(shortfallText(report, en)).toContain(
      "No recipe producing Cuprium can be built in Valley IV.",
    );
    expect(shortfallText(report, zh)).toContain("四号谷地");
  });

  it("names the cohort for an unmet item left to a switched-off event", () => {
    const report = attributeShortfall(
      facts({
        deficitItemIds: ["activity_copper_poly"],
        itemCauses: new Map([
          ["activity_copper_poly", { kind: "event", cohort: "v1.5" }],
        ]),
      }),
    );

    expect(report.clauses).toEqual([
      { kind: "event", detail: "v1.5", itemIds: ["activity_copper_poly"] },
    ]);
    expect(shortfallText(report, en)).toContain("v1.5");
  });

  it("names a hand toggle for an unmet item whose recipes were all switched off", () => {
    const report = attributeShortfall(
      facts({
        deficitItemIds: ["mid"],
        itemCauses: new Map([
          ["mid", { kind: "manual", recipeId: "make_mid" }],
        ]),
      }),
    );

    expect(report.clauses).toEqual([{ kind: "manual", itemIds: ["mid"] }]);
    expect(shortfallText(report, en)).toBe(
      "Delivered below the declared rate: mid. " +
        "Every recipe producing mid is switched off in settings.",
    );
  });

  it("names a cap only from the capped items the plan exhausted", () => {
    const report = attributeShortfall(
      facts({ underDelivered: ["copper_jar"], cappedAtLimit: ["gas_inert"] }),
    );

    expect(report.clauses).toEqual([{ kind: "cap", itemIds: ["gas_inert"] }]);
    expect(shortfallText(report, en)).toContain(
      "The supply of Inergen is drawn to its declared cap.",
    );
  });

  it("lists every supported constraint instead of picking one", () => {
    const report = attributeShortfall(
      facts({
        underDelivered: ["prod"],
        deficitItemIds: ["mid", "far_item"],
        itemCauses: new Map<string, ProducerUnavailableCause>([
          ["mid", { kind: "manual", recipeId: "make_mid" }],
          ["far_item", { kind: "area", area: "tundra" }],
        ]),
        cappedAtLimit: ["ore"],
      }),
    );

    // Restrictions in cause precedence (area before manual), the cap last.
    expect(report.clauses.map((c) => c.kind)).toEqual([
      "area",
      "manual",
      "cap",
    ]);
    const text = shortfallText(report, en);
    expect(text).toContain("far_item");
    expect(text).toContain("mid");
    expect(text).toContain("ore");
  });

  it("groups two items blocked by the same settlement into one sentence", () => {
    const report = attributeShortfall(
      facts({
        deficitItemIds: ["b_item", "a_item"],
        itemCauses: new Map<string, ProducerUnavailableCause>([
          ["a_item", { kind: "area", area: "tundra" }],
          ["b_item", { kind: "area", area: "tundra" }],
        ]),
      }),
    );

    expect(report.clauses).toEqual([
      { kind: "area", detail: "tundra", itemIds: ["a_item", "b_item"] },
    ]);
  });

  it("falls back to neutral wording when the cause is upstream of every unmet item", () => {
    // The ore -> mid -> prod case: the restriction sits on `mid`, the deficit
    // on `prod`, whose own producer is available. Nothing may be named.
    const report = attributeShortfall(
      facts({
        underDelivered: ["prod"],
        deficitItemIds: ["prod"],
        itemCauses: new Map([["mid", { kind: "area", area: "here" }]]),
      }),
    );

    expect(report.clauses).toEqual([]);
    expect(shortfallText(report, en)).toBe(
      "Delivered below the declared rate: prod.",
    );
    expect(shortfallText(report, zh)).toBe("以下产物未达到声明产量：prod。");
  });

  it("says nothing about caps for an unmet item with no binding cap", () => {
    const report = attributeShortfall(
      facts({ underDelivered: ["prod"], deficitItemIds: ["prod"] }),
    );

    expect(report.clauses.some((c) => c.kind === "cap")).toBe(false);
    expect(shortfallText(report, en)).not.toContain("cap");
  });

  it("merges the deficit items with the under-delivered targets", () => {
    const report = attributeShortfall(
      facts({ underDelivered: ["prod"], deficitItemIds: ["mid", "prod"] }),
    );

    expect(report.unmetItemIds).toEqual(["mid", "prod"]);
  });
});
