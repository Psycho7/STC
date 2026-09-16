import { useEffect, useMemo, useRef, useState } from "react";
// Aliased: the bare name would shadow the DOM MouseEvent the Add handler below
// is typed against.
import type { MouseEvent as ReactMouseEvent } from "react";
import type { RecipePack } from "@aef/schema";
import type { RationalString, Target } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { producibleItemIds } from "../data/recipe-category";
import { ratePerSecToPerMin } from "../data/rate-format";
import { computeItemDepths } from "../data/recipe-depth";
import {
  iconIdForItem,
  iconPosition,
  iconSheetUrl,
} from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { RatePromptPopup } from "./RatePromptPopup";
import { useRateEdit } from "./useRateEdit";

type PendingFocus = { itemId: string; kind: "rate" | "trigger" };

// Default for the optional eventOffItems prop: nothing is off-cohort.
const NO_EVENT_OFF: ReadonlyMap<string, string> = new Map();

type Props = {
  targets: Target[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: Target[]) => Target[]) => void;
  pack: RecipePack;
  // Event items of effectively-off cohorts (#144's T6), itemId -> cohort, as
  // derived by unavailableEventItems(pack, overrides) in the owner. Both picker
  // call sites dim these tiles and the hint names the cohort(s). Optional with
  // an empty default so callers that model no cohorts render every tile enabled.
  eventOffItems?: ReadonlyMap<string, string> | undefined;
};

export function TargetsPanel({
  targets,
  onChange,
  pack,
  eventOffItems = NO_EVENT_OFF,
}: Props) {
  const i18n = useI18n();
  // Producible items are the pickable targets: any item produced with positive
  // qty by a non-internal, non-input-supply recipe (raw and byproduct-only
  // items included).
  const pickableItems = useMemo(() => {
    const ids = producibleItemIds(pack.recipes);
    return pack.items.filter((i) => ids.has(i.id));
  }, [pack]);
  // Availability depth per item id, used by the picker popup to group tiles.
  const tierByItemId = useMemo(() => computeItemDepths(pack), [pack]);
  // The picker hint for off-cohort event items (#144's T6): the raw cohort
  // tokens ("v1.2 · v1.5"), the same ones the producer-unavailable validation
  // error interpolates, so both surfaces name a cohort identically. Gated on at
  // least one of the items being in the catalogue above - a cohort whose every
  // item is non-producible would explain dimming the grid never shows.
  const eventOffHint = useMemo(() => {
    if (eventOffItems.size === 0) return undefined;
    if (!pickableItems.some((it) => eventOffItems.has(it.id))) return undefined;
    const cohorts = [...new Set(eventOffItems.values())].sort().join(" · ");
    return i18n.t("picker.event.off", { cohorts });
  }, [eventOffItems, pickableItems, i18n]);
  // Which row the row-swap picker popup is open for, or that Add opened the
  // picker directly (R4), plus the trigger button that opened it so focus can
  // return there on close.
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; itemId: string } | { kind: "add" } | null
  >(null);
  // The item whose amount prompt (R4) is open. Picking in the add picker
  // closes it and opens this, so only one popup is ever mounted.
  const [prompt, setPrompt] = useState<{ itemId: string } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a row swapped onto another item -
    // rows are keyed by itemId), so guard the focus. The removed case hands
    // focus to the replacement row through the pending-focus token below.
    if (btn && document.contains(btn)) btn.focus();
  }
  // Armed by a row swap or an add confirm, consumed by the matching row's
  // callback ref on the next commit (the InputsPanel token, same rules): a
  // swap unmounts the element that held focus, and a fresh add must hand it
  // to the new row's rate input.
  const pendingFocus = useRef<PendingFocus | null>(null);
  // The token lives for exactly one commit: ref callbacks run before effects,
  // so a consumed token is already null here and an unapplied one is dropped
  // rather than firing on a later unrelated commit.
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
  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    itemId: string;
  } | null>(null);
  // The rate edit/commit/revert protocol for the target rows. A target needs a
  // rate, so empty text is invalid rather than a commit, and the committed
  // string is kept as the display value.
  const rateEdit = useRateEdit({
    emptyMeans: "invalid",
    keepTextAfterCommit: true,
    // A failed parse never mutates the plan, so this runs only for a rate the
    // row can take; the "invalid" arm of RateEditConfig types parsed
    // non-optional.
    commit: (itemId, parsed) => {
      onChange((current) => {
        const idx = current.findIndex((t) => t.itemId === itemId);
        // Row removed since the edit: no-op (same reference).
        if (idx < 0) return current;
        const next = current.slice();
        next[idx] = { ...next[idx]!, ratePerSec: parsed };
        return next;
      });
    },
  });

  function handleItemChange(oldItemId: string, newItemId: string) {
    const dup = targets.some((t) => t.itemId === newItemId);
    if (dup) {
      setDuplicateError({ rowId: oldItemId, itemId: newItemId });
      return;
    }
    setDuplicateError(null);
    rateEdit.carryPendingEdit(oldItemId, newItemId);
    onChange((current) => {
      const idx = current.findIndex((t) => t.itemId === oldItemId);
      if (idx < 0) return current;
      if (current.some((t) => t.itemId === newItemId)) return current;
      const next = current.slice();
      next[idx] = { ...next[idx]!, itemId: newItemId };
      return next;
    });
  }

  function handleRemove(itemId: string) {
    setDuplicateError(null);
    rateEdit.clearPendingEdit(itemId);
    onChange((current) => {
      const next = current.filter((t) => t.itemId !== itemId);
      return next.length === current.length ? current : next;
    });
  }

  // R4: Add opens the item picker directly. The picked item's amount is asked
  // in the prompt that follows the pick; nothing commits until a positive rate
  // confirms there (R6), so no draft row ever exists.
  function handleAdd(e: ReactMouseEvent<HTMLButtonElement>) {
    triggerRef.current = e.currentTarget;
    setPickerFor({ kind: "add" });
  }

  // The add prompt confirmed a rate. The row commits exactly once (the picker
  // disables already-targeted items, so the guard is belt and braces), and the
  // pending-focus token hands focus to the new row's rate input.
  function confirmPromptRate(rate: RationalString | undefined) {
    const itemId = prompt?.itemId;
    // The "invalid" mode never confirms without a rate; the guard only tells
    // the type system that.
    if (itemId === undefined || rate === undefined) return;
    pendingFocus.current = { itemId, kind: "rate" };
    onChange((current) =>
      current.some((t) => t.itemId === itemId)
        ? current
        : [...current, { itemId, ratePerSec: rate }],
    );
    triggerRef.current = null;
    setPrompt(null);
  }

  // R7: cancelling the prompt cancels the whole add - nothing committed, and
  // focus returns to the Add button that started it.
  function cancelPrompt() {
    setPrompt(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    if (btn && document.contains(btn)) btn.focus();
  }

  return (
    <div className="boundary-section" data-testid="targets-section">
      <div className="side-section-head">
        <span className="num">SET · 01</span>
        <span className="label">TARGETS BOUNDARY</span>
        <span className="count">
          <span className="v">{targets.length}</span>
          {" / "}
          {pickableItems.length}
        </span>
      </div>
      <div className="side-section-sub">{i18n.t("targets.head.sub")}</div>
      {targets.length === 0 ? (
        <div className="b-empty">{i18n.t("targets.empty")}</div>
      ) : null}
      {targets.map((t) => {
        const iconId = iconIdForItem(t.itemId);
        const iconPos = iconPosition(iconId);
        const rate = rateEdit.field(t.itemId, ratePerSecToPerMin(t.ratePerSec));
        return (
          <div key={t.itemId} className="b-row" data-testid="target-row">
            <span className={"slot" + (iconPos === undefined ? " empty" : "")}>
              <Sprite iconId={iconId} size={40} />
            </span>
            <div className="info">
              <span className="b-pick">
                <button
                  type="button"
                  className="b-pick-trigger"
                  // The name goes in the accessible NAME, not just the visible
                  // text: aria-label overrides the button's content, so a bare
                  // "item" would make every row's trigger announce identically.
                  aria-label={i18n.t("item.selected", {
                    name: i18n.displayName(t.itemId),
                  })}
                  aria-haspopup="dialog"
                  // title shows the full localised item name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(t.itemId)}
                  ref={(el) => focusOnMount(el, t.itemId, "trigger")}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", itemId: t.itemId });
                  }}
                >
                  {i18n.displayName(t.itemId)}
                </button>
              </span>
              <div className="item-id">
                {t.itemId}
                <span className="mid">ITEM</span>
              </div>
              {duplicateError?.rowId === t.itemId && (
                <span role="alert">
                  {i18n.t("targets.duplicate", {
                    itemId: duplicateError.itemId,
                  })}
                </span>
              )}
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("targets.rate.label")}
                aria-describedby={
                  rate.invalid ? `t-rate-err-${t.itemId}` : undefined
                }
                ref={(el) => focusOnMount(el, t.itemId, "rate")}
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
              {rate.invalid ? (
                <span
                  className="b-rate-err"
                  id={`t-rate-err-${t.itemId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
            </div>
            <button
              className="b-remove"
              data-testid="remove-target"
              onClick={() => handleRemove(t.itemId)}
              aria-label={i18n.t("targets.remove.label")}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="b-add" onClick={handleAdd}>
        {i18n.t("targets.add")}
      </button>
      {pickerFor !== null ? renderPicker() : null}
      {prompt !== null ? (
        <RatePromptPopup
          item={{ id: prompt.itemId, name: i18n.displayName(prompt.itemId) }}
          emptyMeans="invalid"
          iconSheetUrl={iconSheetUrl}
          onConfirm={confirmPromptRate}
          onCancel={cancelPrompt}
        />
      ) : null}
    </div>
  );

  function renderPicker() {
    if (pickerFor === null) return null;
    if (pickerFor.kind === "add") {
      // Items already targeted are disabled tiles. Off-cohort event items
      // (#144's T6) dim on top, like every other unavailable pick.
      const disabledIds = new Set<string>(targets.map((t) => t.itemId));
      for (const id of eventOffItems.keys()) disabledIds.add(id);
      return (
        <ItemPickerPopup
          items={pickableItems}
          disabledIds={disabledIds}
          tierByItemId={tierByItemId}
          disabledHint={eventOffHint}
          onPick={(newId) => {
            // The prompt takes focus when it opens (its rate input
            // autofocuses), so the trigger is not refocused here; it stays
            // stashed for the prompt's cancel path (R7).
            setPickerFor(null);
            setPrompt({ itemId: newId });
          }}
          onClose={closePicker}
        />
      );
    }
    const rowId = pickerFor.itemId;
    // The row may have gone (removed, or swapped by another commit) while the
    // popup was open: without this guard the popup highlights a tile for a row
    // that no longer exists and a pick arms a focus token for a commit that
    // can never apply.
    if (!targets.some((t) => t.itemId === rowId)) return null;
    // Disable items other targets already claim; the row's own item stays
    // enabled and highlighted as selected. Off-cohort event items (#144's T6)
    // dim on top, like every other unavailable pick.
    const disabledIds = new Set<string>(
      targets.filter((t) => t.itemId !== rowId).map((t) => t.itemId),
    );
    for (const id of eventOffItems.keys()) disabledIds.add(id);
    return (
      <ItemPickerPopup
        items={pickableItems}
        disabledIds={disabledIds}
        selectedId={rowId}
        tierByItemId={tierByItemId}
        disabledHint={eventOffHint}
        onPick={(newId) => {
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row itself and raise a false duplicate alert.
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
