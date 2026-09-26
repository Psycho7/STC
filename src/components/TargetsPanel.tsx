import { useEffect, useMemo, useState } from "react";
// Aliased: the bare name would shadow the DOM MouseEvent the Add handler below
// is typed against.
import type { MouseEvent as ReactMouseEvent } from "react";
import type { RecipePack } from "@aef/schema";
import type { RationalString, Target } from "../data/targets";
import type { ProducerUnavailableCause } from "../data/plan";
import { useI18n } from "../data/i18n-context";
import { producibleItemIds } from "../data/recipe-category";
import {
  RATE_ERROR_KEY,
  ratePerSecToPerMin,
  rateRevertedText,
} from "../data/rate-format";
import {
  iconIdForItem,
  iconPosition,
  iconSheetUrl,
} from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { RatePromptPopup } from "./RatePromptPopup";
import { usePickerFlow } from "./usePickerFlow";
import { useRateEdit } from "./useRateEdit";

// Default for the optional unavailableItems prop: nothing is unavailable.
const NO_UNAVAILABLE: ReadonlyMap<string, ProducerUnavailableCause> = new Map();

type Props = {
  targets: Target[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: Target[]) => Target[]) => void;
  pack: RecipePack;
  // Unavailable items, each mapped to the cause behind it, as derived by
  // unavailableItems(pack, settings) in the owner. Both picker call sites dim
  // these tiles and the hint names the cause. Optional with an empty default so
  // callers that model no availability render every tile enabled.
  unavailableItems?: ReadonlyMap<string, ProducerUnavailableCause> | undefined;
};

export function TargetsPanel({
  targets,
  onChange,
  pack,
  unavailableItems = NO_UNAVAILABLE,
}: Props) {
  const i18n = useI18n();
  // Producible items are the pickable targets: any item produced with positive
  // qty by a non-internal, non-input-supply recipe (raw and byproduct-only
  // items included).
  const pickableItems = useMemo(() => {
    const ids = producibleItemIds(pack.recipes);
    return pack.items.filter((i) => ids.has(i.id));
  }, [pack]);
  // The row-swap picker (or Add's picker, R4) and the amount prompt (R4) that
  // follows an add pick. Rows are keyed by item id.
  const flow = usePickerFlow<
    { kind: "row"; itemId: string } | { kind: "add" },
    { itemId: string }
  >(pack, pickableItems, unavailableItems);
  const { pickerFor, prompt, closePicker, focusOnMount } = flow;
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
  // Prune pending / seeded state for rows that left the target list by any
  // route: handleRemove clears its own row, but an item swap also retires the
  // old key, and a surviving revert flag would resurface as a stale status
  // line if the same item returns.
  const targetIds = useMemo(
    () => new Set(targets.map((t) => t.itemId)),
    [targets],
  );
  useEffect(() => {
    rateEdit.pruneEditsTo(targetIds);
    // rateEdit is rebuilt every render; the prune depends only on the live ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIds]);

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
    flow.openPicker(e.currentTarget, { kind: "add" });
  }

  // The add prompt confirmed a rate. The row commits exactly once (the picker
  // disables already-targeted items, so the guard is belt and braces), and the
  // pending-focus token hands focus to the new row's rate input.
  function confirmPromptRate(rate: RationalString | undefined) {
    const itemId = prompt?.itemId;
    // The "invalid" mode never confirms without a rate; the guard only tells
    // the type system that.
    if (itemId === undefined || rate === undefined) return;
    flow.armFocus(itemId, "rate");
    onChange((current) =>
      current.some((t) => t.itemId === itemId)
        ? current
        : [...current, { itemId, ratePerSec: rate }],
    );
    flow.closePrompt();
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
                  onClick={(e) =>
                    flow.openPicker(e.currentTarget, {
                      kind: "row",
                      itemId: t.itemId,
                    })
                  }
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
                aria-label={i18n.t("targets.rate.forItem", {
                  name: i18n.displayName(t.itemId),
                })}
                aria-describedby={
                  rate.invalid ? `t-rate-err-${t.itemId}` : undefined
                }
                ref={(el) => focusOnMount(el, t.itemId, "rate")}
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
              {rate.error !== undefined ? (
                <span
                  className="b-rate-err"
                  id={`t-rate-err-${t.itemId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t(RATE_ERROR_KEY[rate.error])}
                </span>
              ) : rate.reverted !== undefined ? (
                <span
                  className="b-rate-err"
                  role="status"
                  data-testid="rate-reverted"
                >
                  {rateRevertedText(i18n, rate.reverted)}
                </span>
              ) : null}
            </div>
            <button
              className="b-remove"
              data-testid="remove-target"
              onClick={() => handleRemove(t.itemId)}
              aria-label={i18n.t("targets.remove.forItem", {
                name: i18n.displayName(t.itemId),
              })}
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
          onCancel={flow.cancelPrompt}
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
      for (const id of unavailableItems.keys()) disabledIds.add(id);
      return (
        <ItemPickerPopup
          items={pickableItems}
          disabledIds={disabledIds}
          tierByItemId={flow.tierByItemId}
          disabledHint={flow.unavailableHint}
          onPick={(newId) => flow.openPrompt({ itemId: newId })}
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
    for (const id of unavailableItems.keys()) disabledIds.add(id);
    return (
      <ItemPickerPopup
        items={pickableItems}
        disabledIds={disabledIds}
        selectedId={rowId}
        tierByItemId={flow.tierByItemId}
        disabledHint={flow.unavailableHint}
        onPick={(newId) => {
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row itself and raise a false duplicate alert.
          if (newId !== rowId) {
            // The swap unmounts this row (rows are keyed by itemId), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            flow.armFocus(newId, "trigger");
            handleItemChange(rowId, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
