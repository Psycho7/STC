import { useEffect, useMemo, useRef, useState } from "react";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { RationalString } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { iconPosition } from "../canvas/iconSprite";

type Props = {
  itemOverrides: ItemOverride[];
  onChange: (next: ItemOverride[]) => void;
  pack: RecipePack;
  targetItemIds?: ReadonlySet<string>;
  // Realized demand per item from the latest render pass, summed over the
  // outbound boundary-edge rates. When this is present a side row shows the
  // same number as the matching canvas ProductNode; rows without an entry just
  // leave the rate slot empty. This value is what we display in place of the
  // old "UNCAPPED" chip.
  realizedRateByItem?: ReadonlyMap<string, RationalString>;
  // Raw items the current plan consumes as assumed-infinite supply. When the
  // user hasn't declared any explicit overrides we surface these as read-only
  // auto-rows, so the "raw is unlimited by default" assumption is visible
  // rather than hidden. Typing a cap into an auto-row promotes it to a real
  // override, which in turn hides the remaining auto-rows.
  assumedRawItemIds?: ReadonlyArray<string>;
};

const DEBOUNCE_MS = 150;

function ratePerSecToPerMin(rps: RationalString): number {
  const f = new Fraction(rps.num)
    .div(new Fraction(rps.denom))
    .mul(new Fraction(60));
  return Number(f.valueOf());
}

// This parser behaves a little differently from the one in TargetsPanel. An
// empty string means "uncap" (no rate limit). A negative or unparseable input
// returns the "INVALID" marker, which lets the caller keep whatever value was
// there before. A valid rate parses into a RationalString.
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
  // Lexicographically sorted items drive both the picker order and the
  // first-unused-id pick when the user adds a row. Re-sorting every render is
  // fine here since there are at most a few hundred items.
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
    rowIdx: number;
    itemId: string;
  } | null>(null);
  const overrideTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const autoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // In-flight edit values keyed by row index. A row without an entry here
  // falls back to the value derived from the prop, so when a new
  // `itemOverrides` prop comes in the visible rate updates on its own without a
  // separate sync effect.
  const [localRates, setLocalRates] = useState<Map<number, string>>(new Map());
  // In-flight edits for auto-rows, keyed by itemId. When the debounce timer
  // fires, a valid rate creates a new ItemOverride, so typing on an auto-row
  // turns it into an explicit override row. The local string only needs to
  // survive long enough to commit: once the prop list grows, the next render
  // replaces this auto-row with the new override row and the local entry is
  // left orphaned.
  const [localAutoRates, setLocalAutoRates] = useState<Map<string, string>>(
    new Map(),
  );
  // A mirror of the latest `itemOverrides` so that a debounce timer scheduled
  // during an earlier render commits against the current list rather than the
  // stale snapshot it captured.
  const overridesRef = useRef(itemOverrides);
  useEffect(() => {
    overridesRef.current = itemOverrides;
  }, [itemOverrides]);

  function commitRate(rowIdx: number, perMinStr: string) {
    const parsed = parsePerMinToOptional(perMinStr);
    // On INVALID, quietly keep the prior value. The local edit string stays in
    // localRates so the user still sees exactly what they typed and can fix it.
    if (parsed === "INVALID") return;
    const current = overridesRef.current;
    const row = current[rowIdx];
    if (!row) return;
    const next = current.slice();
    if (parsed === undefined) {
      // Uncapped, so drop ratePerSec from the override entirely.
      next[rowIdx] = { itemId: row.itemId };
    } else {
      next[rowIdx] = { itemId: row.itemId, ratePerSec: parsed };
    }
    onChange(next);
  }

  function handleRateChange(rowIdx: number, value: string) {
    setLocalRates((prev) => new Map(prev).set(rowIdx, value));
    const existing = overrideTimers.current.get(rowIdx);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      commitRate(rowIdx, value);
      overrideTimers.current.delete(rowIdx);
      setLocalRates((prev) => {
        // After a successful commit the prop drives what's shown; on INVALID we
        // deliberately hold onto the local string so the user can fix the typo.
        const parsed = parsePerMinToOptional(value);
        if (parsed === "INVALID") return prev;
        const next = new Map(prev);
        next.delete(rowIdx);
        return next;
      });
    }, DEBOUNCE_MS);
    overrideTimers.current.set(rowIdx, id);
  }

  // Promote an auto-row into a real override entry. Empty or INVALID strings
  // leave it as an auto-row, since "Unlimited" is the auto state. We guard
  // against re-adding the same itemId in case the commit races with a prop
  // update that already inserted the override.
  function commitAutoRate(itemId: string, perMinStr: string) {
    const parsed = parsePerMinToOptional(perMinStr);
    if (parsed === "INVALID") return;
    if (parsed === undefined) return;
    const current = overridesRef.current;
    if (current.some((o) => o.itemId === itemId)) return;
    onChange([...current, { itemId, ratePerSec: parsed }]);
  }

  function handleAutoRateChange(itemId: string, value: string) {
    setLocalAutoRates((prev) => new Map(prev).set(itemId, value));
    const existing = autoTimers.current.get(itemId);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      commitAutoRate(itemId, value);
      autoTimers.current.delete(itemId);
    }, DEBOUNCE_MS);
    autoTimers.current.set(itemId, id);
  }

  function handleItemChange(rowIdx: number, newItemId: string) {
    const dup = itemOverrides.some(
      (o, i) => i !== rowIdx && o.itemId === newItemId,
    );
    if (dup) {
      setDuplicateError({ rowIdx, itemId: newItemId });
      return;
    }
    setDuplicateError(null);
    const next = itemOverrides.slice();
    const row = next[rowIdx];
    if (!row) return;
    // Keep any rate the row already had when the user swaps the item.
    next[rowIdx] = row.ratePerSec
      ? { itemId: newItemId, ratePerSec: row.ratePerSec }
      : { itemId: newItemId };
    onChange(next);
  }

  function handleRemove(rowIdx: number) {
    setDuplicateError(null);
    const next = itemOverrides.filter((_, i) => i !== rowIdx);
    onChange(next);
  }

  function handleAdd() {
    const used = new Set(itemOverrides.map((o) => o.itemId));
    const candidate = sortedItems.find((it) => !used.has(it.id));
    if (!candidate) return;
    const next: ItemOverride[] = [...itemOverrides, { itemId: candidate.id }];
    onChange(next);
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
          <span className="v">{itemOverrides.length}</span>
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
          realized !== undefined ? ratePerSecToPerMin(realized) : null;
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
      {itemOverrides.map((row, i) => {
        const item = itemById.get(row.itemId);
        const isRaw = item?.raw === true;
        const isAlsoTarget = targetItemIds?.has(row.itemId) === true;
        const iconPos = iconPosition(item?.icon ?? row.itemId);
        const uncapped = row.ratePerSec === undefined;
        const displayedRate =
          localRates.get(i) ??
          (row.ratePerSec ? String(ratePerSecToPerMin(row.ratePerSec)) : "");
        // Realized demand from the latest render pass. If the prop is missing
        // (nothing rendered yet) or the item isn't in the map, show nothing and
        // let the row stay quiet until the next solve finishes.
        const realized = realizedRateByItem?.get(row.itemId);
        const realizedPerMin =
          realized !== undefined ? ratePerSecToPerMin(realized) : null;
        return (
          <div
            key={i}
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
                  onChange={(e) => handleItemChange(i, e.target.value)}
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
              {duplicateError?.rowIdx === i && (
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
                onChange={(e) => handleRateChange(i, e.target.value)}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
            </div>
            <button
              className="b-remove"
              data-testid="remove-input"
              onClick={() => handleRemove(i)}
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
