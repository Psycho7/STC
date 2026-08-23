# Input picker popup

Design for replacing the INPUT SUPPLY item dropdown with the same popup the
targets panel already uses. Phase 1 of a two-phase split; phase 2 (a
user-controlled recipe blocklist) gets its own spec and branch. Rulings were
made on 2026-08-23 and revised twice the same day against two rounds of
two-auditor review.

## Context

`TargetsPanel` picks items through `ItemPickerPopup`: a modal icon grid grouped
by availability depth, searchable by localized name or raw id, with tiles for
items another row already claims rendered disabled. `InputsPanel` still uses a
raw `<select>` listing all 113 pack items in one flat localized-name order.

Two problems follow from the split. The panels are stacked in the same rail
and pick from the same catalogue, so a user scrolling past one and into the
other meets two different controls for the same job. The flat list also drops
the depth grouping and the icons, which is what makes a 113-entry catalogue
scannable.

Separately, `InputsPanel`'s add button commits an arbitrary item. It scans
`sortedItems` for the first id no row uses and writes that override into the
plan immediately, which fires a solve for a row the user never chose.

## Rulings

1. **The input picker renders all pack items**, the same set the dropdown
   offers today; ruling 3 governs which of them are enabled. Restricting the
   set itself to raw and cross-domain items would read as cleaner but silently
   removes the ability to declare an arbitrary intermediate as a boundary
   import, which the current control allows.
2. **Add opens the picker instead of committing a row.** The row is created
   when the user picks an item. Targets need a heavier draft mechanism because
   a target is meaningless without a nonzero rate; an input override is
   meaningful with no rate at all for a non-raw item, where a bare
   `{ itemId }` flips `effectiveSupply` from 0 (must be built on site) to
   Infinity (free boundary import). Picking is therefore enough to commit.
3. **Auto-row items are disabled in the Add popup only.** A pick there appends
   a bare `{ itemId }`, which for a raw item is solver-identical to the
   auto-row it replaces (`effectiveSupply` returns Infinity either way) while
   still firing a full re-solve and hash rewrite; the user would watch a
   near-identical row vanish from the auto block and reappear at the end of
   the override block, having changed nothing. Capping an assumed-raw item
   stays what it is today: type into the auto-row, which `commitAutoRate`
   promotes to a real override carrying the rate.

   From an existing row the same tiles stay **enabled**, because that pick is
   not a bare append. `handleItemChange` carries the row's `ratePerSec` to the
   new item, so swapping a capped row onto a consumed raw item moves a live
   cap. Disabling it would strand a user who wants exactly that: they would
   have to delete the row and retype the number into the auto-row.
4. **Depth grouping is reused unchanged.** `computeItemDepths` seeds every
   entry in `pack.items`, not just producible ones, and all 113 rank on the
   shipped pack (tiers 0 through 8), so the popup's unranked bucket stays
   empty and no new grouping mode is needed.

Ruling 3 leaves one honest gap: a raw item the plan does not currently consume
has no auto-row, so it stays pickable from Add, and the override it creates is
a no-op until the user types a cap. That is the same thing the row is for, and
the same thing today's add button produces, so it is accepted rather than
special-cased.

## Design

### Component reuse

`ItemPickerPopup` is already presentational: it takes the item list, the
disabled set, the selected id, and the depth map, and reports a pick. Nothing
in it is target-specific, and it re-declares `--icons-url` on its own backdrop,
so a second mount site needs no portal or sprite work.

| prop | from a row | from Add |
| --- | --- | --- |
| `items` | all of `pack.items` | same |
| `tierByItemId` | `computeItemDepths(pack)`, memoized per pack | same |
| `disabledIds` | the other override rows' items | every override item, plus every auto-row item |
| `selectedId` | the row's own item | `undefined` |
| `onPick` | own item is a confirm and returns early; otherwise `handleItemChange` swaps, carrying the rate | appends `{ itemId }`, arms the pending focus below |
| `onClose` | clears `pickerFor`, refocuses the trigger | clears `pickerFor`, does **not** refocus the trigger |

A disabled tile therefore means one thing at each site: from a row, "another
override row already claims this"; from Add, "this item already has a row in
the panel". Neither needs a distinguishing reason announced, because neither
site mixes the two meanings.

The row's own item stays enabled and highlighted so re-picking it reads as a
confirm.

### Trigger and focus

Each override row's `<select>` becomes the `b-pick-trigger` button
`TargetsPanel` uses, placed **inside the existing `<span className="b-pick">`
wrapper**. Every trigger rule and the caret affordance are scoped
`[data-testid="side-panel"] .b-row .b-pick ...`, so keeping the wrapper means
no new CSS; dropping it loses all of it.

The accessible name follows `TargetsPanel` exactly: `aria-label` stays the
generic `inputs.item.label`, the visible text is the localized item name, and
`title` carries the same name so it survives truncation at 360px. The
accessible name is therefore unchanged from the select, and existing
`getByLabelText` queries keep resolving.

**Row swap.** `triggerRef` holds the button and `closePicker` refocuses it.
Because React batches the update, the button is still mounted when
`closePicker` runs, so the `document.contains` guard passes and `focus()`
succeeds; the re-render then unmounts the row (rows are keyed by `itemId`) and
the browser resets focus to `document.body`. The end state is a lost focus
ring, which is a regression from the select and is accepted: `TargetsPanel`
behaves identically today. Fixing it means giving rows a synthetic React key,
at which point row identity no longer matches the key of `localRates`,
`dirty` and `invalidIds`, all of which are keyed by `itemId`, so a second
id-to-row mapping appears. Not worth it here.

**Add pick.** The trigger is the add button, which survives, so refocusing it
would leave the user below the row they just created. Instead the pick stores
the chosen item id as a pending-focus id and `onClose` skips the trigger
refocus entirely. The row does not exist yet at that moment: the append
travels `onChange` to `handleItemOverridesChange` to `commitPlan` to
`setPlan`, so the row mounts on a later render. A callback ref on each row's
rate input consumes the pending id when the matching row mounts, focuses it,
and clears it. If the row never arrives, because `validatePlan` rejected the
commit or because the panel is rendered standalone with an `onChange` that
never feeds the prop back, as both unit suites do, the pending id is cleared
on the next pick rather than left armed.

### Picker state

One `pickerFor` state covers both entry points:

- `{ kind: "row", itemId }` - opened from an existing override row.
- `{ kind: "add" }` - opened from the add button, with no row behind it.

Re-picking the row's own item is a confirm, not a swap. Without that guard the
duplicate check in `handleItemChange` matches the row against itself and raises
a false duplicate alert, which is the same guard `TargetsPanel` carries.

For `add`, the pick appends `{ itemId }` with no rate. The updater re-checks
for an existing entry with that id before appending, so a pick racing a prop
update that already inserted the row is a no-op rather than a duplicate.

The add button is **disabled with an explanatory `title`**, not hidden, when
nothing is pickable, so it does not vanish from a panel where `TargetsPanel`'s
equivalent always stays put. The condition is
`displayedInputCount(itemOverrides, assumedRawItemIds) === pack.items.length`,
the same arithmetic the Add popup's `disabledIds` uses. It is a guard rather
than a live case: with 113 items and 9 raw ones it is unreachable on the
shipped pack, and both it and `disabledIds` are derived from the last
completed render through `buildRealizedRateByItem`, so they lag the plan while
a solve is in flight. Without it the user would get a dialog of 113 disabled
tiles, since `picker.empty` only covers an empty search.

This is the one new string: an `inputs.add.exhausted` title in all four
locales. Everything else the design needs already exists in en, ja, ru and zh.

### Commit ordering

Clicking any trigger blurs a dirty rate field first, so `commitFromLocal(...,
revert=true)` runs before the popup opens: valid text commits and fires a
solve, invalid text reverts. Escape and backdrop click cancel the **pick**
only; a rate commit that already happened is not undone. This matches what
clicking the old select did, and the panel survives it because mutation
commits never bump `planEpoch`, so no remount discards local edit state.

### Cleanup this change forces

- The `.b-pick select` face, option, hover and focus rules in `canvas.css`
  lose their last consumer and are deleted. Nothing else depends on them: the
  locale switcher's selects are styled through `.ak-app-shell select` and
  `.topbar select`.
- The block comment above them is **rewritten, not deleted** - it also
  documents `.b-pick` and the caret affordance, both of which survive. What
  goes is its justification of the native select by its ARIA, keyboard
  navigation, type-ahead, IME composition and mobile native picker. Those are
  a real loss; the popup's search box is the replacement affordance, and the
  comment should say so rather than be left asserting the opposite.
- `handleAdd`'s first-unused-id scan goes.
- The `sortedItems` and `collator` memos go with it: the popup sorts
  internally, so the only remaining consumer is the section-head denominator,
  which reads `pack.items.length` instead.

### What does not change

Rate parsing, the auto-row promotion path, the realized-rate display, the
local edit and dirty-flag machinery, and the `duplicateError` state.

Two notes on that machinery, checked rather than assumed. The `localRates` key
migration in `handleItemChange` becomes defensive only, because the blur-first
ordering above means a dirty edit is already committed or reverted by the time
a pick lands; it is kept, not deleted. And `handleItemChange` drops a row's
`plan: true` flag on a swap, which is pre-existing, reachable only from a
hand-crafted URL, and left alone here.

## Testing

`InputsPanel` has two vitest suites plus a Playwright suite in scope.
`test/integration/inputs-panel-shell.test.tsx` is **not** in scope: it edits
rates and mocks the solver, and never touches the item control.

`test/components/InputsPanel.test.tsx` reaches the control through
`getAllByLabelText` plus `selectOptions`. Two of its tests lose their subject:

- The add-button test asserts `onChange` fires once with the first-unused-id
  append, which is exactly what ruling 2 removes. Rewritten against the
  popup; the fixture comment describing the first-unused-lex pick goes stale
  with it.
- The duplicate-selection test loses its trigger, because with sibling rows
  disabled and the own-item confirm guard no gesture reaches
  `setDuplicateError`. Dropped; the state stays as defense-in-depth,
  mirroring `TargetsPanel`.

`src/components/InputsPanel.test.tsx` uses `getByRole("combobox")` and walks
`querySelectorAll("option")`. Its UX-17 test asserts the **global** option
sequence is collator-sorted across all 113 items. `ItemPickerPopup` buckets by
tier and sorts only within a bucket, so that guarantee narrows and the test
cannot be retargeted mechanically. It is dropped from this suite and replaced
by a within-group ordering assertion in `ItemPickerPopup.test.tsx`, which
today asserts group-head order only. That assertion needs a fixture whose
within-tier array order differs from collator order; the current four-item
fixture is already in name order per tier, so it proves nothing as it stands.

Playwright (`test/e2e/inputs-panel.spec.ts`, six tests in file order):

- Test 1 asserts Add commits a row defaulting to the first lexical item. That
  is the behavior ruling 2 removes, so it is replaced by "Add opens the popup
  and commits nothing; a pick appends an uncapped override".
- Test 3 drives a duplicate through `selectOption` and asserts the alert plus
  an unchanged URL. The pick is impossible once the tile is disabled, so it is
  deleted and replaced by an assertion that the tile renders disabled.
- Test 5 caps `copper_ore`, which is raw and consumed by the default plan, so
  it is an auto-row and ruling 3 disables its tile in the Add popup. This is a
  restructure, not a preamble edit: it is rewritten against the auto-row
  typing path, and its `nth(initialCount)` locator goes, since `input-row`
  counts overrides only.
- Tests 2, 4 and 6 locate their row via `clickAddInput()` then
  `nth(initialCount)`. The row does not exist until a pick, so each preamble
  gains an interleaved popup step. Their plan and URL assertions survive
  unchanged.
- `FIRST_LEX_ITEM_ID` and `SECOND_LEX_ITEM_ID` become dead and are removed.

New coverage:

- A pick from the add popup appends an uncapped override and focuses its rate
  input.
- A row's own tile renders selected and enabled; re-picking it commits no
  change and raises no duplicate alert.
- Another override row's item renders disabled from a row popup; every
  auto-row item renders disabled from the Add popup and enabled from a row
  popup.
- Swapping a capped row onto a consumed raw item carries the cap.
- The add button is disabled when every item is claimed. Pinned to
  `test/components/InputsPanel.test.tsx`, whose four-item fixture is the only
  place the condition is reachable.
- Escape and backdrop click close without committing a pick.

## Out of scope

Recipe filtering, which lands separately in phase 2. The targets panel is not
touched. No changes below `src/solver/` or `src/pipeline/`.
