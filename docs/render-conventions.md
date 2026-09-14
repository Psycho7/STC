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
read alike. A card carries no rate column, no products line and no footer:
each row's rate is an overlay at the row's inner end, drawn at rest and
dropped only under the low-zoom band. Cyan product chips are boundary inputs
and outputs rather than machines. Group slabs and loop boxes are containers,
and the cards inside one are its members. A loop box is drawn only when the
cards that survived the solve still form a directed cycle in the solved graph:
a candidate cycle whose bridging recipes solved to zero leaves free cards, not
a box.

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
separate edges. A catalyst row keeps no accent tab and its label is muted a step
below the supplied rows, but its rate reads exactly like an input row's: the
aggregate draw across every machine, a bare number in the same trailing slot.

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
card on the way.

A fan-out carries two kinds of chip, on the two stretches the structure has.
The elected owner draws one aggregate chip on the shared trunk, between the
source port and the split dot, and it states the whole port's total. Each
member draws its own rate on its own leg, never on the shared column: the
column belongs to every member, so a chip parked there names none of them.

Fan-in merges are the mirror image. Several same-item edges joining one target
port reach a shared column, turn onto the target row, and run one shared leg
into the port, marked with a dot where they converge. Each member keeps its own
rate chip on its own source stub, left of the column, and the aggregate chip
rides the shared leg right of the dot. A merge whose members all reach it from
further back draws no aggregate at all -- there is no near member to carry it,
and the target card states the total.

The columns of one corridor are spread apart so that no two dots' keep-offs
overlap, and the gap they run in is widened before routing to hold them plus
the chips on either side (see the reserve model under Rate chips). Several
fan-outs forced into one corridor therefore stand apart rather than braiding.

## Rate chips

Every rate chip states a rate for the stretch of line it stands on. An item
edge's chip states that edge's rate; a trunk's aggregate chip states the whole
port's total, which is the flow the shared stretch under it carries. Totals also
live on the node cards' rows, which show their rates at rest, and
a total on a chip and the same total on a card come from one formatter, so they
should read alike; members rounded independently can still sum a cent off that
number.

Chips, machine cards, boundary cards, product-chip captions and the totals lines
all draw from one formatter, so a plan shows one rate unit throughout. A mix
inside a single plan, `/min` beside `/MIN`, is a defect and not a style.

Where a chip stands is a rule on the drawn line, not a search for free space,
and the rule is one per chip kind:

- a plain item edge's chip stands at the centre of the longest horizontal run of
  its own polyline, slid along that run to the nearest position whose box clears
  every card;
- a trunk's aggregate chip stands one port stub out of the port it labels, on
  the shared stretch;
- a trunk member's chip stands one port stub in from its own end of the stretch
  that is the member's alone -- a fan-out member's leg into its target, a fan-in
  member's stub out of its source.

So every chip sits on a horizontal run of the line it labels, and a chip on a
vertical or on a chamfered corner is a defect. A chip whose box lies on a card
is a defect too: it reads as that card's own label.

Trunk chips stand in reserved room. Before any line is routed, each gap between
two layers is widened to hold a chip zone flush against the cards on each side
and the junction columns between them, with a port stub of pad on the card side
of a chip and a dot keep-off on the column side. A trunk chip therefore stands
beside the port it labels, inside its own side's zone, clear of its dot and
clear of the columns; a trunk chip out among the columns, or lapping the
neighbouring card, is a defect.

Every chip draws at one fixed size: a 20px-tall box, the same in graph units at
every zoom, so zooming out shrinks a chip with the plan instead of holding it at
a reading size. Three zoom bands, the same for every chip family: from zoom 0.5
up a chip draws in full (icon, rate and unit), between 0.35 and 0.5 it draws as
its item icon alone, and below 0.35 it is not drawn at all. A hover-lit chip is
the one exception -- it keeps its digits and stays drawn at any zoom. So a fit
view of a mid-density plan showing icon-only squares is the level of detail
working, not a missing rate. Nothing else takes a chip away or collapses it: no
chip is hidden for lack of room.

Dragging a card re-seats every chip when the drag ends, so a dropped plan obeys
the same rules; mid-drag, chips ride the live line. A decision recorded against
an anchor -- a junction dot -- survives a drag only while that anchor still
matches the live geometry, and comes back as soon as it does.

## Intentional behaviours

Do not report these as defects.

- Row rates vanish below the low-zoom band. The overlay is drawn at rest at
  every other zoom, and hover does nothing to it.
- Every rate chip is hidden below zoom 0.35, a trunk's aggregate chip included.
  A fit shot of a dense plan therefore shows no chips, and card detail fades at
  low zoom by design.
- Between zoom 0.35 and 0.5 every chip renders icon-only. A digit-less square
  chip is the level of detail, not a missing rate: the rate stays on the hover
  title and the aria label, and hovering the edge restores the digits.
- A trunk chip standing a little way out from its port, with empty corridor
  between it and the junction dot, is the reserve model: the chip is seated
  against the room the gap was widened for, not centred on the stretch it
  labels.
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
