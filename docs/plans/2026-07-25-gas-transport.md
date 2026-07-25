# Gas Transport Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make gas a first-class transport kind end to end, so gas items pack
their own lanes and gas edges and ports render distinctly from liquid ones.

**Architecture:** The extractor classifies `gas_*` items as kind `gas` and
synthesizes a `gas_pipe` carrier that the pack, the i18n sidecar, and
`transport-config.json` all agree on. Everything downstream is already
kind-driven, so the render layer only needs a third branch in the two existing
kind switches plus two gas-specific CSS rules.

**Tech Stack:** TypeScript, Bun (extractor), Vite + React 19, @xyflow/react,
vitest, Playwright.

**Spec:** `docs/specs/2026-07-25-gas-transport-design.md`

## Global Constraints

- Branch `feat/gas-transport`, worktree `.claude/worktrees/feat/gas-transport`. Never push.
- Comments and commit messages: ASCII only. No em-dashes, smart quotes, or Unicode arrows.
- Do not mention design docs, ADRs, tickets, or other markdown files in comments or commit messages.
- Commit messages: imperative mood, single line for small changes.
- No new dependencies.
- Surgical changes only; follow existing conventions in each file touched.
- Gas carrier id: `gas_pipe`. Gas kind id: `gas`. Gas lane capacity: `2` items/s.
- Gas dash-dot array: `6 2 1 2`. Gas hover dash-dot array: `8 3 1.5 3`.
- Gas fallback stroke (no item id only): `#22d3ee`. Gas dimmed opacity floor: `0.45`.
- App tests: `bunx vitest run <path>`. Extractor tests: `cd tools/extractor && bun test`.
- Do not run the full vitest suite or Playwright until Task 8; this box has ~7GB RAM.

---

### Task 1: Classify gas items in the extractor

> Deviation on execution: Tasks 1, 2, and 3 could not be verified independently.
> The moment Task 1 lands, `validateReferentialIntegrity` rejects every gas item
> for naming a `Transport.kind` no transport declares, so the extractor suite
> cannot build a pack at all until Task 2's synthetic carrier and Task 3's
> carrier registration exist. The three landed as one commit.

**Files:**
- Modify: `tools/extractor/src/schema.ts` (`TRANSPORT_KIND`)
- Modify: `tools/extractor/src/extract.ts` (`toItem`)
- Test: `tools/extractor/src/extract.test.ts`

**Interfaces:**
- Produces: `TRANSPORT_KIND.GAS === "gas"`; `toItem` returns `transportKind: "gas"` for ids matching `/^gas_/` that have no `stack`.

- [x] **Step 1: Write the failing tests.** In the existing transport-classification describe block (near the current `liquid` / `solid` assertions around line 300), add three cases against the real vendored upstream: `gas_copper` classifies as `gas`; `liquid_water` still classifies as `pipe`; a stacked item still classifies as `belt`.
- [x] **Step 2: Run them and confirm the gas case fails** with the item classified `pipe`. Command: `cd tools/extractor && bun test`.
- [x] **Step 3: Add `GAS: "gas"` to `TRANSPORT_KIND`.**
- [x] **Step 4: Extend `toItem`'s classification** from the two-way `stack` check to the three-way rule: a numeric `stack` is belt; otherwise an id prefixed `gas_` is gas; otherwise pipe. Per decision D3 an unrecognised prefix keeps falling through to pipe, so this is a prepended branch, not a guard. Update the comment on `Item.transportKind` in `schema.ts` to describe all three outcomes.
- [x] **Step 5: Run the tests and confirm they pass.**
- [x] **Step 6: Commit.** Files: `tools/extractor/src/schema.ts`, `tools/extractor/src/extract.ts`, `tools/extractor/src/extract.test.ts`.

**Acceptance:** All eight `gas_*` items classify `gas`; all eleven `liquid_*` items classify `pipe`; no belt item moves.

**Blocks:** Task 2, Task 3.

---

### Task 2: Synthesize the gas_pipe carrier and its translations

**Files:**
- Modify: `tools/extractor/src/extract.ts` (transport assembly in `main`, and `buildI18nSidecar` around line 393)
- Test: `tools/extractor/src/extract.test.ts`

**Interfaces:**
- Consumes: `TRANSPORT_KIND.GAS` from Task 1.
- Produces: a pack `Transport` `{ id: "gas_pipe", kind: "gas", name, icon: "pipe", speed: 2 }`, and a `transports["gas_pipe"]` entry in every locale of the i18n sidecar.

**Why synthetic:** the vendored snapshot declares only `belt` and `pipe` transport
items. Without this the existing referential assertion "every `Item.transportKind`
resolves to a `Transport.kind`" fails as soon as Task 1 lands.

- [x] **Step 1: Write the failing tests.** Assert the built pack contains a transport with id `gas_pipe`, kind `gas`, and speed 2; assert `validateReferentialIntegrity` accepts the pack (it already runs inside the build, so a passing build is the assertion); assert the i18n sidecar has a non-empty `names[locale].transports["gas_pipe"]` for each of `en`, `ja`, `ru`, `zh`.
- [x] **Step 2: Run them and confirm the build now throws** `item gas_copper references unknown Transport.kind gas`.
- [x] **Step 3: Add a module-level synthetic-transport table** near the other module constants, holding the id, kind, icon, speed, and one display name per locale. Name it so its synthetic nature is obvious, and comment why it exists (upstream has no gas pipe entry) and that the `pipe` icon is reused because nothing renders `transports[].icon`.
- [x] **Step 4: Append the synthetic transport to `transports`** after the upstream loop in `main`, before `validateReferentialIntegrity` runs.
- [x] **Step 5: Inject the locale names** in `buildI18nSidecar`, after the `splitLocale` call and before `assertCoverage(locale, "transports", ...)`. The splitter walks upstream keys only, so a synthetic id can never come from `raw.items`.
- [x] **Step 6: Run the tests and confirm they pass.**
- [x] **Step 7: Commit.**

**Acceptance:** `cd tools/extractor && bun test` is green; the build produces three transports.

**Depends on:** Task 1. **Blocks:** Task 3.

---

### Task 3: Regenerate artifacts and register the gas carrier

**Files:**
- Modify: `data/aef/transport-config.json` (`carriers`, `source`)
- Regenerate: `data/aef/recipe-pack.json`, `data/aef/recipe-pack.i18n.json`
- Test: `test/transport-config-guard.test.ts`

**Interfaces:**
- Consumes: the pack shape from Task 2.
- Produces: `carriers.gas = { transportId: "gas_pipe", itemsPerSecondPerLane: 2 }`.

- [x] **Step 1: Write the failing test.** In the transport-config guard suite, assert `loadTransportConfig(defaultTransportConfig, pack)` does not throw for the real pack, and assert `defaultTransportConfig.carriers.gas` exists with `transportId: "gas_pipe"`.
- [x] **Step 2: Run it and confirm it fails** with `UnknownCarrierError` for kind `gas`.
- [x] **Step 3: Add the `gas` carrier** to `data/aef/transport-config.json`. Leave `schemaVersion` at `0.2`: the change is additive and the config schema's `patternProperties` already accepts any carrier key. Extend the `source` string to record that the gas throughput is an uncalibrated placeholder reusing the liquid pipe figure, alongside the existing placeholder note.
- [x] **Step 4: Regenerate the data artifacts.** Run `bun run extract` from the repo root.
- [x] **Step 5: Inspect the diff before staging it.** Expect exactly: eight items flipping `transportKind` from `pipe` to `gas`, one new transport entry, four new i18n transport keys, and a refreshed `extractedAt`. Anything else means Task 1 or 2 is wrong; stop and fix it rather than committing the artifact.
- [x] **Step 6: Run the guard test and confirm it passes.** Command: `bunx vitest run test/transport-config-guard.test.ts`.
- [x] **Step 7: Commit** the config, both regenerated artifacts, and the test in one commit, since the app cannot load a pack whose carrier is unregistered.

**Acceptance:** The app loads the regenerated pack without `UnknownCarrierError`; the artifact diff contains no unexplained change.

**Depends on:** Task 2. **Blocks:** Task 4, Task 8.

---

### Task 4: Split gas out of the pipe lane bucket

> Outcome: no production change and no fixture re-pins were needed. `ffdPack`
> already keys its buckets on the carrier, and the solver and pipeline suites
> stayed green (176 passed) on the regenerated data. The only edit was the test
> fixture's local carrier table, which had no gas entry.

**Files:**
- Test: `test/solver/ffd.test.ts`
- Modify: none expected (`ffdPack` already buckets by `(groupId, carrier)`)
- Possibly modify: pinned lane-count fixtures surfaced by the run

**Interfaces:**
- Consumes: `Item.transportKind === "gas"` from Task 3.

**Note:** this task is a behaviour-confirmation plus fallout cleanup. No production
change is expected; if one turns out to be needed, the bucketing key in
`ffdPack` is the only place to touch.

- [x] **Step 1: Write the failing-or-confirming test.** Build a small fixture with one blueprint group whose replicas output both a gas item and a liquid item at rates that would share a lane under one carrier, and assert the packer emits separate lanes whose carriers are `gas` and `pipe`.
- [x] **Step 2: Run it.** Command: `bunx vitest run test/solver/ffd.test.ts`. It should pass on the strength of Task 3's data change; if it fails, the bucketing key is the fix.
- [x] **Step 3: Run the solver and pipeline suites to surface fixture fallout.** Commands: `bunx vitest run test/solver`, then `bunx vitest run test/pipeline`.
- [x] **Step 4: Re-pin only the fixtures whose new value is provably correct**, one at a time, each with a one-line justification in the commit message naming the group and why its lane count moved. Never bulk-update goldens.
- [x] **Step 5: Re-run both suites and confirm green.**
- [x] **Step 6: Commit.**

**Acceptance:** Gas and liquid streams in one group occupy separate lanes; every moved fixture has a written justification; no rate or feasibility assertion changes.

**Depends on:** Task 3. **Blocks:** Task 8.

---

### Task 5: Render gas edges as dash-dot

**Files:**
- Modify: `src/canvas/ItemEdge.tsx` (`strokeForKind`, and the fallback stroke constants above it)
- Test: `test/canvas/ItemEdge-transport-kind.test.tsx`

**Interfaces:**
- Produces: `strokeForKind(kind, itemId)` returns `{ stroke, strokeDasharray: "6 2 1 2" }` when `kind === "gas"`.
- `BusEdge.tsx` consumes `strokeForKind` unchanged, so bus trunks inherit the gas stroke with no edit there.

- [x] **Step 1: Write the failing tests.** Assert an edge with `transportKind: "gas"` renders `stroke-dasharray="6 2 1 2"` and carries `data-transport-kind="gas"`; assert a gas edge with an item id takes its stroke from `itemColor` (matching how the existing pipe assertion is written); assert a gas edge without an item id falls back to `#22d3ee`; assert the existing belt and pipe cases are unchanged.
- [x] **Step 2: Run them and confirm the gas cases fail.** Command: `bunx vitest run test/canvas/ItemEdge-transport-kind.test.tsx`.
- [x] **Step 3: Add `GAS_STROKE` and `GAS_DASH` constants** beside `PIPE_STROKE` and `PIPE_DASH`, and add the `gas` branch to `strokeForKind` above the existing pipe branch. Update the block comment above the constants so it describes three kinds, keeping its existing note that unknown kinds fall through to belt on purpose.
- [x] **Step 4: Update the `ItemEdgeData.transportKind` doc comment** to say belt, pipe, or gas instead of "belt or pipe, with room to grow".
- [x] **Step 5: Run the tests and confirm they pass.**
- [x] **Step 6: Commit.**

**Acceptance:** Gas edges render dash-dot in both `ItemEdge` and `BusEdge`; belt and pipe rendering is byte-identical to before.

**Blocks:** Task 7, Task 8.

---

### Task 6: Render gas ports as a hollow diamond

**Files:**
- Modify: `src/canvas/PortGlyph.tsx` (`glyphKind`, `baseStyle`, the `PortGlyph` body, and the size constants)
- Test: `test/canvas/port-glyph.test.tsx`

**Interfaces:**
- Produces: `glyphKind("gas") === "gas"`; the rendered span carries `data-glyph="gas"`.

**Sizing rationale:** the belt square and pipe circle occupy an 8px box. A square
rotated 45 degrees presents its diagonal, so an 8px gas box would present 11.3px
and out-mass both siblings, which is exactly the visual failure issue #19 filed
against overlapping port markers. A 6px box presents an 8.49px diagonal, matching
its siblings. `baseStyle` currently hardcodes `GLYPH_SIZE` for both the vertical
centering and the side offset, so it needs a size parameter defaulting to the
existing value; the side offset stays at the shared value so the diamond does not
creep toward the handle.

- [x] **Step 1: Write the failing tests.** Assert `glyphKind("gas")` returns `"gas"`; assert the rendered element has `data-glyph="gas"`, a transparent background, a border in the item's `itemColor` when an item is passed and `#22d3ee` when it is not, and a transform containing `rotate(45deg)`; assert the belt and pipe cases still render `data-glyph="belt"` / `"pipe"` with unchanged geometry.
- [x] **Step 2: Run them and confirm the gas cases fail.** Command: `bunx vitest run test/canvas/port-glyph.test.tsx`.
- [x] **Step 3: Add a `GAS_GLYPH_SIZE` constant of 6 and a `GAS_STROKE` constant of `#22d3ee`;** give `baseStyle` a size parameter defaulting to `GLYPH_SIZE` and use it in both the `top` arithmetic and the width/height, leaving the side offset on the shared constant.
- [x] **Step 4: Add `"gas"` to `glyphKind`'s return union and its accepted values,** and add the gas branch to the style switch: transparent background, 1.5px border in `accent ?? GAS_STROKE`, no border radius, `rotate(45deg)` composed onto whichever transform `baseStyle` already produced. Both vertical modes must keep working: the `top`-supplied mode has no transform today, the row-centered mode already carries `translateY(-50%)`, so the rotation has to compose rather than replace.
- [x] **Step 5: Update the file's header comment** to list all three kind-to-shape mappings, and the `item` prop comment that currently says "belt square / pipe circle".
- [x] **Step 6: Run the tests and confirm they pass.**
- [x] **Step 7: Commit.**

**Acceptance:** Gas ports render a hollow diamond whose visual footprint matches the pipe circle; belt and pipe glyph geometry is unchanged in both vertical modes.

**Blocks:** Task 8.

---

### Task 7: Give gas its own dim and hover reaction

**Files:**
- Modify: `src/canvas/canvas.css` (the ego-network dim block and the `hover-active` emphasis rule, currently around lines 1354-1385)
- Test: `test/canvas/ItemEdge-transport-kind.test.tsx` (attribute contract only)

**Interfaces:**
- Consumes: the `data-transport-kind="gas"` attribute `ItemEdge` stamps on its `BaseEdge` path (Task 5).

**Why gas needs its own rules:** the shared `.react-flow__edge.dimmed` opacity of
0.3 drops the dot segments of a dash-dot pattern below visibility, so a dimmed gas
line reads as broken geometry rather than as a faded edge. Separately, the
`hover-active` rule multiplies stroke width, but `stroke-dasharray` is expressed in
user units and does not scale with it, so at the emphasised width the dots bloat
into blobs and the pattern stops reading as dash-dot.

- [x] **Step 1: Assert the attribute contract in the test file** (jsdom does not evaluate a stylesheet cascade, so the CSS itself is verified visually in Task 8): confirm a dimmed gas edge still exposes `data-transport-kind="gas"` on its path, which is what both new rules select on.
- [x] **Step 2: Run it and confirm the current state.** Command: `bunx vitest run test/canvas/ItemEdge-transport-kind.test.tsx`.
- [x] **Step 3: Add the dim rule** immediately after the existing `.react-flow__edge.dimmed` declaration, raising the opacity floor to 0.45 for `path[data-transport-kind="gas"]`, with a comment giving the reason above.
- [x] **Step 4: Add the hover rule** immediately after the existing `.hover-active .react-flow__edge:not(.dimmed) path` declaration, re-specifying `stroke-dasharray: 8 3 1.5 3` for the gas path, with a comment giving the reason above. Match the existing rule's use of `!important` only if the inline `strokeDasharray` from `strokeForKind` actually wins without it; check, do not assume.
- [x] **Step 5: Run the test and confirm it passes.**
- [x] **Step 6: Commit.**

**Acceptance:** Both rules select on the gas path attribute and sit beside the shared rules they qualify; belt and pipe dim and hover behaviour is unchanged.

**Depends on:** Task 5. **Blocks:** Task 8.

---

### Task 8: Full verification and visual sign-off

**Files:**
- Modify: none expected; fixture re-pins only if justified

- [x] **Step 1: Run `bun run typecheck`.** Expect clean.
- [x] **Step 2: Run `bun run lint`.** Expect clean on tracked files.
- [x] **Step 3: Run the full app suite: `bun run test`.** If it is killed for memory, shard by directory and say so in the report.
- [x] **Step 4: Run the extractor suite: `cd tools/extractor && bun test`.** Expect clean.
- [x] **Step 5: Build and serve.** Run `bun run build`, then `bun run preview`.
- [x] **Step 6: Capture a gas-bearing plan** at fit zoom, with a gas edge hovered, and with a gas edge dimmed by hovering a different edge. Take a zoomed crop of a gas port and of a gas-and-pipe pair running parallel.
- [x] **Step 7: Inspect the captures for wrongness, not presence.** Confirm gas is distinguishable from pipe in all three states; the dash-dot pattern is legible dimmed and hovered; the diamond glyph does not overlap its handle or a neighbouring glyph; a gas bus trunk carries the gas stroke.
- [x] **Step 8: Stop the preview server.**
- [x] **Step 9: Report** every command run with its result, and every acceptance criterion in the spec with its evidence. Do not claim completion for anything not actually observed.

**Acceptance:** All seven spec acceptance criteria have named evidence. Any residual defect is reported rather than silently accepted.

**Depends on:** Tasks 3, 4, 5, 6, 7.

---

## Integration note

This branch rebases onto `develop` after `fix/render-issues-2026-07-25` lands.
Tasks 5, 6, and 7 touch `ItemEdge.tsx`, `PortGlyph.tsx`, and `canvas.css`, which
that campaign also edits for issues #14, #19, and #20. Re-run Task 8 after the
rebase; a conflict resolved in the CSS or the glyph switch is exactly the kind of
change that passes tests and fails visually.
