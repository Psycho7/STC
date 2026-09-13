# Render conventions

What the STC blueprint canvas is trying to draw, in prose. It is the briefing a
render-quality evaluator gets: the exam workflow splices this file whole into the
evaluator's prompt, and an evaluator that has not been told a rule reports the
rule itself as a defect. So it has to describe the renderer as it stands rather
than as it was once designed. A PR that changes a rendering rule updates this
doc in the same PR.

It holds design knowledge only. Measurements, open issues and past exam findings
stay out: an evaluator that has seen them is agreeing with them, not judging the
pixels.

## Cards

A recipe card has a header carrying the machine icon, the machine name and the
machine multiplier (xN), then input rows down its left side and output rows
down its right, each row ending in a port handle with a small item glyph.
Output rows read in the recipe's own declared order, so two cards of one recipe
read alike. At rest a card shows no digits anywhere: no rate column, no
products line, no footer. Each row's rate appears as an overlay at the row's
inner end when the pointer is over the card or the card is selected, and it is
hidden again under the low-zoom band. Cyan product chips are boundary inputs
and outputs rather than machines. Group slabs and loop boxes are containers,
and the cards inside one are its members.

An item imported at the boundary draws one input chip. Consumers outside any
container draw straight from that chip; a container gets a chip of its own,
marked as a tap and fed by the item's chip, because an edge entering a
container has to enter it once. So several tap chips of one item mean several
containers, not several consumers.

A name too long for its row or its title elides
tail-first: a distinguishing trailing bracket group or word is kept whole with
the ellipsis in front of it. When the whole tail cannot fit beside a readable
head, a partial tail is preserved instead -- a window into the tail over the
same minimum readable length, opening from the tail's stem for a bare word
whose whole base survives beside the ellipsis, and otherwise from the tail's
distinguishing end (leading for Latin and CJK tails, trailing for Cyrillic,
where the species word comes last) -- and only a name with no such tail, or no
window that clears the minimum, falls back to plain tail ellipsis. Chinese
tier prefixes (a leading 优质/精选-style
affix) are the one naming shape a tail rule cannot protect; those names are
short enough not to clip at card width.

Below the input rows a card may carry catalyst rows: inputs the machine cycles
rather than consumes, drawn from the plan boundary and handed straight back
every cycle. No producer is ever built for a catalyst, so the charge arrives
from the item's boundary supply card over an edge of its own, landing on a
`cat:<item>` handle at the row's left -- the same x as the input handles, at the
row's centre -- and the row shows the item's transport glyph like a port row
does. The boundary card's rate counts that draw alongside ordinary consumption,
so the card and the inputs panel read the same number. One card can carry the
same item on an input row and a catalyst row; the two take separate handles and
separate edges. A catalyst row keeps no accent tab, its label is muted a step
below the supplied rows, and its rate is the draw for one machine with its unit
spelled out ("6/min") rather than the flow across every machine that the port
rows above it carry.

The behaviour is behind the `CATALYST_SUPPLY_EDGES` code flag (`src/flags.ts`),
on by default; with it off a catalyst row carries no handle and no edge, wears a
small filled disc in the glyph slot, and the inputs panel adds the cycled draw
onto the supply row itself.

Some recipes only run inside a gas environment, which the player builds a
disperser for. Such a card states its requirement as a frame around the card
rather than as a mark inside it: a plate of chevrons above the card, a
single-row plate below it, and a faint tint of the environment's colour with
a soft glow behind the card. The upper plate is two rows tall, blue for a
stable environment and yellow for an acidic one, and carries a dark glyph at
its centre that names the environment: two peaks for a stable one, four
teardrops for an acidic one. The lower plate is one row of the same chevrons,
so every triangle is the same size on both plates, and it carries no glyph.
The space between the plates at the card's sides stays open, and the card's
own border keeps its neutral colour; selection keeps its lime border while
the plates keep the environment colour. Hovering the card names the
environment. The frame is a build requirement rather than a detail figure, so
it draws at every zoom and never collapses with the low-zoom simplifications.

## Edges

An item edge is an orthogonal polyline with chamfered corners, coloured by the
item it carries. It leaves the source's right side and enters the target's left
side, so every arrowhead points right, into its target. Each item edge carries
one rate chip (the item icon and a rate per minute), and that chip belongs on its
own line. The colour keeps the item's icon hue except where a family would
otherwise read as one colour: such an item may sit up to 15 degrees off its icon
hue, and near-gray families keep a saturation ceiling of 34.

A container's frame is kept clear of strokes. A loop's return edge runs in the
corridor, never along the box border: its two verticals hold a fixed gap off
the side borders of whatever container each endpoint sits inside, and its rail
escapes only the cards it actually spans -- one connected band of them --
rather than flying over every card that shares its x-range. A return stroke
and a slab border drawn as one line is a defect. One column may still
share that line: a forward tap's jog descent, dropping into its consumer, may
share an entry-gutter line with a container border. That column is a tap
approach, not a return riding the frame.

Where two strokes of DIFFERENT flows properly cross, the stroke passing under
shows a gap: a short break is cut out of that stroke around the crossing, the
other stroke runs through it unbroken, and whatever lies beneath the pair (a
slab tint) shows through the break untouched, so the crossing
reads as two flows crossing, not as a join. A
merge never looks like that -- it shows a dot or a shared run -- and a bare X
of two continuous strokes is a defect: it is indistinguishable from a merge,
which is exactly the confusion the dot exists to prevent. Crossings inside one
flow (a fan-out's shared run) are one visual line and carry no gap.

## Fan-out and fan-in

Every edge leaving one source port shares a single junction column, marked with
a dot where the flow splits. Members heading one layer over branch off the
column straight into their target. Members reaching further ride the same
column and then run their own leg across to their target, bending around any
card on the way. Each member carries its own rate chip on its own leg, never on
the shared column, and no aggregate rides the shared run.

The column keeps enough room for the nearest member's leg to hold that
member's chip, shifting toward the source port when the corridor is tight;
where even that cannot free a chip-wide leg, the chip collapses to icon-only.

Several such fan-outs can be forced into one corridor, and the columns are then
spread across it to keep them apart. Where that spread still leaves them closer
together than a chip is wide, the corridor is contested: no seat anywhere on such
a column clears the sibling's stroke, so those branch chips seat and render
icon-only, the same collapsed render a short-leg branch gets. Their rates stay on
the target cards.

Fan-in merges are the mirror image. Several same-item edges joining one target
port share a run marked with a dot, and the member that draws the dot keeps its
own rate chip on that run. A merge carries no aggregate sigma chip: the owner's
own member chip is the only rate on it.

## Rate chips

No chip anywhere shows a bare summed total. Every rate chip states one edge's
rate: a fan-out branch chip keeps the plain rate and unit the item edges beside
it carry. Totals live on the node cards' rows, which reveal their rates on
hover or selection. A total on a chip and the same total on a card come from one
formatter, so they should read alike; members rounded independently can still
sum a cent off that number.

Chips, machine cards, boundary cards, product-chip captions and the totals lines
all draw from one formatter, so a plan shows one rate unit throughout. A mix
inside a single plan, `/min` beside `/MIN`, is a defect and not a style.

Every chip draws at one fixed size: a 20px-tall box, the same in graph units at
every zoom, so zooming out shrinks a chip with the plan instead of holding it at
a reading size. Three zoom bands, the same for every chip family: from zoom 0.5
up a chip draws in full (icon, rate and unit), between 0.35 and 0.5 it draws as
its item icon alone, and below 0.35 it is not drawn at all. A hover-lit chip is
the one exception -- it keeps its digits and stays drawn at any zoom. So a fit
view of a mid-density plan showing icon-only squares is the level of detail
working, not a missing rate.

A seating pass places each chip on the line it labels, sliding it along that line
past cards, dots and other chips. A chip never covers its own endpoint card's
port glyph, port handle or row text: the furniture band straddling the port is
a keep-out, so an on-line chip sits in the corridor stretch between its two
ports' furniture. On a corridor too narrow for the chip's own box the chip
renders icon-only, whose square box fits stretches the text cannot. A chip that
had to move is still bound to its own polyline; dragging a card re-seats every chip when the
drag ends, so a dropped plan obeys the same rules (mid-drag, chips ride the
live line with their last seat offsets); one that reads as belonging to a neighbouring line is a defect.
A decision the pass recorded against an anchor -- a hidden chip, a junction dot --
survives a drag only while that anchor still matches the live geometry, and
comes back or disappears as soon as it does not; a decision recorded with no
anchor stands until the next re-seat.

## Intentional behaviours

Do not report these as defects.

- A card at rest shows no row rates: each row's rate is an overlay that appears
  only while the pointer is over the card or the card is selected, and below
  the low-zoom band the overlay stays hidden even then.
- Every rate chip is hidden below zoom 0.35, the trunk's aggregate chip
  included. A fit shot of a dense plan therefore shows no chips, and card detail
  fades at low zoom by design.
- Between zoom 0.35 and 0.5 every chip renders icon-only. A digit-less square
  chip is the level of detail, not a missing rate: the rate stays on the hover
  title and the aria label, and hovering the edge restores the digits.
- A chip on a leg too short for its box renders icon-only at any zoom, fan-out
  branch chips and item-edge chips alike, and so does a fan-out branch chip on a
  contested corridor. These too keep the rate on the hover title and the aria
  label.
- A fan-out branch chip, or a fan-in member chip that would land on the shared
  run, may be deliberately hidden. The rate remains on the edge's hover tooltip
  and on the target card's input row, which reveals it on hover or selection.
- A plain item edge may draw no chip at all: a bare stroke with no chip on it,
  not even an icon-only square, is the seating pass hiding a chip whose only
  remaining seat was more than one chip pitch off the line it labels (a
  crowded corridor, a foreign stroke or a neighbouring chip on every on-line
  seat). The rate stays on the edge's hover tooltip and on the target card's
  input row, which reveals it on hover or selection. A step of a pitch or less
  still reads as sitting beside its line and still draws.
- Mid-drag, a fan-in merge dot can vanish while the merged run still shows one
  member's rate. The dot hides as soon as its stamped x leaves the owner's live
  polyline, while a non-owner member's chip hide is pinned to the port ROW
  alone, so a source dragged horizontally slides the line out from under the dot
  without changing any row. Both stamps are restored by the reseat at drag-stop.
- The short break in a stroke at a crossing (see Edges) is not-a-break. No flow
  is interrupted there: the passing-under edge is continuous in the model, and
  the gap exists only to say "crossing, not a merge". Likewise the stroke that
  stays continuous over the gap is the one passing over, not the one being
  cut.
- A hover screenshot, where the capture took one, dims everything outside the
  hovered ego-network on purpose.
- A rate chip is a hover source for the edge it labels: the chip is drawn
  through a portal but stays inside its edge's React tree, so pointing at the
  chip box lights that edge exactly as pointing at its stroke does, and the
  focus-dim tests pin it.

## Locale notes

Read this section as well when the capture's locale is not `en`.

Every surface is localised, the rate unit included: zh and ja write `/分` where
en writes `/min`. One capture should show one form of it, and the one-unit rule
under Rate chips covers `/分` beside `/min` as well.

CJK text carries its own failure modes, and they are what to look for in a
non-`en` capture:

- an interpunct (`·`) left clinging to the end or the start of a wrapped line
  instead of sitting between the terms it separates;
- a gap inside a name that should be contiguous, such as a card subtitle reading
  `致密 源石粉末` where the port row below it reads `致密源石粉末`;
- a line broken mid-term where the name should have been kept whole.

Judge legibility at the zoom the text is meant to be read at, not at fit zoom:
CJK glyphs carry more strokes in the same box than Latin ones and blur earlier.
