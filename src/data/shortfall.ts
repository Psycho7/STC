// What the status strip is allowed to say about a plan that delivers less than
// it declares.
//
// The deficit's LOCATION is not its cause: the LP funds a deficit column on
// whatever item stayed unmet, which is routinely a target whose own producers
// are all available (an upstream recipe the area or an event switched off shows
// up as a shortfall on the thing downstream of it). So attribution here is
// evidence-driven, and the evidence is deliberately one hop deep:
//
//   - a restriction may be named for an unmet item only when EVERY direct
//     producer of that item is off, which is exactly what the picker's item
//     cause map already records (producersOfItem + outermostCause);
//   - a supply cap may be named only for an item whose explicit cap the drawn
//     plan pulls in full;
//   - anything else gets the neutral unmet-demand sentence. An available direct
//     producer is not evidence of a cap problem, and no reachability walk is
//     run in its place.
//
// Several supported explanations are all shown; there is no "area wins" rule.

import { CAUSE_PRECEDENCE, type ProducerUnavailableCause } from "./plan";
import type { I18nIndex, UiKey } from "./i18n";

type RestrictionKind = ProducerUnavailableCause["kind"];

/**
 * One supported explanation, with the items it holds for. `detail` carries the
 * settlement (area) or the cohort (event); the other kinds need none.
 */
export type ShortfallClause = {
  kind: RestrictionKind | "cap";
  detail?: string;
  itemIds: ReadonlyArray<string>;
};

/** The unmet items and every explanation the evidence supports for them. */
export type ShortfallReport = {
  unmetItemIds: ReadonlyArray<string>;
  clauses: ReadonlyArray<ShortfallClause>;
};

export type ShortfallFacts = {
  /** Target items the drawn plan feeds below their declared rate. */
  underDelivered: ReadonlyArray<string>;
  /**
   * Items the LP left with unmet demand, targets or not, already
   * tolerance-filtered: a sub-tolerance residue is float noise, not a
   * shortfall the item has.
   */
  deficitItemIds: ReadonlyArray<string>;
  /** Items every direct producer of which is off, with the outermost cause. */
  itemCauses: ReadonlyMap<string, ProducerUnavailableCause>;
  /** Items whose explicit supply cap the drawn plan draws in full. */
  cappedAtLimit: ReadonlyArray<string>;
};

function causeDetail(cause: ProducerUnavailableCause): string | undefined {
  switch (cause.kind) {
    case "area":
      return cause.area;
    case "event":
      return cause.cohort;
    case "manual":
      return undefined;
  }
}

export function attributeShortfall(facts: ShortfallFacts): ShortfallReport {
  const unmetItemIds = [
    ...new Set([...facts.underDelivered, ...facts.deficitItemIds]),
  ].sort();
  if (unmetItemIds.length === 0) return { unmetItemIds, clauses: [] };

  // Group the unmet items that carry a direct-producer cause by that cause, so
  // two items blocked by the same settlement read as one sentence.
  const grouped = new Map<string, ShortfallClause & { itemIds: string[] }>();
  for (const itemId of unmetItemIds) {
    const cause = facts.itemCauses.get(itemId);
    if (cause === undefined) continue;
    const detail = causeDetail(cause);
    const existing = grouped.get(`${cause.kind}:${detail ?? ""}`);
    if (existing) {
      existing.itemIds.push(itemId);
      continue;
    }
    grouped.set(`${cause.kind}:${detail ?? ""}`, {
      kind: cause.kind,
      ...(detail !== undefined && { detail }),
      itemIds: [itemId],
    });
  }

  // Restriction clauses follow the cause precedence plan validation reports
  // with: the outermost switch first.
  const clauses: ShortfallClause[] = [...grouped.values()].sort(
    (a, b) =>
      CAUSE_PRECEDENCE.indexOf(a.kind as RestrictionKind) -
      CAUSE_PRECEDENCE.indexOf(b.kind as RestrictionKind),
  );

  if (facts.cappedAtLimit.length > 0) {
    clauses.push({ kind: "cap", itemIds: [...facts.cappedAtLimit].sort() });
  }

  return { unmetItemIds, clauses };
}

const CLAUSE_KEY: Record<ShortfallClause["kind"], UiKey> = {
  area: "app.shortfall.cause.area",
  event: "app.shortfall.cause.event",
  manual: "app.shortfall.cause.manual",
  cap: "app.shortfall.cause.cap",
};

/**
 * The strip's sentence: the neutral unmet-demand lead, then one sentence per
 * supported explanation. A report with no clauses is the neutral fallback.
 */
export function shortfallText(
  report: ShortfallReport,
  i18n: I18nIndex,
): string {
  const names = (ids: ReadonlyArray<string>): string =>
    ids.map((id) => i18n.displayName(id)).join(", ");

  const parts = [
    i18n.t("app.shortfall.unmet", { items: names(report.unmetItemIds) }),
  ];
  for (const clause of report.clauses) {
    const items = names(clause.itemIds);
    // The settlement is named the way the settings panel names it; a cohort is
    // the raw token every other surface interpolates.
    const params =
      clause.kind === "area"
        ? { items, area: i18n.displayName(clause.detail ?? "") }
        : clause.kind === "event"
          ? { items, cohort: clause.detail ?? "" }
          : { items };
    parts.push(i18n.t(CLAUSE_KEY[clause.kind], params));
  }
  return parts.join(" ");
}
