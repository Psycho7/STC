import { useEffect, useMemo, useRef, useState } from "react";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { RationalString } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { formatRationalPerMin, ratePerSecToPerMin } from "../data/rate-format";
import { iconPosition } from "../canvas/iconSprite";

type Props = {
  itemOverrides: ItemOverride[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a debounced commit
  // built from a stale prop can otherwise drop a concurrent edit or resurrect
  // a removed row. An updater that finds nothing to change must return its
  // input unchanged (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: ItemOverride[]) => ItemOverride[]) => void;
  pack: RecipePack;
  targetItemIds?: ReadonlySet<string>;
  // Realized demand per item from the latest render pass, summed over outbound
  // boundary-edge rates. When present, a side row shows the same number as the
  // matching canvas ProductNode; rows without an entry leave the rate slot
  // empty. Shown in place of the old "UNCAPPED" chip.
  realizedRateByItem?: ReadonlyMap<string, RationalString>;
  // Raw items the current plan consumes as assumed-infinite supply. With no
  // explicit overrides declared, these surface as read-only auto-rows so the
  // "raw is unlimited by default" assumption is visible. Typing a cap into an
  // auto-row promotes it to a real override, hiding the remaining auto-rows.
  assumedRawItemIds?: ReadonlyArray<string>;
};

const DEBOUNCE_MS = 150;

// Number of input rows the panel actually shows: explicit overrides plus the
// assumed-raw auto-rows surfaced when nothing is capped. The supply counters
// (stats strip, side tab, section head) route through this so none of them can
// report 0 while auto-rows are on screen.
export function displayedInputCount(
  itemOverrides: ReadonlyArray<{ itemId: string }>,
  assumedRawItemIds: ReadonlyArray<string> | undefined,
): number {
  const autoCount =
    itemOverrides.length > 0 ? 0 : (assumedRawItemIds?.length ?? 0);
  return itemOverrides.length + autoCount;
}

// Behaves a little differently from the parser in TargetsPanel. Empty string
// means "uncap" (no rate limit). A negative or unparseable input returns the
// "INVALID" marker, letting the caller keep the prior value. A valid rate parses
// into a RationalString.
function parsePerMinToOptional(
  perMinStr: string,
): RationalString | undefined | "INVALID" {
  if (perMinStr.trim() === "") return undefined;
  let f: Fraction;
  try {
    f = new Fraction(perMinStr).div(new Fraction(60));
  } catch {
    return "INVALID";
  }
  if (f.compare(0) < 0) return "INVALID";
  const s = f.toFraction(false);
  const [n, d] = s.includes("/") ? s.split("/") : [s, "1"];
  return { num: n!, denom: d! };
}

export function InputsPanel({
  itemOverrides,
  onChange,
  pack,
  targetItemIds,
  realizedRateByItem,
  assumedRawItemIds,
}: Props) {
  const i18n = useI18n();
  // Sorted items drive both the picker order and the first-unused-id pick when
  // the user adds a row. Re-sorting every render is fine at a few hundred items.
  const sortedItems = useMemo(
    () =>
      pack.items
        .slice()
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [pack],
  );
  const itemById = useMemo(() => {
    const m = new Map<string, (typeof pack.items)[number]>();
    for (const it of pack.items) m.set(it.id, it);
    return m;
  }, [pack]);

  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    itemId: string;
  } | null>(null);
  const overrideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // Auto-row timers have no clearPendingEdit analog: nothing cancels them when
  // auto-rows transition out (e.g. an override appears and hides the rows).
  // Intentional gap - a late fire is a no-op because commitAutoRate's
  // duplicate guard skips items that already have an override, and an empty or
  // INVALID value never mutates the list.
  const autoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // In-flight edit values keyed by itemId. A row without an entry falls back
  // to the prop-derived value, so a new `itemOverrides` prop updates the visible
  // rate without a separate sync effect. Keying by id (not row index) keeps a
  // pending edit attached to its row across removals and reorders.
  const [localRates, setLocalRates] = useState<Map<string, string>>(new Map());
  // In-flight edits for auto-rows, keyed by itemId. When the debounce fires, a
  // valid rate creates a new ItemOverride, turning the auto-row into an explicit
  // override row. The local string only needs to survive until commit: once the
  // prop list grows, the next render replaces the auto-row and the local entry
  // is orphaned.
  const [localAutoRates, setLocalAutoRates] = useState<Map<string, string>>(
    new Map(),
  );
  // Returns false only on INVALID, so the caller keeps the prior value and
  // the local edit string for the user to fix.
  function commitRate(itemId: string, perMinStr: string): boolean {
    const parsed = parsePerMinToOptional(perMinStr);
    if (parsed === "INVALID") return false;
    onChange((current) => {
      const idx = current.findIndex((o) => o.itemId === itemId);
      // Row removed while the edit was pending: no-op (same reference).
      if (idx < 0) return current;
      const next = current.slice();
      if (parsed === undefined) {
        // Uncapped: drop ratePerSec from the override.
        next[idx] = { itemId };
      } else {
        next[idx] = { itemId, ratePerSec: parsed };
      }
      return next;
    });
    return true;
  }

  function scheduleCommit(itemId: string, value: string) {
    const existing = overrideTimers.current.get(itemId);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      commitRate(itemId, value);
      overrideTimers.current.delete(itemId);
      // Keep the committed text as the display value: re-serializing
      // ratePerSec would rewrite an exact "1/3" into a 16-digit float. On
      // INVALID it likewise stays so the user can fix the typo. (Navigation
      // resets localRates; that is handled by the panel owner.)
    }, DEBOUNCE_MS);
    overrideTimers.current.set(itemId, id);
  }

  function handleRateChange(itemId: string, value: string) {
    setLocalRates((prev) => new Map(prev).set(itemId, value));
    scheduleCommit(itemId, value);
  }

  // Drop the pending debounce timer and in-flight edit text for a row that is
  // going away, so a stale entry can never fire against (or redisplay on) a
  // later row that reuses the same id.
  function clearPendingEdit(itemId: string) {
    const existing = overrideTimers.current.get(itemId);
    if (existing) clearTimeout(existing);
    overrideTimers.current.delete(itemId);
    setLocalRates((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  }

  // Promote an auto-row into a real override entry. Empty or INVALID strings
  // leave it as an auto-row, since "Unlimited" is the auto state. Guard against
  // re-adding the same itemId in case the commit races with a prop update that
  // already inserted the override. Returns false only on INVALID, so the
  // caller keeps the local text for the user to fix.
  function commitAutoRate(itemId: string, perMinStr: string): boolean {
    const parsed = parsePerMinToOptional(perMinStr);
    if (parsed === "INVALID") return false;
    if (parsed === undefined) return true;
    onChange((current) =>
      current.some((o) => o.itemId === itemId)
        ? current
        : [...current, { itemId, ratePerSec: parsed }],
    );
    return true;
  }

  function handleAutoRateChange(itemId: string, value: string) {
    setLocalAutoRates((prev) => new Map(prev).set(itemId, value));
    const existing = autoTimers.current.get(itemId);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      const committed = commitAutoRate(itemId, value);
      autoTimers.current.delete(itemId);
      if (!committed) return;
      // A non-empty valid value promotes the auto-row into an override; carry
      // its committed text over to localRates so the new override row shows what
      // the user typed instead of the re-serialized Fraction. An empty value is
      // a no-op (stays Unlimited). Either way prune the in-flight auto text so a
      // later auto-row rebirth comes back as Unlimited, not a stale cap.
      if (value.trim() !== "") {
        setLocalRates((prev) => new Map(prev).set(itemId, value));
      }
      setLocalAutoRates((prev) => {
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
    }, DEBOUNCE_MS);
    autoTimers.current.set(itemId, id);
  }

  function handleItemChange(oldItemId: string, newItemId: string) {
    const dup = itemOverrides.some((o) => o.itemId === newItemId);
    if (dup) {
      setDuplicateError({ rowId: oldItemId, itemId: newItemId });
      return;
    }
    setDuplicateError(null);
    // An in-flight cap edit follows the row to its new id.
    const pendingValue = localRates.get(oldItemId);
    const pendingTimer = overrideTimers.current.get(oldItemId);
    if (pendingTimer) clearTimeout(pendingTimer);
    overrideTimers.current.delete(oldItemId);
    if (pendingValue !== undefined) {
      setLocalRates((prev) => {
        const next = new Map(prev);
        next.delete(oldItemId);
        next.set(newItemId, pendingValue);
        return next;
      });
      scheduleCommit(newItemId, pendingValue);
    }
    onChange((current) => {
      const idx = current.findIndex((o) => o.itemId === oldItemId);
      if (idx < 0) return current;
      if (current.some((o) => o.itemId === newItemId)) return current;
      const next = current.slice();
      const row = next[idx]!;
      // Keep any rate the row had when the user swaps the item.
      next[idx] = row.ratePerSec
        ? { itemId: newItemId, ratePerSec: row.ratePerSec }
        : { itemId: newItemId };
      return next;
    });
  }

  function handleRemove(itemId: string) {
    setDuplicateError(null);
    clearPendingEdit(itemId);
    onChange((current) => {
      const next = current.filter((o) => o.itemId !== itemId);
      return next.length === current.length ? current : next;
    });
  }

  function handleAdd() {
    onChange((current) => {
      const used = new Set(current.map((o) => o.itemId));
      const candidate = sortedItems.find((it) => !used.has(it.id));
      if (!candidate) return current;
      return [...current, { itemId: candidate.id }];
    });
  }

  useEffect(() => {
    const oTimers = overrideTimers.current;
    const aTimers = autoTimers.current;
    return () => {
      for (const id of oTimers.values()) clearTimeout(id);
      oTimers.clear();
      for (const id of aTimers.values()) clearTimeout(id);
      aTimers.clear();
    };
  }, []);

  const hasOverrides = itemOverrides.length > 0;
  const autoRows = !hasOverrides ? (assumedRawItemIds ?? []) : [];
  const showEmptyState = !hasOverrides && autoRows.length === 0;

  return (
    <div className="boundary-section" data-testid="inputs-section">
      <div className="side-section-head">
        <span className="num">SUP · 02</span>
        <span className="label">INPUT SUPPLY</span>
        <span className="count">
          <span className="v">
            {displayedInputCount(itemOverrides, assumedRawItemIds)}
          </span>
          {" / "}
          {sortedItems.length}
        </span>
      </div>
      <div className="side-section-sub">
        {"// boundary import budget · raw + cross-domain"}
      </div>
      {showEmptyState ? (
        <div className="b-empty">
          {i18n.locale === "zh"
            ? "未配置任何输入 — 全部按 raw 自动求解"
            : "No declared inputs — defaults to raw-source feed"}
        </div>
      ) : null}
      {autoRows.map((itemId) => {
        const item = itemById.get(itemId);
        const isAlsoTarget = targetItemIds?.has(itemId) === true;
        const iconPos = iconPosition(item?.icon ?? itemId);
        const displayedRate = localAutoRates.get(itemId) ?? "";
        const realized = realizedRateByItem?.get(itemId);
        const realizedPerMin =
          realized !== undefined ? formatRationalPerMin(realized) : null;
        return (
          <div
            key={`auto:${itemId}`}
            className="b-row"
            data-testid="input-auto-row"
            data-item-id={itemId}
            data-is-raw="true"
            data-is-also-target={isAlsoTarget ? "true" : "false"}
          >
            <span className={"slot" + (iconPos === undefined ? " empty" : "")}>
              {iconPos !== undefined ? (
                <span className="ico ico-40">
                  <span
                    className="spr"
                    style={{ backgroundPosition: iconPos }}
                  />
                </span>
              ) : null}
            </span>
            <div className="info">
              <span
                className="b-name"
                title={i18n.displayName(itemId)}
                data-testid="input-auto-name"
              >
                {i18n.displayName(itemId)}
              </span>
              {realizedPerMin !== null ? (
                <div className="b-needed" data-testid="input-realized-rate">
                  {i18n.t("inputs.needed", { rate: realizedPerMin })}
                </div>
              ) : null}
              {isAlsoTarget ? (
                <div className="b-tags">
                  <span className="dual">DUAL</span>
                </div>
              ) : null}
              <div className="item-id">
                {itemId}
                <span className="mid">ITEM</span>
              </div>
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("inputs.rate.label")}
                placeholder={i18n.t("inputs.unlimited")}
                value={displayedRate}
                onChange={(e) => handleAutoRateChange(itemId, e.target.value)}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
            </div>
          </div>
        );
      })}
      {itemOverrides.map((row) => {
        const item = itemById.get(row.itemId);
        const isRaw = item?.raw === true;
        const isAlsoTarget = targetItemIds?.has(row.itemId) === true;
        const iconPos = iconPosition(item?.icon ?? row.itemId);
        const uncapped = row.ratePerSec === undefined;
        const displayedRate =
          localRates.get(row.itemId) ??
          (row.ratePerSec ? ratePerSecToPerMin(row.ratePerSec) : "");
        // Realized demand from the latest render pass. If the prop is missing
        // (nothing rendered yet) or the item isn't in the map, show nothing
        // until the next solve finishes.
        const realized = realizedRateByItem?.get(row.itemId);
        const realizedPerMin =
          realized !== undefined ? formatRationalPerMin(realized) : null;
        return (
          <div
            key={row.itemId}
            className="b-row"
            data-testid="input-row"
            data-is-raw={isRaw ? "true" : "false"}
            data-is-also-target={isAlsoTarget ? "true" : "false"}
          >
            <span className={"slot" + (iconPos === undefined ? " empty" : "")}>
              {iconPos !== undefined ? (
                <span className="ico ico-40">
                  <span
                    className="spr"
                    style={{ backgroundPosition: iconPos }}
                  />
                </span>
              ) : null}
            </span>
            <div className="info">
              <span className="b-pick">
                <select
                  aria-label={i18n.t("inputs.item.label")}
                  title={i18n.displayName(row.itemId)}
                  value={row.itemId}
                  onChange={(e) => handleItemChange(row.itemId, e.target.value)}
                >
                  {sortedItems.map((it) => (
                    <option key={it.id} value={it.id}>
                      {i18n.displayName(it.id)}
                    </option>
                  ))}
                </select>
              </span>
              {uncapped && realizedPerMin !== null ? (
                <div className="b-needed" data-testid="input-realized-rate">
                  {i18n.t("inputs.needed", { rate: realizedPerMin })}
                </div>
              ) : null}
              {(isAlsoTarget || (!uncapped && realizedPerMin !== null)) && (
                <div className="b-tags">
                  {isAlsoTarget ? <span className="dual">DUAL</span> : null}
                  {!uncapped && realizedPerMin !== null ? (
                    <>
                      {isAlsoTarget ? <span className="sep">·</span> : null}
                      <span
                        className="realized"
                        data-testid="input-realized-rate"
                      >
                        {realizedPerMin}
                        {i18n.t("inputs.rate.unit")}
                      </span>
                    </>
                  ) : null}
                </div>
              )}
              <div className="item-id">
                {row.itemId}
                <span className="mid">ITEM</span>
              </div>
              {duplicateError?.rowId === row.itemId && (
                <span role="alert">{i18n.t("inputs.duplicate")}</span>
              )}
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("inputs.rate.label")}
                placeholder={
                  uncapped
                    ? i18n.t("inputs.unlimited")
                    : i18n.t("inputs.rate.placeholder")
                }
                value={displayedRate}
                onChange={(e) => handleRateChange(row.itemId, e.target.value)}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
            </div>
            <button
              className="b-remove"
              data-testid="remove-input"
              onClick={() => handleRemove(row.itemId)}
              aria-label={i18n.t("inputs.remove.label")}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="b-add" onClick={handleAdd}>
        {i18n.t("inputs.add")}
      </button>
    </div>
  );
}
