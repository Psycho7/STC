import { useEffect, useMemo, useRef, useState } from "react";
// Aliased: the bare name would shadow the DOM KeyboardEvent the document-level
// Escape listener below is typed against.
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { Item } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import { iconPosition, iconSheetUrl } from "../canvas/iconSprite";

type Props = {
  // The pickable catalogue. The caller decides what belongs here: targets pass
  // only producible items, inputs pass the whole pack.
  items: Item[];
  // Items the caller has already spoken for. Their tiles render disabled so a
  // duplicate cannot be picked, rather than surfacing a post-hoc error. What
  // counts as spoken for is the caller's business; disabledHint is how it
  // explains a reason the grid cannot show.
  disabledIds: ReadonlySet<string>;
  // The item of the row being edited, highlighted as selected.
  selectedId?: string | undefined;
  // Availability depth per item id. POSITIVE_INFINITY marks items the depth
  // fixpoint cannot rank (no non-excluded producer, or members of a cycle no
  // planter breaks open); they group under the unranked bucket. Computed once
  // by the caller so the popup stays presentational.
  tierByItemId: Map<string, number>;
  // Optional one-line explanation of what a dimmed tile means, rendered under
  // the search box. A caller that disables tiles for a reason the grid cannot
  // show passes it; a caller whose disabled tiles are self-explanatory omits
  // it. Not a per-tile title: a disabled button dispatches no pointer events,
  // so a title on one never renders a tooltip, and aria-label beats title for
  // the accessible name, so nothing is announced either.
  disabledHint?: string | undefined;
  onPick: (itemId: string) => void;
  onClose: () => void;
};

export function ItemPickerPopup({
  items,
  disabledIds,
  selectedId,
  tierByItemId,
  disabledHint,
  onPick,
  onClose,
}: Props) {
  const i18n = useI18n();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The tile the grid's single tab stop currently sits on. Null until the user
  // moves it, so the derived rovingId below can follow selectedId and the
  // search results without an effect.
  const [activeId, setActiveId] = useState<string | null>(null);
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

  // Enabled tiles in visual order. Disabled tiles are real disabled buttons and
  // take no focus, so they are not stops.
  const navIds = useMemo(
    () =>
      groups.flatMap((g) =>
        g.items.filter((it) => !disabledIds.has(it.id)).map((it) => it.id),
      ),
    [groups, disabledIds],
  );

  // The grid is ONE tab stop, not one per tile: on the shipped pack a tabbable
  // tile per item would put ~250 stops between the search box and the end of
  // the dialog. The stop starts on the row's current item when there is one, so
  // Tab out of the search box lands on what the user is editing.
  const rovingId =
    activeId !== null && navIds.includes(activeId)
      ? activeId
      : selectedId !== undefined && navIds.includes(selectedId)
        ? selectedId
        : (navIds[0] ?? null);

  function focusTile(id: string) {
    setActiveId(id);
    dialogRef.current
      ?.querySelector<HTMLButtonElement>(
        `[data-testid="picker-tile"][data-item-id="${id}"]`,
      )
      ?.focus();
  }

  // Everything inside the dialog that Tab can reach: the close button, the
  // search box, and the grid's single roving stop.
  function tabbables(): HTMLElement[] {
    const root = dialogRef.current;
    if (!root) return [];
    return [
      ...root.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled])",
      ),
    ].filter((el) => el.tabIndex >= 0);
  }

  // Columns come from the live grid rather than a constant, since the template
  // is responsive. An environment that does not compute the property (jsdom)
  // reports none, and one column degrades Up/Down into Left/Right rather than
  // throwing.
  function columnsFor(tile: HTMLElement): number {
    const grid = tile.closest(".recipe-picker-grid");
    if (!grid) return 1;
    const cols = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .filter(Boolean).length;
    return cols > 0 ? cols : 1;
  }

  function onDialogKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Tab") {
      // aria-modal alone does not confine Tab. Without this, Tab off the last
      // stop leaves the dialog for the page behind the backdrop, which the
      // user cannot see and can only come back from by tabbing the whole way
      // round.
      const stops = tabbables();
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      const at = e.shiftKey ? first : last;
      if (document.activeElement !== at) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    const tile = e.target as HTMLElement;
    if (tile.dataset["testid"] !== "picker-tile") return;
    const from = navIds.indexOf(tile.dataset["itemId"] ?? "");
    if (from < 0) return;
    const cols = columnsFor(tile);
    let to: number;
    switch (e.key) {
      case "ArrowRight":
        to = from + 1;
        break;
      case "ArrowLeft":
        to = from - 1;
        break;
      case "ArrowDown":
        to = from + cols;
        break;
      case "ArrowUp":
        to = from - cols;
        break;
      case "Home":
        to = 0;
        break;
      case "End":
        to = navIds.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const id = navIds[Math.max(0, Math.min(navIds.length - 1, to))];
    if (id !== undefined) focusTile(id);
  }

  return createPortal(
    // The portal escapes .ak-app-shell where --icons-url lives, so the backdrop
    // re-declares it or every sprite tile renders blank.
    <div
      className="recipe-picker-backdrop"
      style={{ ["--icons-url" as string]: `url(${iconSheetUrl})` }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="recipe-picker"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t("picker.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onDialogKeyDown}
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
        {disabledHint !== undefined ? (
          <div className="recipe-picker-hint" data-testid="picker-hint">
            {disabledHint}
          </div>
        ) : null}
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
                        tabIndex={it.id === rovingId ? 0 : -1}
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
