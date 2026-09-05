import { useEffect, useMemo, useRef, useState } from "react";
import type { RecipePack } from "@aef/schema";
import type { ItemOverride } from "../data/plan";
import type { RationalString } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { formatRationalPerMin, ratePerSecToPerMin } from "../data/rate-format";
import { iconPosition } from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { computeItemDepths } from "../data/recipe-depth";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { useRateEdit } from "./useRateEdit";

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

// A focus target armed by a pick and consumed by the row that renders on the
// very next commit. The kind matters: both consumers live on the same row and
// React attaches refs in tree order, so the trigger inside .info completes
// before the rate input inside .b-rate. A bare item id would let the trigger
// ref swallow every token and the add path's rate focus would never fire.
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
  // The token lives for exactly one commit. focusOnMount is an inline arrow, so
  // React re-attaches it on every render, not only on mount: an unconsumed
  // token would otherwise sit armed indefinitely and fire on some later,
  // unrelated commit that happens to render a row with the same item id,
  // yanking focus out of whatever the user was doing. Ref callbacks run before
  // effects within a commit, so a token the matching row consumed is already
  // null here; one whose commit never applied is dropped.
  useEffect(() => {
    pendingFocus.current = null;
  });
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
  // The row's item name plus, when present, the invalid-rate message. The
  // name is a description rather than a label so the accessible NAME stays
  // the generic rate label every existing query resolves by.
  function rateDescribedBy(itemId: string, invalid: boolean): string {
    const ids = [`i-name-${itemId}`];
    if (invalid) ids.push(`i-rate-err-${itemId}`);
    return ids.join(" ");
  }
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a committed swap unmounts its row),
    // so guard the focus.
    if (btn && document.contains(btn)) btn.focus();
  }

  // Defence in depth, not a reachable path. The row popup disables every other
  // override row's tile using the same set handleItemChange tests, and a
  // disabled button dispatches no click, so nothing in the UI can drive a
  // duplicate here. Kept so a future entry point that forgets to disable its
  // tiles degrades to an inline message rather than a silent row swap.
  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    itemId: string;
  } | null>(null);
  // The rate edit/commit/revert protocol for the explicit override rows. Empty
  // text is a valid commit here (uncapped), and the committed string is kept as
  // the display value.
  // This instance and autoEdit below carry SEPARATE invalid sets, which is
  // equivalent to the one shared set only because an item is only ever an
  // override row or an auto-row, never both at once. The autoRows filter below
  // ("every assumed-raw item WITHOUT an explicit override") is what enforces
  // that; break it and the two sets start disagreeing about the same item.
  // The split also means an invalid flag does NOT follow an item across a
  // family change (auto row promoted to override, or override reverting to
  // auto): the stale cue the shared set used to carry over is dropped now.
  const rowEdit = useRateEdit({
    emptyMeans: "uncap",
    keepTextAfterCommit: true,
    commit: (itemId, parsed) => {
      onChange((current) => {
        const idx = current.findIndex((o) => o.itemId === itemId);
        // Row removed since the edit: no-op (same reference).
        if (idx < 0) return current;
        const next = current.slice();
        // Spread the existing override so a rate edit never drops its other
        // fields (a hand-authored hash can carry plan: true).
        const row = { ...next[idx]! };
        if (parsed === undefined) {
          // Uncapped: drop ratePerSec from the override.
          delete row.ratePerSec;
        } else {
          row.ratePerSec = parsed;
        }
        next[idx] = row;
        return next;
      });
    },
  });
  // Prune pending / seeded texts for rows that left the override list by any
  // route: handleRemove clears its own row, but a promoted override can also
  // vanish when the list changes under the panel, and a surviving seeded text
  // would resurface if the item's row returns.
  const overrideIds = useMemo(
    () => new Set(itemOverrides.map((o) => o.itemId)),
    [itemOverrides],
  );
  useEffect(() => {
    rowEdit.pruneEditsTo(overrideIds);
    // rowEdit is rebuilt every render; the prune depends only on the live ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideIds]);
  // The same protocol for the auto-rows. A valid non-empty rate promotes the
  // auto-row into an explicit override; an empty one is a no-op, since
  // "Unlimited" is the auto state. The text only needs to survive until commit
  // (the promoted row displays the seeded copy), so it is dropped afterwards
  // and a later auto-row rebirth comes back as Unlimited, not a stale cap.
  // Separate invalid set from rowEdit, on the disjointness invariant noted
  // there and enforced by the autoRows filter below; as noted there, the
  // flag does not carry across a family change either.
  const autoEdit = useRateEdit({
    emptyMeans: "uncap",
    keepTextAfterCommit: false,
    commit: (itemId, parsed, text) => {
      // Guard against re-adding the same itemId in case the commit races with
      // a prop update that already inserted the override.
      if (parsed !== undefined) {
        onChange((current) =>
          current.some((o) => o.itemId === itemId)
            ? current
            : [...current, { itemId, ratePerSec: parsed }],
        );
      }
      // Carry the committed text over to the override rows so the promoted row
      // shows what the user typed instead of the re-serialized Fraction.
      if (text.trim() !== "") rowEdit.seedCommittedText(itemId, text);
    },
  });

  function handleItemChange(oldItemId: string, newItemId: string) {
    const dup = itemOverrides.some((o) => o.itemId === newItemId);
    if (dup) {
      setDuplicateError({ rowId: oldItemId, itemId: newItemId });
      return;
    }
    setDuplicateError(null);
    rowEdit.carryPendingEdit(oldItemId, newItemId);
    onChange((current) => {
      const idx = current.findIndex((o) => o.itemId === oldItemId);
      if (idx < 0) return current;
      if (current.some((o) => o.itemId === newItemId)) return current;
      const next = current.slice();
      const row = next[idx]!;
      // Keep any rate (and every other override field, e.g. plan) when the
      // user swaps the item; only itemId changes.
      next[idx] = { ...row, itemId: newItemId };
      return next;
    });
  }

  function handleRemove(itemId: string) {
    setDuplicateError(null);
    rowEdit.clearPendingEdit(itemId);
    onChange((current) => {
      const next = current.filter((o) => o.itemId !== itemId);
      return next.length === current.length ? current : next;
    });
  }

  // Auto-rows are every assumed-raw item WITHOUT an explicit override
  // (overrideIds above), shown regardless of how many overrides exist. Capping
  // one item no longer hides the realized demand of the remaining raw inputs.
  const autoRows = (assumedRawItemIds ?? []).filter(
    (id) => !overrideIds.has(id),
  );
  const showEmptyState = itemOverrides.length === 0 && autoRows.length === 0;
  // Every item already has a row, so the picker would open on an all-dimmed
  // grid. Unreachable on the shipped pack, but a hand-crafted plan can carry
  // one override per item. Derived from the last completed render (autoRows
  // comes from realized demand), so it lags an in-flight solve; that is
  // harmless for a guard.
  // >= rather than ===: displayedInputCount sums a set that is never
  // intersected with pack.items, so a list carrying an unknown or duplicate
  // item overshoots. validatePlan rejects both today, but == would fail open on
  // exactly the all-dimmed grid this guard exists to prevent.
  const shownCount = displayedInputCount(itemOverrides, assumedRawItemIds);
  const addExhausted = shownCount >= pack.items.length;

  return (
    <div className="boundary-section" data-testid="inputs-section">
      <div className="side-section-head">
        <span className="num">SUP · 02</span>
        <span className="label">INPUT SUPPLY</span>
        <span className="count">
          <span className="v">{shownCount}</span>
          {" / "}
          {pack.items.length}
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
        const rate = autoEdit.field(itemId, "");
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
              <Sprite iconId={item?.icon ?? itemId} size={40} />
            </span>
            <div className="info">
              <span
                className="b-name"
                id={`i-name-${itemId}`}
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
                aria-describedby={rateDescribedBy(itemId, rate.invalid)}
                placeholder={i18n.t("inputs.unlimited")}
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {rate.invalid ? (
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
        const rate = rowEdit.field(
          row.itemId,
          row.ratePerSec ? ratePerSecToPerMin(row.ratePerSec) : "",
        );
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
              <Sprite iconId={item?.icon ?? row.itemId} size={40} />
            </span>
            <div className="info">
              <span className="b-pick">
                <button
                  type="button"
                  className="b-pick-trigger"
                  ref={(el) => focusOnMount(el, row.itemId, "trigger")}
                  // The name goes in the accessible NAME, not just the visible
                  // text: aria-label overrides the button's content, so a bare
                  // "Item" would make every row's trigger announce identically
                  // and a screen-reader user could not tell which row they were
                  // about to open the picker for. The <select> this replaced
                  // announced its item as the control's value.
                  aria-label={i18n.t("item.selected", {
                    name: i18n.displayName(row.itemId),
                  })}
                  aria-haspopup="dialog"
                  // title shows the full localised item name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(row.itemId)}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", itemId: row.itemId });
                  }}
                >
                  <span id={`i-name-${row.itemId}`}>
                    {i18n.displayName(row.itemId)}
                  </span>
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
                aria-describedby={rateDescribedBy(row.itemId, rate.invalid)}
                placeholder={
                  uncapped
                    ? i18n.t("inputs.unlimited")
                    : i18n.t("inputs.rate.placeholder")
                }
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {rate.invalid ? (
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
        onClick={(e) => {
          if (addExhausted) return;
          triggerRef.current = e.currentTarget;
          setPickerFor({ kind: "add" });
        }}
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
    // The row may have gone (removed, or swapped by another commit) while the
    // popup was open. Rendering on regardless would highlight a tile for a row
    // that no longer exists and let a pick arm a focus token for a commit that
    // can never apply.
    const row =
      pickerFor.kind === "row"
        ? itemOverrides.find((o) => o.itemId === pickerFor.itemId)
        : undefined;
    if (pickerFor.kind === "row" && row === undefined) return null;
    // Sibling override rows are always dimmed. Auto-row items are dimmed
    // unless the popup belongs to a row that carries a cap: there
    // handleItemChange moves the cap onto the new item, which is a live
    // capability, and blocking it would force a delete-and-retype. Every other
    // case - Add, or a row with no cap to carry - would only append a bare
    // override, which for a raw item leaves effectiveSupply at Infinity either
    // way: a full re-solve and hash rewrite that changes nothing, and from a
    // row it destroys the row it came from as well. To cap a raw item, type
    // into its auto-row, whose commit promotes it to a real override.
    // Add reaches this with row undefined, so it filters nothing out and takes
    // the raw-item branch, which is exactly its own rule.
    const disabledIds = new Set<string>(
      itemOverrides
        .filter((o) => o.itemId !== row?.itemId)
        .map((o) => o.itemId),
    );
    if (row?.ratePerSec === undefined) {
      for (const id of assumedRawItemIds ?? []) disabledIds.add(id);
    }
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={row?.itemId}
        tierByItemId={tierByItemId}
        // Accurate for every reason a tile is dimmed here: a sibling row
        // already claims the item, or it has an auto-row this popup cannot
        // usefully take over. Either way the advice is to edit that row.
        // Before the first solve lands there are no auto-rows and no
        // overrides, so nothing is dimmed and the hint would explain an
        // absence.
        disabledHint={
          disabledIds.size > 0 ? i18n.t("inputs.picker.listed") : undefined
        }
        onPick={(newId) => {
          if (row === undefined) {
            // The row mounts on a later commit, so hand its rate input the
            // focus: it is the only edit that makes the new row do anything.
            pendingFocus.current = { itemId: newId, kind: "rate" };
            onChange((current) =>
              current.some((o) => o.itemId === newId)
                ? current
                : [...current, { itemId: newId }],
            );
            // Re-picking the row's own (still-enabled, highlighted) item is a
            // confirm, not a swap; without this guard the dup check would match
            // the row against itself and raise a false duplicate alert.
          } else if (newId !== row.itemId) {
            // The swap unmounts this row (rows are keyed by itemId), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            pendingFocus.current = { itemId: newId, kind: "trigger" };
            handleItemChange(row.itemId, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
