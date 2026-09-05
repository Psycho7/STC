// The localStorage keys the app persists its two view preferences under.
//
// Both are read during boot - the locale in the i18n provider's initial state,
// the bus-lane flag in the App's - so anything that wants a page to come up in a
// chosen state has to write them before the app runs. The exam CLIs and the e2e
// specs do exactly that from an init script, which means the strings exist on
// both sides of the browser boundary and a rename that misses one side changes
// nothing visible: the page simply boots on its defaults, and every capture
// taken after it is silently in the wrong locale or with the lanes off.
//
// A leaf with no imports, so a CLI can name a key without loading the app. The
// Playwright specs under test/e2e still write the strings out by hand, because
// an addInitScript callback is serialised and cannot close over an import; a
// rename has to sweep those too.
export const LOCALE_STORAGE_KEY = "aef.locale";
export const BUS_LANES_STORAGE_KEY = "aef.busLanes";
