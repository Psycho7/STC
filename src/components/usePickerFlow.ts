import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, RecipePack } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import { computeItemDepths } from "../data/recipe-depth";

// A focus target armed by a pick and consumed by the row that renders on the
// very next commit. The kind matters: both consumers live on the same row and
// React attaches refs in tree order, so the trigger inside .info completes
// before the rate input inside .b-rate. A bare row key would let the trigger
// ref swallow every token and the add path's rate focus would never fire.
type PendingFocus = { rowKey: string; kind: "rate" | "trigger" };

// The picker -> amount prompt flow a boundary panel runs: which row (or Add)
// the item picker is open for, the prompt a pick in the add picker opens, the
// trigger button focus returns to, and the focus token that follows a row
// across the commit that re-keys it. PickerFor and Prompt are the panel's own
// shapes; the row key is opaque here (an item id for targets, an item override
// key for inputs).
export function usePickerFlow<PickerFor, Prompt>(
  pack: RecipePack,
  // The pickable catalogue, which only gates the event-off hint below.
  catalogue: readonly Item[],
  eventOffItems: ReadonlyMap<string, string>,
) {
  const i18n = useI18n();
  // Availability depth per item id, used by the picker popup to group tiles.
  // computeItemDepths seeds every pack item; ones no recipe can reach land in
  // the unranked bucket, which on the shipped pack is empty.
  const tierByItemId = useMemo(() => computeItemDepths(pack), [pack]);
  // The picker hint for off-cohort event items (#144's T6): the raw cohort
  // tokens ("v1.2 · v1.5"), the same ones the producer-unavailable validation
  // error interpolates, so both surfaces name a cohort identically. Gated on at
  // least one of the items being in the catalogue, so a cohort whose every item
  // the grid never shows explains nothing.
  const eventOffHint = useMemo(() => {
    if (eventOffItems.size === 0) return undefined;
    if (!catalogue.some((it) => eventOffItems.has(it.id))) return undefined;
    const cohorts = [...new Set(eventOffItems.values())].sort().join(" · ");
    return i18n.t("picker.event.off", { cohorts });
  }, [eventOffItems, catalogue, i18n]);

  // Which row the picker popup is open for, or that Add opened it, plus the
  // trigger button that opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<PickerFor | null>(null);
  // The amount prompt a pick in the add picker opens. Opening it closes the
  // picker, so only one popup is ever mounted.
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Armed by a pick, consumed by the matching row's callback ref on the next
  // commit: a swap unmounts the element that held focus, and a fresh add must
  // hand it to the new row's rate input. A stale token (the commit was
  // rejected, or the panel is rendered with an onChange that never feeds the
  // prop back) is simply overwritten by the next pick.
  const pendingFocus = useRef<PendingFocus | null>(null);
  // The token lives for exactly one commit. focusOnMount is an inline arrow, so
  // React re-attaches it on every render, not only on mount: an unconsumed
  // token would otherwise sit armed indefinitely and fire on some later,
  // unrelated commit that happens to render a row with the same key, yanking
  // focus out of whatever the user was doing. Ref callbacks run before
  // effects within a commit, so a token the matching row consumed is already
  // null here; one whose commit never applied is dropped.
  useEffect(() => {
    pendingFocus.current = null;
  });

  // The trigger may have been removed (a committed swap unmounts its row), so
  // guard the focus. The removed case hands focus to the replacement row
  // through the pending-focus token instead.
  function restoreTriggerFocus() {
    const btn = triggerRef.current;
    triggerRef.current = null;
    if (btn && document.contains(btn)) btn.focus();
  }

  return {
    tierByItemId,
    eventOffHint,
    pickerFor,
    prompt,
    openPicker(trigger: HTMLButtonElement, openFor: PickerFor) {
      triggerRef.current = trigger;
      setPickerFor(openFor);
    },
    closePicker() {
      setPickerFor(null);
      restoreTriggerFocus();
    },
    // The prompt takes focus when it opens (its rate input autofocuses), so
    // the picker closes without refocusing; the trigger stays stashed for the
    // prompt's cancel path (R7).
    openPrompt(next: Prompt) {
      setPickerFor(null);
      setPrompt(next);
    },
    // The prompt confirmed and committed: nothing to hand focus back to.
    closePrompt() {
      triggerRef.current = null;
      setPrompt(null);
    },
    // R7: cancelling the prompt cancels the whole add - nothing committed, and
    // focus returns to the Add button that started it.
    cancelPrompt() {
      setPrompt(null);
      restoreTriggerFocus();
    },
    armFocus(rowKey: string, kind: PendingFocus["kind"]) {
      pendingFocus.current = { rowKey, kind };
    },
    focusOnMount(
      el: HTMLElement | null,
      rowKey: string,
      kind: PendingFocus["kind"],
    ) {
      const want = pendingFocus.current;
      if (!el || !want || want.rowKey !== rowKey || want.kind !== kind) return;
      pendingFocus.current = null;
      el.focus();
    },
  };
}
