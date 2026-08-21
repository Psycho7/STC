# Trunk-rate legibility and seating-frame follow-ups

Design for the campaign closing issues #39, #45 and #50, plus the contract pin
tests and the three seating-frame follow-ups deferred from PR #47. Rulings in
this document were made by the user on 2026-08-21; the second batch followed a
two-auditor spec audit the same day.

## Context

PR #44 removed the multi-member bus aggregate chip (issue #39's bus half): a
multi-member trunk draws no summed total, only member chips and the junction
dot. Two residuals followed (issue #45):

1. The fan-in Sigma chip still exists (built in `chipSeating.ts` phase 3.5,
   seated in phase 5, rendered in `ItemEdge.tsx`) and on the default plan
   seats ~216px from its merge junction, so the binding-by-adjacency it
   depends on does not happen on the first plan a user opens. Any member chip
   that seats on the shared run is suppressed in its favor.
2. With the bus aggregate gone, the water trunk's only visible lane number is
   the surviving "30/min" member chip (the 240/min member's rise chip is
   cascade-hidden), which reads as the 270/min trunk total.

Separately, the short-leg campaign's sign-off census found 15 of 59 corpus
junction dots fully covered by chip boxes, with every fan-in/bus dot invisible
on crystal and equip4 (issue #50), and PR #47 deferred three frame-alignment
follow-ups.

## Rulings

1. **Remove the fan-in Sigma chip.** Mirror the bus-aggregate ruling: the card
   rates and member chips carry the information. The fan-in junction dot stays.
2. **Member chips on multi-member trunks read as shares.**
3. **Share chrome applies to every multi-member trunk member** - bus-lane rises
   and fan-out branches alike. Declined fan-out groups (#43's divergence
   family) are OUT of scope: they are plain item edges with no
   `busMemberCount`, and their divergence dots plus per-branch chips already
   mark the split.
4. **Share form is compact**: the chip renders rate and trunk total as a
   solidus pair; the full "x of N/min" wording lives on the tooltip. The chip
   text must fit the existing 120px `CHIP_BOX_WIDTH` clamp - the box does not
   widen and the seating extents do not change.
5. **Fan-in restore is owner-only.** The shared-run hide mechanism stays for
   non-owner members (their rates read on their own leg segments); only the
   owner's plain rate chip returns, under the ordinary member-chip rules.
6. **N is the drawn trunk's total** (`busDisplayTotalRate`), not the source
   card's full output. Sub-trunks split by `FANOUT_SPAN_MAX` show their own
   total; the card row states the full output.
7. **Dot keepoff is sized at fit zoom**: the keepoff rect is the dot's
   graph-unit extent at the plan's fit zoom plus a small margin, and the
   acceptance bound is numeric (see Workstream C).

## Workstream A: fan-in Sigma removal (#45-1, closes #39)

Deletion inventory (the Sigma lives entirely in `chipSeating.ts` and
`ItemEdge.tsx`; `busRouting.ts` has no fan-in code):

- `chipSeating.ts`: phase 3.5 sigma-job construction, phase 5 deferred
  seating, the `edges.map` stamp of `faninSigmaX/Y/Dx/Dy`, the
  total/display-total accumulation and its DEV rate-less tripwire, the
  `ChipAnchorData` fields and the `contentBounds` reader of the sigma box.
- `ItemEdge.tsx`: the `faninSigma*` data fields plus the companion
  `faninTotalRate` / `faninDisplayTotalRate` / `faninMemberCount`, the
  sigma chip render, the FlowChip `variant="sigma"` and `marker` props and
  their icon-only survival path, and the `CHIP_ICON_ONLY_MAX_ZOOM` doc line
  naming the fan-in aggregate as an exempt family.
- `canvas.css`: `.flow-chip.sigma`.
- `.claude/workflows/render-quality-exam.js` exam prose still describing
  Sigma totals (stale since PR #44, a known false-finding source, issue #35).

Kept, per ruling 5:

- The fan-in junction dot, its placement and staleness rules, unchanged.
- The shared-run hide for non-owners (`faninChipHidden`, `faninChipHiddenAtY`,
  `faninMemberRunByIndex`) and its hover fallback.
- The Sigma-motivated group filters (`faninExcludedKeys`, the short-run skip)
  keep gating the dot exactly as today; expanding dot coverage to previously
  excluded merges is explicitly out of scope.
- The owner's restored chip is zoom-gated like any member chip. Accepted
  consequence: below `LABEL_MIN_ZOOM` a fan-in port shows no number (the
  Sigma was gate-exempt); the target card still states the total.

Tests: the two Sigma cases in `ItemEdge.test.tsx`, the Sigma half of
`faninMarkers.test.ts` (the owner/non-owner hide fixture stays), and the stale
comment in `shortLegChips.test.ts` are rewritten to pin the new contract: no
Sigma anywhere, dot present, owner chip restored and gated, non-owner hide
intact.

## Workstream B: share chrome on trunk member chips (#45-2)

- Any member chip on a trunk with `busMemberCount > 1` renders the compact
  share form: rate, solidus, drawn-trunk total - e.g. "30/270" - via a new
  chip-level i18n key. The unit stays OFF the chip (avoids the 120px clamp for
  decimal pairs like "133.33/266.67" and the zh/ru unit mismatch that copying
  `product.tap.share` verbatim would cause - that key hardcodes "/min" while
  chips localize via `canvas.rate.unit`). The tooltip carries the full
  per-locale "x of N/min" wording with the localized unit.
- Chip text uses `busDisplayTotalRate` so visible members sum to the shown
  total; the tooltip may carry the exact `busTotalRate`. Both fields already
  reach lane members and fan-out branch members.
- Applies in `BusEdge.tsx`'s shared member-chip markup. Single-member trunks
  keep plain "x/min". Icon-only collapse, zoom gate, and all seating extents
  are unchanged - `CHIP_HALF_W_WIDE` is a fixed constant, so B causes zero
  seating churn by construction.
- Tests: the plain-text pins on multi-member fixtures in `BusEdge.test.tsx`
  (the "60/min" rise pin and its siblings) move to the share form.
- Acceptance: no share chip ellipsizes anywhere in the corpus (the `.chip-text`
  overflow rule truncates silently; the census/probe must check).

## Workstream C: junction-dot keepoff (#50)

- Junction dots - bus-lane, fan-out trunk (every bus member draws one),
  fan-in, and divergence `fanout-junction-*` - become keepoff rectangles in
  the chip seating pass.
- Sizing per ruling 7: the dot's graph-unit extent at the plan's fit zoom
  plus a small margin. Whether the keepoff is a hard invariant or a scored
  cost is tuned by measurement against that fixed geometry.
- Structural prerequisite: dot positions must be known before seating phase 1.
  Fan-in junctions are computed in phase 3.5, divergence dots in 3.6, and
  lane/fan-out junction points are not cached at all today - hoisting all four
  dot families ahead of the chip phases is an explicit task, not incidental.
- This supersedes the ratified chips-over-dots stance recorded in
  `canvas.css` and the short-leg plan: seating now avoids dots up front. The
  z-order itself stays (chip digits still win when an overlap survives); the
  css comments are updated to name this campaign's ruling.
- Acceptance: a committed census helper (dot-coverage check alongside the
  e2e geometry audit) reports covered-at-fit dots; corpus-wide count drops
  from 15/59 to at most 3, each survivor individually justified in the
  ledger. The crystal and equip4 dots (2/2 covered today) become visible.

## Workstream D: contract pin tests

Two silent-delete risks get one small spec each (no behavior change):

- The container `elk.spacing.nodeNode` option string the short-leg campaign
  introduced: `slabSpacing.test.ts` pins the between-layers behavior and
  `layout-invariants.test.ts` pins only the root-level string; nothing pins
  the container-level option.
- `PORT_ZONE_DEPTH = 8` is coupled to the `.rn-row` 8px port inset only by
  comments; a test ties the constant to the CSS value.

## Workstream E: seating-frame follow-ups (PR #47 deferrals)

1. **Per-edge endpoint-parity ratchet**: an audit comparing endpoints rebuilt
   from the layout model PLUS `PORT_DRIFT` against the drawn frame, to catch
   the row-index disagreements the drift probe cannot see. The tolerance is
   set by measurement, not assumed: the code documents up to ~1 unit of
   reconstruction noise against React Flow's measured handles, so the plan
   harvests the corpus maximum first and pins with small headroom.
2. **Fan-in stamp frame fix**: the fan-in run stamps merge-x from the drawn
   polyline but tx/ty from the model (`tx` additionally omits
   `PORT_DRIFT.recipe.targetDx = -3`), and `FANIN_EPS = 1` is exactly
   saturated by the recipe dy of +1 in TWO places: the detection gate and the
   on-run hide test. Derive tx/ty from `chipSeating.edgeEndpoints` and move
   both saturated comparisons onto the drawn frame so the epsilon is a real
   tolerance again. After Workstream A the surviving fan-in surface is the
   junction stamp plus the non-owner hide logic; `faninMarkers.test.ts`
   guards the failure mode loudly.
3. **cards[] to drawn frame, both-or-neither**: the e2e audit imports
   `chipEntersOwnCardBody` from `chipSeating.ts` (there is no copy), and its
   card rects are already drawn-frame DOM boxes, while the seating pass
   builds `cards[]` from the model (300-wide at `node.position` vs the 302
   border box). The atomic unit is therefore the seating `cards[]`
   construction together with the predicate's frame assumptions and the
   `PORT_ZONE_DEPTH` derivation it applies - moved in one change; nothing in
   the audit itself relocates.

## Out of scope

- Declined fan-out (#43) share chrome (ruling 3).
- Expanding fan-in dot coverage to `faninExcludedKeys` / short-run merges.
- The copper trunk's "no lane numbers at fit" state (accepted ruling; share
  chrome only changes chips that already render).
- chipIconOnly drag-staleness and the narrower icon-only seat half-extent.
- The multi6 tier-1 RAW expected-red family.

## Acceptance criteria

- Issues #39, #45 and #50 closable with evidence; #45's two captures
  re-taken showing the Sigma gone and the water trunk reading "30/270".
- Pre-change ratchet harvest with the preserved probe
  (`.superpowers/sdd/ratchet-probe.spec.ts.keep` in the short-leg worktree)
  before any code change; every moved cell attributed by detached-build
  differential probes; UP moves need an explicit user ruling.
- Full board green against the expected-red baseline: multi6 tier-1 RAW,
  inputs-panel 4, raw-and-transport 1, placement-shots first-run seeding.
  battery5 RAW stays clean.
- Mandatory visual protocol after each render-affecting workstream: fit
  captures (default, battery5, battery5-xiranite, equip4, multi6) plus zoomed
  crops of the water/copper band, the sewage fan-in run, and a
  previously-covered junction dot.
- No ellipsized share chip in the corpus (Workstream B check).
- `bunx tsc --noEmit`, lint, and the full vitest suite clean.

## Dependencies and ordering constraints

- A before E2 (deleting the Sigma seat logic first shrinks the fan-in stamp
  surface E2 must touch).
- A and B before C: A changes the chip population near fan-in dots and B
  changes chip text, so C's census baseline and tuning are measured once,
  after both. (B itself moves no seat - fixed extents.)
- E3 is atomic (both-or-neither); E1 lands before E3 so the parity ratchet
  witnesses the cards[] move.
- D is independent and can land any time.
- Fit-zoom guard: the fit camera derives from `contentBounds`, which unions
  chip boxes - so A (restored chips) and C (relocated chips) can move it
  without touching graph width. battery5-xiranite sits 0.0027 above
  `LABEL_MIN_ZOOM` 0.35; re-measure its fit zoom after EVERY workstream, and
  no workstream may grow the contentBounds rect. The stale ~0.28 calibration
  comment near `CHIP_ICON_ONLY_MAX_ZOOM` gets corrected during the first
  harvest.
