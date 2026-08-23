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
- Verification commands: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:e2e`.

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

### Task 1: `ItemPickerPopup` gains `disabledHint`

**Files:**
- Modify: `src/components/ItemPickerPopup.tsx`
- Modify: `src/canvas/canvas.css` (new rule after `.recipe-picker-search:focus`)
- Test: `src/components/ItemPickerPopup.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `ItemPickerPopup` accepts `disabledHint?: string`. When set, the dialog renders `<div className="recipe-picker-hint" data-testid="picker-hint">{disabledHint}</div>` between the search input and `.recipe-picker-body`. When absent, no such element exists.

- [ ] **Step 1: Write the failing tests**

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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: FAIL, both new tests, `Unable to find an element by: [data-testid="picker-hint"]`.

- [ ] **Step 3: Add the prop and render the line**

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

- [ ] **Step 4: Add the CSS rule**

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

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: PASS, all tests in the file.

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: Fix the fixture so the assertion can fail**

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

- [ ] **Step 2: Write the failing test**

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

- [ ] **Step 3: Run the whole file to verify the fixture change did not break the existing tests**

Run: `bun run test -- src/components/ItemPickerPopup.test.tsx`
Expected: PASS. The new test passes immediately because the popup already sorts; the point of Step 1 is that it would now fail if the sort were removed. If any pre-existing test in the file fails, it was asserting against the old fixture ids: update its expected ids to the new fixture rather than reverting the fixture.

- [ ] **Step 4: Verify the test is load-bearing**

Temporarily delete the `.sort(...)` call inside the `groups` memo in `src/components/ItemPickerPopup.tsx` (the inner one applied to `group`, not the outer `.sort((a, b) => a.tier - b.tier)`), re-run the file, confirm the new test FAILS, then restore the sort and re-run to confirm PASS.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Write the failing tests**

In `test/components/InputsPanel.test.tsx`, replace the existing duplicate-selection test (the one calling `user.selectOptions(selects[1]!, "copper_ore")` and asserting `getByRole("alert")`) with:

```tsx
test("a row trigger opens the picker with siblings disabled and its own item selected", async () => {
  const user = userEvent.setup();
  render(
    <LocaleProvider locale="zh">
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }, { itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
      />
    </LocaleProvider>,
  );
  const triggers = screen.getAllByLabelText("物品");
  await user.click(triggers[0]!);
  const own = document.querySelector('[data-item-id="copper_ore"]');
  const sibling = document.querySelector('[data-item-id="iron_ore"]');
  expect(own).not.toBeNull();
  expect((own as HTMLButtonElement).disabled).toBe(false);
  expect(own!.className).toContain("selected");
  expect((sibling as HTMLButtonElement).disabled).toBe(true);
});

test("picking a different item swaps the row and keeps its rate", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="zh">
      <InputsPanel
        itemOverrides={[
          { itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } },
        ]}
        onChange={onChange}
        pack={fixturePack}
      />
    </LocaleProvider>,
  );
  await user.click(screen.getAllByLabelText("物品")[0]!);
  await user.click(document.querySelector('[data-item-id="iron_ore"]')!);
  expect(onChange).toHaveBeenCalledTimes(1);
  const updater = onChange.mock.calls[0]![0] as (
    c: ItemOverride[],
  ) => ItemOverride[];
  expect(updater([{ itemId: "copper_ore", ratePerSec: { num: "1", denom: "2" } }]))
    .toEqual([{ itemId: "iron_ore", ratePerSec: { num: "1", denom: "2" } }]);
});

test("re-picking the row's own item commits nothing and raises no alert", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="zh">
      <InputsPanel
        itemOverrides={[{ itemId: "copper_ore" }]}
        onChange={onChange}
        pack={fixturePack}
      />
    </LocaleProvider>,
  );
  await user.click(screen.getAllByLabelText("物品")[0]!);
  await user.click(document.querySelector('[data-item-id="copper_ore"]')!);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByTestId("picker-tile")).toBeNull();
});
```

Conventions in this file, which the snippets above must follow: it uses `describe` / `it`, not bare `test`; it renders `<InputsPanel />` with no `LocaleProvider`, so the default `zh` locale applies and `getAllByLabelText("物品")` is the item query; and its fixture pack is `fixturePack`, whose items are `zinc`, `copper_ore` (raw), `copper_plate`, `iron_ore` (raw). Rewrite each snippet accordingly: `it(...)`, no provider wrapper, `pack={fixturePack}`. `ItemOverride` is already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: FAIL. `getAllByLabelText("物品")` still resolves (to the selects), but clicking one opens no dialog, so `[data-item-id=...]` is null.

- [ ] **Step 3: Add the imports and picker state**

In `src/components/InputsPanel.tsx`, add to the imports:

```tsx
import { computeItemDepths } from "../data/recipe-depth";
import { ItemPickerPopup } from "./ItemPickerPopup";
```

`useRef` is already imported. Inside the component, after the `itemById` memo:

```tsx
  // Availability depth per item id, used by the picker popup to group tiles.
  // Every pack item is seeded, so nothing lands in the unranked bucket.
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

- [ ] **Step 4: Tag override rows with their item id**

Auto-rows already carry `data-item-id`; override rows do not, so no selector can address one by item. Both the unit tests in Task 6 and the e2e selectors in Task 9 need it. Add to the override row's wrapping `div`, next to `data-testid="input-row"`:

```tsx
            data-item-id={row.itemId}
```

- [ ] **Step 5: Replace the select with a trigger button**

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

- [ ] **Step 6: Render the popup**

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

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: the three new tests PASS. Other tests in the file that use `selectOptions` will now fail; leave them for Task 8.

- [ ] **Step 8: Commit**

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

- [ ] **Step 1: Write the failing test**

Append to `test/components/InputsPanel.test.tsx`:

```tsx
test("a committed swap moves focus to the swapped row's trigger", async () => {
  const user = userEvent.setup();
  function Parent() {
    const [rows, setRows] = useState<ItemOverride[]>([{ itemId: "copper_ore" }]);
    return (
      <LocaleProvider locale="zh">
        <InputsPanel
          itemOverrides={rows}
          onChange={(update) => setRows((cur) => update(cur))}
          pack={fixturePack}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  await user.click(screen.getAllByLabelText("物品")[0]!);
  await user.click(document.querySelector('[data-item-id="iron_ore"]')!);
  const trigger = screen.getAllByLabelText("物品")[0]!;
  expect(trigger.textContent).toBe("iron_ore");
  expect(document.activeElement).toBe(trigger);
});
```

Import `useState` from `react` in the test file if it is not already imported. The expected `textContent` is the localized display name of the swapped-in item; use whatever the fixture's `displayName` yields for it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "committed swap"`
Expected: FAIL, `expected <body> to be <button>`.

- [ ] **Step 3: Add the pending-focus token**

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

- [ ] **Step 4: Arm on swap and consume on the trigger**

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

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "committed swap"`
Expected: PASS.

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: Write the failing tests**

In `test/components/InputsPanel.test.tsx`, replace the existing add-button test (the one asserting `onChange` fires once with the first-unused item) with:

```tsx
test("Add opens the picker and commits nothing until a pick", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="zh">
      <InputsPanel
        itemOverrides={[]}
        onChange={onChange}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />
    </LocaleProvider>,
  );
  await user.click(screen.getByText(TEXT_ADD));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("picker-hint")).not.toBeNull();
  // The auto-row item already has a row, so its tile is dimmed here.
  expect(
    (document.querySelector('[data-item-id="copper_ore"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

test("a pick from the Add picker appends an uncapped override", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="zh">
      <InputsPanel itemOverrides={[]} onChange={onChange} pack={fixturePack} />
    </LocaleProvider>,
  );
  await user.click(screen.getByText(TEXT_ADD));
  await user.click(document.querySelector('[data-item-id="iron_ore"]')!);
  expect(onChange).toHaveBeenCalledTimes(1);
  const updater = onChange.mock.calls[0]![0] as (
    c: ItemOverride[],
  ) => ItemOverride[];
  expect(updater([])).toEqual([{ itemId: "iron_ore" }]);
  // Racing a prop update that already inserted the row is a no-op.
  expect(updater([{ itemId: "iron_ore" }])).toEqual([{ itemId: "iron_ore" }]);
});

test("a pick from the Add picker focuses the new row's rate input", async () => {
  const user = userEvent.setup();
  function Parent() {
    const [rows, setRows] = useState<ItemOverride[]>([]);
    return (
      <LocaleProvider locale="zh">
        <InputsPanel
          itemOverrides={rows}
          onChange={(update) => setRows((cur) => update(cur))}
          pack={fixturePack}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  await user.click(screen.getByText(TEXT_ADD));
  await user.click(document.querySelector('[data-item-id="iron_ore"]')!);
  const rateInput = screen.getAllByLabelText("速率")[0]!;
  expect(document.activeElement).toBe(rateInput);
});

test("the Add button is aria-disabled and inert when every item is claimed", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const all = fixturePack.items.map((i) => ({ itemId: i.id }));
  render(
    <LocaleProvider locale="zh">
      <InputsPanel itemOverrides={all} onChange={onChange} pack={fixturePack} />
    </LocaleProvider>,
  );
  const add = screen.getByText(TEXT_ADD);
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await user.click(add);
  expect(screen.queryByTestId("picker-tile")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
```

Define `TEXT_ADD` near the top of the file from the exact `inputs.add` zh string in `src/data/i18n.ts`; read it out of the file rather than guessing. The rate query is `getAllByLabelText("速率")`, as the rest of this suite already uses.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: FAIL on all four new tests. The first fails because Add still commits immediately.

- [ ] **Step 3: Add the two i18n keys**

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

- [ ] **Step 4: Widen `pickerFor` and rewrite `handleAdd`**

In `src/components/InputsPanel.tsx`, widen the state type:

```tsx
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; itemId: string } | { kind: "add" } | null
  >(null);
```

Replace `handleAdd` entirely (its first-unused-id scan goes):

```tsx
  function handleAdd(e: React.MouseEvent<HTMLButtonElement>) {
    if (addExhausted) return;
    triggerRef.current = e.currentTarget;
    setPickerFor({ kind: "add" });
  }
```

Add `import type { MouseEvent } from "react"` and use `MouseEvent<HTMLButtonElement>` if the file's import style prefers named type imports.

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

- [ ] **Step 5: Make the Add button inert rather than disabled**

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

- [ ] **Step 6: Branch `renderPicker` on the entry point**

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

- [ ] **Step 7: Consume the rate token on the rate input**

Add the callback ref to the override row's rate `<input>`:

```tsx
                ref={(el) => focusOnMount(el, row.itemId, "rate")}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `bun run test -- test/components/InputsPanel.test.tsx`
Expected: the four new tests PASS.

- [ ] **Step 9: Add the aria-disabled CSS**

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

- [ ] **Step 10: Commit**

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

- [ ] **Step 1: Write the failing test**

Append to `test/components/InputsPanel.test.tsx`:

```tsx
test("rate inputs are described by their row's item name", () => {
  render(
    <LocaleProvider locale="zh">
      <InputsPanel
        itemOverrides={[{ itemId: "iron_ore" }]}
        onChange={() => {}}
        pack={fixturePack}
        assumedRawItemIds={["copper_ore"]}
      />
    </LocaleProvider>,
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

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "described by"`
Expected: FAIL, `expected null not to be null`.

- [ ] **Step 3: Add the name nodes**

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

- [ ] **Step 4: Point both rate inputs at them**

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

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- test/components/InputsPanel.test.tsx -t "described by"`
Expected: PASS.

- [ ] **Step 6: Commit**

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

- [ ] **Step 1: Delete the sortedItems and collator memos**

In `src/components/InputsPanel.tsx`, delete the `collator` and `sortedItems` `useMemo` blocks and their comments. Their last consumer was the option list and `handleAdd`, both gone. Replace the section-head denominator `{sortedItems.length}` with `{pack.items.length}`. Drop the now-unused `Intl.Collator` reference.

- [ ] **Step 2: Delete the dead CSS and rewrite the comment**

In `src/canvas/canvas.css`, delete the `.b-pick select` face, hover, focus, focus-visible and `select option` rules. The locale switcher is the app's only other `<select>` and is styled through `.ak-app-shell select` and `.ak-app-shell .topbar select`, so nothing else depends on them.

Rewrite the block comment above them. It must still document `.b-pick` as the row's name-surface slot in the fixed row layout, the persistent caret as the touch and discoverability affordance, and why the caret stays minimal instead of reinstating a boxed select. What goes is the `color-scheme: dark` sentence and the justification of the native select. Record honestly that the popup only partly replaces it:

```css
/* The picker is the row's name surface itself. The row layout is fixed: icon,
   product-name, item-id, rate, and a remove control. The product-name slot is
   a borderless button that opens the item picker dialog, so it reads as the
   heading line rather than a control. A small persistent caret at the right
   edge marks the affordance for touch and for first-impression
   discoverability, without bringing back the boxed-select redundancy an
   earlier pass had. Moving off a native <select> costs the platform's
   keyboard nav, type-ahead, IME composition and mobile native picker; the
   dialog's search box replaces finding an item by name, but it has no focus
   trap, no arrow-key grid navigation, and no type-ahead outside that field,
   so Tab walks every tile and then leaves the dialog. */
```

- [ ] **Step 3: Rewrite the two stale popup prop comments**

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

- [ ] **Step 4: Verify nothing regressed**

Run: `bun run typecheck && bun run lint && bun run test -- src/components test/components`
Expected: typecheck and lint clean. Test failures at this point should only be in `src/components/InputsPanel.test.tsx`, which Task 8 handles.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Delete the test**

Delete the whole `test("item picker options are sorted by localized display name, not id", ...)` block from `src/components/InputsPanel.test.tsx`. It asserts the global option sequence is collator-sorted across all 113 items by walking `querySelectorAll("option")`. The popup buckets by tier and sorts only within a bucket, so the global guarantee no longer holds and the test cannot be retargeted mechanically. Task 2 moved the surviving guarantee into `ItemPickerPopup.test.tsx`.

- [ ] **Step 2: Fix any other combobox reference in the file**

Search the file for `getByRole("combobox")` and `querySelectorAll("option")`. Any remaining use belongs to the deleted test; if another test uses them, rewrite it to click the row trigger and then a `[data-item-id]` tile, following Task 3's pattern.

- [ ] **Step 3: Run the suite**

Run: `bun run test -- src/components/InputsPanel.test.tsx`
Expected: PASS, whole file.

- [ ] **Step 4: Run every vitest suite**

Run: `bun run test`
Expected: PASS. `test/integration/inputs-panel-shell.test.tsx` must pass untouched; if it fails, something in Tasks 3 to 7 changed the rate control, which is out of scope.

- [ ] **Step 5: Commit**

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

- [ ] **Step 1: Add a pick helper and delete the dead constants**

At the top of `test/e2e/inputs-panel.spec.ts`, add:

```ts
// Add now opens the picker instead of committing a row, so every "add a row"
// preamble is two steps: click Add, then click the item's tile.
async function addInputRow(page: Page, itemId: string) {
  await clickAddInput(page);
  await page.locator(`[data-item-id="${itemId}"]`).click();
}
```

Delete `FIRST_LEX_ITEM_ID` (used by Tests 1 and 3), and `SECOND_LEX_ITEM_ID`, `TEXT.duplicateAlert` and `COMMIT_DEBOUNCE_MS` (used by Test 3 alone). The last one's comment already describes a debounce the app no longer has.

- [ ] **Step 2: Replace Test 1**

Test 1 asserts Add appends a row defaulting to the first lexical item. That behavior is gone. Replace its body:

```ts
  await clickAddInput(page);
  // No row yet: the picker is open and nothing has been committed.
  await expect(inputRows(page)).toHaveCount(initialCount);
  await expect(page.locator(".recipe-picker")).toBeVisible();
  const hashBefore = page.url();
  await page.locator('[data-item-id="copper_powder"]').click();
  await expect(inputRows(page)).toHaveCount(initialCount + 1);
  const row = inputRows(page).nth(initialCount);
  await expect(row.getByRole("button", { name: TEXT.itemLabel })).toHaveText(
    /.+/,
  );
  // An uncapped override: the rate field is empty and shows the unlimited
  // placeholder.
  await expect(row.locator("input")).toHaveValue("");
  expect(page.url()).not.toBe(hashBefore);
```

- [ ] **Step 3: Replace Test 3**

Test 3 drove a duplicate through `selectOption` and asserted the per-row alert plus an unchanged URL. The pick is impossible now, so assert the tile is dimmed instead:

```ts
  await addInputRow(page, "copper_powder");
  // Open the picker from a different row and confirm the taken item is dimmed.
  await addInputRow(page, "copper_plate");
  const secondRow = inputRows(page).nth(initialCount + 1);
  await secondRow.getByRole("button", { name: TEXT.itemLabel }).click();
  await expect(page.locator('[data-item-id="copper_powder"]')).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".recipe-picker")).toHaveCount(0);
```

- [ ] **Step 4: Restructure Test 5**

Test 5 caps `copper_ore`, which is raw and consumed by the default plan, so it is an auto-row and its tile is dimmed in the Add picker. Drive the auto-row typing path instead, and drop the `nth(initialCount)` locator, since `input-row` counts overrides only:

```ts
  const autoRow = page.locator(
    '[data-testid="input-auto-row"][data-item-id="copper_ore"]',
  );
  await expect(autoRow).toHaveCount(1);
  await autoRow.locator("input").fill("120");
  await autoRow.locator("input").press("Enter");
  // Typing a cap promotes the auto-row into a real override row.
  await expect(
    page.locator('[data-testid="input-row"][data-item-id="copper_ore"]'),
  ).toHaveCount(1);
```

Keep the test's existing assertions about what lands in the plan and the URL hash, retargeted at that locator.

- [ ] **Step 5: Re-preamble Tests 2, 4 and 6**

In each, replace `await clickAddInput(page);` followed by `inputRows(page).nth(initialCount)` with `await addInputRow(page, "copper_powder");` and keep everything after it. `copper_powder` is not raw, so it is never an auto-row and its tile is always enabled. Their plan and URL assertions survive unchanged.

- [ ] **Step 6: Run the suite**

Run: `bun run test:e2e -- inputs-panel`
Expected: PASS, all six tests.

If failures appear that look unrelated to this change, baseline first: `git stash && bun run test:e2e -- inputs-panel && git stash pop`. This repo has known pre-existing e2e failures in other spec files; only regressions inside `inputs-panel.spec.ts` count here.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/inputs-panel.spec.ts
git commit -m "Drive the input panel e2e suite through the item picker"
```

---

### Task 10: Full verification and visual check

**Files:** none modified unless a gate fails.

- [ ] **Step 1: Run every gate**

```bash
bun run typecheck && bun run lint && bun run format && bun run test && bun run test:e2e
```

Expected: all clean, except pre-existing e2e failures outside `inputs-panel.spec.ts`. Record which of those were already failing on `origin/develop` before blaming this branch.

- [ ] **Step 2: Visual check in the browser**

Run `bun run dev`, open the app, and confirm by looking, not by presence:

- A row's name line still reads as a heading with the caret at its right edge, not as a boxed control.
- Clicking it opens the picker with that item highlighted and the sibling rows' items dimmed. No hint line here.
- Add opens the picker with a hint line under the search box and every already-listed item dimmed, including the raw auto-rows.
- Picking from Add appends a row and the caret cursor lands in its rate field.
- Picking a different item from a row swaps it and the focus ring is on the swapped row's trigger.
- Escape and a backdrop click both return the focus ring to the trigger that opened the picker.
- Long names truncate with an ellipsis and show the full name on hover.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "Fix issues found in verification"
```

## Self-review notes

Spec coverage: ruling 1 is Task 3 and 5 (`items: pack.items` at both sites); ruling 2 is Task 5; ruling 3 is Task 5's two `disabledIds` sets; ruling 4 is Task 3's `tierByItemId`. Trigger and focus is Tasks 3, 4, 5 and 6. Picker state is Task 5. Commit ordering needs no code: the blur-first behavior falls out of the existing `onBlur` handler and is asserted indirectly by Task 9's Test 5. CSS is Tasks 1, 5 and 7. Other cleanup is Task 7. Testing is Tasks 2, 3, 5, 6, 8 and 9.

Names used consistently across tasks: `pickerFor`, `triggerRef`, `closePicker`, `pendingFocus`, `focusOnMount`, `rateDescribedBy`, `addExhausted`, `renderPicker`, `PendingFocus`, `i-name-${itemId}`, `inputs.picker.listed`, `inputs.add.exhausted`, `disabledHint`, `recipe-picker-hint`, `picker-hint`, `addInputRow`.
