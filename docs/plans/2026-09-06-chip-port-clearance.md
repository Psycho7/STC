# Chip port clearance (#82) and the OFF-mode fan-out fix

Campaign doc, 2026-09-06. Branch `fix/off-fanout-port-clearance`. Two parts,
executed in order; every measurement cited below is a committed baseline cell
or a run log kept with the session.

## Part A: fan-out trunks stay formed with bus lanes off

`layoutRenderPlan` used to drop BOTH `routeBusEdges` and `routeFanoutEdges`
when `busLanesEnabled === false`, but a fresh browser reads as OFF -- so the
landing render never consolidated same-source groups: the default plan's
copper pair drew as two plain item edges, the 240/min chip seated on the
shared trunk prefix burying the split, and the 30/min chip took a nudge seat
48 units off its line. The fix drops only the lane pass (the classifiers read
disjoint span bands, so un-laned input feeds the fan-out pass exactly the
members it would have seen anyway).

Delivered, in landing order:

- The geometry audit gained a lanes on/off mode dimension; all thirteen
  baseline tables plus CENSUS_TOTALS are two-level per mode, OFF arms measured
  write-then-compare in two passes (pre-change, post-change). Every OFF cell
  fell or held A->B except CROSSING default 2 -> 4, the ratified restoration's
  own arithmetic (the count lands at exactly the on-mode figure).
- `edge-span-census` pins the new contract: OFF yields zero `laneY` stamps but
  keeps `fanout`-stamped trunks (red if the filter is widened again).
- render-conventions.md states the setting gates lanes only and names the exam
  capture's forced-on load as a known coverage gap.
- The ON render was proven unmoved: by construction (one removed conjunct),
  by audit (green at pinned values, modulo multi6's standing e:97 RAW pierce),
  and by pixels (placement-shots bit-identical against parent goldens on every
  exact-match scenario). chip-widths green in all four locales with a local
  OFF flip.

## Part B: chips clear of ports and row text (#82)

The placement ruling: a chip never covers its own endpoint card's port handle,
glyph or row text; it prefers the middle of the longest straight run. Off-line
seats are never the way to clear a port.

Delivered: the port furniture is modelled (`PORT_FURNITURE_OUT`, full-height
`portKeepOutRect` bands pinned to the drawn glyph edges), the band is a HARD
keep-out in the on-line, sidestep, graze and escape tiers, the short-leg
collapse reads the band-subtracted LARGEST CLEAR SPAN (with the split dot's
keep-off subtracted on branch legs), and each chip carries a per-chip
counter-scale cap (`chipScaleCap` / `fanoutBranchScaleCap`) so the widest box
it can ever draw fits the window its seat reserved.

Result at the wholesale re-measure, both modes:

- PORT_COVER: ZERO everywhere (first recording: 12 of 17 chips on default,
  5 of 7 on tundra, 31 on multi6).
- CARD_INTRUSION: ZERO everywhere (was 77 on-mode corpus-wide) -- the band's
  inner edge is exactly the intrusion budget.
- DOT_COVER: one residual (rot-bottled_food_4 on, a re-seated share chip over
  its own junction dot).
- The whole geometry audit is green at the pinned values except multi6's
  standing e:97 RAW pierce in both modes, the same documented failset the
  corpus carried before the campaign.

### B5 is CUT: the layer-gap widening failed its own gate

B0's frame measurement (fit zoom / content w x h / layer columns, on-mode):

| scenario           | zoom   | content   | layers | largest spacing before 0.35  |
| ------------------ | ------ | --------- | ------ | ---------------------------- |
| default            | 0.900  | 1548x558  | 5      | ~718                         |
| battery5           | 0.446  | 3120x1459 | 10     | ~205                         |
| battery5-xiranite  | 0.3498 | 3982x2078 | 14     | ~110 (at the line)           |
| crystal            | 0.503  | 2767x577  | 8      | ~283                         |
| equip4             | 0.436  | 3193x645  | 9      | ~208                         |
| multi6             | 0.220  | 4176x3901 | 12     | height-bound (already below) |
| tundra             | 0.655  | 2126x310  | 6      | ~480                         |
| script43           | 0.463  | 3008x1577 | 9      | ~231                         |
| coupon-web         | 0.616  | 2156x1392 | 8      | ~370                         |
| gas-web            | 0.507  | 2422x1692 | 8      | ~332                         |
| rot-bottled_food_3 | 0.533  | 2614x1091 | 9      | ~280                         |
| rot-bottled_food_4 | 0.456  | 3058x1144 | 8      | ~242                         |

Every unwrapped plan fits `zoom = min(1920/cw, 1080/ch) / 1.378` exactly and
is width-bound. battery5-xiranite measures **0.3498** -- already a hair UNDER
LABEL_MIN_ZOOM 0.35 -- so ANY spacing widening crosses hard (145 projects
~0.314, hiding every label chip at fit on that plan in both modes). The plan
made B5 severable for exactly this outcome; BETWEEN_LAYERS_SPACING stays 110
and #82 closes on the seating rules alone, at a higher icon-only count.

### The trade, recorded for ratification

Every port-covering seat the band outlawed had to go somewhere. On the crowded
plans it went to escapes and collapses, and four soft ratchets rose
corpus-wide (on-mode): CHIP_OFFPATH 0 -> 27, SEAT_VALIDITY 5 -> 36,
CHIP_SEGMENT 26 -> 46, FOREIGN_STROKE 40 -> 59. The mechanism is uniform --
the F1 deep-class chips and backward-rail chips whose ONLY on-line seats were
the port-covering ones now escape (their boxes cross more foreign lines from
the new seats), and short corridors collapse honestly (CHIP_COLLAPSE
coupon-web 0 -> 8, battery5-xiranite 2 -> 5, with B5 cut). Two seat
robustness fixes landed with the re-measure: a half-unit frame margin on the
foreign raw card (an eps-flush seat flipped the hard e2e gate on camera
rounding), and the escape cascade now keeps off the own-port band too (its
residue is what PORT_COVER: 0 rests on).

PENDING USER RATIFICATION (R7 precedent -- pinned by the controller, ratified
after): the four risen soft tables above, as one named trade ("the port-band
eviction"), against PORT_COVER and CARD_INTRUSION at zero. If the trade is
refused, the alternative is hiding the evicted item chips (overturns ruling
R5) or re-widening corridors (blocked by the B5 gate on battery5-xiranite).

### Deviations from the plan text

- The Task-6 corridor fixture's three siblings stay FULL under the implemented
  clipped-band window (its 106-unit window holds the 94.5 natural box); the
  plan's accept predicted collapsed there, which matches an unclipped
  subtraction. The clipped window is the geometric truth ("fits BETWEEN the
  ports' furniture") and the default plan's copper pair still collapses on
  its own legs via the branch-leg measure, which is the visual acceptance.
- The chain-clash drift fixture is structurally gone under capped reserves
  (two adjacent-corridor chips can no longer reach each other); its numeric
  pin moved to the seat suite as a pre-seated clash.
- `bun run format` and repo-wide `bun run lint` are pre-existing red on this
  machine's checkout (191 unformatted files on clean develop; one eslint
  error inside an untracked, gitignored `.claude/worktrees`). All campaign
  files are prettier- and eslint-clean.
