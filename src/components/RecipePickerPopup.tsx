import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Recipe } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import { iconPosition, iconSheetUrl } from "../canvas/iconSprite";

type Props = {
  // Already-filtered pickable recipes; the caller decides what is pickable.
  recipes: Recipe[];
  // Recipes another target/draft already claims. Their tiles render disabled so
  // a duplicate can't be picked, rather than surfacing a post-hoc error.
  disabledIds: ReadonlySet<string>;
  // The recipe of the row being edited, highlighted as selected.
  selectedId?: string;
  // Crafting-tier depth per recipe id (POSITIVE_INFINITY for cycle-only ones),
  // computed once by the caller so the popup stays presentational.
  depthByRecipeId: Map<string, number>;
  onPick: (recipeId: string) => void;
  onClose: () => void;
};

export function RecipePickerPopup({
  recipes,
  disabledIds,
  selectedId,
  depthByRecipeId,
  onPick,
  onClose,
}: Props) {
  const i18n = useI18n();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const collator = useMemo(() => new Intl.Collator(i18n.locale), [i18n.locale]);

  // Autofocus the search box on open; a document-level Escape closes.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Filter by localized name or raw id, bucket by crafting-tier depth, sort each
  // bucket by localized name, and order the buckets ascending (Infinity last,
  // since there is a single Infinity bucket so its key never collides).
  const groups = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(i18n.locale);
    const byDepth = new Map<number, Recipe[]>();
    for (const r of recipes) {
      const name = i18n.displayName(r.id);
      if (
        q &&
        !name.toLocaleLowerCase(i18n.locale).includes(q) &&
        !r.id.toLocaleLowerCase(i18n.locale).includes(q)
      )
        continue;
      const depth = depthByRecipeId.get(r.id) ?? Number.POSITIVE_INFINITY;
      const arr = byDepth.get(depth);
      if (arr) arr.push(r);
      else byDepth.set(depth, [r]);
    }
    return [...byDepth.entries()]
      .map(([depth, group]) => ({
        depth,
        recipes: group
          .slice()
          .sort((a, b) =>
            collator.compare(i18n.displayName(a.id), i18n.displayName(b.id)),
          ),
      }))
      .sort((a, b) => a.depth - b.depth);
  }, [recipes, search, depthByRecipeId, collator, i18n]);

  return createPortal(
    // The portal escapes .ak-app-shell where --icons-url lives, so the backdrop
    // re-declares it or every sprite tile renders blank.
    <div
      className="recipe-picker-backdrop"
      style={{ ["--icons-url" as string]: `url(${iconSheetUrl})` }}
      onClick={onClose}
    >
      <div
        className="recipe-picker"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t("picker.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="recipe-picker-head">
          <span className="recipe-picker-title">{i18n.t("picker.title")}</span>
          <button
            type="button"
            className="recipe-picker-close"
            aria-label={i18n.t("picker.close.label")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <input
          ref={searchRef}
          type="text"
          className="recipe-picker-search"
          aria-label={i18n.t("picker.search.label")}
          placeholder={i18n.t("picker.search.placeholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="recipe-picker-body">
          {groups.length === 0 ? (
            <div className="recipe-picker-empty" data-testid="picker-empty">
              {i18n.t("picker.empty")}
            </div>
          ) : (
            groups.map((g) => (
              <div className="recipe-picker-group" key={g.depth}>
                <div className="recipe-picker-group-head">
                  {g.depth === Number.POSITIVE_INFINITY
                    ? i18n.t("picker.group.unranked")
                    : i18n.t("picker.group.depth", { n: g.depth })}
                </div>
                <div className="recipe-picker-grid">
                  {g.recipes.map((r) => {
                    const name = i18n.displayName(r.id);
                    // Same fallback chain the target row uses for its slot icon.
                    const iconPos =
                      iconPosition(r.out[0]?.item) ??
                      iconPosition(r.icon) ??
                      iconPosition(r.producers?.[0]) ??
                      iconPosition(r.id);
                    return (
                      <button
                        type="button"
                        key={r.id}
                        className={
                          "recipe-picker-tile" +
                          (r.id === selectedId ? " selected" : "")
                        }
                        data-testid="picker-tile"
                        data-recipe-id={r.id}
                        disabled={disabledIds.has(r.id)}
                        aria-label={name}
                        title={name}
                        onClick={() => onPick(r.id)}
                      >
                        {iconPos !== undefined ? (
                          <span className="ico ico-40">
                            <span
                              className="spr"
                              style={{ backgroundPosition: iconPos }}
                            />
                          </span>
                        ) : (
                          <span
                            className="recipe-picker-tile-empty"
                            aria-hidden="true"
                          >
                            ?
                          </span>
                        )}
                        <span className="recipe-picker-tile-label">{name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
