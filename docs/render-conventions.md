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
machine multiplier (xN, drawn only when N is not 1), then input rows down its left side and output rows
down its right, each row ending in a port handle with a small item glyph.
Output rows read in the recipe's own declared order, so two cards of one recipe
read alike. A card carries no products line and no footer. A row is a
three-column grid -- item sprite, name, rate -- and the output side mirrors it,
so every rate stands at its row's inner end. The rate holds a column of its
own: it is always drawn whole, never clipped and never wrapped, and the name is
what gives way, eliding to whatever width is left. Row rates are drawn at rest
and drop only under the low-zoom band. Cyan product chips are boundary inputs
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

A name too long for its row or its title loses its tail: the longest head that
fits is drawn, followed by an ellipsis. One rule, every surface, every locale --
nothing at the end of a name is rescued, and no bracket group or trailing word
is treated as more distinguishing than the head. Two items whose names run
together up to the cut therefore paint the same string, which is the price of
the rule and not a defect; the full name is on the hover title of the row or the
card.

Below the input rows a card may carry catalyst rows: the charge consumed to
activate the machine, which the plan draws from its boundary because no producer
is ever built for a catalyst. The charge arrives over an edge of its own,
landing on a `cat:<item>` handle at the row's left -- the same x as the input
handles, at the row's centre -- and the row shows the item's transport glyph like
a port row does. One card can carry the same item on an input row and a catalyst
row; the two take separate handles and separate edges.

The catalyst rows are a block of their own, set off from the inputs above them by
a hairline with half a row of air around it. They read at full ink, as important
as the supplied rows, and each carries a TICKED accent tab in the item's hue
where an input row carries a solid bar: the ladder, not a colour, is what says
catalyst on this canvas -- rows and edges keep the item hue, and the boundary
card's yellow tab and badge below are the canvas's one yellow. No word names the
block. The rate reads like an input
row's -- a bare number in the same trailing slot -- and states whole machines'
worth of charge, `ceil(machines)` times the per-machine figure, since a machine
takes its whole charge to start whether or not its last run is a full one. A card
running 2.5 machines therefore reads three machines of catalyst beside port rows
sized for 2.5. Naming the row states the per-machine figure ("6/min per
machine").

A boundary card draws the item's name and its amount. Nothing else: no word on
it names the card's direction, its provenance or its class. What kind of card it
is reads off the drawing instead -- direction off the side the accent tab sits on
and the column the card stands in, a tap off its dashed tab and the `of N/min`
share under its figure, catalyst supply off a TICKED tab in the catalyst yellow,
and a target output off a lime tab and figure where a surplus output's are amber.
The words are not lost, they ride the card's aria-label, so a screen reader still
hears the direction and the class. Any of them drawn on the card is a defect --
with the one exception the next paragraph names.

Catalyst supply leaves the boundary on cards of its own, the `u:cat:<item>`
family, never on the item's ordinary supply card: an item feeding both an input
row somewhere and a catalyst row elsewhere draws two boundary cards, and each
card's rate counts only its own side. The catalyst family follows the ordinary
one's shape -- a single card when one bucket takes the item, otherwise an
aggregate card plus a tap slice per container. A cap typed on the catalyst
supply draws its chip in the ordinary cap slot. The catalyst boundary card also
carries the one word any boundary card draws: a small yellow boxed CATALYST
badge after the item's name, so the pool reads at a glance and not only through
the tab's pattern. It is the deliberate exception to the no-words rule above;
the name gives way to it, eliding its tail like any over-long name, and no
chip, recipe row or edge carries the word.

A target output that the plan feeds below its declared rate borrows the tap's
chip. Its figure is the rate that actually arrives, and the chip underneath
carries the declared one: `35/min` over `of 120/min`, or `0/min` when nothing
arrives. The short figure is red, which already means "not met" in the panels;
amber would read as a surplus. The `of` chip stays neutral like the tap's, and
the lime tab still marks the card a target.
A target that is fully fed shows the declared rate alone. The card and
the shortfall strip flag the same items from one predicate, so they never
disagree about which targets fall short.

Two pools answer the plan's catalyst need: the dedicated catalyst supply and
whatever headroom the ordinary supply has left after its own consumers. So an
item's catalyst account reads as the need, how much of it came from catalyst
supply, how much from general supply, and how much neither pool could cover.
Naming an aggregate or single catalyst card states that breakdown under the item
name, with the unmet line drawn only when there is a shortage; the inputs panel
states the same account across the item's two rows, and flags the shortage there
as well.

Some recipes only run inside a gas environment, which the player builds a
disperser for. Such a card states its requirement in a plate of chevrons that is
the card's own first row, above the header and inside the card's box, exactly as
wide as the card: one row tall, blue for a stable environment and yellow for an
acidic one, with a dark glyph at its centre naming the environment -- two peaks
for a stable one, four teardrops for an acidic one. The plate is the only one;
nothing is drawn under the card and nothing reaches past its sides. Behind the
card a faint tint of the environment's colour and a soft glow stay. The card's
own border keeps its neutral colour, and selection keeps its lime border while
the plate keeps the environment colour. Hovering the card names the environment.
The requirement is a build constraint rather than a detail figure, so the plate
draws at every zoom and never collapses with the low-zoom simplifications.

## Edges

An item edge is an orthogonal polyline with chamfered corners, coloured by the
item it carries. It leaves the source's right side and enters the target's left
side, so every arrowhead points right, into its target. Each item edge carries
one rate chip (the item icon and a rate per minute), and that chip belongs on its
own line. The colour keeps the item's icon hue except where a family would
otherwise read as one colour: such an item may sit up to 15 degrees off its icon
hue, and near-gray families keep a saturation ceiling of 34.

Line style says what the edge is for, not what carries it. Every edge that moves
material is solid, whether it rides a belt, a pipe or a gas line. Only an edge
out of the catalyst boundary pool is dashed, in the item's own colour, so that an
item supplied both ways cannot draw its charge line and its ordinary supply line
as the same mark. No new colour is spent on it, and the dash does not fade: a
catalyst edge sits at the same opacity as any other.

Transport kind reaches the reader through the port glyph -- filled square for
belt, hollow circle for pipe, hollow diamond for gas -- and through the item's
own row on the card, never through the line. Kind is a property of the item, so
the line would only repeat what the glyph and the icon already say, and it would
spend the one visual channel the catalyst rule needs.

A container's frame is kept clear of strokes. A loop's return edge runs in the
corridor, never along the box border: its two verticals hold a fixed gap off
the side borders of whatever container each endpoint sits inside, and its rail
escapes only the cards it actually spans -- one connected band of them --
rather than flying over every card that shares its x-range. Any stroke drawn as
one line with a slab border is a defect, a loop's return and a forward run
alike: a horizontal running along a container's top or bottom border reads as
the edge of the slab rather than as a line of the plan, whichever direction it
travels.

How much air the two owe that border is not the same number, because they are
not the same line. A loop return's rail clears a container by about 56 units; a
forward run a jog relocates clears a FOREIGN container's top or bottom border by 32. The rail is a stroke the reader follows across the whole graph and can be
parked anywhere in the corridor, while a jog takes the nearest clear level to
the row it is heading for, and a rail-sized moat there would push the run past
the box or into the next layer for no gain. Each is the clearance its own family
owes, not a single number two passes disagree about, and the pair are tuned
separately by eye.

Three things are exempt. A forward tap's jog descent, dropping into its
consumer, may share an entry-gutter line with a container border -- that column
is a tap approach, not a stroke riding the frame. A run inside a container one of
its own endpoints sits in is getting out, not riding. And an unjogged port-to-port
horizontal lies where its two ports are: it took no level from any pass, and
lifting it off a border would lift it off a port.

A forward edge between two adjacent layers drops LATE. It holds its source
port's row from the port all the way across the gap and turns down only in the
approach band in front of its target, so two such edges into neighbouring rows
of one card share that band and nothing else: they no longer run a row pitch
apart the whole width of the gap. A step spanning one row is drawn as a single
diagonal rather than a bevel-vertical-bevel. Trunk members and edges that skip a
layer keep their old shape -- they turn where their structure says, not at the
entry column. The entry columns fan in the sense of the approach: rows reached
from below or by a backward rail put the topmost row on the leftmost column,
while rows every edge drops into from above reverse among themselves and put the
bottom row leftmost, so a lower row's source sitting inside the upper row's drop
does not braid the two.

Forward horizontals keep a floor off each other, the horizontal sibling of the
column floor under Fan-out and fan-in. Where two such runs of DIFFERENT edges
share more than a port stub of x, they stay at least a chip box apart in y, and
the one routed later jogs to the nearest clear level to buy it. Runs of the same
edge, and the members of one trunk on their shared column, are exempt. The defect
it exists to prevent is the same one: two lines a couple of units apart read as
one thick stroke, and the two rate chips centred on them smear into one figure
that names neither.

A loop return's rail owes the same floor to those runs, and it is the side that
moves. Forward levels are settled before any rail is placed, so a rail that
would land inside a run's floor steps to the nearest level that is clear of the
run and still clear of every card it spans; a forward run never moves for a
rail. The rail keeps its columns where they were, so the price of the step is
the crossings its two verticals make on the way to the new level -- each one
cued like any other crossing.

Where two strokes of DIFFERENT flows properly cross, the stroke passing under
shows a gap: a short break is cut out of that stroke around the crossing, the
other stroke runs through it unbroken, and whatever lies beneath the pair (a
slab tint) shows through the break untouched, so the crossing
reads as two flows crossing, not as a join. A
merge never looks like that -- it shows a dot or a shared run -- and a bare X
of two continuous strokes is a defect: it is indistinguishable from a merge,
which is exactly the confusion the dot exists to prevent. Crossings inside one
flow (a fan-out's shared run) are one visual line and carry no gap.

Both marks have to stay legible to do that work. A stroke of another flow
running inside a junction dot's disc is a defect: the dot marks one flow meeting
itself, so any line through it is read as a member of that merge or split. A
crossing gap covered by a chip box or a junction dot is a defect for the same
reason -- both paint above the strokes, so the gap is simply not there, and a
dot sitting where two flows cross says the merge the gap exists to deny.

## Fan-out and fan-in

Every edge leaving one source port shares a single junction column, marked with
a dot where the flow splits. The dot stands on the shared run one chamfer before
the column, and one chamfer past it for a merge, because the corner at the
column is bevelled away: that point is the last one every member's path shares
before they part, and the first they share again after they meet.
Members heading one layer over branch off the
column straight into their target. Members reaching further ride the same
column and then run their own leg across to their target, bending around any
card on the way.

A fan-out carries two kinds of chip, on the two stretches the structure has.
The elected owner draws one aggregate chip on the shared trunk, between the
source port and the split dot, and it states the whole port's total. Each
member draws its own rate on its own leg, never on the shared column: the
column belongs to every member, so a chip parked there names none of them.

Every fan-out with a forward member states its total, whatever that member's
reach; a trunk whose members all run backward draws none. Where one member
heads to the next layer over it carries the aggregate on the shared trunk. Where
they all reach further, the owner is a far member instead -- the first that bends
away from the source row, so the total and the split dot ride one line -- and it
draws the total on its own source stub, in the same reserve the trunk chip would
have taken. Without it a reader sees one boundary port labelled and the next one
silent, with nothing on the canvas to say why: layer distance is not drawn.

Fan-in merges are the mirror image. Several same-item edges joining one target
port reach a shared column, turn onto the target row, and run one shared leg
into the port, marked with a dot where they converge. Each member keeps its own
rate chip on its own source stub, left of the column, and the aggregate chip
rides the shared leg right of the dot.

The two sides are deliberately asymmetric: a fan-in may draw no aggregate at
all. Three cases leave one ownerless, and six merges across the corpus fall
under them. All members reach the port from two or more layers back, so no
shared leg is drawn for a total to ride, and the target card's own row states it
instead. Every near member is DUAL -- each is already a fan-out member drawing
its own source's total on the same chip -- so a merge total would restate a
figure standing beside it. Or the member is backward, arriving on a detour rail
with no merge dot to bind a total to. The fan-out side has none of these: an
elected far owner always has a source stub of its own to carry the box.

The columns of one corridor are spread apart so that no two dots' keep-offs
overlap, and the gap they run in is widened before routing to hold them plus
the chips on either side (see the reserve model under Rate chips). Several
fan-outs forced into one corridor therefore stand apart rather than braiding.

The spread is a floor, not a preference, and it covers every vertical in a gap,
whichever pass placed it: a junction column, a target's entry column, a
staggered 1-to-1 bend and a jogged leg's descent all keep at least one entry
slot pitch from each other, and a neighbour of a trunk column keeps a whole port
stub off it because that column carries every member's stroke. Verticals of the
SAME edge, and the members of one trunk sharing their column on purpose, are
exempt. Two verticals of different edges a few units apart read as one thick
line, which is the defect the floor exists to prevent. The gap's column zone is
charged for the columns it must hold at that spacing, so the room is bought
before anything is routed.

## Rate chips

Every rate chip states a rate for the stretch of line it stands on. An item
edge's chip states that edge's rate; a trunk's aggregate chip states the whole
port's total, which is the flow the shared stretch under it carries. Totals also
live on the node cards' rows, which show their rates at rest, and
a total on a chip and the same total on a card come from one formatter, so they
should read alike; members rounded independently can still sum a cent off that
number.

Chips, machine cards, boundary cards and the totals lines all draw from one
formatter, so a plan shows one rate unit throughout. A mix inside a single plan,
`/min` beside `/MIN`, is a defect and not a style. That formatter also fixes how
precise a figure gets: at or above 0.1/min a rate carries at most one fractional
digit, with trailing zeros dropped, so no surface on the canvas prints two
decimals. Below 0.1/min it takes as many digits as it needs to avoid printing a
real rate as `0`.

Where a chip stands is a rule on the drawn line, not a search for free space,
and the rule is one per chip kind:

- a plain item edge's chip stands at the centre of the longest horizontal run of
  its own polyline, slid along that run to the nearest position whose box clears
  every card and every vertical stroke of another flow. A foreign column may
  cross the run; it may not cross the box, because the chip draws above every
  stroke and would swallow the crossing cue with it. Where no seat on the line
  clears both, the cards win the seat and the column stays in the box;
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

A 1-to-1 edge's chip is paid for by the same reserve, from the other side. Such
an edge has two horizontal legs, one out of its source port and one into its
target port, and its bend column stays inside the gap's column zone so neither
leg is shorter than the chip box it may have to carry: a column parked in the
source reserve shortens the first leg, one parked in the target reserve shortens
the last. A chip seat also clears the port furniture -- handles, glyphs, the row
strip -- not only the card box.

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

- Row rates vanish below the low-zoom band. At every other zoom the rate column
  is drawn at rest, and hover does nothing to it.
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
- A split or merge dot sits 8 units beside its column rather than on it. The
  offset is the chamfer that bevels the corner away: the dot stands on the run
  the members share, which is where the reader looks for it, not on the column
  they take.
- A forward edge drawn as one straight horizontal, port to port with no jog at
  all, may lie along a container border. Its level is the row its two ports
  share, not a level any pass picked, and lifting the line off the border would
  take it off a port.
- A forward run may travel beside the border of a container one of its own
  endpoints sits inside. A line leaving a card within a slab has to get past
  that slab's edge, so the stretch beside it is the way out rather than a
  stroke riding a frame it has no business near.
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
- Which part of a trunk member the pointer sat on decides what a hover
  screenshot lights. On the stretch the trunk shares -- the run out of a shared
  out-port, the leg into a shared in-port -- every member of that trunk stays
  lit. On a member's own branch leg only that edge and its two cards do, and the
  rest of the trunk dims even though the same trunk's total and junction dot
  stay lit beside it. A member drawing two trunks (one on each of its rows)
  lights one of them per stretch, never both. Which member draws the total is a
  drawing role and changes nothing here.
- A rate chip is a hover source for the edge it labels: the chip is drawn
  through a portal but stays inside its edge's React tree, so pointing at the
  chip box lights that edge exactly as pointing at its stroke does. An aggregate
  chip is the one exception, and it follows the same rule: it states the trunk's
  total, so it lights the trunk. The focus-dim tests pin both.

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
