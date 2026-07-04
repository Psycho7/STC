import { useEffect, useRef, useState } from "react";
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
import { iconPosition } from "../canvas/iconSprite";

type Props = {
  targets: Target[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a debounced commit
  // built from a stale prop can otherwise drop a concurrent edit or resurrect
  // a removed row. An updater that finds nothing to change must return its
  // input unchanged (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: Target[]) => Target[]) => void;
  pack: RecipePack;
};

const DEBOUNCE_MS = 150;

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
  const [duplicateError, setDuplicateError] = useState<{
    rowId: string;
    recipeId: string;
  } | null>(null);
  const timerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // In-flight edit values keyed by recipeId. A row without an entry falls back
  // to the prop-derived value, so a new `targets` prop updates the visible rate
  // without a separate sync effect. Keying by id (not row index) keeps a
  // pending edit attached to its row across removals and reorders.
  const [localRates, setLocalRates] = useState<Map<string, string>>(new Map());

  // Returns true iff the text parsed, regardless of whether the row still
  // exists: valid text must always be pruned from localRates, while INVALID
  // text is kept so the user can finish what they were typing.
  function commitRate(recipeId: string, perMinStr: string): boolean {
    const parsed = parsePerMinToRationalPerSec(perMinStr);
    if (!parsed) return false;
    onChange((current) => {
      const idx = current.findIndex((t) => t.recipeId === recipeId);
      // Row removed while the edit was pending: no-op (same reference).
      if (idx < 0) return current;
      const next = current.slice();
      next[idx] = { ...next[idx]!, ratePerSec: parsed };
      return next;
    });
    return true;
  }

  function scheduleCommit(recipeId: string, value: string) {
    const existing = timerRefs.current.get(recipeId);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      commitRate(recipeId, value);
      timerRefs.current.delete(recipeId);
      // Keep the committed text as the display value: re-serializing
      // t.ratePerSec would rewrite an exact "1/3" into a 16-digit float. A
      // failed parse likewise keeps the local string so the user can fix the
      // typo. (Navigation resets localRates; that is handled by the panel owner.)
    }, DEBOUNCE_MS);
    timerRefs.current.set(recipeId, id);
  }

  function handleRateChange(recipeId: string, value: string) {
    setLocalRates((prev) => new Map(prev).set(recipeId, value));
    scheduleCommit(recipeId, value);
  }

  // Drop the pending debounce timer and in-flight edit text for a row that is
  // going away, so a stale entry can never fire against (or redisplay on) a
  // later row that reuses the same id.
  function clearPendingEdit(recipeId: string) {
    const existing = timerRefs.current.get(recipeId);
    if (existing) clearTimeout(existing);
    timerRefs.current.delete(recipeId);
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
    // An in-flight rate edit follows the row to its new id.
    const pendingValue = localRates.get(oldRecipeId);
    const pendingTimer = timerRefs.current.get(oldRecipeId);
    if (pendingTimer) clearTimeout(pendingTimer);
    timerRefs.current.delete(oldRecipeId);
    if (pendingValue !== undefined) {
      setLocalRates((prev) => {
        const next = new Map(prev);
        next.delete(oldRecipeId);
        next.set(newRecipeId, pendingValue);
        return next;
      });
      scheduleCommit(newRecipeId, pendingValue);
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

  function handleAdd() {
    onChange((current) => {
      const used = new Set(current.map((t) => t.recipeId));
      const candidate = pickableRecipes.find((r) => !used.has(r.id));
      if (!candidate) return current;
      return [
        ...current,
        { recipeId: candidate.id, ratePerSec: { num: "0", denom: "1" } },
      ];
    });
  }

  useEffect(() => {
    const timers = timerRefs.current;
    return () => {
      for (const id of timers.values()) clearTimeout(id);
      timers.clear();
    };
  }, []);

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
      <div className="side-section-sub">
        {"// declared output rates · items per minute"}
      </div>
      {targets.length === 0 ? (
        <div className="b-empty">
          {i18n.locale === "zh"
            ? "未声明任何目标产物 — 点击下方按钮添加"
            : "No declared outputs yet — use the action below"}
        </div>
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
          localRates.get(t.recipeId) ??
          ratePerSecToPerMin(t.ratePerSec);
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
                <select
                  aria-label={i18n.t("targets.recipe.label")}
                  // title shows the full localised recipe name on hover, for
                  // when the select truncates long names at narrow widths.
                  title={i18n.displayName(t.recipeId)}
                  value={t.recipeId}
                  onChange={(e) =>
                    handleRecipeChange(t.recipeId, e.target.value)
                  }
                >
                  {pickableRecipes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {i18n.displayName(r.id)}
                    </option>
                  ))}
                </select>
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
                value={displayedRate}
                onChange={(e) => handleRateChange(t.recipeId, e.target.value)}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
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
      <button className="b-add" onClick={handleAdd}>
        {i18n.t("targets.add")}
      </button>
    </div>
  );
}
