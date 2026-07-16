import { useMemo, useRef, useState } from "react";
import Fraction from "fraction.js";
import type { Recipe, RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import {
  hasPositivePrimaryQty,
  isInputSupplyRecipe,
  isSinkRecipe,
} from "../data/recipe-category";
import { ratePerSecToPerMin } from "../data/rate-format";
import { computeRecipeDepths } from "../data/recipe-depth";
import { iconPosition } from "../canvas/iconSprite";
import { RecipePickerPopup } from "./RecipePickerPopup";

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

// Accepts an items-per-minute value as an integer ("120"), decimal ("30.5"), or
// rational ("1/3"). Returns undefined if it can't parse or the result is
// negative.
function parsePerMinToRationalPerSec(
  perMinStr: string,
): { num: string; denom: string } | undefined {
  let f: Fraction;
  try {
    f = new Fraction(perMinStr).div(new Fraction(60));
  } catch {
    return undefined;
  }
  if (f.compare(0) < 0) return undefined;
  const s = f.toFraction(false);
  const [n, d] = s.includes("/") ? s.split("/") : [s, "1"];
  return { num: n!, denom: d! };
}

// Which recipes are valid to pick as a target. Carve-outs:
// - `__internal` recipes are synthetic raw sources; never show them.
// - `__domain_transfer` recipes import an item across domains, an input-supply
//   mechanism, not a production step; they belong in the input-supply UI.
// - Sink recipes (out: []) consume items but produce nothing, so a target
//   rate is undefined for them.
// - A zero-qty primary output produces none of the item the target names, so
//   the rate is meaningless; validatePlan rejects it as a second line.
function isPickableTarget(recipe: Recipe): boolean {
  return (
    recipe.category !== "__internal" &&
    !isInputSupplyRecipe(recipe) &&
    !isSinkRecipe(recipe) &&
    hasPositivePrimaryQty(recipe)
  );
}

export function TargetsPanel({ targets, onChange, pack }: Props) {
  const i18n = useI18n();
  const pickableRecipes = pack.recipes.filter(isPickableTarget);
  // Crafting-tier depth per recipe, used by the picker popup to group tiles.
  const depthByRecipeId = useMemo(() => computeRecipeDepths(pack), [pack]);
  // Which row/draft the picker popup is open for, plus the trigger button that
  // opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<
    | { kind: "row"; recipeId: string }
    | { kind: "draft"; draftId: string }
    | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a promoted draft), so guard the focus.
    if (btn && document.contains(btn)) btn.focus();
  }
  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    recipeId: string;
  } | null>(null);
  // In-flight edit values keyed by recipeId. A row without an entry falls back
  // to the prop-derived value, so a new `targets` prop updates the visible rate
  // without a separate sync effect. Keying by id (not row index) keeps an
  // uncommitted edit attached to its row across removals and reorders. The text
  // is committed only on blur or Enter, and the committed string is kept here as
  // the display value (re-serializing ratePerSec would turn "1/3" into a float).
  const [localRates, setLocalRates] = useState<Map<string, string>>(new Map());
  // Recipe ids whose localRates text has not yet been committed. Guards the
  // blur/Enter commit so re-blurring an unedited field never re-fires a solve.
  // The owner remounts this panel (via a key keyed on plan identity) when it
  // navigates to a new plan, which drops all uncommitted local edit state, so
  // there is no cross-plan carryover to clear here.
  const dirty = useRef<Set<string>>(new Set());
  // Recipe ids whose last commit attempt failed to parse. Drives the input's
  // aria-invalid flag and the inline error message. Typing clears the flag; a
  // successful commit or a blur-revert clears it too.
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());
  function markInvalid(recipeId: string, on: boolean) {
    setInvalidIds((prev) => {
      if (on === prev.has(recipeId)) return prev;
      const next = new Set(prev);
      if (on) next.add(recipeId);
      else next.delete(recipeId);
      return next;
    });
  }

  // Returns true iff the text parsed. Invalid text is left in place so the user
  // can finish typing; a failed parse never mutates the plan.
  function commitRate(recipeId: string, perMinStr: string): boolean {
    const parsed = parsePerMinToRationalPerSec(perMinStr);
    if (!parsed) return false;
    onChange((current) => {
      const idx = current.findIndex((t) => t.recipeId === recipeId);
      // Row removed since the edit: no-op (same reference).
      if (idx < 0) return current;
      const next = current.slice();
      next[idx] = { ...next[idx]!, ratePerSec: parsed };
      return next;
    });
    return true;
  }

  function handleRateChange(recipeId: string, value: string) {
    dirty.current.add(recipeId);
    // Typing clears any prior invalid cue; the value is re-checked on commit.
    markInvalid(recipeId, false);
    setLocalRates((prev) => new Map(prev).set(recipeId, value));
  }

  // Commit the row's uncommitted text on blur (revert=true) or Enter
  // (revert=false). Only a dirty row acts; a successful parse commits and clears
  // the dirty/invalid flags. On a failed parse, Enter surfaces the invalid cue
  // and keeps the bad text so the user can fix it, while a blur reverts the
  // field to its last-good value so it never sticks on rejected input.
  function commitFromLocal(recipeId: string, revert: boolean) {
    if (!dirty.current.has(recipeId)) return;
    const value = localRates.get(recipeId);
    if (value === undefined) return;
    if (commitRate(recipeId, value)) {
      dirty.current.delete(recipeId);
      markInvalid(recipeId, false);
      return;
    }
    if (revert) {
      dirty.current.delete(recipeId);
      markInvalid(recipeId, false);
      setLocalRates((prev) => {
        if (!prev.has(recipeId)) return prev;
        const next = new Map(prev);
        next.delete(recipeId);
        return next;
      });
    } else {
      markInvalid(recipeId, true);
    }
  }

  // Drop the in-flight edit text and dirty flag for a row that is going away, so
  // a stale entry can never redisplay on a later row that reuses the same id.
  function clearPendingEdit(recipeId: string) {
    dirty.current.delete(recipeId);
    markInvalid(recipeId, false);
    setLocalRates((prev) => {
      if (!prev.has(recipeId)) return prev;
      const next = new Map(prev);
      next.delete(recipeId);
      return next;
    });
  }

  function handleRecipeChange(oldRecipeId: string, newRecipeId: string) {
    const dup = targets.some((t) => t.recipeId === newRecipeId);
    if (dup) {
      setDuplicateError({ rowId: oldRecipeId, recipeId: newRecipeId });
      return;
    }
    setDuplicateError(null);
    // An uncommitted rate edit follows the row to its new id, dirty flag and all,
    // so the user can still blur to commit it under the swapped recipe.
    const pendingValue = localRates.get(oldRecipeId);
    if (pendingValue !== undefined) {
      const wasDirty = dirty.current.delete(oldRecipeId);
      if (wasDirty) dirty.current.add(newRecipeId);
      setLocalRates((prev) => {
        const next = new Map(prev);
        next.delete(oldRecipeId);
        next.set(newRecipeId, pendingValue);
        return next;
      });
    }
    onChange((current) => {
      const idx = current.findIndex((t) => t.recipeId === oldRecipeId);
      if (idx < 0) return current;
      if (current.some((t) => t.recipeId === newRecipeId)) return current;
      const next = current.slice();
      next[idx] = { ...next[idx]!, recipeId: newRecipeId };
      return next;
    });
  }

  function handleRemove(recipeId: string) {
    setDuplicateError(null);
    clearPendingEdit(recipeId);
    onChange((current) => {
      const next = current.filter((t) => t.recipeId !== recipeId);
      return next.length === current.length ? current : next;
    });
  }

  // Clicking Add creates a local draft row instead of committing an arbitrary
  // first-pack-order recipe at rate 0. A draft never touches the plan until it
  // has both a chosen recipe and a committed nonzero rate; drafts are local
  // state, so navigation (which remounts the panel) drops them.
  const [drafts, setDrafts] = useState<
    Array<{ id: string; recipeId: string; rate: string }>
  >([]);
  const draftSeq = useRef(0);

  function handleAdd() {
    const id = `draft:${draftSeq.current++}`;
    setDrafts((prev) => [...prev, { id, recipeId: "", rate: "" }]);
  }

  function removeDraft(id: string) {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  }

  // Apply an edited draft: promote it into a real target once it carries a
  // recipe and a committed nonzero rate (dropping the draft), otherwise just
  // store the updated draft. A nonzero rate is required so an empty or 0 draft
  // never churns a re-solve for a row that renders nothing.
  function applyDraft(next: { id: string; recipeId: string; rate: string }) {
    const parsed = parsePerMinToRationalPerSec(next.rate);
    const ready =
      next.recipeId !== "" && parsed !== undefined && parsed.num !== "0";
    if (ready) {
      onChange((current) =>
        current.some((t) => t.recipeId === next.recipeId)
          ? current
          : [...current, { recipeId: next.recipeId, ratePerSec: parsed }],
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
          {pickableRecipes.length}
        </span>
      </div>
      <div className="side-section-sub">{i18n.t("targets.head.sub")}</div>
      {targets.length === 0 ? (
        <div className="b-empty">{i18n.t("targets.empty")}</div>
      ) : null}
      {targets.map((t) => {
        const recipe = pack.recipes.find((r) => r.id === t.recipeId);
        const outputItemId = recipe?.out[0]?.item;
        // Chain of icon fallbacks. Sink recipes (out: []) and disambiguated
        // variants like "liquid_cleaner_1-sewage" don't match their own id in
        // the icon sheet, but the recipe usually carries an explicit compound
        // icon id; as a last resort the first producer (machine) icon stands in.
        const iconPos =
          iconPosition(outputItemId) ??
          iconPosition(recipe?.icon) ??
          iconPosition(recipe?.producers?.[0]) ??
          iconPosition(t.recipeId);
        const displayedRate =
          localRates.get(t.recipeId) ?? ratePerSecToPerMin(t.ratePerSec);
        return (
          <div key={t.recipeId} className="b-row" data-testid="target-row">
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
                  aria-label={i18n.t("targets.recipe.label")}
                  aria-haspopup="dialog"
                  // title shows the full localised recipe name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(t.recipeId)}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", recipeId: t.recipeId });
                  }}
                >
                  {i18n.displayName(t.recipeId)}
                </button>
              </span>
              <div className="item-id">
                {t.recipeId}
                <span className="mid">RECIPE</span>
              </div>
              {duplicateError?.rowId === t.recipeId && (
                <span role="alert">
                  {i18n.t("targets.duplicate", {
                    recipeId: duplicateError.recipeId,
                  })}
                </span>
              )}
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("targets.rate.label")}
                aria-invalid={invalidIds.has(t.recipeId) ? true : undefined}
                aria-describedby={
                  invalidIds.has(t.recipeId)
                    ? `t-rate-err-${t.recipeId}`
                    : undefined
                }
                className={invalidIds.has(t.recipeId) ? "invalid" : undefined}
                value={displayedRate}
                onChange={(e) => handleRateChange(t.recipeId, e.target.value)}
                onBlur={() => commitFromLocal(t.recipeId, true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitFromLocal(t.recipeId, false);
                }}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
              {invalidIds.has(t.recipeId) ? (
                <span
                  className="b-rate-err"
                  id={`t-rate-err-${t.recipeId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
            </div>
            <button
              className="b-remove"
              data-testid="remove-target"
              onClick={() => handleRemove(t.recipeId)}
              aria-label={i18n.t("targets.remove.label")}
            >
              ×
            </button>
          </div>
        );
      })}
      {drafts.map((draft) => {
        const iconPos =
          draft.recipeId !== ""
            ? (iconPosition(
                pack.recipes.find((r) => r.id === draft.recipeId)?.out[0]?.item,
              ) ?? iconPosition(draft.recipeId))
            : undefined;
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
                    (draft.recipeId === "" ? " placeholder" : "")
                  }
                  aria-label={i18n.t("targets.recipe.label")}
                  aria-haspopup="dialog"
                  title={
                    draft.recipeId !== ""
                      ? i18n.displayName(draft.recipeId)
                      : undefined
                  }
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "draft", draftId: draft.id });
                  }}
                >
                  {draft.recipeId !== ""
                    ? i18n.displayName(draft.recipeId)
                    : i18n.t("targets.recipe.choose")}
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
      const rowId = pickerFor.recipeId;
      // Disable recipes other targets or any draft already claim; the row's own
      // recipe stays enabled and highlighted as selected.
      const disabledIds = new Set<string>([
        ...targets.filter((t) => t.recipeId !== rowId).map((t) => t.recipeId),
        ...drafts.map((d) => d.recipeId).filter((id) => id !== ""),
      ]);
      return (
        <RecipePickerPopup
          recipes={pickableRecipes}
          disabledIds={disabledIds}
          selectedId={rowId}
          depthByRecipeId={depthByRecipeId}
          onPick={(newId) => {
            // Re-picking the row's own (still-enabled, highlighted) recipe is a
            // confirm, not a swap; without this guard the dup check would match
            // the row itself and raise a false duplicate alert.
            if (newId !== rowId) handleRecipeChange(rowId, newId);
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
      ...targets.map((t) => t.recipeId),
      ...drafts
        .filter((d) => d.id !== draft.id && d.recipeId !== "")
        .map((d) => d.recipeId),
    ]);
    return (
      <RecipePickerPopup
        recipes={pickableRecipes}
        disabledIds={disabledIds}
        selectedId={draft.recipeId || undefined}
        depthByRecipeId={depthByRecipeId}
        onPick={(newId) => {
          applyDraft({ ...draft, recipeId: newId });
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
