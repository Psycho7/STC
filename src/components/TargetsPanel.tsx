import { useMemo, useRef, useState } from "react";
import type { RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { producibleItemIds } from "../data/recipe-category";
import {
  parsePerMinToRatePerSec,
  ratePerSecToPerMin,
} from "../data/rate-format";
import { computeItemDepths } from "../data/recipe-depth";
import { iconPosition } from "../canvas/iconSprite";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { useRateEdit } from "./useRateEdit";

type Props = {
  targets: Target[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: Target[]) => Target[]) => void;
  pack: RecipePack;
};

export function TargetsPanel({ targets, onChange, pack }: Props) {
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
  // Which row/draft the picker popup is open for, plus the trigger button that
  // opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; itemId: string } | { kind: "draft"; draftId: string } | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a promoted draft, or a row swapped
    // onto another item - rows are keyed by itemId), so guard the focus. When
    // it has gone, focus falls to the body: InputsPanel hands it to the
    // replacement row instead, and this panel does not yet. Fixing it here
    // wants the same pending-focus token, or row keys that survive an item
    // swap.
    if (btn && document.contains(btn)) btn.focus();
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
    // row can take; under emptyMeans "invalid" parsed is never undefined.
    commit: (itemId, parsed) => {
      onChange((current) => {
        const idx = current.findIndex((t) => t.itemId === itemId);
        // Row removed since the edit: no-op (same reference).
        if (idx < 0) return current;
        const next = current.slice();
        next[idx] = { ...next[idx]!, ratePerSec: parsed! };
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

  // Clicking Add creates a local draft row instead of committing an arbitrary
  // first-pack-order item at rate 0. A draft never touches the plan until it
  // has both a chosen item and a committed nonzero rate; drafts are local
  // state, so navigation (which remounts the panel) drops them.
  const [drafts, setDrafts] = useState<
    Array<{ id: string; itemId: string; rate: string }>
  >([]);
  const draftSeq = useRef(0);

  function handleAdd() {
    const id = `draft:${draftSeq.current++}`;
    setDrafts((prev) => [...prev, { id, itemId: "", rate: "" }]);
  }

  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  // Apply an edited draft: promote it into a real target once it carries an
  // item and a committed nonzero rate (dropping the draft), otherwise just
  // store the updated draft. A nonzero rate is required so an empty or 0 draft
  // never churns a re-solve for a row that renders nothing.
  function applyDraft(next: { id: string; itemId: string; rate: string }) {
    const parsed = parsePerMinToRatePerSec(next.rate);
    const ready =
      next.itemId !== "" && parsed !== undefined && parsed.num !== "0";
    if (ready) {
      onChange((current) =>
        current.some((t) => t.itemId === next.itemId)
          ? current
          : [...current, { itemId: next.itemId, ratePerSec: parsed }],
      );
      removeDraft(next.id);
    } else {
      setDrafts((prev) => prev.map((d) => (d.id === next.id ? next : d)));
    }
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
        const iconPos = iconPosition(t.itemId);
        const rate = rateEdit.field(t.itemId, ratePerSecToPerMin(t.ratePerSec));
        return (
          <div key={t.itemId} className="b-row" data-testid="target-row">
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
      {drafts.map((draft) => {
        const iconPos =
          draft.itemId !== "" ? iconPosition(draft.itemId) : undefined;
        return (
          <div key={draft.id} className="b-row" data-testid="target-draft-row">
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
                  className={
                    "b-pick-trigger" +
                    (draft.itemId === "" ? " placeholder" : "")
                  }
                  // An empty draft has no item to name, so it keeps the
                  // call-to-action string; once picked it names the item like a
                  // target row's trigger does.
                  aria-label={
                    draft.itemId !== ""
                      ? i18n.t("item.selected", {
                          name: i18n.displayName(draft.itemId),
                        })
                      : i18n.t("targets.item.choose")
                  }
                  aria-haspopup="dialog"
                  title={
                    draft.itemId !== ""
                      ? i18n.displayName(draft.itemId)
                      : undefined
                  }
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "draft", draftId: draft.id });
                  }}
                >
                  {draft.itemId !== ""
                    ? i18n.displayName(draft.itemId)
                    : i18n.t("targets.item.choose")}
                </button>
              </span>
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("targets.rate.label")}
                value={draft.rate}
                onChange={(e) =>
                  setDrafts((prev) =>
                    prev.map((d) =>
                      d.id === draft.id ? { ...d, rate: e.target.value } : d,
                    ),
                  )
                }
                onBlur={() => applyDraft(draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyDraft(draft);
                }}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
            </div>
            <button
              className="b-remove"
              data-testid="remove-draft"
              onClick={() => removeDraft(draft.id)}
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
    </div>
  );

  function renderPicker() {
    if (pickerFor === null) return null;
    if (pickerFor.kind === "row") {
      const rowId = pickerFor.itemId;
      // Disable items other targets or any draft already claim; the row's own
      // item stays enabled and highlighted as selected.
      const disabledIds = new Set<string>([
        ...targets.filter((t) => t.itemId !== rowId).map((t) => t.itemId),
        ...drafts.map((d) => d.itemId).filter((id) => id !== ""),
      ]);
      return (
        <ItemPickerPopup
          items={pickableItems}
          disabledIds={disabledIds}
          selectedId={rowId}
          tierByItemId={tierByItemId}
          onPick={(newId) => {
            // Re-picking the row's own (still-enabled, highlighted) item is a
            // confirm, not a swap; without this guard the dup check would match
            // the row itself and raise a false duplicate alert.
            if (newId !== rowId) handleItemChange(rowId, newId);
            closePicker();
          }}
          onClose={closePicker}
        />
      );
    }
    const draft = drafts.find((d) => d.id === pickerFor.draftId);
    // The draft may have vanished (promoted or removed) before the popup closed.
    if (!draft) return null;
    const disabledIds = new Set<string>([
      ...targets.map((t) => t.itemId),
      ...drafts
        .filter((d) => d.id !== draft.id && d.itemId !== "")
        .map((d) => d.itemId),
    ]);
    return (
      <ItemPickerPopup
        items={pickableItems}
        disabledIds={disabledIds}
        selectedId={draft.itemId || undefined}
        tierByItemId={tierByItemId}
        onPick={(newId) => {
          applyDraft({ ...draft, itemId: newId });
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
