// The settings panel's Recipes section (#125): one checkbox per recipe the
// user may switch off by hand.
//
// Two views over the same toggles. The default one is item-centric, because a
// toggle only changes anything for an item that has more than one producer -
// 28 items on the shipped pack, carrying 98 producer rows. The expansion is the
// whole catalogue grouped by machine, for the rarer "I never want this row
// built" case. A recipe with two producer machines appears under each of them
// and the checkbox is keyed on the recipe id, so the two seats share one state.
//
// Switching off the last producer of a committed target is allowed - the plan
// keeps the target and never silently turns it into external supply - so the
// section names the stranded target in a live region instead of refusing the
// toggle. The modal covers the plan banner, and this is the feedback while it
// is open.
//
// A recipe an area or an event already hides is not a choice the user has, so
// it renders as a disabled row stating the reason instead of a live toggle.
// Its stored manual state is left alone: the three predicates are independent,
// and re-enabling the area must not resurrect a hand-disabled recipe.

import { useMemo, useState } from "react";
import type { Recipe, RecipePack } from "@aef/schema";
import { searchNames } from "../data/i18n";
import { useI18n } from "../data/i18n-context";
import type { I18nIndex } from "../data/i18n";
import type { ProducerUnavailableCause } from "../data/plan";
import { isInputSupplyRecipe, producersOfItem } from "../data/recipe-category";
import type { RecipeId } from "../solver/types";

type Props = {
  pack: RecipePack;
  // Why each unavailable recipe is off. A manual cause is the section's own
  // doing and stays a live toggle; an area or event cause is not, and renders
  // as a disabled row carrying the reason.
  unavailableCauses: ReadonlyMap<RecipeId, ProducerUnavailableCause>;
  // The hand-disabled set, owned by the parent on the one-writer terms the
  // other sections use. Every change hands back a fresh set.
  disabledRecipeIds: ReadonlySet<RecipeId>;
  onDisabledRecipesChange: (next: ReadonlySet<RecipeId>) => void;
  // The COMMITTED plan's target items, in plan order, and the item-level cause
  // map behind the pickers' dimmed tiles. Switching off a target's last
  // producer is allowed and the target is kept, so the notice below is the only
  // feedback while the modal still covers the banner: these two together say
  // which committed target the toggles just stranded.
  committedTargetItemIds: ReadonlySet<string>;
  unavailableItemCauses: ReadonlyMap<string, ProducerUnavailableCause>;
};

type ItemGroup = { itemId: string; recipes: Recipe[] };
type MachineGroup = { machineId: string; recipes: Recipe[] };

// The items a toggle can actually change the solve for: those with more than
// one producer, in pack order. producersOfItem is the same producer notion
// plan validation counts with, so a row that appears here is a row the plan
// loader would miss if it were switched off.
function multiProducerGroups(pack: RecipePack): ItemGroup[] {
  const groups: ItemGroup[] = [];
  for (const item of pack.items) {
    const recipes = producersOfItem(pack.recipes, item.id);
    if (recipes.length > 1) groups.push({ itemId: item.id, recipes });
  }
  return groups;
}

// The whole catalogue by machine, walking the FULL producers array rather than
// producers[0]: ten shipped recipes have two machines and would otherwise
// vanish from the second one's group. Input-supply rows are left out - their
// "machine" is the synthetic __domain_transfer marker, not a thing the player
// places - which leaves the 29 machines that build something.
function machineGroupsOf(pack: RecipePack): MachineGroup[] {
  const byMachine = new Map<string, Recipe[]>();
  for (const recipe of pack.recipes) {
    if (isInputSupplyRecipe(recipe)) continue;
    for (const machineId of recipe.producers) {
      const group = byMachine.get(machineId);
      if (group === undefined) {
        byMachine.set(machineId, [recipe]);
        continue;
      }
      group.push(recipe);
    }
  }
  // Pack order, so the groups read the same way the machine list does.
  return pack.machines.flatMap((machine) => {
    const recipes = byMachine.get(machine.id);
    return recipes === undefined ? [] : [{ machineId: machine.id, recipes }];
  });
}

// An empty needle matches everything; anything else matches against both
// shipped locales, so the filter finds a name the current locale never shows.
function matches(id: string, needle: string): boolean {
  if (needle === "") return true;
  return searchNames(id).some((name) => name.includes(needle));
}

function reasonOf(
  cause: ProducerUnavailableCause,
  i18n: I18nIndex,
): string | null {
  switch (cause.kind) {
    case "area":
      // The settlement by the name the Area section shows, not its pack id.
      return i18n.t("settings.recipes.off.area", {
        area: i18n.displayName(cause.area),
      });
    case "event":
      return i18n.t("settings.recipes.off.event", { cohort: cause.cohort });
    case "manual":
      return null;
  }
}

export function RecipeToggles({
  pack,
  unavailableCauses,
  disabledRecipeIds,
  onDisabledRecipesChange,
  committedTargetItemIds,
  unavailableItemCauses,
}: Props) {
  const i18n = useI18n();
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  // Both groupings are pack-shaped and cost a full walk of the recipe list, so
  // they survive a keystroke in the filter box; the filter itself runs per
  // render over the already-grouped lists.
  const itemGroups = useMemo(() => multiProducerGroups(pack), [pack]);
  const machineGroups = useMemo(() => machineGroupsOf(pack), [pack]);

  const needle = query.trim().toLowerCase();
  // An item whose own name matches keeps all its producers; otherwise the
  // group keeps the rows whose recipe name matches, and empties out of the
  // list when none does.
  const shownItems = itemGroups.flatMap((group) => {
    const recipes = matches(group.itemId, needle)
      ? group.recipes
      : group.recipes.filter((r) => matches(r.id, needle));
    return recipes.length === 0 ? [] : [{ ...group, recipes }];
  });
  // Same rule one level down: a recipe stays when its own name matches or when
  // one of the items it makes does. This runs whether or not the catalogue is
  // expanded, because the empty message has to count the matches hiding behind
  // the disclosure as matches.
  const matchedMachines = machineGroups.flatMap((group) => {
    const recipes = group.recipes.filter(
      (r) =>
        matches(r.id, needle) || r.out.some((o) => matches(o.item, needle)),
    );
    return recipes.length === 0 ? [] : [{ ...group, recipes }];
  });
  const shownMachines = showAll ? matchedMachines : [];

  function toggle(recipeId: RecipeId, enabled: boolean): void {
    const next = new Set(disabledRecipeIds);
    if (enabled) {
      next.delete(recipeId);
    } else {
      next.add(recipeId);
    }
    onDisabledRecipesChange(next);
  }

  function row(recipe: Recipe, key: string) {
    return (
      <RecipeToggleRow
        key={key}
        recipe={recipe}
        cause={unavailableCauses.get(recipe.id)}
        enabled={!disabledRecipeIds.has(recipe.id)}
        onToggle={toggle}
      />
    );
  }

  const empty = shownItems.length === 0 && matchedMachines.length === 0;

  // Committed targets nothing can make any more, in plan order. The cause map
  // covers area and event reasons too, which is right: the line states the
  // outcome, and the rows below it state which predicate took each recipe.
  const strandedTargets = [...committedTargetItemIds].filter((itemId) =>
    unavailableItemCauses.has(itemId),
  );

  return (
    <section
      className="settings-section"
      aria-label={i18n.t("settings.recipes.title")}
    >
      <div className="settings-section-head">
        <span className="settings-section-title">
          {i18n.t("settings.recipes.title")}
        </span>
      </div>
      {/* Mounted even while it says nothing: a live region that enters the DOM
          together with its first text is not announced. */}
      <p
        className="settings-recipe-notice"
        data-testid="settings-recipe-notice"
        role="status"
        aria-live="polite"
      >
        {strandedTargets.length === 0
          ? ""
          : i18n.t("settings.recipes.notice", {
              items: strandedTargets
                .map((itemId) => i18n.displayName(itemId))
                .join(" · "),
            })}
      </p>
      <input
        type="search"
        className="settings-recipe-filter"
        data-testid="settings-recipe-filter"
        aria-label={i18n.t("settings.recipes.filter.label")}
        placeholder={i18n.t("settings.recipes.filter.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {shownItems.map((group) => (
        <div
          key={group.itemId}
          className="settings-recipe-group"
          data-testid="settings-item-group"
          data-item={group.itemId}
        >
          <span className="settings-recipe-group-title">
            {i18n.displayName(group.itemId)}
          </span>
          <ul className="settings-recipe-toggles">
            {group.recipes.map((r) => row(r, r.id))}
          </ul>
        </div>
      ))}
      <button
        type="button"
        className="settings-disclosure"
        aria-expanded={showAll}
        onClick={() => setShowAll((s) => !s)}
      >
        {i18n.t(
          showAll ? "settings.recipes.hideAll" : "settings.recipes.showAll",
        )}
      </button>
      {shownMachines.map((group) => (
        <div
          key={group.machineId}
          className="settings-recipe-group"
          data-testid="settings-machine-group"
          data-machine={group.machineId}
        >
          <span className="settings-recipe-group-title">
            {i18n.displayName(group.machineId)}
          </span>
          <ul className="settings-recipe-toggles">
            {group.recipes.map((r) => row(r, `${group.machineId}:${r.id}`))}
          </ul>
        </div>
      ))}
      {empty ? (
        <p className="settings-recipe-empty">
          {i18n.t("settings.recipes.empty")}
        </p>
      ) : null}
    </section>
  );
}

function RecipeToggleRow({
  recipe,
  cause,
  enabled,
  onToggle,
}: {
  recipe: Recipe;
  cause: ProducerUnavailableCause | undefined;
  enabled: boolean;
  onToggle: (recipeId: RecipeId, enabled: boolean) => void;
}) {
  const i18n = useI18n();
  const reason = cause === undefined ? null : reasonOf(cause, i18n);
  return (
    <li
      className={"settings-recipe-toggle" + (reason === null ? "" : " off")}
      data-testid="settings-recipe-toggle"
      data-recipe={recipe.id}
    >
      <input
        type="checkbox"
        className="settings-recipe-check"
        data-testid="settings-recipe-checkbox"
        aria-label={i18n.t("settings.recipes.toggle.label", {
          recipe: i18n.displayName(recipe.id),
        })}
        checked={enabled}
        disabled={reason !== null}
        onChange={(e) => onToggle(recipe.id, e.target.checked)}
      />
      <span className="settings-recipe-name">
        {i18n.displayName(recipe.id)}
      </span>
      {/* The machine and inputs summary reads exactly like the Events
          expansion's, so the two recipe lists in one dialog are one shape. */}
      <span className="settings-recipe-meta">
        {i18n.t("settings.events.recipe.machine", {
          machine: recipe.producers
            .map((id) => i18n.displayName(id))
            .join(" · "),
        })}
      </span>
      <span className="settings-recipe-meta">
        {i18n.t("settings.events.recipe.inputs", {
          inputs: recipe.in
            .map((s) => `${i18n.displayName(s.item)} ×${s.qty}`)
            .join(", "),
        })}
      </span>
      {reason === null ? null : (
        <span className="settings-recipe-reason">{reason}</span>
      )}
    </li>
  );
}
