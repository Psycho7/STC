# Input picker popup

Design for replacing the INPUT SUPPLY item dropdown with the same popup the
targets panel already uses. Phase 1 of a two-phase split; phase 2 (a
user-controlled recipe blocklist) gets its own spec and branch. Rulings were
made on 2026-08-23 and revised five times the same day against five rounds of
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

   From an existing row the same tiles stay **enabled**. For a capped row that
   pick is not a bare append at all: `handleItemChange` carries the row's
   `ratePerSec` to the new item, so the swap moves a live cap, and disabling
   it would strand a user who wants exactly that, forcing them to delete the
   row and retype the number into the auto-row. An **uncapped** row swapped
   onto a consumed raw item does reproduce the bare-append churn the Add-side
   ban exists to prevent. That is tolerated: the row already exists, so
   nothing new appears, and the swap still deletes the old import, which is a
   real change rather than a no-op.
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
in its behavior is target-specific, and it re-declares `--icons-url` on its
own backdrop, so a second mount site needs no portal or sprite work. Two of
its prop comments are target-specific and go stale here; they are listed under
cleanup.

| prop | from a row | from Add |
| --- | --- | --- |
| `items` | all of `pack.items` | same |
| `tierByItemId` | `computeItemDepths(pack)`, memoized per pack | same |
| `disabledIds` | the other override rows' items | every override item, plus every auto-row item |
| `disabledHint` | omitted | `inputs.picker.listed` (copy below) |
| `selectedId` | the row's own item | `undefined` |
| `onPick` | own item returns early from the swap and arms nothing, then closes; otherwise `handleItemChange` swaps, carrying any rate, and arms `{ itemId, kind: "trigger" }` | appends `{ itemId }` and arms `{ itemId, kind: "rate" }`, then closes |
| `onClose` | clears `pickerFor`, refocuses the trigger | same |

A disabled tile therefore means one thing at each site: from a row, "another
override row already claims this"; from Add, "this item already has a row in
the panel". Auto-rows already exclude overridden items, so the Add union is
exactly "items with a visible row", and neither site mixes the two meanings.

The Add site is the one place a user can hit a disabled tile with no visible
route forward: someone trying to cap copper ore from Add gets a dead tile and
no cue that the panel's own auto-row does it. `ItemPickerPopup` gains an
optional `disabledHint` for that reason, rendered as **a single visible line
under the search box** whenever the prop is set. It is deliberately not a
tile `title`: a natively `disabled` button dispatches no pointer events in
Chromium or WebKit, so no tooltip appears, and `aria-label` beats `title` for
the accessible name, so nothing is announced either. That is the same trap the
add button avoids below, and making 113 tiles `aria-disabled` to dodge it
would make every one of them focusable, defeating the single roving tab stop
the grid now uses. Tiles
keep `title` and `aria-label` set to the item name, disabled or not.
`TargetsPanel` omits the prop and is unaffected.

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

`closePicker` is identical for both entry points and always refocuses the
trigger, so Escape and backdrop click never strand focus on `document.body`.

A pick additionally arms a **pending-focus token**, `{ itemId, kind }`. The
kind is load-bearing, not decoration: both consumers live on the same row, and
React attaches refs in tree order, so the trigger inside `.info` completes
before the rate input inside `.b-rate`. A bare item id would let the trigger
ref swallow every token, and the Add path's rate focus would never fire. Each
callback ref consumes the token only when the kind matches its own, then
clears it.

- **Add** arms `kind: "rate"`. The trigger is the add button, which survives,
  so refocusing it alone would leave the user below the row they just created.
  The rate input is the only edit that makes the new row do anything.
- **Row swap** arms `kind: "trigger"`. Rows are keyed by `itemId`, so a
  committed swap unmounts the row and its trigger, and the browser drops focus
  to `document.body` after `closePicker` has already refocused the old button.
  The swapped row's trigger is the right landing point: it is the control the
  user invoked, and the rate carried over, so focusing the rate input would
  imply an edit they did not start.
- **Own-item confirm** arms nothing. The row never unmounts, so `closePicker`
  refocuses the surviving trigger and there is nothing to restore. Arming here
  would leave a token that no mount consumes until some unrelated later
  remount yanks focus.

Because `closePicker` runs synchronously inside the click handler while the
row mounts on the following commit, a consumed token always fires last and
wins. The row does not exist when `onPick` runs: the append travels `onChange`
to `handleItemOverridesChange` to `commitPlan` to `setPlan`. If the row never
arrives, because the updater returned the same reference or `validatePlan`
rejected the commit, or because the panel is rendered standalone with an
`onChange` that never feeds the prop back, as `test/components/InputsPanel.test.tsx`
does, no row mounts, `closePicker`'s refocus is already the correct end state,
and the stale token is discarded when the next pick arms a new one.

Focus lands on an input whose accessible name is the generic
`inputs.rate.label`, identical across rows, so on its own a screen reader
announces "Rate, edit" with no indication of which item it caps. Every rate
input, on auto-rows and override rows alike, therefore gains an
`aria-describedby` pointing at its row's item name, joined with the existing
invalid-rate message id when that is present. The accessible *name* is
untouched, so every `getAllByLabelText` query keeps resolving.

The id must sit on a dedicated name node, never on the trigger button. A
description resolves to the referenced element's accessible *name*, and the
trigger's `aria-label` is the generic `inputs.item.label`, so pointing at the
button would announce "Rate, edit, Item" and silently reinstate the problem
this fixes. Override rows wrap the trigger's visible text in a
`<span id={`i-name-${itemId}`}>`; auto-rows put the same id on their existing
`.b-name` span.

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

When nothing is pickable the add button stays in place, matching
`TargetsPanel`'s always-present button, and is marked `aria-disabled="true"`
with an explanatory `title`, its click handler short-circuiting. A genuinely
`disabled` button is not focusable, so keyboard and screen-reader users would
never receive the explanation. The condition is
`displayedInputCount(itemOverrides, assumedRawItemIds) === pack.items.length`,
the same arithmetic the Add popup's `disabledIds` uses; both sides are subsets
of `pack.items` because `validatePlan` rejects unknown and duplicate
overrides, so equality is the right test. It is a guard rather than an
everyday case: it needs a hand-crafted or fully-overridden plan, which the URL
hash can deliver, and both it and `disabledIds` are derived from the last
completed render through `buildRealizedRateByItem`, so they lag the plan while
a solve is in flight. Without it the user would get a dialog of 113 disabled
tiles, since `picker.empty` only covers an empty search.

Two new strings, in all four locales: `inputs.add.exhausted` for that title
and `inputs.picker.listed` for the Add popup's `disabledHint`. Both live in
the `inputs.` namespace rather than `picker.`, because `InputsPanel`
translates them and passes them down; every existing `picker.` string is
translated inside `ItemPickerPopup` itself. Everything else the design needs
already exists in en, ja, ru and zh.

Both follow the neighbours' conventions: sentence case, no trailing period,
spaced em dash as in `inputs.empty`.

```
en  inputs.add.exhausted  All items already have a row
    inputs.picker.listed  Dimmed items already have a row in the panel — edit that row instead
zh  inputs.add.exhausted  所有物品均已添加
    inputs.picker.listed  灰显的物品已在面板中 — 请直接编辑对应行
ja  inputs.add.exhausted  すべてのアイテムが既に追加されています
    inputs.picker.listed  グレー表示のアイテムは既にパネルにあります — 対応する行を直接編集してください
ru  inputs.add.exhausted  Все предметы уже объявлены
    inputs.picker.listed  Затемнённые предметы уже есть в панели — редактируйте их строки
```

### Commit ordering

Clicking any trigger blurs a dirty rate field first, so `commitFromLocal(...,
revert=true)` runs before the popup opens: valid text commits and fires a
solve, invalid text reverts. Escape and backdrop click cancel the **pick**
only; a rate commit that already happened is not undone. This matches what
clicking the old select did, and the panel survives it because mutation
commits never bump `planEpoch`, so no remount discards local edit state.

### CSS

- The `.b-pick select` face, option, hover and focus rules in `canvas.css`
  lose their last consumer and are deleted. Nothing else depends on them: the
  locale switcher is the app's only other `<select>`, and it is styled through
  `.ak-app-shell select` and `.ak-app-shell .topbar select`.
- The block comment above them is **rewritten, not deleted**. It must still
  document `.b-pick` as the row's name-surface slot in the fixed row layout,
  the persistent caret as the touch and discoverability affordance, and why
  that caret stays minimal rather than reinstating a boxed select. What goes
  is the `color-scheme: dark` sentence and, more importantly, the
  justification of the native select by its ARIA, keyboard navigation,
  type-ahead, IME composition and mobile native picker. The rewritten comment
  records what the popup does and does not replace rather than implying
  parity. **Amended after review:** the original text recorded the missing
  focus trap and arrow-key navigation as an accepted loss. They were built
  instead, so the comment records the narrower residue - type-ahead outside
  the search field, IME composition and the mobile native picker. See the
  keyboard section below.
- The exhausted add button needs its own rules, and specificity decides all
  of them. The scoped `.b-add:disabled` rule is **extended, not deleted**: its
  selector gains `, ... .b-add[aria-disabled="true"]`. A generic
  `.ak-app-shell button[aria-disabled="true"]` would not do, because the base
  `.ak-app-shell [data-testid="side-panel"] .b-add` rule outranks it and the
  button would keep `cursor: pointer`. Only the equally scoped rule wins.
  (Nothing sets `disabled` on a `.b-add` today, so that half of the selector
  is dead either way; it costs nothing to keep.)
- Two hover rules must be guarded, not one. Scoped `.b-add:hover` gains
  `:not([aria-disabled="true"])` - but that unmasks the generic
  `.ak-app-shell button:hover:not(:disabled)`, which outranks the base
  `.b-add` rule and would repaint the inert button's dashed-lime face solid.
  Guard that one too, or declare `background` and `border-color` in the
  extended scoped rule above.
- The `disabledHint` line needs a rule in the `.recipe-picker-*` family,
  sitting between `.recipe-picker-search` and `.recipe-picker-body`.

### Other cleanup

- `handleAdd`'s first-unused-id scan goes.
- The `sortedItems` and `collator` memos go with it: the popup sorts
  internally, so the only remaining consumer is the section-head denominator,
  which reads `pack.items.length` instead.
- Two `ItemPickerPopup` prop comments go stale and are rewritten: the one
  describing `items` as already-filtered producible items, which the input
  picker violates by passing all of `pack.items`, and the one describing
  `disabledIds` in terms of targets and drafts.

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
`getAllByLabelText` plus `selectOptions`, and is the suite whose queries
constrain the rate input's accessible name. Two of its tests lose their
subject:

- The add-button test asserts `onChange` fires once with the first-unused-id
  append, which is exactly what ruling 2 removes. Rewritten against the
  popup; the fixture comment describing the first-unused-lex pick goes stale
  with it.
- The duplicate-selection test loses its trigger, because with sibling rows
  disabled and the own-item confirm guard no gesture reaches
  `setDuplicateError`. Dropped; the state stays as defense-in-depth,
  mirroring `TargetsPanel`.

`src/components/InputsPanel.test.tsx` uses `getByRole("combobox")` and walks
`querySelectorAll("option")`; it selects rate inputs by role, not by label.
Its UX-17 test asserts the **global** option sequence is collator-sorted
across all 113 items. `ItemPickerPopup` buckets by tier and sorts only within
a bucket, so that guarantee narrows and the test cannot be retargeted
mechanically. It is dropped from this suite and replaced by a within-group
ordering assertion in `ItemPickerPopup.test.tsx`, which today asserts
group-head order only. That assertion needs a fixture whose within-tier array
order differs from collator order; the current four-item fixture is already in
name order per tier, so it proves nothing as it stands. Three of this suite's
four parent wrappers do feed the updated list back, so a pick there mounts a
real row and can assert the pending-focus behavior.

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
- Four constants become dead: `FIRST_LEX_ITEM_ID`, used by Tests 1 and 3, and
  `SECOND_LEX_ITEM_ID`, `TEXT.duplicateAlert` and `COMMIT_DEBOUNCE_MS`, used
  by Test 3 alone. The last one's comment already describes a debounce the app
  no longer has.

New coverage:

- A pick from the add popup appends an uncapped override and focuses its rate
  input, not its trigger.
- A committed row swap focuses the swapped row's trigger.
- An own-item confirm leaves focus on the surviving trigger and arms nothing.
- A row's own tile renders selected and enabled; re-picking it commits no
  change and raises no duplicate alert.
- Another override row's item renders disabled from a row popup; every
  auto-row item renders disabled from the Add popup and enabled from a row
  popup.
- The Add popup renders the `disabledHint` line; a row popup does not.
- Swapping a capped row onto a consumed raw item carries the cap.
- Escape and backdrop click close without committing a pick, and return focus
  to the trigger.
- The add button is `aria-disabled` and inert when every item is claimed.
  Pinned to `test/components/InputsPanel.test.tsx`, whose four-item fixture
  reaches the condition without a hand-crafted plan.

## Out of scope

Recipe filtering, which lands separately in phase 2. The targets panel is not
touched. No changes below `src/solver/` or `src/pipeline/`.

## Keyboard model (added after review)

The original spec accepted "no focus trap, no arrow-key grid navigation" as
the price of leaving the native `<select>`. Review found that this branch
doubles the affected surface by adding a second caller, so the gap was closed
in `ItemPickerPopup` rather than deferred. Both panels get it.

- **One roving tab stop, not one per tile.** Every tile carries
  `tabIndex={-1}` except the active one. Without this the shipped pack puts
  roughly 250 stops between the search box and the end of the dialog. The stop
  starts on `selectedId` when the caller passes one, so tabbing out of the
  search box lands on the item being edited, and it follows the search results
  when the grid is filtered.
- **Arrow keys move within the grid.** Left and Right step one cell; Up and
  Down step one row, where the column count is read from the live grid's
  computed `grid-template-columns` rather than a constant, since the template is
  responsive. Home and End jump to the first and last tile, crossing tier-group
  boundaries. Movement clamps at both ends instead of wrapping.
- **The step is over every cell, then it walks off disabled ones.** Disabled
  tiles are real `disabled` buttons and take no focus, so they cannot be
  landings, but they still occupy grid cells. Stepping over the enabled subset
  instead would make "one row down" drift by however many disabled tiles sit
  above, so the arithmetic runs over the full list and a landing on a disabled
  cell continues in the direction of travel to the next enabled one. A move with
  no enabled tile beyond it stays put. Verified in the browser at five columns:
  Down holds the column and Right holds the row.
- **Tab is trapped.** `aria-modal` does not confine Tab on its own. Tab off the
  last stop returns to the first and Shift+Tab off the first goes to the last;
  in the middle of the ring the event is left to the browser.
- **Still missing, deliberately:** type-ahead outside the search field, IME
  composition on the grid itself, and the mobile native picker. The search box
  covers finding an item by name in every locale, which is what type-ahead was
  mostly used for.
