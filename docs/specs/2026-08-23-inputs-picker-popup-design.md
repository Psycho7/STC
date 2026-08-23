# Input picker popup

Design for replacing the INPUT SUPPLY item dropdown with the same popup the
targets panel already uses. Phase 1 of a two-phase split; phase 2 (a
user-controlled recipe blocklist) gets its own spec and branch. Rulings were
made by the user on 2026-08-23.

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
   a target is meaningless without a nonzero rate; an input override is valid
   with no rate at all (it means uncapped), so picking an item is enough to
   commit.
3. **Depth grouping is reused unchanged.** `computeItemDepths` already ranks
   every item in the pack, not just producible ones, so the popup needs no new
   grouping mode.

## Design

### Component reuse

`ItemPickerPopup` is already presentational: it takes the item list, the
disabled set, the selected id, and the depth map, and reports a pick. Nothing
in it is target-specific. `InputsPanel` mounts the same component with
different props.

- `items` - all of `pack.items`, sorted inside the popup.
- `tierByItemId` - `computeItemDepths(pack)`, memoized per pack.
- `disabledIds` - the item ids of the other explicit override rows. Auto-rows
  are derived from the solve rather than declared by the user, so an
  assumed-raw item stays pickable; picking one promotes it to an explicit
  override, which is the same promotion typing a cap into its auto-row
  performs.
- `selectedId` - the row's own item, so the tile renders highlighted and
  enabled.

### Trigger and focus

Each override row's `<select>` becomes the `b-pick-trigger` button
`TargetsPanel` uses, carrying the localized item name as both label and
`title` so long names that truncate at 360px stay readable on hover. A
`triggerRef` holds the button that opened the popup and `closePicker` returns
focus to it, guarding against the button having been removed from the DOM.

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

### What does not change

Rate parsing, the auto-row promotion path, the local edit and dirty-flag
machinery, the realized-rate display, and the duplicate error banner all stay
as they are. `duplicateError` becomes hard to reach once disabled tiles block
the dupe, but it stays as a second line of defense, matching `TargetsPanel`.

## Testing

`InputsPanel` has two vitest suites (`src/components/InputsPanel.test.tsx` and
`test/components/InputsPanel.test.tsx`), an integration shell suite, and a
Playwright suite. The unit suites reach the item control through
`getAllByLabelText` plus `selectOptions`; the Playwright suite reaches it
through `getByRole("combobox")` at five sites. All of them are rewritten
against the popup.

New coverage:

- Add with no rows opens the popup and commits nothing until a pick.
- A pick from the add popup appends an uncapped override.
- A row's own tile renders selected and enabled; re-picking it commits no
  change and raises no duplicate alert.
- Another row's item renders disabled.
- An assumed-raw auto-row's item stays enabled, and picking it promotes the
  auto-row to an explicit override.
- Escape and backdrop click close without committing.

The Playwright suite keeps its existing assertions about what lands in the
plan and the URL hash; only the interaction that selects an item changes.

## Out of scope

Recipe filtering, which lands separately in phase 2. The targets panel is not
touched. No changes below `src/solver/` or `src/pipeline/`.
