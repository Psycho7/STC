# Trunk-rate legibility and seating-frame follow-ups

Design for the campaign closing issues #39, #45 and #50, plus the contract pin
tests and the three seating-frame follow-ups deferred from PR #47. Rulings in
this document were made by the user on 2026-08-21.

## Context

PR #44 removed the multi-member bus aggregate chip (issue #39's bus half): a
multi-member trunk draws no summed total, only member chips and the junction
dot. Two residuals followed (issue #45):

1. The fan-in Sigma chip still exists (`ItemEdge.tsx`, anchor fields
   `faninSigma*`) and on the default plan seats ~216px from its merge junction,
   so the binding-by-adjacency it depends on does not happen on the first plan
   a user opens. It also suppresses the shared-run member's own rate chip.
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
2. **Member chips on multi-member trunks read as shares**: "x of N/min",
   matching the raw-tap share chip language already shipped in PR #44.
3. **Share chrome applies to every multi-member trunk member** - bus-lane rises
   and fan-out branches alike. One rule, no per-kind exceptions.

## Workstream A: fan-in Sigma removal (#45-1, closes #39)

- Delete the Sigma chip render (`variant="sigma"`), its anchor fields
  (`faninSigmaX/Y/Dx/Dy`) end to end (`busRouting.ts` emission,
  `chipSeating.ts` seating entry, `ItemEdge.tsx` render), and the
  `chipSeating.ts` code that reserves the junction-side seat for it.
- The fan-in junction dot keeps its current placement and staleness rules; it
  remains the merge marker, exactly as bus trunks keep theirs.
- Restore the shared-run owner member's plain rate chip, which is currently
  suppressed because "the summed Sigma reads there instead" (`ItemEdge.tsx`).
  It follows the ordinary member-chip rules (zoom gate, hover, staleness).
  Fan-in member chips stay plain "x/min": a fan-in is not a trunk share; the
  total lives on the target card.
- Tests pinning Sigma behavior (`faninMarkers.test.ts` and related unit
  coverage) are rewritten to pin the new contract: no Sigma chip anywhere, dot
  present, shared-run member chip restored and gated normally.

## Workstream B: share chrome on trunk member chips (#45-2)

- Any member chip on a trunk with `busMemberCount > 1` renders "x of N/min"
  via a new chip-level i18n key with the same wording per locale as
  `product.tap.share`. `busTotalRate` already reaches member edge data.
- Applies in `BusEdge.tsx`'s shared member-chip markup, covering both lane
  rises and fan-out branches. Single-member trunks keep plain "x/min".
- Icon-only collapse and the label zoom gate are unchanged; the wider chip box
  flows through the normal seating pass and its ratchet discipline.

## Workstream C: junction-dot keepoff (#50)

- Junction dots (bus-lane, fan-in, and divergence `fanout-junction-*`) become
  keepoff rectangles in the chip seating pass, so a seat that would cover a
  dot is avoided the way card bodies already are.
- Whether the keepoff is a hard invariant or a scored cost (like the graze
  scan's foreign-line count) is an implementation decision made by
  measurement: the tier is chosen so covered dots drop corpus-wide without
  creating new off-path escape seats beyond standing rulings.
- Acceptance: the crystal and equip4 dots (2/2 covered each today) become
  visible; the corpus covered count drops from 15/59 to at most a handful,
  each survivor individually justified in the ledger.

## Workstream D: contract pin tests

Two silent-delete risks get one small spec each (no behavior change):

- The container `elk.spacing.nodeNode` option string the short-leg campaign
  introduced: `slabSpacing.test.ts` pins the between-layers behavior but
  nothing pins the option string itself.
- `PORT_ZONE_DEPTH = 8` is coupled to the `.rn-row` 8px port inset only by
  comments; a test ties the constant to the CSS value.

## Workstream E: seating-frame follow-ups (PR #47 deferrals)

1. **Per-edge endpoint-parity ratchet**: an audit comparing endpoints rebuilt
   from the layout model against the drawn frame, within ~0.02 units, to catch
   row-index disagreements the drift probe cannot see.
2. **Fan-in stamp frame fix**: the fan-in marker family takes x from the drawn
   frame and y from the model, and `FANIN_EPS = 1` (`chipSeating.ts`) is
   exactly saturated by the recipe dy of +1. Derive tx/ty from
   `chipSeating.edgeEndpoints` so the epsilon is a real tolerance again.
   `faninMarkers.test.ts` guards the failure mode loudly. This work survives
   Workstream A: the dot and member-chip logic still use the fan-in stamp.
3. **cards[] to drawn frame, both-or-neither**: move the seating pass's
   `cards[]` into the drawn frame together with `chipEntersOwnCardBody` and
   the e2e audit's copy of the predicate (`test/e2e/geometry.ts`), in one
   change - the predicate is shared verbatim, so a partial move desynchronizes
   the audit from the app.

## Out of scope

- The copper trunk's "no lane numbers at fit" state is an accepted ruling and
  stays (share chrome only changes chips that already render).
- chipIconOnly drag-staleness and the narrower icon-only seat half-extent
  (recorded residuals, low value).
- The multi6 tier-1 RAW expected-red family.

## Acceptance criteria

- Issues #39, #45 and #50 closable with evidence; #45's two captures
  re-taken showing the Sigma gone and the water trunk reading "30 of 270/min".
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
- `bunx tsc --noEmit`, lint, and the full vitest suite clean.

## Dependencies and ordering constraints

- Workstream A before E2 (deleting the Sigma seat logic first shrinks the
  fan-in stamp surface E2 must touch).
- Workstream B before C (share chrome widens chips; the keepoff tier is tuned
  against final chip boxes so the ratchet churn is measured once).
- E3 is atomic (both-or-neither); E1 lands before E3 so the parity ratchet
  witnesses the cards[] move.
- D is independent and can land any time.
- battery5-xiranite fit zoom is 0.352658, 0.0027 above `LABEL_MIN_ZOOM` 0.35:
  no workstream may grow the plan's graph width, or ~40 chips drop under the
  label LOD and the chip-tier ratchets need a wholesale re-measure.
