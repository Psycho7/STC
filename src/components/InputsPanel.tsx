import { useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { RationalString } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { formatRationalPerMin, ratePerSecToPerMin } from "../data/rate-format";
import { iconPosition } from "../canvas/iconSprite";
import { computeItemDepths } from "../data/recipe-depth";
import { ItemPickerPopup } from "./ItemPickerPopup";

type Props = {
  itemOverrides: ItemOverride[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
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

// Number of input rows the panel actually shows: explicit overrides plus every
// assumed-raw item that does not yet have an override (those still render as
// auto-rows). The supply counters (stats strip, side tab, section head) route
// through this so none of them can report 0 while auto-rows are on screen, and
// an overridden raw item is counted once (as its override), never twice.
export function displayedInputCount(
  itemOverrides: ReadonlyArray<{ itemId: string }>,
  assumedRawItemIds: ReadonlyArray<string> | undefined,
): number {
  const overrideIds = new Set(itemOverrides.map((o) => o.itemId));
  const autoCount = (assumedRawItemIds ?? []).filter(
    (id) => !overrideIds.has(id),
  ).length;
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

// A focus target armed by a pick and consumed on the commit that mounts the
// row. The kind matters: both consumers live on the same row and React
// attaches refs in tree order, so the trigger inside .info completes before
// the rate input inside .b-rate. A bare item id would let the trigger ref
// swallow every token and the add path's rate focus would never fire.
type PendingFocus = { itemId: string; kind: "rate" | "trigger" };

export function InputsPanel({
  itemOverrides,
  onChange,
  pack,
  targetItemIds,
  realizedRateByItem,
  assumedRawItemIds,
}: Props) {
  const i18n = useI18n();
  // Locale-aware compare so the picker scans by the displayed name, not the
  // internal id, in every locale.
  const collator = useMemo(() => new Intl.Collator(i18n.locale), [i18n.locale]);
  // Sorted items drive both the picker order and the first-unused-id pick when
  // the user adds a row. Ordered by localized display name (the name shown), not
  // internal id. Re-sorting every render is fine at a few hundred items.
  const sortedItems = useMemo(
    () =>
      pack.items
        .slice()
        .sort((a, b) =>
          collator.compare(i18n.displayName(a.id), i18n.displayName(b.id)),
        ),
    [pack, collator, i18n],
  );
  const itemById = useMemo(() => {
    const m = new Map<string, (typeof pack.items)[number]>();
    for (const it of pack.items) m.set(it.id, it);
    return m;
  }, [pack]);
  // Availability depth per item id, used by the picker popup to group tiles.
  // computeItemDepths seeds every pack item; ones no recipe can reach land in
  // the unranked bucket, which on the shipped pack is empty.
  const tierByItemId = useMemo(() => computeItemDepths(pack), [pack]);
  // Which row the picker popup is open for, plus the trigger button that
  // opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; itemId: string } | { kind: "add" } | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Armed by a pick, consumed by the matching row's callback ref on the next
  // commit. A stale token (the commit was rejected, or the panel is rendered
  // with an onChange that never feeds the prop back) is simply overwritten by
  // the next pick.
  const pendingFocus = useRef<PendingFocus | null>(null);
  function focusOnMount(
    el: HTMLElement | null,
    itemId: string,
    kind: PendingFocus["kind"],
  ) {
    const want = pendingFocus.current;
    if (!el || !want || want.itemId !== itemId || want.kind !== kind) return;
    pendingFocus.current = null;
    el.focus();
  }
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a committed swap unmounts its row),
    // so guard the focus.
    if (btn && document.contains(btn)) btn.focus();
  }

  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    itemId: string;
  } | null>(null);
  // In-flight edit values keyed by itemId. A row without an entry falls back
  // to the prop-derived value, so a new `itemOverrides` prop updates the visible
  // rate without a separate sync effect. Keying by id (not row index) keeps an
  // uncommitted edit attached to its row across removals and reorders. Text is
  // committed only on blur or Enter; the committed string is kept here as the
  // display value (re-serializing ratePerSec would turn "1/3" into a float).
  const [localRates, setLocalRates] = useState<Map<string, string>>(new Map());
  // In-flight edits for auto-rows, keyed by itemId. On commit a valid rate
  // creates a new ItemOverride, turning the auto-row into an explicit override
  // row. The local string only needs to survive until commit: once the prop list
  // grows, the next render replaces the auto-row and the local entry is orphaned.
  const [localAutoRates, setLocalAutoRates] = useState<Map<string, string>>(
    new Map(),
  );
  // Item ids whose local text has not yet been committed, one set per row kind.
  // Guards the blur/Enter commit so re-blurring an unedited field never re-fires
  // a solve.
  // The owner remounts this panel (via a key keyed on plan identity) when it
  // navigates to a new plan, dropping all uncommitted local edit state, so there
  // is no cross-plan carryover to clear here.
  const dirty = useRef<Set<string>>(new Set());
  const dirtyAuto = useRef<Set<string>>(new Set());
  // Item ids whose last commit attempt failed to parse (INVALID). Drives the
  // input's aria-invalid flag and the inline error message. Shared across auto
  // and override rows since an item is only ever one or the other at a time.
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());
  function markInvalid(itemId: string, on: boolean) {
    setInvalidIds((prev) => {
      if (on === prev.has(itemId)) return prev;
      const next = new Set(prev);
      if (on) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  // Returns false only on INVALID, so the caller keeps the prior value and the
  // local edit string for the user to fix.
  function commitRate(itemId: string, perMinStr: string): boolean {
    const parsed = parsePerMinToOptional(perMinStr);
    if (parsed === "INVALID") return false;
    onChange((current) => {
      const idx = current.findIndex((o) => o.itemId === itemId);
      // Row removed since the edit: no-op (same reference).
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

  function handleRateChange(itemId: string, value: string) {
    dirty.current.add(itemId);
    markInvalid(itemId, false);
    setLocalRates((prev) => new Map(prev).set(itemId, value));
  }

  // Commit an override row's uncommitted text on blur (revert=true) or Enter
  // (revert=false). A valid parse (including empty = uncap) commits and clears
  // the flags. On INVALID, Enter surfaces the cue and keeps the text; blur
  // reverts the field to its last-good value.
  function commitFromLocal(itemId: string, revert: boolean) {
    if (!dirty.current.has(itemId)) return;
    const value = localRates.get(itemId);
    if (value === undefined) return;
    if (commitRate(itemId, value)) {
      dirty.current.delete(itemId);
      markInvalid(itemId, false);
      return;
    }
    if (revert) {
      dirty.current.delete(itemId);
      markInvalid(itemId, false);
      setLocalRates((prev) => {
        if (!prev.has(itemId)) return prev;
        const next = new Map(prev);
        next.delete(itemId);
        return next;
      });
    } else {
      markInvalid(itemId, true);
    }
  }

  // Drop the in-flight edit text and dirty flag for a row that is going away, so
  // a stale entry can never redisplay on a later row that reuses the same id.
  function clearPendingEdit(itemId: string) {
    dirty.current.delete(itemId);
    markInvalid(itemId, false);
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
    dirtyAuto.current.add(itemId);
    markInvalid(itemId, false);
    setLocalAutoRates((prev) => new Map(prev).set(itemId, value));
  }

  // Prune the in-flight auto text so a later auto-row rebirth comes back as
  // Unlimited, not a stale cap.
  function dropAutoText(itemId: string) {
    setLocalAutoRates((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  }

  // Commit an auto-row's uncommitted text on blur (revert=true) or Enter
  // (revert=false). A non-empty valid value promotes the auto-row into an
  // override; carry its committed text over to localRates so the new override
  // row shows what the user typed instead of the re-serialized Fraction. An
  // empty value is a no-op (stays Unlimited). On INVALID, Enter surfaces the cue
  // and keeps the text; blur reverts the field to Unlimited (empty).
  function commitAutoFromLocal(itemId: string, revert: boolean) {
    if (!dirtyAuto.current.has(itemId)) return;
    const value = localAutoRates.get(itemId);
    if (value === undefined) return;
    if (commitAutoRate(itemId, value)) {
      dirtyAuto.current.delete(itemId);
      markInvalid(itemId, false);
      if (value.trim() !== "") {
        setLocalRates((prev) => new Map(prev).set(itemId, value));
      }
      dropAutoText(itemId);
      return;
    }
    if (revert) {
      dirtyAuto.current.delete(itemId);
      markInvalid(itemId, false);
      dropAutoText(itemId);
    } else {
      markInvalid(itemId, true);
    }
  }

  function handleItemChange(oldItemId: string, newItemId: string) {
    const dup = itemOverrides.some((o) => o.itemId === newItemId);
    if (dup) {
      setDuplicateError({ rowId: oldItemId, itemId: newItemId });
      return;
    }
    setDuplicateError(null);
    // An uncommitted cap edit follows the row to its new id, dirty flag and all.
    const pendingValue = localRates.get(oldItemId);
    if (pendingValue !== undefined) {
      const wasDirty = dirty.current.delete(oldItemId);
      if (wasDirty) dirty.current.add(newItemId);
      setLocalRates((prev) => {
        const next = new Map(prev);
        next.delete(oldItemId);
        next.set(newItemId, pendingValue);
        return next;
      });
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

  function handleAdd(e: MouseEvent<HTMLButtonElement>) {
    if (addExhausted) return;
    triggerRef.current = e.currentTarget;
    setPickerFor({ kind: "add" });
  }

  // Auto-rows are every assumed-raw item WITHOUT an explicit override, shown
  // regardless of how many overrides exist. Capping one item no longer hides the
  // realized demand of the remaining raw inputs.
  const overrideIds = new Set(itemOverrides.map((o) => o.itemId));
  const autoRows = (assumedRawItemIds ?? []).filter(
    (id) => !overrideIds.has(id),
  );
  const showEmptyState = itemOverrides.length === 0 && autoRows.length === 0;
  // Every item already has a row, so the picker would open on an all-dimmed
  // grid. Unreachable on the shipped pack, but a hand-crafted plan can carry
  // one override per item. Derived from the last completed render (autoRows
  // comes from realized demand), so it lags an in-flight solve; that is
  // harmless for a guard.
  const addExhausted =
    displayedInputCount(itemOverrides, assumedRawItemIds) === pack.items.length;

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
        <div className="b-empty">{i18n.t("inputs.empty")}</div>
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
                aria-invalid={invalidIds.has(itemId) ? true : undefined}
                aria-describedby={
                  invalidIds.has(itemId) ? `i-rate-err-${itemId}` : undefined
                }
                className={invalidIds.has(itemId) ? "invalid" : undefined}
                placeholder={i18n.t("inputs.unlimited")}
                value={displayedRate}
                onChange={(e) => handleAutoRateChange(itemId, e.target.value)}
                onBlur={() => commitAutoFromLocal(itemId, true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitAutoFromLocal(itemId, false);
                }}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {invalidIds.has(itemId) ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${itemId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
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
            data-item-id={row.itemId}
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
                <button
                  type="button"
                  className="b-pick-trigger"
                  ref={(el) => focusOnMount(el, row.itemId, "trigger")}
                  aria-label={i18n.t("inputs.item.label")}
                  aria-haspopup="dialog"
                  // title shows the full localised item name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(row.itemId)}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", itemId: row.itemId });
                  }}
                >
                  {i18n.displayName(row.itemId)}
                </button>
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
                ref={(el) => focusOnMount(el, row.itemId, "rate")}
                aria-label={i18n.t("inputs.rate.label")}
                aria-invalid={invalidIds.has(row.itemId) ? true : undefined}
                aria-describedby={
                  invalidIds.has(row.itemId)
                    ? `i-rate-err-${row.itemId}`
                    : undefined
                }
                className={invalidIds.has(row.itemId) ? "invalid" : undefined}
                placeholder={
                  uncapped
                    ? i18n.t("inputs.unlimited")
                    : i18n.t("inputs.rate.placeholder")
                }
                value={displayedRate}
                onChange={(e) => handleRateChange(row.itemId, e.target.value)}
                onBlur={() => commitFromLocal(row.itemId, true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFromLocal(row.itemId, false);
                }}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {invalidIds.has(row.itemId) ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${row.itemId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
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
      <button
        className="b-add"
        onClick={handleAdd}
        // aria-disabled, not disabled: a disabled button is not focusable, so
        // keyboard and screen-reader users would never reach the title that
        // explains why it does nothing.
        aria-disabled={addExhausted ? true : undefined}
        title={addExhausted ? i18n.t("inputs.add.exhausted") : undefined}
      >
        {i18n.t("inputs.add")}
      </button>
      {pickerFor !== null ? renderPicker() : null}
    </div>
  );

  function renderPicker() {
    if (pickerFor === null) return null;
    if (pickerFor.kind === "add") {
      // Everything with a visible row is dimmed: the explicit overrides plus
      // the auto-rows. Picking an auto-row item would append a bare override,
      // which for a raw item leaves effectiveSupply at Infinity either way -
      // a full re-solve and hash rewrite that changes nothing, and a row that
      // jumps from the auto block to the end of the override block. Capping
      // one stays what it is today: type into its auto-row.
      const disabledIds = new Set<string>([
        ...itemOverrides.map((o) => o.itemId),
        ...(assumedRawItemIds ?? []),
      ]);
      return (
        <ItemPickerPopup
          items={pack.items}
          disabledIds={disabledIds}
          tierByItemId={tierByItemId}
          disabledHint={i18n.t("inputs.picker.listed")}
          onPick={(newId) => {
            // The row mounts on a later commit, so hand its rate input the
            // focus: it is the only edit that makes the new row do anything.
            pendingFocus.current = { itemId: newId, kind: "rate" };
            onChange((current) =>
              current.some((o) => o.itemId === newId)
                ? current
                : [...current, { itemId: newId }],
            );
            closePicker();
          }}
          onClose={closePicker}
        />
      );
    }
    const rowId = pickerFor.itemId;
    // Only the other override rows are disabled here. Auto-row items stay
    // enabled: for a capped row handleItemChange carries the rate onto the
    // new item, so this is a live cap move, and blocking it would force a
    // delete-and-retype.
    const disabledIds = new Set<string>(
      itemOverrides.filter((o) => o.itemId !== rowId).map((o) => o.itemId),
    );
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={rowId}
        tierByItemId={tierByItemId}
        onPick={(newId) => {
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row against itself and raise a false duplicate alert.
          if (newId !== rowId) {
            // The swap unmounts this row (rows are keyed by itemId), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            pendingFocus.current = { itemId: newId, kind: "trigger" };
            handleItemChange(rowId, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
