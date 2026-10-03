// localStorage keys the app persists boot-time state under.
//
// Both are read during boot - the i18n provider's initial state, and the
// event-cohort overrides that decide which recipes exist (#144) - so anything
// that wants a page to come up with them set has to write them before the app
// runs. The exam CLIs and the e2e specs do exactly that from an init script,
// which means each string exists on both sides of the browser boundary and a
// rename that misses one side changes nothing visible: the page simply boots
// on its default, and every capture taken after it is silently in the wrong
// state.
//
// A leaf with no imports, so a CLI can name the keys without loading the app.
// An addInitScript callback is serialised and cannot close over an import, but
// it can be handed an argument, so both writers import this and pass it in
// through the boot helper in test/e2e/viewport.ts: a rename is a compile error
// on both sides of the browser boundary rather than a silent no-op.
export const LOCALE_STORAGE_KEY = "aef.locale";

// The event-cohort overrides map (#144): a JSON object of cohort -> boolean.
// Seeded before boot the same way when an exam or spec needs a specific cohort
// switched off from the first solve.
export const EVENT_COHORT_OVERRIDES_STORAGE_KEY = "aef.eventCohortOverrides";

// The settlement the plan is built in (#124): a bare location id from the pack
// ("tundra", "jinlong"). ABSENT until the user picks one, which reads as the
// pack's latest settlement.
export const AREA_STORAGE_KEY = "aef.area";

// The recipes switched off by hand (#125): a JSON array of pack recipe ids.
// Read back against the loaded pack, so an id the pack no longer carries is
// dropped rather than switching off whatever recipe inherits the name.
export const DISABLED_RECIPES_STORAGE_KEY = "aef.disabledRecipes";
