import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Recipe, RecipePack } from "@aef/schema";
import { useI18n } from "../data/i18n-context";
import {
  effectiveCohortEnabled,
  eventCohortsOf,
  type EventCohortOverrides,
} from "../data/availability";
import { iconSheetUrl } from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import type { ProducerUnavailableCause } from "../data/plan";
import type { RecipeId } from "../solver/types";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { RecipeToggles } from "./RecipeToggles";
import { useModalDialog } from "./useModalDialog";

// Icons a cohort row's strip shows before the "+N" overflow chip.
const MAX_STRIP_ICONS = 4;

type Props = {
  // The loaded pack. Counts, icons, and the recipe lists are all derived from
  // it here, so the parent stays thin - the same division TargetsPanel and
  // InputsPanel use for their pickable catalogues.
  pack: RecipePack;
  // The pack's own cohort (packCohortOf(pack)), passed in rather than derived
  // so the panel stays presentational over the cohort model: App already
  // computed it once to derive the unavailable set.
  packCohort: string;
  // The current override map, owned by the parent (#144: state and storage
  // never disagree because one writer applies both). The panel never mutates
  // it in place - every change hands back a fresh map.
  overrides: EventCohortOverrides;
  onOverridesChange: (next: EventCohortOverrides) => void;
  // The selected settlement (#124), or undefined for all of them - owned by
  // the parent on the same one-writer terms as the overrides above.
  area: string | undefined;
  onAreaChange: (next: string | undefined) => void;
  // The hand-disabled recipes (#125), owned by the parent on the same terms.
  disabledRecipeIds: ReadonlySet<RecipeId>;
  onDisabledRecipesChange: (next: ReadonlySet<RecipeId>) => void;
  // Why each unavailable recipe is off, so the Recipes section can tell a
  // choice the user still has from one an area or an event already took.
  unavailableCauses: ReadonlyMap<RecipeId, ProducerUnavailableCause>;
  onClose: () => void;
};

// One row's worth of derived data: the cohort's items and recipes (pack rows
// tagged with it), its effective on/off state, and whether an override (not the
// version rule) decided that state.
type CohortRow = {
  cohort: string;
  current: boolean;
  enabled: boolean;
  overridden: boolean;
  items: RecipePack["items"];
  recipes: Recipe[];
};

export function SettingsPanel({
  pack,
  packCohort,
  overrides,
  onOverridesChange,
  area,
  onAreaChange,
  disabledRecipeIds,
  onDisabledRecipesChange,
  unavailableCauses,
  onClose,
}: Props) {
  const i18n = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus the dialog on open and hand focus back to whatever had it (the gear
  // button) on close. Capture happens on mount, restore on unmount, so EVERY
  // close path - Escape, overlay click, the close button, or the parent
  // unmounting for its own reasons - returns focus without each caller having
  // to remember to.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  const trapTab = useModalDialog(dialogRef, onClose);

  // The Events rows, one per cohort the pack carries, in eventCohortsOf's
  // sorted order. Recomputed per render of a small list; no memo needed.
  const rows: CohortRow[] = eventCohortsOf(pack).map((cohort) => ({
    cohort,
    current: cohort === packCohort,
    enabled: effectiveCohortEnabled(cohort, packCohort, overrides),
    overridden: overrides[cohort] !== undefined,
    items: pack.items.filter((i) => i.event === cohort),
    recipes: pack.recipes.filter((r) => r.event === cohort),
  }));

  // The Area choices: all areas first, then one per settlement the pack lists.
  // The labels are the sidecar's own location names (displayName flattens that
  // bucket), so a new settlement needs no new UI string.
  const areaOptions: { id: string | undefined; label: string }[] = [
    { id: undefined, label: i18n.t("settings.area.all") },
    ...pack.locations.map((l) => ({ id: l.id, label: i18n.displayName(l.id) })),
  ];

  // A flip stores exactly one cohort's boolean into the parent-owned map; the
  // section reset clears every cohort's override in one write.
  function setOverride(cohort: string, value: boolean): void {
    onOverridesChange({ ...overrides, [cohort]: value });
  }

  return createPortal(
    // The portal escapes .ak-app-shell where --icons-url lives, so the backdrop
    // re-declares it or the icon strip renders blank.
    <div
      className="settings-backdrop"
      style={{ ["--icons-url" as string]: `url(${iconSheetUrl})` }}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t("settings.title")}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="settings-head">
          <span className="settings-title">{i18n.t("settings.title")}</span>
          <button
            type="button"
            className="settings-close"
            aria-label={i18n.t("settings.close.label")}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="settings-body">
          {/* The panel portals to <body> but renders under LocaleProvider, so
              the switcher's useLocale() still resolves here without threading
              the locale through props. */}
          <section
            className="settings-section"
            aria-label={i18n.t("settings.locale.title")}
          >
            <div className="settings-section-head">
              <span className="settings-section-title">
                {i18n.t("settings.locale.title")}
              </span>
            </div>
            <LocaleSwitcher />
          </section>
          {/* The Area section (#124). Buttons rather than radio inputs: the
              row is styled as a segmented control, and role="radio" on a
              button carries the same semantics to assistive tech as long as
              aria-checked rides along. */}
          <section
            className="settings-section"
            aria-label={i18n.t("settings.area.title")}
          >
            <div className="settings-section-head">
              <span className="settings-section-title">
                {i18n.t("settings.area.title")}
              </span>
            </div>
            <div
              className="settings-areas"
              role="radiogroup"
              aria-label={i18n.t("settings.area.title")}
            >
              {areaOptions.map((option) => {
                const selected = option.id === area;
                return (
                  <button
                    key={option.id ?? "all"}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={"settings-area" + (selected ? " selected" : "")}
                    data-area={option.id ?? "all"}
                    onClick={() => onAreaChange(option.id)}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </section>
          {/* The Recipes section (#125), which renders its own
              .settings-section so the body stays a plain list of them. */}
          <RecipeToggles
            pack={pack}
            unavailableCauses={unavailableCauses}
            disabledRecipeIds={disabledRecipeIds}
            onDisabledRecipesChange={onDisabledRecipesChange}
          />
          {/* The Events section (#144). */}
          <section
            className="settings-section"
            aria-label={i18n.t("settings.events.title")}
          >
            <div className="settings-section-head">
              <span className="settings-section-title">
                {i18n.t("settings.events.title")}
              </span>
              <button
                type="button"
                className="settings-reset"
                onClick={() => onOverridesChange({})}
              >
                {i18n.t("settings.events.reset")}
              </button>
            </div>
            {rows.map((row) => (
              <CohortRowView
                key={row.cohort}
                row={row}
                onToggle={setOverride}
              />
            ))}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CohortRowView({
  row,
  onToggle,
}: {
  row: CohortRow;
  onToggle: (cohort: string, value: boolean) => void;
}) {
  const i18n = useI18n();
  const [expanded, setExpanded] = useState(false);
  const shown = row.items.slice(0, MAX_STRIP_ICONS);
  const overflow = row.items.length - shown.length;
  return (
    <div className="settings-cohort" data-cohort={row.cohort}>
      <div className="settings-cohort-head">
        <span className="settings-cohort-version">{row.cohort}</span>
        {/* The pill states the version rule, the switch states the effective
            one, so a forced-on past cohort still reads "past" - an override
            never hides behind the pill. */}
        <span className={"settings-pill" + (row.current ? " current" : "")}>
          {i18n.t(
            row.current ? "settings.events.current" : "settings.events.past",
          )}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          data-testid="settings-switch"
          aria-label={i18n.t("settings.events.switch.label", {
            cohort: row.cohort,
          })}
          checked={row.enabled}
          onChange={(e) => onToggle(row.cohort, e.target.checked)}
        />
      </div>
      <div className="settings-cohort-main">
        <span className="settings-icons" aria-hidden="true">
          {shown.map((it) => (
            <span
              key={it.id}
              className="settings-icons-slot"
              title={i18n.displayName(it.id)}
            >
              <Sprite iconId={it.icon} size={28} />
            </span>
          ))}
          {overflow > 0 ? (
            <span className="settings-icons-more">+{overflow}</span>
          ) : null}
        </span>
        <span className="settings-counts">
          {i18n.t("settings.events.counts", {
            items: row.items.length,
            recipes: row.recipes.length,
          })}
        </span>
        {row.overridden ? null : (
          <span className="settings-default" data-testid="settings-default-tag">
            {i18n.t("settings.events.default")}
          </span>
        )}
      </div>
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        {i18n.t(
          expanded
            ? "settings.events.hideRecipes"
            : "settings.events.showRecipes",
        )}
      </button>
      {expanded ? (
        <ul className="settings-recipes">
          {row.recipes.map((r) => (
            <li key={r.id} data-testid="settings-recipe-row">
              <span className="settings-recipe-name">
                {i18n.displayName(r.id)}
              </span>
              <span className="settings-recipe-meta">
                {i18n.t("settings.events.recipe.machine", {
                  machine: i18n.displayName(r.producers[0] ?? r.id),
                })}
              </span>
              <span className="settings-recipe-meta">
                {i18n.t("settings.events.recipe.inputs", {
                  inputs: r.in
                    .map((s) => `${i18n.displayName(s.item)} ×${s.qty}`)
                    .join(", "),
                })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
