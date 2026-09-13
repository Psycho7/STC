// The localStorage key the app persists its view locale under.
//
// It is read during boot - in the i18n provider's initial state - so anything
// that wants a page to come up in a chosen locale has to write it before the app
// runs. The exam CLIs and the e2e specs do exactly that from an init script,
// which means the string exists on both sides of the browser boundary and a
// rename that misses one side changes nothing visible: the page simply boots on
// its default, and every capture taken after it is silently in the wrong locale.
//
// A leaf with no imports, so a CLI can name the key without loading the app. An
// addInitScript callback is serialised and cannot close over an import, but it
// can be handed an argument, so both writers import this and pass it in
// through the boot helper in test/e2e/viewport.ts: a rename is a compile error
// on both sides of the browser boundary rather than a silent no-op.
export const LOCALE_STORAGE_KEY = "aef.locale";
