import { useEffect, useRef, useState } from "react";
import Fraction from "fraction.js";
import type { Recipe, RecipePack } from "@aef/schema";
import type { Target } from "../data/targets";
import { useI18n } from "../data/i18n-context";
import { isInputSupplyRecipe, isSinkRecipe } from "../data/recipe-category";
import { iconPosition } from "../canvas/iconSprite";

type Props = {
  targets: Target[];
  onChange: (next: Target[]) => void;
  pack: RecipePack;
  // Recipes the solver cannot handle as targets yet. When this is provided,
  // handleAdd's auto-pick skips them so the panel never lands the user on one
  // of these by default.
  unsafeRecipes?: ReadonlySet<string>;
};

const DEBOUNCE_MS = 150;

function ratePerSecToPerMin(rps: { num: string; denom: string }): number {
  const f = new Fraction(rps.num)
    .div(new Fraction(rps.denom))
    .mul(new Fraction(60));
  return Number(f.valueOf());
}

// Accepts an items-per-minute value as an integer ("120"), a decimal ("30.5"),
// or a rational ("1/3"). Returns undefined if it can't parse or the result is
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

// Decides which recipes are valid to pick as a target. Three are carved out:
// - `__internal` recipes are synthetic raw sources and should never show up in
//   the picker.
// - `__domain_transfer` recipes describe an input-supply mechanism (importing
//   an item across domains) rather than a production step, so they belong in
//   the input-supply UI, not the targets dropdown.
// - Sink recipes (cost === -1) consume items but produce nothing, so declaring
//   one as a target makes no sense.
function isPickableTarget(recipe: Recipe): boolean {
  return (
    recipe.category !== "__internal" &&
    !isInputSupplyRecipe(recipe) &&
    !isSinkRecipe(recipe)
  );
}

export function TargetsPanel({
  targets,
  onChange,
  pack,
  unsafeRecipes,
}: Props) {
  const i18n = useI18n();
  const pickableRecipes = pack.recipes.filter(isPickableTarget);
  const [duplicateError, setDuplicateError] = useState<{
    rowIdx: number;
    recipeId: string;
  } | null>(null);
  const timerRefs = useRef<Map<number, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  // In-flight edit values keyed by row index. A row without an entry here falls
  // back to the value derived from the prop, so when a new `targets` prop comes
  // in the visible rate updates on its own without a separate sync effect.
  const [localRates, setLocalRates] = useState<Map<number, string>>(new Map());
  // A mirror of the latest `targets` so that a debounce timer scheduled during
  // an earlier render commits against the current list rather than the stale
  // snapshot it captured when the timer was set.
  const targetsRef = useRef(targets);
  useEffect(() => {
    targetsRef.current = targets;
  }, [targets]);

  function commitRate(rowIdx: number, perMinStr: string) {
    const parsed = parsePerMinToRationalPerSec(perMinStr);
    if (!parsed) return;
    const current = targetsRef.current;
    const t = current[rowIdx];
    if (!t) return;
    const next = current.slice();
    next[rowIdx] = { ...t, ratePerSec: parsed };
    onChange(next);
  }

  function handleRateChange(rowIdx: number, value: string) {
    setLocalRates((prev) => new Map(prev).set(rowIdx, value));
    const existing = timerRefs.current.get(rowIdx);
    if (existing) clearTimeout(existing);
    const id = setTimeout(() => {
      commitRate(rowIdx, value);
      timerRefs.current.delete(rowIdx);
      setLocalRates((prev) => {
        const next = new Map(prev);
        next.delete(rowIdx);
        return next;
      });
    }, DEBOUNCE_MS);
    timerRefs.current.set(rowIdx, id);
  }

  function handleRecipeChange(rowIdx: number, newRecipeId: string) {
    const dup = targets.some(
      (t, i) => i !== rowIdx && t.recipeId === newRecipeId,
    );
    if (dup) {
      setDuplicateError({ rowIdx, recipeId: newRecipeId });
      return;
    }
    setDuplicateError(null);
    const next = targets.slice();
    const t = next[rowIdx];
    if (!t) return;
    next[rowIdx] = { ...t, recipeId: newRecipeId };
    onChange(next);
  }

  function handleRemove(rowIdx: number) {
    setDuplicateError(null);
    const next = targets.filter((_, i) => i !== rowIdx);
    onChange(next);
  }

  function handleAdd() {
    const used = new Set(targets.map((t) => t.recipeId));
    const candidate = pickableRecipes.find(
      (r) => !used.has(r.id) && !unsafeRecipes?.has(r.id),
    );
    if (!candidate) return;
    const next: Target[] = [
      ...targets,
      { recipeId: candidate.id, ratePerSec: { num: "0", denom: "1" } },
    ];
    onChange(next);
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
      {targets.map((t, i) => {
        const recipe = pack.recipes.find((r) => r.id === t.recipeId);
        const outputItemId = recipe?.out[0]?.item;
        // Walk a chain of icon fallbacks. Sink recipes (out: []) and
        // disambiguated variants like "liquid_cleaner_1-sewage" don't match
        // their own id in the icon sheet, but the recipe usually carries an
        // explicit compound icon id, and as a last resort the first producer
        // (machine) icon is a safe stand-in.
        const iconPos =
          iconPosition(outputItemId) ??
          iconPosition(recipe?.icon) ??
          iconPosition(recipe?.producers?.[0]) ??
          iconPosition(t.recipeId);
        const displayedRate =
          localRates.get(i) ?? String(ratePerSecToPerMin(t.ratePerSec));
        return (
          <div key={i} className="b-row" data-testid="target-row">
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
                  // title shows the full localised recipe name on hover, which
                  // matters when the select truncates long names at narrow widths.
                  title={i18n.displayName(t.recipeId)}
                  value={t.recipeId}
                  onChange={(e) => handleRecipeChange(i, e.target.value)}
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
              {duplicateError?.rowIdx === i && (
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
                onChange={(e) => handleRateChange(i, e.target.value)}
              />
              <span className="unit">{i18n.t("targets.rate.unit")}</span>
            </div>
            <button
              className="b-remove"
              data-testid="remove-target"
              onClick={() => handleRemove(i)}
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
