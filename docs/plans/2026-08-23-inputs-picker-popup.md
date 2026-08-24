# Input picker popup implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the INPUT SUPPLY item `<select>` with the same `ItemPickerPopup` modal the targets panel uses, and make Add open that picker instead of committing an arbitrary first-unused item.

**Architecture:** `ItemPickerPopup` is already presentational and gains one optional prop (`disabledHint`). `InputsPanel` mounts it from two entry points, a row trigger and the Add button, distinguished by a `pickerFor` discriminated union. Focus that would otherwise be lost across the commit boundary is restored by a pending-focus token carrying a `kind`. No file below `src/solver/` or `src/pipeline/` changes.

**Tech Stack:** React 19, TypeScript, vitest + @testing-library/react (jsdom), Playwright, plain CSS.

Design spec: `docs/specs/2026-08-23-inputs-picker-popup-design.md`.

## Global Constraints

- Comments and commit messages are ASCII only. No em dashes, smart quotes, or Unicode arrows in source comments.
- Comments must not reference design docs, specs, ADRs, tickets, or other Markdown files.
- UI strings (`src/data/i18n.ts`) are the exception: they follow the file's existing conventions, which include a spaced em dash. Sentence case, no trailing period.
- Every new UI string must be added to all four locales: `zh`, `en`, `ja`, `ru`. `Record<Locale, Record<UiKey, string>>` makes a missing locale a compile error; a missing `UiKey` union entry is not, so add the key to the union too.
- Do not touch `TargetsPanel.tsx` behavior. It shares `ItemPickerPopup`, so every change there must be backwards compatible via optional props.
- Do not modify `test/integration/inputs-panel-shell.test.tsx`. It never touches the item control.
- Verification commands: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:e2e`. CI runs lint, typecheck, typecheck:tools, test and build. It does NOT run `format` or `test:e2e`, so those two are on you.

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/components/ItemPickerPopup.tsx` | The shared modal item grid | Modify: add `disabledHint`, rewrite two stale prop comments |
| `src/components/ItemPickerPopup.test.tsx` | Popup unit tests | Modify: fixture + within-group ordering + hint tests |
| `src/components/InputsPanel.tsx` | The INPUT SUPPLY section | Modify: trigger, picker state, pending focus, Add button, name spans, cleanup |
| `src/components/InputsPanel.test.tsx` | Unit tests colocated with the panel | Modify: drop UX-17, add focus tests |
| `test/components/InputsPanel.test.tsx` | Unit tests using the 4-item fixture | Modify: rewrite add + duplicate tests, add exhausted test |
| `test/e2e/inputs-panel.spec.ts` | Playwright suite | Modify: replace 2 tests, restructure 1, re-preamble 3, drop 4 constants |
| `src/canvas/canvas.css` | Styling | Modify: delete select rules, rewrite comment, add hint + aria-disabled rules |
| `src/data/i18n.ts` | UI strings | Modify: 2 new keys across 4 locales |

---

### Task 0: Record the e2e baseline

Run this FIRST, before any file is touched. `bun run test:e2e` is not a CI gate and this repo has known pre-existing e2e failures, so the only way to tell a regression from an inherited failure is to measure the suite before the change. Measuring it later is worse than not measuring: by Task 9 the select is already gone, every legacy test fails on `getByRole("combobox")`, and a "no new failures" gate passes vacuously.

**Files:**
- Create: `.artifacts/e2e-baseline.txt` (scratch; `.artifacts/` is already gitignored)

**Interfaces:**
- Consumes: nothing.
- Produces: the list of `inputs-panel` tests already failing on this branch's merge base, which Task 9 Step 7 compares against.

- [x] **Step 1: Run the suite on the untouched tree**

```bash
mkdir -p .artifacts
bun run test:e2e -- inputs-panel 2>&1 | tee .artifacts/e2e-baseline.txt | tail -40
```

`.artifacts/` is already in `.gitignore`, so the scratch file can never be swept into a commit by a later `git add -A`. Do not try to add it to `.git/info/exclude`: execution happens in a git worktree, where `.git` is a pointer file rather than a directory, and the redirect fails.

Do not use `git stash` for this. At Task 0 the tree is already clean, so a stash saves nothing and a following `git stash pop` either errors or applies an unrelated stash entry from another session.

- [x] **Step 2: Record the result**

Write the names of the failing tests into the plan itself, replacing this line, so a later task does not have to re-derive them:

> Baseline failures on the merge base (`bun run test:e2e -- inputs-panel`, 4 failed / 2 passed):
>
> - Test 1 (Add input row defaults to first unused itemId): FAIL. `FIRST_LEX_ITEM_ID` is stale; the select holds `domain_key_tundra`, not `bottled_food_1`. Retitled in Task 9 Step 2, so exempt from the gate.
> - Test 2 (Remove input row): PASS. Gated.
> - Test 3 (Duplicate-guard): FAIL. `SECOND_LEX_ITEM_ID` is stale; the second row holds `liquid_acid`. Retitled in Task 9 Step 3, so exempt.
> - Test 4 (Cap a rate, then clear it): FAIL. Strict-mode violation: the bare `[data-flavor="inputProduct"][data-item-id="copper_powder"]` locator resolves to 2 nodes (the import unit and `u:in:copper_powder:target`). Pre-existing and unrelated to the picker.
> - Test 5 (Cap exceeding demand): FAIL. Same family: the `copper_ore` inputProduct locator resolves to 3 nodes (the import unit plus two tap replicas).
> - Test 6 (Dual-listed item): PASS. It already pins each input unit by exact node id. Gated.
>
> Correction to the note below: the missing blur is real (the panel commits only on blur or Enter) but it is NOT what fails Tests 4 and 6 today. Their URL polls pass vacuously, because the baseline URL is captured immediately after `selectOption` and the hash rewrite from THAT commit lands during the poll. Test 6 passes outright. Adding the `Enter` press is still required for the rate commit to happen at all, but it will not turn Test 4 or 5 green: their remaining failure is the strict-mode locator above, which Task 9 leaves in place.

Expect some. Tests 4 and 6 in particular fill a rate with `fill()` and never blur, and the panel commits only on blur or Enter, so their URL polls have nothing to wait for. Task 9 fixes that.

---

### Task 1: `ItemPickerPopup` gains `disabledHint`

**Files:**
- Modify: `src/components/ItemPickerPopup.tsx`
- Modify: `src/canvas/canvas.css` (new rule after `.recipe-picker-search:focus`)
- Test: `src/components/ItemPickerPopup.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `ItemPickerPopup` accepts `disabledHint?: string`. When set, the dialog renders `<div className="recipe-picker-hint" data-testid="picker-hint">{disabledHint}</div>` between the search input and `.recipe-picker-body`. When absent, no such element exists.

- [x] **Step 1: Write the failing tests**

Append to `src/components/ItemPickerPopup.test.tsx`:

```tsx
test("renders the disabled hint line when the prop is set", () => {
  renderPopup({ disabledHint: "already in the panel" });
  const hint = screen.getByTestId("picker-hint");
  expect(hint.textContent).toBe("already in the panel");
  // The hint is a sibling of the scroll body, not inside it, so it never
  // scrolls out of view.
  expect(hint.parentElement?.className).toBe("recipe-picker");
});

test("renders no hint line when the prop is absent", () => {
  renderPopup();
  expect(screen.queryByTestId("picker-hint")).toBeNull();
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: FAIL on the first test only, `Unable to find an element by: [data-testid="picker-hint"]`. The second test asserts the hint is absent, so it passes before the implementation exists; it is there to pin the absence once the prop lands.

- [x] **Step 3: Add the prop and render the line**

In `src/components/ItemPickerPopup.tsx`, add to the `Props` type after `tierByItemId`:

```tsx
  // Optional one-line explanation of what a dimmed tile means, rendered under
  // the search box. A caller that disables tiles for a reason the grid cannot
  // show passes it; a caller whose disabled tiles are self-explanatory omits
  // it. Not a per-tile title: a disabled button dispatches no pointer events,
  // so a title on one never renders a tooltip, and aria-label beats title for
  // the accessible name, so nothing is announced either.
  disabledHint?: string | undefined;
```

Add `disabledHint` to the destructured parameter list.

Then insert between the `<input className="recipe-picker-search" ... />` element and `<div className="recipe-picker-body">`:

```tsx
        {disabledHint !== undefined ? (
          <div className="recipe-picker-hint" data-testid="picker-hint">
            {disabledHint}
          </div>
        ) : null}
```

- [x] **Step 4: Add the CSS rule**

In `src/canvas/canvas.css`, immediately after the `.recipe-picker-search:focus` block:

```css
.recipe-picker-hint {
  margin: 0 18px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--ak-text-decoration);
  letter-spacing: 0.04em;
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: PASS, all tests in the file.

- [x] **Step 6: Commit**

```bash
git add src/components/ItemPickerPopup.tsx src/components/ItemPickerPopup.test.tsx src/canvas/canvas.css
git commit -m "Add an optional disabled-tile hint line to the item picker"
```

---

### Task 2: Pin within-group ordering in the popup

The panel suite currently owns the "sorted by localized display name" guarantee via the `<select>`'s flat option list. That list is about to disappear, and the popup sorts only within a tier bucket. Move the guarantee here first, so it is never uncovered.

**Files:**
- Test: `src/components/ItemPickerPopup.test.tsx`

**Interfaces:**
- Consumes: `ItemPickerPopup` from Task 1.
- Produces: nothing consumed by later tasks.

- [x] **Step 1: Fix the fixture so the assertion can fail**

The current tier-1 items are `alpha, bravo`, already in collator order, so a sort assertion would pass even with the sort removed. Replace the `ITEMS` and `TIERS` blocks in `src/components/ItemPickerPopup.test.tsx`:

```tsx
// Tier 1 is deliberately NOT in name order in the array, so a within-group
// ordering assertion fails if the popup stops sorting.
const ITEMS = [
  mkItem("delta"),
  mkItem("bravo"),
  mkItem("alpha"),
  mkItem("charlie"),
  mkItem("echo"),
];

// alpha, bravo, delta -> tier 1; charlie -> tier 2; echo -> Infinity.
const TIERS = new Map<string, number>([
  ["alpha", 1],
  ["bravo", 1],
  ["delta", 1],
  ["charlie", 2],
  ["echo", Number.POSITIVE_INFINITY],
]);
```

- [x] **Step 2: Write the failing test**

Append to `src/components/ItemPickerPopup.test.tsx`:

```tsx
test("sorts tiles by localized name within each group, not by array order", () => {
  renderPopup();
  const groups = [...document.querySelectorAll(".recipe-picker-group")];
  const namesPerGroup = groups.map((g) =>
    [...g.querySelectorAll(".recipe-picker-tile-label")].map(
      (el) => el.textContent ?? "",
    ),
  );
  const collator = new Intl.Collator("en");
  for (const names of namesPerGroup) {
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
  }
  // Tier 1 specifically: array order was delta, bravo, alpha.
  expect(namesPerGroup[0]).toEqual(["alpha", "bravo", "delta"]);
});
```

- [x] **Step 3: Run the whole file to verify the fixture change did not break the existing tests**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: PASS. The new test passes immediately because the popup already sorts; the point of Step 1 is that it would now fail if the sort were removed. If any pre-existing test in the file fails, it was asserting against the old fixture ids: update its expected ids to the new fixture rather than reverting the fixture.

- [x] **Step 4: Verify the test is load-bearing**

Temporarily delete the `.sort(...)` call inside the `groups` memo in `src/components/ItemPickerPopup.tsx` (the inner one applied to `group`, not the outer `.sort((a, b) => a.tier - b.tier)`), re-run the file, confirm the new test FAILS, then restore the sort and re-run to confirm PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/ItemPickerPopup.test.tsx
git commit -m "Pin within-group tile ordering in the item picker suite"
```

---

### Task 3: Swap the row's select for a picker trigger

Row entry point only. Add still behaves as it does today; Task 5 changes it.

**Files:**
- Modify: `src/components/InputsPanel.tsx`
- Test: `test/components/InputsPanel.test.tsx`

**Interfaces:**
- Consumes: `ItemPickerPopup` from Task 1.
- Produces: `InputsPanel` renders one `button.b-pick-trigger` per override row, with `aria-label={i18n.t("inputs.item.label")}`, `aria-haspopup="dialog"`, `title` and visible text both the localized item name. Local state `pickerFor: { kind: "row"; itemId: string } | null` and a `closePicker()` that always refocuses the stored trigger.

- [x] **Step 1: Write the failing tests**

In `test/components/InputsPanel.test.tsx`, replace the existing duplicate-selection test (the one calling `user.selectOptions(selects[1]!, "copper_ore")` and asserting `getByRole("alert")`) with:

```tsx
it("a row trigger opens the picker with siblings disabled and its own item selected", async () => {
  const user = userEvent.setup();
  render(
    <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }, { itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
      />
  );
  const triggers = screen.getAllByLabelText("物品");
  await user.click(triggers[0]!);
  const own = pickerTile("copper_ore");
  const sibling = pickerTile("iron_ore");
  expect(own).not.toBeNull();
  expect(own!.disabled).toBe(false);
  expect(own!.className).toContain("selected");
  expect(sibling!.disabled).toBe(true);
});

it("picking a different item swaps the row and keeps its rate", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <InputsPanel
        itemOverrides={[
          { itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } },
        ]}
        onChange={onChange}
        pack={fixturePack}
      />
  );
  await user.click(screen.getAllByLabelText("物品")[0]!);
  await user.click(pickerTile("iron_ore")!);
  expect(onChange).toHaveBeenCalledTimes(1);
  const updater = onChange.mock.calls[0]![0] as (
    c: ItemOverride[],
  ) => ItemOverride[];
  expect(updater([{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]))
    .toEqual([{ itemId: "iron_ore", ratePerSec: { num: "1", denom: "2" } }]);
});

it("a row popup leaves auto-row items enabled and shows no hint", async () => {
  const user = userEvent.setup();
  render(
    <InputsPanel
      itemOverrides={[{ itemId: "iron_ore" }]}
      onChange={() => {}}
      pack={fixturePack}
      assumedRawItemIds={["copper_ore"]}
    />,
  );
  // Open the picker from the override row, not from Add.
  await user.click(screen.getAllByLabelText("物品")[0]!);
  // copper_ore has an auto-row, but a row swap carries the row's rate onto it,
  // so it is a live cap move and must stay pickable here. Only the Add popup
  // dims it.
  expect(pickerTile("copper_ore")!.disabled).toBe(false);
  expect(screen.queryByTestId("picker-hint")).toBeNull();
});

it("Escape returns focus to the trigger that opened the picker", async () => {
  const user = userEvent.setup();
  render(
    <InputsPanel
      itemOverrides={[{ itemId: "copper_ore" }]}
      onChange={() => {}}
      pack={fixturePack}
    />,
  );
  const trigger = screen.getAllByLabelText("物品")[0]!;
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(screen.queryByTestId("picker-tile")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("re-picking the row's own item commits nothing and raises no alert", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />
  );
  const trigger = screen.getAllByLabelText("物品")[0]!;
  await user.click(trigger);
  await user.click(pickerTile("copper_ore")!);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("picker-tile")).toBeNull();
  // The row never unmounts on a confirm, so focus returns to the same button.
  expect(document.activeElement).toBe(trigger);
});

it("a backdrop click returns focus to the trigger", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <InputsPanel
      itemOverrides={[{ itemId: "copper_ore" }]}
      onChange={onChange}
      pack={fixturePack}
    />,
  );
  const trigger = screen.getAllByLabelText("物品")[0]!;
  await user.click(trigger);
  await user.click(document.querySelector(".recipe-picker-backdrop")!);
  expect(screen.queryByTestId("picker-tile")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
```

**File conventions, and a required helper.** This block applies to every snippet in Tasks 3 to 6. Tasks 4, 5 and 6 each point back here. The helper below is declared ONCE, by this task; a later task must use it, never redeclare it, or `bun run typecheck` fails on a duplicate implementation.

- The file uses `describe` / `it`, never bare `test`. `vitest.config.ts` sets `globals: false`, so `test` is not even defined.
- It renders `<InputsPanel />` bare, with no `LocaleProvider`. The default locale is `zh`, so the item query is `getAllByLabelText("物品")` and the rate query is `getAllByLabelText("速率")`.
- Its fixture pack is `fixturePack`. Items: `zinc`, `copper_ore` (raw), `copper_plate`, `iron_ore` (raw).
- `ItemOverride` is already imported. `useState` is NOT: add `import { useState } from "react";` the first time a snippet needs it.

Add this helper once, near the top of the file. It is not optional. `data-item-id` appears on picker tiles, on auto-rows, and (after Task 3) on override rows. The popup portals to `document.body`, and Testing Library appends its container to `document.body` first, so a bare `[data-item-id="X"]` query returns the ROW, not the tile: `.disabled` reads `undefined` and `.className` reads `"b-row"`, and a correct implementation fails the assertion.

```tsx
function pickerTile(itemId: string): HTMLButtonElement | null {
  return document.querySelector(
    `[data-testid="picker-tile"][data-item-id="${itemId}"]`,
  );
}
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: FAIL on five of the six. Four throw on `pickerTile(...)!` or assert against a dialog that never opens, because clicking a `<select>` opens nothing. The backdrop test is the fifth: `document.querySelector(".recipe-picker-backdrop")` is null pre-implementation, so the click throws.

Exactly one is not red-first, and that is fine: the Escape test ends by asserting `document.activeElement` is the clicked control, which is trivially true of a focused `<select>`. It exists to pin the focus contract once `closePicker` owns it, and it would catch a `closePicker` that forgot to refocus. Do not "fix" it into vacuity.

Indentation in the snippets above may not match Prettier's output. CI runs lint, typecheck, test and build, not `format`, so this will not fail the build - but run `bunx prettier --write test/components/InputsPanel.test.tsx` before committing anyway, and do the same in Tasks 4, 5 and 6, rather than leaving the whole formatting debt to Task 10.

- [x] **Step 3: Add the imports and picker state**

In `src/components/InputsPanel.tsx`, add to the imports:

```tsx
import { computeItemDepths } from "../data/recipe-depth";
import { ItemPickerPopup } from "./ItemPickerPopup";
```

`useRef` is already imported. Inside the component, after the `itemById` memo:

```tsx
  // Availability depth per item id, used by the picker popup to group tiles.
  // computeItemDepths seeds every pack item; ones no recipe can reach land in
  // the unranked bucket, which on the shipped pack is empty.
  const tierByItemId = useMemo(() => computeItemDepths(pack), [pack]);
  // Which row the picker popup is open for, plus the trigger button that
  // opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<{
    kind: "row";
    itemId: string;
  } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a committed swap unmounts its row),
    // so guard the focus.
    if (btn && document.contains(btn)) btn.focus();
  }
```

- [x] **Step 4: Tag override rows with their item id**

Auto-rows already carry `data-item-id`; override rows do not, so no selector can address one by item. Both the unit tests in Task 6 and the e2e selectors in Task 9 need it. Add to the override row's wrapping `div`, next to `data-testid="input-row"`:

```tsx
            data-item-id={row.itemId}
```

- [x] **Step 5: Replace the select with a trigger button**

In the override-row JSX, replace the whole `<span className="b-pick"><select ...>...</select></span>` block with:

```tsx
              <span className="b-pick">
                <button
                  type="button"
                  className="b-pick-trigger"
                  aria-label={i18n.t("inputs.item.label")}
                  aria-haspopup="dialog"
                  // title shows the full localised item name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(row.itemId)}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", itemId: row.itemId });
                  }}
                >
                  {i18n.displayName(row.itemId)}
                </button>
              </span>
```

- [x] **Step 6: Render the popup**

Immediately before the closing `</div>` of the `boundary-section` wrapper, after the `<button className="b-add">`:

```tsx
      {pickerFor !== null ? renderPicker() : null}
```

And add this function inside the component, after the `return (...)` block, mirroring how `TargetsPanel` places its own:

```tsx
  function renderPicker() {
    if (pickerFor === null) return null;
    const rowId = pickerFor.itemId;
    // Disable items the other override rows already claim; the row's own item
    // stays enabled and highlighted so re-picking it reads as a confirm.
    const disabledIds = new Set<string>(
      itemOverrides.filter((o) => o.itemId !== rowId).map((o) => o.itemId),
    );
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={rowId}
        tierByItemId={tierByItemId}
        onPick={(newId) => {
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row against itself and raise a false duplicate alert.
          if (newId !== rowId) handleItemChange(rowId, newId);
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
```

- [x] **Step 7: Run the tests to verify they pass**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: all six new tests PASS, and the rest of this file stays green.

This task does leave the repo red elsewhere, deliberately: `src/components/InputsPanel.test.tsx`'s UX-17 test reaches the item control through `getByRole("combobox")`, which no longer exists. That suite stays red from here until Task 8 retires it. Do not try to fix it inside this task.

- [x] **Step 8: Commit**

```bash
git add src/components/InputsPanel.tsx test/components/InputsPanel.test.tsx
git commit -m "Open the item picker from an input row trigger"
```

---

### Task 4: Restore focus after a committed swap

A committed swap unmounts the row, because rows are keyed by `itemId`, so `closePicker`'s refocus lands on a button the next commit removes and focus falls to `document.body`.

**Files:**
- Modify: `src/components/InputsPanel.tsx`
- Test: `test/components/InputsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 3's `pickerFor` and `closePicker`.
- Produces: a module-local type `PendingFocus = { itemId: string; kind: "rate" | "trigger" }` and a `pendingFocusRef` whose token each row's callback ref consumes only on a matching `kind`. Task 5 arms `kind: "rate"`.

- [x] **Step 1: Write the failing test**

Append to `test/components/InputsPanel.test.tsx`:

```tsx
it("a committed swap moves focus to the swapped row's trigger", async () => {
  const user = userEvent.setup();
  function Parent() {
    const [rows, setRows] = useState<ItemOverride[]>([{ itemId: "copper_ore" }]);
    return (
      <InputsPanel
          itemOverrides={rows}
          onChange={(update) => setRows((cur) => update(cur))}
          pack={fixturePack}
        />
    );
  }
  render(<Parent />);
  await user.click(screen.getAllByLabelText("物品")[0]!);
  await user.click(pickerTile("iron_ore")!);
  const trigger = screen.getAllByLabelText("物品")[0]!;
  // Assert the row identity by id, not by rendered text: displayName resolves
  // iron_ore to its localized name, which differs per locale.
  expect(trigger.closest("[data-item-id]")?.getAttribute("data-item-id")).toBe(
    "iron_ore",
  );
  expect(document.activeElement).toBe(trigger);
});
```

Follow the file conventions in Task 3 Step 1: `it(...)` not `test(...)`, no `LocaleProvider` wrapper (default locale `zh`), `pack={fixturePack}`. Use the `pickerTile` helper Task 3 declared; do not redeclare it. Add `import { useState } from "react";` if it is not there yet. Append inside the existing `describe("InputsPanel", ...)` block, so the suite does not end up split.

- [x] **Step 2: Run the test to verify it fails**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "committed swap"`
Expected: FAIL, `expected <body> to be <button>`.

- [x] **Step 3: Add the pending-focus token**

In `src/components/InputsPanel.tsx`, above the component:

```tsx
// A focus target armed by a pick and consumed on the commit that mounts the
// row. The kind matters: both consumers live on the same row and React
// attaches refs in tree order, so the trigger inside .info completes before
// the rate input inside .b-rate. A bare item id would let the trigger ref
// swallow every token and the add path's rate focus would never fire.
type PendingFocus = { itemId: string; kind: "rate" | "trigger" };
```

Inside the component, next to `triggerRef`:

```tsx
  // Armed by a pick, consumed by the matching row's callback ref on the next
  // commit. A stale token (the commit was rejected, or the panel is rendered
  // with an onChange that never feeds the prop back) is simply overwritten by
  // the next pick.
  const pendingFocus = useRef<PendingFocus | null>(null);
  function focusOnMount(
    el: HTMLElement | null,
    itemId: string,
    kind: PendingFocus["kind"],
  ) {
    const want = pendingFocus.current;
    if (!el || !want || want.itemId !== itemId || want.kind !== kind) return;
    pendingFocus.current = null;
    el.focus();
  }
```

- [x] **Step 4: Arm on swap and consume on the trigger**

In `renderPicker`'s `onPick`, change the swap branch:

```tsx
        onPick={(newId) => {
          if (newId !== rowId) {
            // The swap unmounts this row (rows are keyed by itemId), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            pendingFocus.current = { itemId: newId, kind: "trigger" };
            handleItemChange(rowId, newId);
          }
          closePicker();
        }}
```

Add the callback ref to the trigger button from Task 3:

```tsx
                  ref={(el) => focusOnMount(el, row.itemId, "trigger")}
```

- [x] **Step 5: Run the test to verify it passes**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "committed swap"`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/components/InputsPanel.tsx test/components/InputsPanel.test.tsx
git commit -m "Restore focus to the swapped input row's trigger"
```

---

### Task 5: Add opens the picker

**Files:**
- Modify: `src/components/InputsPanel.tsx`
- Modify: `src/data/i18n.ts`
- Test: `test/components/InputsPanel.test.tsx`

**Interfaces:**
- Consumes: Tasks 1, 3 and 4.
- Produces: `pickerFor` widens to `{ kind: "row"; itemId: string } | { kind: "add" }`. Two new i18n keys, `inputs.picker.listed` and `inputs.add.exhausted`.

- [x] **Step 1: Write the failing tests**

In `test/components/InputsPanel.test.tsx`, replace the existing add-button test (the one asserting `onChange` fires once with the first-unused item) with:

```tsx
it("Add opens the picker and commits nothing until a pick", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />
  );
  await user.click(screen.getByText(TEXT_ADD));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("picker-hint")).not.toBeNull();
  // The auto-row item already has a row, so its tile is dimmed here.
  expect(
    (pickerTile("copper_ore") as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("a pick from the Add picker appends an uncapped override", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />
  );
  await user.click(screen.getByText(TEXT_ADD));
  await user.click(pickerTile("iron_ore")!);
  expect(onChange).toHaveBeenCalledTimes(1);
  const updater = onChange.mock.calls[0]![0] as (
    c: ItemOverride[],
  ) => ItemOverride[];
  expect(updater([])).toEqual([{ itemId: "iron_ore" }]);
  // Racing a prop update that already inserted the row is a no-op.
  expect(updater([{ itemId: "iron_ore" }])).toEqual([{ itemId: "iron_ore" }]);
});

it("a pick from the Add picker focuses the new row's rate input", async () => {
  const user = userEvent.setup();
  function Parent() {
    const [rows, setRows] = useState<ItemOverride[]>([]);
    return (
      <InputsPanel
          itemOverrides={rows}
          onChange={(update) => setRows((cur) => update(cur))}
          pack={fixturePack}
        />
    );
  }
  render(<Parent />);
  await user.click(screen.getByText(TEXT_ADD));
  await user.click(pickerTile("iron_ore")!);
  const rateInput = screen.getAllByLabelText("速率")[0]!;
  expect(document.activeElement).toBe(rateInput);
});

it("the Add button is aria-disabled and inert when every item is claimed", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const all = fixturePack.items.map((i) => ({ itemId: i.id }));
  render(
    <InputsPanel itemOverrides={all} onChange={onChange} pack={fixturePack} />
  );
  const add = screen.getByText(TEXT_ADD);
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await user.click(add);
  expect(screen.queryByTestId("picker-tile")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
```

Use the `pickerTile` helper Task 3 declared; do not redeclare it, or `bun run typecheck` fails on a duplicate implementation. Append inside the existing `describe("InputsPanel", ...)` block.

Also delete the fixture comment above `fixturePack` that this task falsifies: "items intentionally out of lex order in the array so the 'first unused (sorted lex)' picker has something to do". There is no first-unused pick any more.

Define `TEXT_ADD` near the top of the file from the exact `inputs.add` zh string in `src/data/i18n.ts`; read it out of the file rather than guessing. The rate query is `getAllByLabelText("速率")`, as the rest of this suite already uses.

- [x] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: FAIL on all four new tests. The first fails because Add still commits immediately.

- [x] **Step 3: Add the two i18n keys**

In `src/data/i18n.ts`, add to the `UiKey` union next to the other `inputs.` keys:

```ts
  | "inputs.add.exhausted"
  | "inputs.picker.listed"
```

Then add to each of the four locale records, next to their `inputs.add` entry:

```ts
    // zh
    "inputs.add.exhausted": "所有物品均已添加",
    "inputs.picker.listed": "灰显的物品已在面板中 — 请直接编辑对应行",
    // en
    "inputs.add.exhausted": "All items already have a row",
    "inputs.picker.listed":
      "Dimmed items already have a row in the panel — edit that row instead",
    // ja
    "inputs.add.exhausted": "すべてのアイテムが既に追加されています",
    "inputs.picker.listed":
      "グレー表示のアイテムは既にパネルにあります — 対応する行を直接編集してください",
    // ru
    "inputs.add.exhausted": "Все предметы уже объявлены",
    "inputs.picker.listed":
      "Затемнённые предметы уже есть в панели — редактируйте их строки",
```

- [x] **Step 4: Widen `pickerFor` and rewrite `handleAdd`**

In `src/components/InputsPanel.tsx`, widen the state type:

```tsx
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; itemId: string } | { kind: "add" } | null
  >(null);
```

Replace `handleAdd` entirely (its first-unused-id scan goes):

```tsx
  function handleAdd(e: MouseEvent<HTMLButtonElement>) {
    if (addExhausted) return;
    triggerRef.current = e.currentTarget;
    setPickerFor({ kind: "add" });
  }
```

Add `import type { MouseEvent } from "react";` and write the parameter as `e: MouseEvent<HTMLButtonElement>`. Do not write `React.MouseEvent`: `tsconfig.json` sets `verbatimModuleSyntax`, and no file under `src/` uses the `React.` namespace.

Above the `return`, next to the existing `autoRows` computation:

```tsx
  // Every item already has a row, so the picker would open on an all-dimmed
  // grid. Unreachable on the shipped pack, but a hand-crafted plan can carry
  // one override per item. Derived from the last completed render (autoRows
  // comes from realized demand), so it lags an in-flight solve; that is
  // harmless for a guard.
  const addExhausted =
    displayedInputCount(itemOverrides, assumedRawItemIds) === pack.items.length;
```

- [x] **Step 5: Make the Add button inert rather than disabled**

Replace the add button:

```tsx
      <button
        className="b-add"
        onClick={handleAdd}
        // aria-disabled, not disabled: a disabled button is not focusable, so
        // keyboard and screen-reader users would never reach the title that
        // explains why it does nothing.
        aria-disabled={addExhausted ? true : undefined}
        title={addExhausted ? i18n.t("inputs.add.exhausted") : undefined}
      >
        {i18n.t("inputs.add")}
      </button>
```

- [x] **Step 6: Branch `renderPicker` on the entry point**

Replace `renderPicker` from Task 3:

```tsx
  function renderPicker() {
    if (pickerFor === null) return null;
    if (pickerFor.kind === "add") {
      // Everything with a visible row is dimmed: the explicit overrides plus
      // the auto-rows. Picking an auto-row item would append a bare override,
      // which for a raw item leaves effectiveSupply at Infinity either way -
      // a full re-solve and hash rewrite that changes nothing, and a row that
      // jumps from the auto block to the end of the override block. Capping
      // one stays what it is today: type into its auto-row.
      const disabledIds = new Set<string>([
        ...itemOverrides.map((o) => o.itemId),
        ...(assumedRawItemIds ?? []),
      ]);
      return (
        <ItemPickerPopup
          items={pack.items}
          disabledIds={disabledIds}
          tierByItemId={tierByItemId}
          disabledHint={i18n.t("inputs.picker.listed")}
          onPick={(newId) => {
            // The row mounts on a later commit, so hand its rate input the
            // focus: it is the only edit that makes the new row do anything.
            pendingFocus.current = { itemId: newId, kind: "rate" };
            onChange((current) =>
              current.some((o) => o.itemId === newId)
                ? current
                : [...current, { itemId: newId }],
            );
            closePicker();
          }}
          onClose={closePicker}
        />
      );
    }
    const rowId = pickerFor.itemId;
    // Only the other override rows are disabled here. Auto-row items stay
    // enabled: for a capped row handleItemChange carries the rate onto the
    // new item, so this is a live cap move, and blocking it would force a
    // delete-and-retype.
    const disabledIds = new Set<string>(
      itemOverrides.filter((o) => o.itemId !== rowId).map((o) => o.itemId),
    );
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={rowId}
        tierByItemId={tierByItemId}
        onPick={(newId) => {
          if (newId !== rowId) {
            pendingFocus.current = { itemId: newId, kind: "trigger" };
            handleItemChange(rowId, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
```

- [x] **Step 7: Consume the rate token on the rate input**

Add the callback ref to the override row's rate `<input>`:

```tsx
                ref={(el) => focusOnMount(el, row.itemId, "rate")}
```

- [x] **Step 8: Run the tests to verify they pass**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: the four new tests PASS.

- [x] **Step 9: Add the aria-disabled CSS**

In `src/canvas/canvas.css`, extend the scoped disabled rule's selector and guard both hover rules. Specificity is the whole point here: a generic `.ak-app-shell button[aria-disabled="true"]` is (0,2,1) and loses to the base `.ak-app-shell [data-testid="side-panel"] .b-add` at (0,3,0), so the button would keep `cursor: pointer`.

```css
.ak-app-shell [data-testid="side-panel"] .b-add:hover:not([aria-disabled="true"]) {
  background: rgba(203, 255, 64, 0.08);
  border-color: var(--ak-accent-lime);
  color: var(--ak-accent-lime-bright);
  box-shadow: 0 0 22px rgba(203, 255, 64, 0.12);
}
.ak-app-shell [data-testid="side-panel"] .b-add:disabled,
.ak-app-shell [data-testid="side-panel"] .b-add[aria-disabled="true"] {
  opacity: 0.35;
  cursor: not-allowed;
  box-shadow: none;
}
```

And guard the generic hover rule, which is (0,3,1) and would otherwise outrank the base `.b-add` rule once the scoped hover stops matching, repainting the inert button's face solid:

```css
.ak-app-shell button:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--ak-bg-tertiary);
  border-color: var(--ak-divider-strong);
}
```

Nothing else in the app sets `aria-disabled`, so the guard has no other effect.

- [x] **Step 10: Commit**

```bash
git add src/components/InputsPanel.tsx src/data/i18n.ts src/canvas/canvas.css test/components/InputsPanel.test.tsx
git commit -m "Open the item picker from the Add input button"
```

---

### Task 6: Name the focused rate input for screen readers

Focus now lands silently on an input whose accessible name is the generic rate label, identical on every row.

**Files:**
- Modify: `src/components/InputsPanel.tsx`
- Test: `test/components/InputsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 5.
- Produces: every rate input, on both row kinds, carries `aria-describedby` referencing `i-name-${itemId}`, joined with `i-rate-err-${itemId}` when the row is invalid.

- [x] **Step 1: Write the failing test**

Append to `test/components/InputsPanel.test.tsx`:

```tsx
it("rate inputs are described by their row's item name", () => {
  render(
    <InputsPanel
        itemOverrides={[{ itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />
  );
  for (const itemId of ["copper_ore", "iron_ore"]) {
    const nameEl = document.getElementById(`i-name-${itemId}`);
    expect(nameEl).not.toBeNull();
    const row = document.querySelector(`[data-item-id="${itemId}"]`);
    const input = row!.querySelector("input")!;
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(
      `i-name-${itemId}`,
    );
  }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "described by"`
Expected: FAIL, `expected null not to be null`.

- [x] **Step 3: Add the name nodes**

The id must sit on a dedicated node, never on the trigger button: a description resolves to the referenced element's accessible name, and the trigger's `aria-label` is the generic item label, so pointing at the button would announce "Rate, edit, Item".

Override row trigger, wrap the visible text:

```tsx
                  <span id={`i-name-${row.itemId}`}>
                    {i18n.displayName(row.itemId)}
                  </span>
```

Auto row, add the id to the existing `.b-name` span:

```tsx
              <span
                className="b-name"
                id={`i-name-${itemId}`}
                title={i18n.displayName(itemId)}
                data-testid="input-auto-name"
              >
```

- [x] **Step 4: Point both rate inputs at them**

Add a helper inside the component:

```tsx
  // The row's item name plus, when present, the invalid-rate message. The
  // name is a description rather than a label so the accessible NAME stays
  // the generic rate label every existing query resolves by.
  function rateDescribedBy(itemId: string): string {
    const ids = [`i-name-${itemId}`];
    if (invalidIds.has(itemId)) ids.push(`i-rate-err-${itemId}`);
    return ids.join(" ");
  }
```

Replace the `aria-describedby` expression on both the auto-row input and the override-row input with `aria-describedby={rateDescribedBy(itemId)}` and `aria-describedby={rateDescribedBy(row.itemId)}` respectively.

- [x] **Step 5: Run the test to verify it passes**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "described by"`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/components/InputsPanel.tsx test/components/InputsPanel.test.tsx
git commit -m "Describe input rate fields by their row's item name"
```

---

### Task 7: Remove the dead select code and comments

**Files:**
- Modify: `src/components/InputsPanel.tsx`
- Modify: `src/components/ItemPickerPopup.tsx`
- Modify: `src/canvas/canvas.css`

**Interfaces:**
- Consumes: Tasks 3 and 5.
- Produces: no behavior change. The section-head denominator reads `pack.items.length`.

- [x] **Step 1: Delete the sortedItems and collator memos**

In `src/components/InputsPanel.tsx`, delete the `collator` and `sortedItems` `useMemo` blocks and their comments. Their last consumer was the option list and `handleAdd`, both gone. Replace the section-head denominator `{sortedItems.length}` with `{pack.items.length}`. Drop the now-unused `Intl.Collator` reference.

- [x] **Step 2: Delete the dead CSS and rewrite the comment**

In `src/canvas/canvas.css`, delete the `.b-pick select` face, hover, focus, focus-visible and `select option` rules. The locale switcher is the app's only other `<select>` and is styled through `.ak-app-shell select` and `.ak-app-shell .topbar select`, so nothing else depends on them.

Rewrite the block comment above them, and keep it short: `.b-pick-trigger` already ships its own comment further down the file, added for `TargetsPanel`, which says the trigger is a bare button that opens the popup. Do not restate that. What this comment must still document `.b-pick` as the row's name-surface slot in the fixed row layout, the persistent caret as the touch and discoverability affordance, and why the caret stays minimal instead of reinstating a boxed select. What goes is the `color-scheme: dark` sentence and the justification of the native select. Record honestly that the popup only partly replaces it:

```css
/* The picker is the row's name surface itself. The row layout is fixed: icon,
   product-name, item-id, rate, and a remove control. A small persistent caret
   at the right edge of the product-name slot marks the affordance for touch
   and for first-impression discoverability, without bringing back the
   boxed-select redundancy an earlier pass had. Moving off a native <select>
   costs the platform's
   keyboard nav, type-ahead, IME composition and mobile native picker; the
   dialog's search box replaces finding an item by name, but it has no focus
   trap, no arrow-key grid navigation, and no type-ahead outside that field,
   so Tab walks every tile and then leaves the dialog. */
```

- [x] **Step 3: Rewrite the two stale popup prop comments**

In `src/components/ItemPickerPopup.tsx`, the `items` comment says "Already-filtered producible items", which the input picker violates by passing all of `pack.items`, and the `disabledIds` comment is written in terms of targets and drafts:

```tsx
  // The pickable catalogue. The caller decides what belongs here: targets pass
  // only producible items, inputs pass the whole pack.
  items: Item[];
  // Items the caller has already spoken for. Their tiles render disabled so a
  // duplicate cannot be picked, rather than surfacing a post-hoc error. What
  // counts as spoken for is the caller's business; disabledHint is how it
  // explains a reason the grid cannot show.
  disabledIds: ReadonlySet<string>;
```

- [x] **Step 4: Verify nothing regressed**

Run: `bun run typecheck && bun run lint && bun run test -- src/components test/components`
Expected: typecheck and lint clean. Test failures at this point should only be in `src/components/InputsPanel.test.tsx`, which Task 8 handles.

- [x] **Step 5: Commit**

```bash
git add src/components/InputsPanel.tsx src/components/ItemPickerPopup.tsx src/canvas/canvas.css
git commit -m "Remove the input row select and refresh its stale comments"
```

---

### Task 8: Retire the UX-17 option-order test

**Files:**
- Modify: `src/components/InputsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 7.
- Produces: nothing.

- [x] **Step 1: Delete the test**

Delete the whole `test("item picker options are sorted by localized display name, not id", ...)` block from `src/components/InputsPanel.test.tsx`. It asserts the global option sequence is collator-sorted across all 113 items by walking `querySelectorAll("option")`. The popup buckets by tier and sorts only within a bucket, so the global guarantee no longer holds and the test cannot be retargeted mechanically. Task 2 moved the surviving guarantee into `ItemPickerPopup.test.tsx`.

- [x] **Step 2: Remove the import the deletion orphans**

`import { pack as realPack } from "../data/load";` had the deleted test as its only consumer. Leaving it fails `bun run lint` under `@typescript-eslint/no-unused-vars`. Delete it, along with any other binding that test was alone in using.

- [x] **Step 3: Fix any other combobox reference in the file**

Search the file for `getByRole("combobox")` and `querySelectorAll("option")`. Any remaining use belongs to the deleted test; if another test uses them, rewrite it to click the row trigger and then a `[data-item-id]` tile, following Task 3's pattern.

- [x] **Step 4: Run the suite**

Run: `bun run test -- src/components/InputsPanel.test.tsx`
Expected: PASS, whole file.

- [x] **Step 5: Run every vitest suite**

Run: `bun run test`
Expected: PASS. `test/integration/inputs-panel-shell.test.tsx` must pass untouched; if it fails, something in Tasks 3 to 7 changed the rate control, which is out of scope.

- [x] **Step 6: Commit**

```bash
git add src/components/InputsPanel.test.tsx
git commit -m "Retire the input select option-order test"
```

---

### Task 9: Rewrite the Playwright suite

Six tests, in file order. Two are replaced, one is restructured, three keep their assertions and gain a popup step.

**Files:**
- Modify: `test/e2e/inputs-panel.spec.ts`

**Interfaces:**
- Consumes: Tasks 3 to 7.
- Produces: nothing.

- [x] **Step 1: Add a pick helper and delete the dead constants**

Delete the four-line comment above the lex constants along with them; it explains a pinning that no longer exists.

Every tile locator MUST be scoped to `.recipe-picker`. `data-item-id` is on picker tiles, on canvas ProductNodes (`src/canvas/ProductNode.tsx`), on auto-rows, and now on override rows. `copper_powder` and `iron_powder` are default targets, so their canvas nodes exist in every default-plan test before the picker even opens; an unscoped locator matches two or more elements and Playwright fails with a strict-mode violation rather than a useful assertion error.

```ts
// Add now opens the picker instead of committing a row, so every "add a row"
// preamble is two steps: click Add, then click the item's tile. The locator is
// scoped to the dialog because data-item-id is also on canvas nodes and rows.
async function addInputRow(page: Page, itemId: string): Promise<void> {
  await clickAddInput(page);
  await page.locator(`.recipe-picker [data-item-id="${itemId}"]`).click();
}
```

`Page` is already imported. Delete `FIRST_LEX_ITEM_ID` (used by Tests 1 and 3), and `SECOND_LEX_ITEM_ID`, `TEXT.duplicateAlert` and `COMMIT_DEBOUNCE_MS` (used by Test 3 alone). `COMMIT_DEBOUNCE_MS`'s comment already describes a debounce the app no longer has.

Item ids in this file are from the real pack, not the unit fixture. Raw items are `originium_ore, quartz_sand, iron_ore, copper_ore, gas_xiranite, liquid_water, liquid_acid, gas_inert, domain_key_tundra`; everything else is non-raw. There is no `copper_plate`.

- [x] **Step 2: Replace Test 1's body and title**

The old title, "Add input row defaults to first unused itemId (lex-sorted)", describes behavior that no longer exists. Retitle it "Add opens the picker and a pick appends an uncapped override". Keep the test's existing preamble (`attachConsoleListener`, `page.goto`, `waitForCanvasReady`, `waitForInputsPanel`, `const initialCount = ...`) and its trailing `await expectNoConsoleErrors(log)`. Replace only what sits between them:

```ts
    await clickAddInput(page);
    // No row yet: the picker is open and nothing has been committed.
    await expect(inputRows(page)).toHaveCount(initialCount);
    await expect(page.locator(".recipe-picker")).toBeVisible();
    const urlBefore = page.url();

    await page.locator('.recipe-picker [data-item-id="copper_powder"]').click();
    await expect(inputRows(page)).toHaveCount(initialCount + 1);
    // Pin the identity of the committed row, not merely that some row appeared.
    await expect(
      page.locator('[data-testid="input-row"][data-item-id="copper_powder"]'),
    ).toHaveCount(1);
    // An uncapped override: the rate field is empty.
    await expect(inputRows(page).nth(initialCount).locator("input")).toHaveValue(
      "",
    );
    // The hash is rewritten after the solve settles, so poll rather than read.
    await expect.poll(() => page.url(), { timeout: 5_000 }).not.toBe(urlBefore);
```

- [x] **Step 3: Replace Test 3's body and title**

Retitle from "Duplicate-guard surfaces error and does not propagate" to "A claimed item's tile is disabled in the picker". Same rule: keep the preamble and the trailing `expectNoConsoleErrors`. The old test drove a duplicate through `selectOption` and asserted the per-row alert. That pick is impossible now, so assert the tile is dimmed instead. Note the two rows use **different** items: once `copper_powder` has a row its tile is disabled, so a second `addInputRow` for the same id would time out on Playwright's actionability check.

```ts
    await addInputRow(page, "copper_powder");
    await addInputRow(page, "iron_powder");
    await expect(inputRows(page)).toHaveCount(initialCount + 2);

    // Open the picker from the second row: the item the first row claims is
    // dimmed, so a duplicate cannot be picked at all.
    const secondRow = inputRows(page).nth(initialCount + 1);
    await secondRow.getByRole("button", { name: TEXT.itemLabel }).click();
    await expect(
      page.locator('.recipe-picker [data-item-id="copper_powder"]'),
    ).toBeDisabled();
    // The row's own item stays enabled, as a confirm.
    await expect(
      page.locator('.recipe-picker [data-item-id="iron_powder"]'),
    ).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(page.locator(".recipe-picker")).toHaveCount(0);
```

- [x] **Step 4: Restructure Test 5**

Test 5 is "cap exceeding demand commits cleanly with no error banner". It caps `copper_ore`, which is raw and consumed by the default plan, so it is an auto-row and its tile is dimmed in the Add picker. Drive the auto-row typing path instead.

Same rule as Steps 2 and 3: keep the preamble and the trailing `expectNoConsoleErrors(log)`, replace what sits between. That deletes `await clickAddInput(page)`, the `const newRow = ...` binding and the `select` / `selectOption` pair. **Keep** the existing `copperOreInput` ProductNode assertion that follows: the item still crosses the boundary with a cap, so its input node must still render, and dropping the assertion would quietly narrow what this test proves.

Three things must be preserved. Keep the cap value `9999`: the test's whole premise is a cap **above** demand, and the default plan needs roughly 270 copper_ore/min, so a smaller number can produce an infeasible solve and the very error banner the test asserts is absent. Keep the `headerErrors` count-0 assertion. And re-capture a URL baseline before the fill, since the old `urlAfterItem` was captured after a `selectOption` that no longer happens.

```ts
    const autoRow = page.locator(
      '[data-testid="input-auto-row"][data-item-id="copper_ore"]',
    );
    await expect(autoRow).toHaveCount(1);

    const urlBeforeCap = page.url();
    const rateInput = autoRow.getByRole("textbox", { name: TEXT.rateLabel });
    await rateInput.fill("9999");
    // fill() does not blur, and the panel commits only on blur or Enter.
    await rateInput.press("Enter");

    // Typing a cap promotes the auto-row into a real override row.
    await expect(
      page.locator('[data-testid="input-row"][data-item-id="copper_ore"]'),
    ).toHaveCount(1);
    await expect
      .poll(() => page.url(), { timeout: 5_000 })
      .not.toBe(urlBeforeCap);
```

Delete `const initialCount = await inputRows(page).count();` from this test: its only consumer was the `nth(initialCount)` locator, and an unused binding fails `bun run lint`.

- [x] **Step 5: Re-preamble Tests 2, 4 and 6**

These keep their assertions. In each, the two lines

```ts
    const select = newRow.getByRole("combobox", { name: TEXT.itemLabel });
    await select.selectOption("copper_powder");
```

are deleted, and `await clickAddInput(page);` becomes `await addInputRow(page, "copper_powder");`. **Keep** the `const newRow = inputRows(page).nth(initialCount);` binding: the surviving `rateInput` lines below it depend on it.

Test 2 is the exception: it calls `clickAddInput` twice and asserts `toHaveCount(initialCount + 2)`. It needs two `addInputRow` calls with two **different** non-raw items, because the first pick disables its own tile:

```ts
    await addInputRow(page, "copper_powder");
    await addInputRow(page, "iron_powder");
```

Test 2 has neither a `select` nor a `newRow` binding to begin with: it only calls `clickAddInput` twice and then removes `nth(initialCount)`. That removal locator is still correct (it is the `copper_powder` row), so nothing after the preamble needs changing.

Add `await rateInput.press("Enter");` after **every** `rateInput.fill(...)` in Tests 4 and 6. Test 4 fills **twice** - once with `"30"` to cap, and again with `""` to uncap - and each fill is followed by its own URL poll, so one Enter press fixes only the first half and the test still times out on the second. Test 6 fills once.

`fill()` sets the value and fires `input`, but never blurs, and `InputsPanel` commits only on blur or Enter. Without this the URL poll that follows has nothing to wait for. If these tests were in your Task 0 baseline as failing, this is likely why.

- [x] **Step 6: Format**

Run: `bunx prettier --write test/e2e/inputs-panel.spec.ts`

- [x] **Step 7: Run the suite**

Run: `bun run test:e2e -- inputs-panel`
Expected: no test fails that was passing in the Task 0 baseline.

Match by position, not by name: Tests 1 and 3 were retitled in Steps 2 and 3, so their baseline rows have no counterpart and they are exempt from the gate. Tests 2, 4, 5 and 6 keep their titles and are the ones the gate covers. Tests 4 and 6 may move from failing to passing once the Enter press lands; that is an improvement, not a regression to investigate.

> **Deviation, found by running Step 7.** Adding the Enter press made Tests 4 and 6
> commit their rate for the first time, and both then failed: with a finite cap on
> `copper_powder` no `inputProduct` node renders at all. A probe over the seeded
> plan pinned the mechanism:
>
> | copper_powder override | nodes emitted |
> | --- | --- |
> | uncapped | `u:in:copper_powder`, `u:in:copper_powder:target`, `u:out:copper_powder` |
> | cap 6/min | none (solver runs `loop:copper_powder` instead) |
> | cap 30/min | none (same) |
> | cap 120/min | `u:in:copper_powder`, `u:out:copper_powder` |
>
> The mechanism is a route switch in the LP, not a render threshold. Unlimited
> supply is a structural fork: `effectiveSupply === Infinity` drops the item's
> mass-balance row and stops producer expansion, which makes the `liquid_copper`
> recipe that consumes copper_powder the cheap route. Any finite cap restores that
> row and the producer chain, the LP switches to `phase_trans_1-liquid_copper`
> (which consumes no copper_powder), and nothing in-graph consumes the item, so no
> boundary input node is emitted. The `u:in:<item>:target` passthrough is also
> hard-gated on infinite supply. So both tests had been asserting the UNCAPPED
> shape all along while their comments claimed a below-demand cap.
>
> Out-of-scope observation, not fixed here: in the capped cases the LP still
> reports a nonzero `draws` entry for copper_powder that never reaches the canvas.
> At cap 1/2 the output node claims 1/2 with no incoming edges at all. The finite-
> supply exclusion on the target passthrough is where that draw is dropped. Fixed by matching each test to the shape it needs:
> Test 4's cap goes 30 -> 120/min (a cap the solver satisfies by importing), and
> Test 6 drops the rate fill entirely and asserts the dual emission on the uncapped
> override, which is the only state that emits the `:target` passthrough it checks.
>
> Result: 6 passed, 0 failed, against a 2-passed / 4-failed baseline.

- [x] **Step 8: Commit**

```bash
git add test/e2e/inputs-panel.spec.ts
git commit -m "Drive the input panel e2e suite through the item picker"
```

---

### Task 10: Full verification and visual check

**Files:** none modified unless a gate fails.

- [x] **Step 1: Run every gate**

```bash
bun run typecheck && bun run lint && bun run test && bun run test:e2e
```

`bun run format` is deliberately NOT in this chain. It is `prettier --check .` over the whole repo, it already fails on the untouched tree (198 files, including files this branch never touches), and an `&&` chain would abort there and never reach `test` or `test:e2e` - the two checks this step exists for. Format the files you touched with `bunx prettier --write` instead, as each task instructs.

Expected: typecheck, lint and test clean.

For e2e this runs the whole Playwright suite, which is wider than the Task 0 baseline. Two different rules apply. Inside `inputs-panel.spec.ts`, compare against the Task 0 baseline: no test that was passing there may fail now, and Tests 1 and 3 are exempt because they were retitled, so match by position. Outside it, the Task 0 baseline has no rows at all; this repo carries known pre-existing failures in other specs, so judge those against `origin/develop` before attributing anything to this branch.

- [x] **Step 2: Visual check in the browser**

Run `bun run dev`, open the app, and confirm by looking, not by presence:

- A row's name line still reads as a heading with the caret at its right edge, not as a boxed control.
- Clicking it opens the picker with that item highlighted and the sibling rows' items dimmed. No hint line here.
- Add opens the picker with a hint line under the search box and every already-listed item dimmed, including the raw auto-rows.
- Picking from Add appends a row and the caret cursor lands in its rate field.
- Picking a different item from a row swaps it and the focus ring is on the swapped row's trigger.
- Escape and a backdrop click both return the focus ring to the trigger that opened the picker.
- Long names truncate with an ellipsis and show the full name on hover.

> **Gate results.** `typecheck` clean, `lint` clean, `test` 1450 passed / 1 skipped
> across 134 files.
>
> `test:e2e -- inputs-panel`: 6 passed, 0 failed, against a 2-passed / 4-failed
> Task 0 baseline. Every gated test (2 and 6) still passes; 1, 3, 4 and 5 all moved
> from failing to passing.
>
> Full `test:e2e`: 12 failures on the first run, 2 on the second. The 10 that
> vanished were `placement-shots`, whose screenshot baselines are gitignored and so
> were absent in a fresh worktree; the first run writes them. The 2 that remain,
> `geometry-audit multi6` and `raw-and-transport override copper_ore plan:true`,
> reproduce identically on a detached `origin/develop` worktree, so they are
> inherited, not caused here. No spec outside `inputs-panel.spec.ts` touches the
> inputs panel controls at all (no `combobox`, `selectOption`, `b-pick` or
> `input-row` reference anywhere else under `test/e2e/`).
>
> **Step 2 evidence.** Driven through Playwright with programmatic focus readback
> plus screenshots, since this session has no interactive browser. Captures kept in
> `.artifacts/shots/` (gitignored).
>
> - Resting panel: the row name reads as a heading with the cyan caret at the right
>   edge of the name slot, no box. The section-head denominator reads `113`, from
>   `pack.items.length`.
> - Row picker: own item outlined lime as selected, sibling row's item dimmed, no
>   hint line (`hintCount=0`).
> - Add picker: hint line renders under the search box and stays anchored there
>   when the grid scrolls or filters; exactly the 3 auto-row items
>   (`copper_ore`, `iron_ore`, `liquid_water`) are dimmed out of 113 tiles.
> - Pick from Add: row appended and focus lands on its rate input
>   (`{tag: INPUT, label: 速率, row: copper_powder}`).
> - Swap from a row: focus lands on the swapped row's trigger
>   (`{tag: BUTTON, cls: b-pick-trigger, row: iron_powder}`).
> - Escape and backdrop click: focus returns to the trigger that opened the picker
>   in both cases. No focus RING is painted, because `:focus-visible` does not match
>   a mouse-opened dialog; that is the pre-existing `.b-pick-trigger` rule and
>   applies to the targets panel identically.
> - Truncation: no name in the shipped zh pack overflows the trigger even at a
>   1100px viewport, so the real pack never exercises it. Forcing a 31-character
>   name confirms the rule works: `scrollWidth 455 vs clientWidth 166`,
>   `overflow: hidden`, `text-overflow: ellipsis`, and the caret stays visible.
>   `title` carries the full name.
> - `addExhausted` is false on the default plan (`aria-disabled` absent), as
>   expected at 4 of 113 items.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in verification"
```

## Self-review notes

Spec coverage: ruling 1 is Task 3 and 5 (`items: pack.items` at both sites); ruling 2 is Task 5; ruling 3 is Task 5's two `disabledIds` sets; ruling 4 is Task 3's `tierByItemId`. Trigger and focus is Tasks 3, 4, 5 and 6. Picker state is Task 5. Commit ordering needs no code: the blur-first behavior falls out of the existing `onBlur` handler and is asserted indirectly by Task 9's Test 5. CSS is Tasks 1, 5 and 7. Other cleanup is Task 7. Testing is Tasks 2, 3, 5, 6, 8 and 9.

Names used consistently across tasks: `pickerFor`, `triggerRef`, `closePicker`, `pendingFocus`, `focusOnMount`, `rateDescribedBy`, `addExhausted`, `renderPicker`, `PendingFocus`, `i-name-${itemId}`, `inputs.picker.listed`, `inputs.add.exhausted`, `disabledHint`, `recipe-picker-hint`, `picker-hint`, `addInputRow`.
