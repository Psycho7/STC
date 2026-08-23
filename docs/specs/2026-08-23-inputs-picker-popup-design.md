# Input picker popup

Design for replacing the INPUT SUPPLY item dropdown with the same popup the
targets panel already uses. Phase 1 of a two-phase split; phase 2 (a
user-controlled recipe blocklist) gets its own spec and branch. Rulings were
made on 2026-08-23 and revised the same day after a two-auditor spec audit.

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

1. **The input picker offers all pack items**, the same set the dropdown
   offers today. Restricting it to raw and cross-domain items would read as
   cleaner but silently removes the ability to declare an arbitrary
   intermediate as a boundary import, which the current control allows.
2. **Add opens the picker instead of committing a row.** The row is created
   when the user picks an item. Targets need a heavier draft mechanism because
   a target is meaningless without a nonzero rate; an input override is
   meaningful with no rate at all for a non-raw item, where a bare
   `{ itemId }` flips `effectiveSupply` from 0 (must be built on site) to
   Infinity (free boundary import). Picking is therefore enough to commit.
3. **Auto-row items are not pickable.** Every item currently rendered as an
   auto-row is disabled in the popup, from both entry points. Picking one
   would append a bare `{ itemId }` override, which for a raw item is
   solver-identical to the auto-row it replaces (`effectiveSupply` returns
   Infinity either way) while still firing a full re-solve and hash rewrite.
   The user would watch a near-identical row vanish from the auto block and
   reappear at the end of the override block, having changed nothing. Capping
   an assumed-raw item stays what it is today: type into the auto-row, which
   `commitAutoRate` promotes to a real override carrying the rate.
4. **Depth grouping is reused unchanged.** `computeItemDepths` seeds every
   entry in `pack.items`, not just producible ones, and all 113 rank on the
   shipped pack, so the popup's unranked bucket stays empty and no new
   grouping mode is needed.

Ruling 3 leaves one honest gap: a raw item the plan does not currently consume
has no auto-row, so it stays pickable, and the override it creates is a no-op
until the user types a cap. That is the same thing the row is for, and the same
thing today's add button produces, so it is accepted rather than special-cased.

## Design

### Component reuse

`ItemPickerPopup` is already presentational: it takes the item list, the
disabled set, the selected id, and the depth map, and reports a pick. Nothing
in it is target-specific, and it re-declares `--icons-url` on its own backdrop,
so a second mount site needs no portal or sprite work.

Props per entry point:

| prop | from a row | from Add |
| --- | --- | --- |
| `items` | all of `pack.items` | same |
| `tierByItemId` | `computeItemDepths(pack)`, memoized per pack | same |
| `disabledIds` | other override rows' items, plus every auto-row item | all override items, plus every auto-row item |
| `selectedId` | the row's own item | `undefined` |

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

Focus:

- From a row, `triggerRef` holds the button and `closePicker` returns focus to
  it. A committed swap unmounts the row, because rows are keyed by `itemId`,
  so the `document.contains` guard fires and focus falls to `document.body`.
  That is a regression from the select, which keeps focus, and it is accepted:
  `TargetsPanel` behaves identically today, and fixing it means re-keying rows
  by a synthetic id, which also re-keys `localRates`, `dirty` and `invalidIds`.
- From Add, the trigger is the add button, which survives, so the guard never
  fires. Returning focus there would leave the user below the row they just
  created, so an add-pick instead focuses the **new row's rate input**, which
  is the only edit that makes the row do anything.

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

The add button is hidden when every pack item already has an override or an
auto-row. Today that case silently no-ops; without the guard it would open a
dialog of 113 disabled tiles, and `picker.empty` only covers an empty search.

### Commit ordering

Clicking any trigger blurs a dirty rate field first, so `commitFromLocal(...,
revert=true)` runs before the popup opens: valid text commits and fires a
solve, invalid text reverts. Escape and backdrop click cancel the **pick**
only; a rate commit that already happened is not undone. This matches what
clicking the old select did, and the panel survives it because mutation
commits never bump `planEpoch`, so no remount discards local edit state.

### Cleanup this change forces

- The `.b-pick select` face, option, hover and focus rules in `canvas.css`
  lose their last consumer and are deleted, along with the block comment above
  them that justifies the native select by its ARIA, keyboard navigation,
  type-ahead, IME composition and mobile native picker. Those are a real loss;
  the popup's search box is the replacement affordance, and the comment is
  rewritten to say so rather than left asserting the opposite.
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

The two unit suites reach the control by different paths, and only one is a
selector swap:

- `test/components/InputsPanel.test.tsx` uses `getAllByLabelText` plus
  `selectOptions`. Its duplicate-selection test loses its trigger: with
  auto-rows and sibling rows disabled and the own-item confirm guard, no
  gesture reaches `setDuplicateError`. The test is dropped and the state stays
  as defense-in-depth, mirroring `TargetsPanel`.
- `src/components/InputsPanel.test.tsx` uses `getByRole("combobox")` and walks
  `querySelectorAll("option")`. Its UX-17 test asserts the **global** option
  sequence is collator-sorted across all 113 items. `ItemPickerPopup` buckets
  by tier and sorts only within a bucket, so that guarantee narrows and the
  test cannot be retargeted mechanically. It is dropped from this suite; if
  `ItemPickerPopup.test.tsx` does not already assert per-group name ordering,
  it gains that assertion.

Playwright (`test/e2e/inputs-panel.spec.ts`, six tests):

- Test 1 asserts Add commits a row defaulting to the first lexical item. That
  is the behavior ruling 2 removes, so the test is replaced by "Add opens the
  popup and commits nothing; a pick appends an uncapped override".
- Test 3 drives a duplicate through `selectOption` and asserts the alert plus
  an unchanged URL. The pick is impossible once the tile is disabled, so the
  test is deleted and replaced by an assertion that the tile renders disabled.
- Tests 2, 4, 5 and 6 all locate their row via `clickAddInput()` then
  `nth(initialCount)`. The row does not exist until a pick, so each preamble
  gains an interleaved popup step. Their plan and URL assertions survive
  unchanged.
- `FIRST_LEX_ITEM_ID` and `SECOND_LEX_ITEM_ID` become dead and are removed.

New coverage:

- A pick from the add popup appends an uncapped override and focuses its rate
  input.
- A row's own tile renders selected and enabled; re-picking it commits no
  change and raises no duplicate alert.
- Another override row's item, and every auto-row item, render disabled.
- The add button is absent when every item is claimed.
- Escape and backdrop click close without committing a pick.

## Out of scope

Recipe filtering, which lands separately in phase 2. The targets panel is not
touched. No changes below `src/solver/` or `src/pipeline/`.
