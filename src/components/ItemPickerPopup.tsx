import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Item } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import { iconPosition, iconSheetUrl } from "../canvas/iconSprite";

type Props = {
  // Already-filtered producible items; the caller decides what is pickable.
  items: Item[];
  // Items another target/draft already claims. Their tiles render disabled so
  // a duplicate can't be picked, rather than surfacing a post-hoc error.
  disabledIds: ReadonlySet<string>;
  // The item of the row being edited, highlighted as selected.
  selectedId?: string | undefined;
  // Availability tier per item id. POSITIVE_INFINITY marks items the tier
  // fixpoint cannot rank (no non-excluded producer, or loops with no external
  // finite feeder); they group under the unranked bucket. Computed once by the
  // caller so the popup stays presentational.
  tierByItemId: Map<string, number>;
  onPick: (itemId: string) => void;
  onClose: () => void;
};

export function ItemPickerPopup({
  items,
  disabledIds,
  selectedId,
  tierByItemId,
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

  // Filter by localized name or raw id, bucket by availability tier, sort each
  // bucket by localized name, and order the buckets ascending (Infinity last,
  // since there is a single Infinity bucket so its key never collides).
  const groups = useMemo(() => {
    const q = search.trim().toLocaleLowerCase(i18n.locale);
    const byTier = new Map<number, Item[]>();
    for (const it of items) {
      const name = i18n.displayName(it.id);
      if (
        q &&
        !name.toLocaleLowerCase(i18n.locale).includes(q) &&
        !it.id.toLocaleLowerCase(i18n.locale).includes(q)
      )
        continue;
      const tier = tierByItemId.get(it.id) ?? Number.POSITIVE_INFINITY;
      const arr = byTier.get(tier);
      if (arr) arr.push(it);
      else byTier.set(tier, [it]);
    }
    return [...byTier.entries()]
      .map(([tier, group]) => ({
        tier,
        items: group
          .slice()
          .sort((a, b) =>
            collator.compare(i18n.displayName(a.id), i18n.displayName(b.id)),
          ),
      }))
      .sort((a, b) => a.tier - b.tier);
  }, [items, search, tierByItemId, collator, i18n]);

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
              <div className="recipe-picker-group" key={g.tier}>
                <div className="recipe-picker-group-head">
                  {g.tier === Number.POSITIVE_INFINITY
                    ? i18n.t("picker.group.unranked")
                    : i18n.t("picker.group.depth", { n: g.tier })}
                </div>
                <div className="recipe-picker-grid">
                  {g.items.map((it) => {
                    const name = i18n.displayName(it.id);
                    const iconPos = iconPosition(it.id);
                    return (
                      <button
                        type="button"
                        key={it.id}
                        className={
                          "recipe-picker-tile" +
                          (it.id === selectedId ? " selected" : "")
                        }
                        data-testid="picker-tile"
                        data-item-id={it.id}
                        disabled={disabledIds.has(it.id)}
                        aria-label={name}
                        title={name}
                        onClick={() => onPick(it.id)}
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
