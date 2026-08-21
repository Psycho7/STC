# Trunk-Rate Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues #39, #45 and #50 and land the three PR #47 seating-frame deferrals: the fan-in Sigma chip is removed, multi-member trunk chips read as shares, junction dots stop hiding under chips, and the seating pass measures in the drawn frame.

**Architecture:** Per the spec `docs/specs/2026-08-21-trunk-rate-legibility-design.md`: (A) delete the fan-in Sigma end to end and restore the owner member's gated chip, keeping the non-owner shared-run hide; (B) compact "rate/total" share text on multi-member trunk chips, zero seating churn by construction; (C) hoist junction-dot geometry ahead of the seating phases, then make dots keepoff rects sized at fit zoom, guarded by a committed dot-coverage census; (D) two contract pin tests; (E) endpoint-parity audit, fan-in stamp on the drawn frame, and the atomic cards[]-to-drawn-frame move. Ordering: A before E2; A and B before C; E1 before E3; D independent.

**Tech Stack:** Vite + React 19 + TS, @xyflow/react, elkjs, vitest (unit), Playwright (e2e, NOT in CI), bun.

## Global Constraints

- Worktree: `/home/rins/workspace/STC-workspace/STC/.claude/worktrees/fix/trunk-rate-legibility` (branch `fix/trunk-rate-legibility` off develop@b485973). All paths below are relative to it.
- RAM: the box has 3.2GB total. Wrap every heavy command: `systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- <cmd>`. Never let Playwright's webServer chain the build: run `bun run build` alone first, then `bun run preview --port 4173 --strictPort` in background (`reuseExistingServer` picks it up; it serves `dist/`, so REBUILD after src changes). One scenario per `bunx playwright test` invocation; `-g` needs a `$` anchor (`battery5$` - `battery5` alone also matches `battery5-xiranite`). Chromium is installed; never install browsers. Never `pkill -f "vite preview"` (matches the calling shell's own cmdline).
- Ratchets (`test/e2e/geometry-audit.spec.ts`): five baseline tables, all `expect.soft`. EIGHT standing rulings are enumerated in the NOTE block at :251-297 - keep the enumeration correct when adding rulings or tables. Harvest actuals with the preserved probe: copy `.superpowers/sdd/ratchet-probe.spec.ts.keep` from the fix/short-leg-legibility worktree into `test/e2e/`, run, delete. NEVER re-author the probe. DOWN re-pins are free; an UP move needs an explicit user ruling. Attribute moves by detached-build differential probes, never inference.
- Expected-red e2e baseline (pre-existing, NOT regressions): geometry-audit multi6 tier-1 RAW (ratified; battery5 RAW is CLEAN - a battery5 RAW hit is a regression); inputs-panel 4 + raw-and-transport 1 (product-node pin family); placement-shots fails 7/7 on the first run in a fresh worktree, passes on rerun. multi6 fit zoom ~0.21 suppresses all label chips (off-path blind spot).
- Fit-zoom guard: battery5-xiranite fit zoom is 0.352658, 0.0027 above `LABEL_MIN_ZOOM` 0.35. The fit camera derives from `contentBounds` (unions chip boxes). Re-measure the five fit zooms after every render-affecting task; a battery5-xiranite drop below 0.35 is a STOP (report, do not absorb). Reference fits: default 0.899871, battery5 0.448487, battery5-xiranite 0.352658, equip4 0.436267, multi6 0.208893.
- Goldens (`test/e2e/__screenshots__/`) are gitignored and local; regeneration is a ledger note, never a commit.
- ASCII only in code, comments, and commit messages (existing i18n string literals are exempt). Commit per task, imperative mood. Bare `#NN` issue refs are fine in commits; no doc-file references.
- Visual verification is MANDATORY after each render-affecting task (Tasks 3, 4, 6, 8, 9): fit captures + zoomed crops, inspected for wrongness, not just presence. Park the pointer off-target before resting shots (zoom gestures leave the mouse hovering).
- `gh pr merge` and `git stash` are classifier-blocked; the user merges. `gh issue comment`, `gh pr create`, `git push` are allowed. Merges target `develop`, so Closes-keywords never fire - issues are closed manually with evidence comments.
- Stale LSP diagnostics fire after subagent edits - trust `bunx tsc --noEmit`, not the diagnostics block.

---

### Task 1: Commit the plan and harvest the pre-change baseline

**Files:**
- Create: `docs/plans/2026-08-21-trunk-rate-legibility.md` (this file)
- Create (temporary): `test/e2e/ratchet-probe.spec.ts` - copied from the short-leg worktree's `.superpowers/sdd/ratchet-probe.spec.ts.keep`, deleted again in this task
- Ledger: `.superpowers/sdd/progress.md` (gitignored)

**Interfaces:**
- Produces: the pre-change actuals table (five audits x seven scenarios) and the five fit zooms, recorded in the ledger. Every later re-measure diffs against it.

- [x] **Step 1: Commit the plan doc**

```bash
git add docs/plans/2026-08-21-trunk-rate-legibility.md
git commit -m "Add trunk-rate legibility campaign plan"
```

- [x] **Step 2: Build and start the preview server**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- bun run build
# then, in background:
bun run preview --port 4173 --strictPort
```

- [x] **Step 3: Copy the preserved probe and run it, one scenario per invocation**

```bash
cp ../short-leg-legibility/.superpowers/sdd/ratchet-probe.spec.ts.keep test/e2e/ratchet-probe.spec.ts
# for each of: default battery5 battery5-xiranite crystal equip4 multi6 tundra
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- \
  bunx playwright test test/e2e/ratchet-probe.spec.ts -g "<scenario>$"
```

Expected actuals equal the committed pins everywhere (rulings 7cdcf01: chipSeg battery5-xiranite 15, offPath battery5 2; only multi6 tier-1 RAW red): crossings 9/8/55/1/1/415/0, paddedGrazes 0/1/0/0/0/1/0, chipSeg 0/3/15/0/1/0/0, offPath 0/2/2/0/0/0/0, ownPierce all 0. Record the table and the five fit zooms in the ledger. Any mismatch is a STOP.

- [x] **Step 4: Delete the probe, verify clean tree, run the unit suite once for the baseline count**

```bash
rm test/e2e/ratchet-probe.spec.ts
git status --short
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- bunx vitest run
```

Record the passing test count in the ledger.

---

### Task 2: Workstream D - contract pin tests

**Files:**
- Modify: `test/canvas/layout-invariants.test.ts` (root pin at :134; add the container-level pin beside it)
- Create: `test/canvas/portZoneDepth.test.ts`

**Interfaces:**
- Consumes: `buildElkGraph` (or the same fixture path layout-invariants already uses) for the container options; `PORT_ZONE_DEPTH` from `src/canvas/chipSeating.ts:219`; the `.rn-row` rule from `src/canvas/canvas.css:2055`.
- Produces: nothing later tasks rely on (pure guards).

- [x] **Step 1: Write the container-spacing pin.** In `layout-invariants.test.ts`, assert that a loop-slab container's `layoutOptions` carry `elk.spacing.nodeNode` and `elk.layered.spacing.nodeNodeBetweenLayers` equal to the root-level strings (`src/canvas/layout.ts:370-373` vs :169). Use a fixture with at least one loop container.
- [x] **Step 2: Write the depth-coupling pin.** In `portZoneDepth.test.ts`, read `canvas.css` as text (the repo has precedent for CSS-text assertions in `test/canvas/` - follow the existing import style), extract the `.rn-row` padding inset, and assert it equals `PORT_ZONE_DEPTH`. If text-parsing the shorthand proves brittle, pin the two numbers side by side with a comment-free assertion (`expect(PORT_ZONE_DEPTH).toBe(8)` plus a regex on `.rn-row`'s `padding: 0 8px` line) - the point is that changing either side alone fails a test.
- [x] **Step 3: Mutation-check both pins.** Temporarily change the container option string and `PORT_ZONE_DEPTH` (to 9) and confirm each test fails; revert.
- [x] **Step 4: Run, verify green, commit**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- bunx vitest run test/canvas/layout-invariants.test.ts test/canvas/portZoneDepth.test.ts
git add -A && git commit -m "Pin container ELK spacing strings and port-zone depth coupling"
```

---

### Task 3: Workstream A - remove the fan-in Sigma, restore the owner chip

**Files:**
- Modify: `src/canvas/chipSeating.ts` (phase 3.5 sigma-job build :1502-1599 minus the group/merge detection the dot needs, phase 5 deferred seating :1737-1767, `edges.map` stamp :1830-1840, total/display-total accumulation and DEV rate-less tripwire :1478-1487 and :1558-1566, `ChipAnchorData` sigma fields and `contentBounds` sigma reader :1877-1882 and :1934-1940)
- Modify: `src/canvas/ItemEdge.tsx` (`faninSigma*` + `faninTotalRate`/`faninDisplayTotalRate`/`faninMemberCount` data fields :96-115, sigma render block :593-615, faninText :466-486, FlowChip `variant`/`marker` props :233-254 and :277-288, owner-suppression comment and restore at :430-437, `CHIP_ICON_ONLY_MAX_ZOOM` doc line :152-163)
- Modify: `src/canvas/canvas.css` (`.flow-chip.sigma` :1811-1817)
- Modify: `.claude/workflows/render-quality-exam.js:283-284` (stale Sigma prose)
- Modify: `test/canvas/ItemEdge.test.tsx` (:199-241, :276-311), `test/canvas/faninMarkers.test.ts`, `test/canvas/shortLegChips.test.ts:20`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the fan-in surface later tasks touch is now junction stamp + non-owner hide only. `faninChipHidden`, `faninChipHiddenAtY`, `faninMemberRunByIndex`, `faninExcludedKeys`, and the dot stamp survive UNCHANGED - Task 8 (E2) depends on exactly this surface.

Key decisions (from the spec - do not relitigate): owner-only restore; non-owner hide and hover fallback (`ItemEdge.tsx:552-565`) stay; dot gating (`faninExcludedKeys` :1429-1433, short-run skip :1557) stays; the restored owner chip is zoom-gated (accepted: below `LABEL_MIN_ZOOM` a fan-in port shows no number).

- [x] **Step 1: Rewrite the tests first.** Replace the two Sigma cases in `ItemEdge.test.tsx` and the Sigma assertions in `faninMarkers.test.ts` with pins of the new contract: no element with class `sigma` anywhere; junction dot present at the merge; owner edge renders its plain rate chip (gated); non-owner `faninChipHidden` fixture (:105-110) unchanged. Fix the stale comment in `shortLegChips.test.ts:20`. Run - the new assertions fail against current code.
- [x] **Step 2: Delete the Sigma.** Remove every site in the Files list. The phase 3.5 group detection that feeds the DOT stamp stays; only sigma-job construction, seating, stamping and rendering go. `bunx tsc --noEmit` is the completeness check - the compiler finds every orphaned field.
- [x] **Step 3: Restore the owner chip.** The owner's suppression is the `variant`-driven skip in `ItemEdge.tsx:430-437`; with the Sigma gone the owner renders the ordinary member chip under the ordinary gates. Confirm the non-owner path still consults `faninChipHidden`.
- [x] **Step 4: Update the exam prose** in `render-quality-exam.js` to describe the current marks (junction dot, member chips, no aggregates).
- [x] **Step 5: Full unit suite + typecheck + lint green.** Expected: count from Task 1 minus deleted Sigma tests plus new pins.
- [x] **Step 6: Rebuild, re-probe all seven scenarios, re-measure fit zooms.** Chip population changed (owner chips restored, sigma boxes gone from `contentBounds`): attribute every moved cell; DOWN re-pin freely; UP is a STOP for a user ruling. battery5-xiranite fit zoom must stay >= 0.35.
- [x] **Step 7: Visual verification.** Fit captures (default, battery5-xiranite, multi6) + a zoomed crop of the default plan's sewage fan-in run: dot present, owner chip readable, no Sigma, no stranded chrome. Inspect for wrongness.
- [x] **Step 8: Commit** `git commit -m "Remove the fan-in sigma chip and restore the owner member chip (#39, #45)"`

---

### Task 4: Workstream B - compact share chrome on trunk member chips

**Files:**
- Modify: `src/canvas/BusEdge.tsx` (member chip text/label/title :200-215; consume `busDisplayTotalRate` beside the existing :156 drop-chip use)
- Modify: `src/data/i18n.ts` (new key `canvas.chip.share` in all four locale blocks)
- Modify: `test/canvas/BusEdge.test.tsx` (:243, :287, :344-352, :524 - the plain-text pins on multi-member fixtures)

**Interfaces:**
- Consumes: `busMemberCount`, `busDisplayTotalRate`, `busTotalRate` - already stamped on lane members (`busRouting.ts:592-615`) and fan-out branches (:882-899).
- Produces: member chip text contract for Task 6's census: on `busMemberCount > 1`, chip text is `"{rate}/{displayTotal}"` (digits only, no unit); tooltip/aria carry the full share wording with the localized unit and the exact `busTotalRate`.

Key decisions: chip text is locale-independent digits (`${memberRateStr}/${displayTotalStr}`); the unit stays off the chip (120px `CHIP_BOX_WIDTH` clamp, zh/ru unit mismatch). New key `canvas.chip.share` mirrors `product.tap.share`'s per-locale wording but with the LOCALIZED unit (`canvas.rate.unit` values), e.g. en `"{rate} of {total}/min"`, and the zh/ja forms reuse that key's existing prefix words with `/分`. Single-member trunks and declined fan-outs (#43) unchanged.

- [x] **Step 1: Update the BusEdge test pins first** to the share form (e.g. `"60/120"` where the fixture's trunk totals 120) and add one pin that a single-member trunk still reads `"60/min"`. Run - fails.
- [x] **Step 2: Implement.** Branch on `memberCount > 1` where `riseText` is built; extend `riseLabel`/`riseTitle` via `i18n.t("canvas.chip.share", ...)`. Add the four locale strings.
- [x] **Step 3: Unit suite + typecheck + lint green.**
- [x] **Step 4: No-ellipsis check.** Rebuild; on each of default, battery5, battery5-xiranite, equip4 at fit zoom, assert via a throwaway page probe that no `.flow-chip` with share text has `scrollWidth > clientWidth`. Record worst-case width in the ledger.
- [x] **Step 5: Re-probe spot-check.** Seating extents are constants (`CHIP_HALF_W_WIDE`), so ratchet actuals must be BYTE-IDENTICAL to Task 3's - probe battery5-xiranite and default only; any delta is a STOP (it means text width leaked into seating).
- [x] **Step 6: Visual verification.** Zoomed crop of the default water/copper band: water members read as shares, copper trunk unchanged; hover shows the full wording. Fit capture for regressions.
- [x] **Step 7: Commit** `git commit -m "Render multi-member trunk chips as rate/total shares (#45)"`

---

### Task 5: Workstream C prerequisite - hoist junction-dot geometry ahead of seating

**Files:**
- Modify: `src/canvas/chipSeating.ts` (fan-in junctions from phase 3.5, divergence dots from phase 3.6 :1613-1665, lane junctions currently uncached, fan-out junctions in `fanoutGeomByIndex` :864-871)
- Test: `test/canvas/faninMarkers.test.ts` + the divergence dot spec (whichever file pins `fanout-junction-*` today - locate by `rg -n "fanout-junction" test/`)

**Interfaces:**
- Consumes: Task 3's reduced fan-in surface.
- Produces: `dotKeepoffs: ReadonlyArray<{x: number; y: number; kind: "lane" | "fanout" | "fanin" | "divergence"}>` available BEFORE seating phase 1, covering all four dot families. Task 6 consumes it. Dot POSITIONS must be identical to current behavior - this task is a pure reorder/cache.

- [x] **Step 1: Pin current dot positions.** Extend the existing marker tests to snapshot every junction coordinate on a fixture with all four families (or add fixtures). Run green BEFORE refactoring.
- [x] **Step 2: Hoist.** Compute/cache the four families' dot coordinates before phase 1; phases 3.5/3.6 consume the cache instead of recomputing. No seating behavior change.
- [x] **Step 3: Full unit suite green, positions byte-identical.** Re-probe battery5-xiranite only - actuals must be unchanged.
- [x] **Step 4: Commit** `git commit -m "Hoist junction-dot geometry ahead of the chip seating phases"`

---

### Task 6: Workstream C - junction-dot keepoff + committed census (#50)

**Files:**
- Modify: `src/canvas/chipSeating.ts` (seating tiers consume `dotKeepoffs`)
- Modify: `src/canvas/canvas.css` (:1750-1757 and :1819-1823 - update the chips-over-dots ruling comments: seating now avoids dots; z-order unchanged as the fallback)
- Modify: `test/e2e/geometry.ts` (new `auditDotsUnderChips`), `test/e2e/geometry-audit.spec.ts` (sixth soft table + NOTE-block update: enumerate the new ruling supersession)
- Test: unit fixture in `test/canvas/` for the keepoff (a seat that would cover a dot moves off it)

**Interfaces:**
- Consumes: `dotKeepoffs` from Task 5; share-chip text contract from Task 4 (census reads final chip boxes).
- Produces: `auditDotsUnderChips(chips, dots, fitZoom)` in `test/e2e/geometry.ts` returning covered dots; a pinned per-scenario baseline table.

Key decisions: keepoff rect = dot's graph-unit extent at the plan's FIT zoom (dot renders 3-5 screen px, `ItemEdge.tsx:325-339`) plus a small margin; hard-vs-scored tier is tuned by measurement so covered dots drop without new off-path escapes beyond standing rulings. Acceptance: corpus covered-at-fit <= 3 total, crystal and equip4 dots visible, each survivor justified in the ledger.

- [x] **Step 1: Write the census first.** Implement `auditDotsUnderChips` + the sixth geometry-audit table pinned to the CURRENT actuals (expect ~15 corpus-wide; harvest exact per-scenario numbers with a temporary probe). Commit the red-free baseline before touching seating.
- [x] **Step 2: Unit-test the keepoff** with a fixture chip whose preferred seat covers a dot; assert it seats clear. Run - fails.
- [x] **Step 3: Implement the keepoff**, starting as a scored cost in the graze tier (least invasive); escalate to a hard constraint only if measurement shows scored insufficient to reach <= 3. Record the tier choice and rationale in the ledger.
- [x] **Step 4: Re-harvest everything.** All five original tables plus the dot table, all seven scenarios, plus fit zooms. Keepoff relocates chips: attribute every moved cell; UP moves and any new off-path escape are a STOP for a user ruling. Re-pin the dot table to the new actuals (target <= 3 corpus-wide; if the scored tier lands above 3, STOP and report before escalating).
- [x] **Step 5: Update the css ruling comments.**
- [x] **Step 6: Visual verification.** Crystal and equip4 fit captures: the previously invisible dots are visible. battery5 Seed-Picking divergence crop: dot clear of the e:8 rise chip. Fit captures corpus-wide for regressions.
- [x] **Step 7: Full unit suite + e2e board green vs expected-red baseline. Commit** `git commit -m "Keep chip seats off junction dots and pin a dot-coverage audit (#50)"`

---

### Task 7: Workstream E1 - endpoint-parity audit

**Files:**
- Modify: `test/e2e/geometry.ts` (parity helper), `test/e2e/geometry-audit.spec.ts` (seventh soft table + NOTE update)
- Reference: `src/canvas/chipSeating.ts:783-833` (`PORT_DRIFT` + `edgeEndpoints` at :817)

**Interfaces:**
- Consumes: `edgeEndpoints`-equivalent reconstruction (model + `PORT_DRIFT`) vs the drawn path's first/last points from the collected SVG geometry.
- Produces: per-scenario max parity delta, pinned. Task 9 (E3) relies on this table to witness the cards[] frame move.

- [x] **Step 1: Measure before pinning.** Temporary probe printing per-scenario max |rebuilt - drawn| per axis. The code documents ~1 unit of reconstruction noise (`ItemEdge.tsx:180-183`) - expect maxima near 1, NOT 0.02.
- [x] **Step 2: Pin with small headroom** (measured max + ~0.5, per scenario). The table's job is catching row-index disagreements (deltas of a full row pitch), not sub-pixel noise.
- [x] **Step 3: Mutation-check**: temporarily zero one `PORT_DRIFT` entry; the table must go red. Revert.
- [x] **Step 4: Commit** `git commit -m "Add a per-edge endpoint-parity audit against the drawn frame"`

---

### Task 8: Workstream E2 - fan-in stamp on the drawn frame

**Files:**
- Modify: `src/canvas/chipSeating.ts` (fan-in run tx/ty from `edgeEndpoints` instead of raw model :1470-1471; the `FANIN_EPS` detection gate :1473 and the on-run hide test :1723-1726 both compare in the drawn frame)
- Test: `test/canvas/faninMarkers.test.ts`

**Interfaces:**
- Consumes: Task 3's surface (dot stamp + non-owner hide); `edgeEndpoints` (chipSeating.ts:817).
- Produces: `FANIN_EPS = 1` is a real tolerance (no longer saturated by the recipe `dy: +1` drift, and tx no longer omits `PORT_DRIFT.recipe.targetDx = -3`).

- [x] **Step 1: Write the saturation guard first.** A fixture where the target port sits at the drift-displaced position: current code's model-frame comparison sits exactly at eps (passes by luck); assert detection still holds when dy grows to 2 in the DRAWN frame - fails on current code (the loud failure `faninMarkers.test.ts` exists for).
- [x] **Step 2: Derive tx/ty via `edgeEndpoints`**, update both comparisons. Existing fan-in fixtures must still detect their merges.
- [x] **Step 3: Full unit suite green; rebuild + re-probe default and battery5-xiranite** (fan-in stamps can move dots/hides): attribute any dot-table or chip-table delta; visual crop of the sewage run if anything moved.
- [x] **Step 4: Commit** `git commit -m "Stamp fan-in runs in the drawn frame so FANIN_EPS is a real tolerance"`

---

### Task 9: Workstream E3 - cards[] to the drawn frame (atomic)

**Files:**
- Modify: `src/canvas/chipSeating.ts` (`cards[]` construction :950-960 moves to the drawn frame: 302-wide border box at the drawn position, consistent with `PORT_DRIFT`'s derivation comment; the `chipEntersOwnCardBody` frame assumptions and the `PORT_ZONE_DEPTH` application move in the SAME commit)
- Test: existing `chipSeating` unit fixtures; `test/e2e/geometry-audit.spec.ts` tier-1

**Interfaces:**
- Consumes: Task 7's parity table (witnesses the frame move: parity deltas must NOT change, card-relative audits may).
- Produces: seating and the e2e audit measure card boxes in the same frame; the audit itself does not relocate (it imports the predicate, `test/e2e/geometry.ts:13`, and already collects drawn-frame rects).

- [x] **Step 1: Pre-measure.** Detached probe of all seven scenarios at HEAD (this is the Task 6 post-state) - the diff baseline.
- [x] **Step 2: Move `cards[]` + predicate assumptions + depth application in one commit.** `bunx tsc --noEmit` + unit suite; fixtures that hand-build cards need their coordinates shifted by the border delta (300 -> 302 box), which is the test-update signature of the frame move.
- [x] **Step 3: Re-harvest all tables + fit zooms.** Expect small chipSeg/ownPierce/graze shifts (2px-frame corrections); attribute each; DOWN free, UP is a STOP. Parity table unchanged.
- [x] **Step 4: Visual spot-check** (battery5-xiranite band crop) + **commit** `git commit -m "Measure seating card boxes in the drawn frame"`

---

### Task 10: Final board, sign-off, PR

**Files:**
- Modify: this plan (checkboxes + close-out), ledger.

- [x] **Step 1: Full e2e board** (all specs, one scenario per invocation) vs the expected-red baseline; full vitest; tsc; lint. Correct the stale `~0.28` calibration comment near `CHIP_ICON_ONLY_MAX_ZOOM` (`ItemEdge.tsx:158`) with the harvested figure.
- [x] **Step 2: Re-take #45's two evidence captures** (band fit, sigma-vs-junction location) showing the Sigma gone and "30/270" on the water trunk; capture a formerly-covered dot for #50.
- [x] **Step 3: Visual sign-off** across the five fit captures + crops; record verdicts in the ledger.
- [ ] **Step 4: PR to develop.** Title/body per `docs/pr-guideline.md`, run through the humanizer skill. Push, verify CI green.
- [ ] **Step 5: After the user merges: close #39, #45, #50 with evidence comments** (before/after captures, census numbers). Transcribe any mid-campaign rulings into this plan's close-out section.

## Acceptance criteria (from the spec)

- #39/#45/#50 closable with evidence; water trunk reads "30/270"; Sigma gone; crystal/equip4 dots visible; dot census <= 3 corpus-wide.
- No ellipsized share chip in the corpus; battery5-xiranite fit zoom >= 0.35 throughout; battery5 RAW stays clean; no unattributed ratchet moves; UP moves user-ratified.
- `bunx tsc --noEmit`, lint, vitest, e2e board green vs expected-red baseline.

## Close-out

### Final board (Task 10 Step 1)

`bunx vitest run` 133 files, 1378 passed / 1 skipped. `bunx tsc --noEmit` clean,
`bun run lint` clean. E2e board run one scenario per invocation across every spec
file: geometry-audit 20 passed / 1 failed (multi6 tier-1 RAW, the ratified red;
battery5 RAW clean), inputs-panel 4 failed and raw-and-transport 1 failed (the
pre-existing product-node pin family), everything else green. No unexpected red.

`placement-shots` opened 3 red - crystal, equip4 and tundra over their pixel
budgets against local goldens written two commits before the Task 6 keepoff. The
tundra expected/actual pair was compared before regenerating: structurally
identical, whole canvas shifted ~2px, a pure fit-camera translate from the
chip-extent changes feeding `contentBounds`. Goldens regenerated (they are
gitignored and never committed); the board then passes 7/7.

Fit zooms unchanged from the Task 9 post-state: default 0.899871, battery5
0.448487, battery5-xiranite 0.352658 (0.0027 above `LABEL_MIN_ZOOM`, no STOP),
crystal 0.503433, equip4 0.436267, multi6 0.206472, tundra 0.655221.

The `CHIP_ICON_ONLY_MAX_ZOOM` comment's stale figures were replaced from that
table: at 0.32 the gate separates multi6 (0.21, the only plan that collapses)
from battery5-xiranite (0.353, above `LABEL_MIN_ZOOM`, so nothing collapses on it
either), with the other five plans between 0.44 and 0.90.

### Rulings carried out of the campaign

All four rulings below were controller best-judgment calls made mid-campaign
and are **pending user confirmation at sign-off**.

- **Task 6 census ruling (provisional).** Authorized the icon-only collapse of
  short-leg fan-out branch chips to clear census survivors 1-4, and accepted the
  two remaining covered dots: battery5-xiranite `fanin-junction-e:14` (89 units
  of reach against the ~93 its drawn box needs - this is the named must-clear
  case from Task 3, and it is **left standing**) and multi6 `e:74` (crowding),
  both falling back to z-order. Dot-move and hard-constraint remedies were not
  taken. Executed by Task 6b exactly as authorized: census 10 -> 6 -> 2,
  acceptance target (<= 3) met. Attributed cost: multi6 fit zoom 0.208893 ->
  0.206472 for one revealed dot; multi6 `paddedGrazes` 1 -> 0 deliberately NOT
  re-pinned (camera-rounding artifact). If survivor 5 is not accepted after all,
  the remedy is moving the dot - the collapse cannot reach an item edge on a long
  leg.
- **Task 7/9 re-scope ruling (provisional).** The endpoint-parity table is a
  NEGATIVE CONTROL ("the port frame within the card did not move"), not the
  witness of Task 9's `cards[]` frame move: it anchors on the drawn origin and
  cancels the model-vs-drawn term by construction. Task 9's actual witnesses are
  the card-relative tables, the unit fixtures whose hand-built card coordinates
  shift by the 300 -> 302 border delta, and a new pinned assertion that a
  recipe's drawn width equals what `cards[]` claims (RED 302 vs 300 before the
  move, GREEN after).
- **Ruling 7 amendment (provisional).** The spec sized the dot keepoff "at the
  plan's fit zoom", but seating runs before a camera exists, so there is no fit
  zoom to read at that point. The implementation uses a single corpus-worst-case
  constant instead, `DOT_KEEPOFF = 16`, sized for the corpus's lowest fit (~0.21,
  multi6). This is a miss in the spec's constraint rather than a deviation in the
  implementation: a per-plan sizing would make every seat move with the camera.
- **Aria display-total acceptance (provisional).** Task 4's brief said the
  tooltip and aria label both carry the exact `busTotalRate`. The implementation
  gives aria the DISPLAY total, matching the pre-existing `dropLabel` /
  `dropTitle` convention, because a screen reader speaking a 17-digit exact
  fraction is worse than one speaking the number on the chip. Accepted
  deviation; the `title` attribute still carries the exact total.

### Residuals and follow-ups

- **Task 6b hover residual.** A hovered collapsed branch chip re-expands to
  digits and re-covers its dot for as long as the pointer rests there. This is
  the deliberate focused-overrides-compact contract; the census measures the
  resting state, and seat/render box agreement holds at rest only. A hovered chip
  may also transiently overlap a neighbour.
- `entryBandOf` (both `chipSeating` copies) still builds the arrival band from the
  model `nodeHeight` while the e2e mirror uses the drawn rect - the same 2px frame
  class Task 9 closed for `cards[]`, one level down. Moving it moves seats.
- `contentBounds` still unions model node boxes, so fit frames a recipe two units
  short. Moving it shifts all seven fit zooms against battery5-xiranite's 0.0027
  of headroom.
- Task 9 loosened the audit's own-card tier by 1px (shared predicate, drawn frame)
  while tightening seating's foreign gate by 2px - both correct per the
  derivation, noted for interpreting future tier-4 moves.
- Watch item from Task 4: the worst-case share chip (battery5-xiranite
  "297.95/717.95") draws 110px against the 120px `CHIP_BOX_WIDTH` clamp. One more
  digit on a future pack silently ellipsizes; the tooltip keeps the full value.
- The zh/ja share wording reuses `product.tap.share`'s prefix words in a new
  position (brief-pinned by user ruling) and is still worth a native-reader check.
