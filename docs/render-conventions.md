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

A recipe card has a header carrying the recipe name and the machine multiplier
(xN), then input rows down its left side and output rows down its right, each
row ending in a port handle with a small item glyph. Output rows read in the
recipe's own declared order, so two cards of one recipe read alike. Cyan
product chips are boundary inputs and outputs rather than machines. Group slabs
and loop boxes are containers, and the cards inside one are its members.

An item imported at the boundary draws one input chip. Consumers outside any
container draw straight from that chip; a container gets a chip of its own,
marked as a tap and fed by the item's chip, because an edge entering a
container has to enter it once. So several tap chips of one item mean several
containers, not several consumers.

A name too long for its row, its title or the products line elides
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
it carry. Totals live on the node cards' rows. A total on a chip and the same
total on a card come from one formatter, so they should read alike; members
rounded independently can still sum a cent off that number.

Chips, machine cards, boundary cards, product-chip captions and the totals lines
all draw from one formatter, so a plan shows one rate unit throughout. A mix
inside a single plan, `/min` beside `/MIN`, is a defect and not a style.

A seating pass places each chip on the line it labels, sliding it along that line
past cards, dots and other chips. A chip never covers its own endpoint card's
port glyph, port handle or row text: the furniture band straddling the port is
a keep-out, so an on-line chip sits in the corridor stretch between its two
ports' furniture. On a corridor too narrow for the chip's full box the chip
holds a capped size -- counter-scaled by less than the usual maximum so the
widest box it can draw fits that stretch -- or renders icon-only when even the
natural text does not fit. A corridor shared with another chip works the same
way: when the full box has no seat left on the line, the chip shrinks to its
natural size before it takes any seat off the line. A chip that had to move is
still bound to its own polyline; dragging a card re-seats every chip when the
drag ends, so a dropped plan obeys the same rules (mid-drag, chips ride the
live line with their last seat offsets); one that reads as belonging to a neighbouring line is a defect.
A decision the pass recorded against an anchor -- a hidden chip, a junction dot --
survives a drag only while that anchor still matches the live geometry, and
comes back or disappears as soon as it does not; a decision recorded with no
anchor stands until the next re-seat.

## Intentional behaviours

Do not report these as defects.

- Rate chips are hidden below zoom 0.35. A fit shot of a dense plan therefore
  shows few chips or none, and card detail fades at low zoom by design.
- A chip on a leg too short for its box renders icon-only at any zoom, fan-out
  branch chips and item-edge chips alike, and so does a fan-out branch chip on a
  contested corridor. A chip whose corridor holds its natural text but not the
  full counter-scaled box instead draws at a capped size, smaller than the
  usual counter-scale maximum, and so does a chip whose full box has no seat
  left on its line beside a neighbouring chip (the second of two chips into
  adjacent rows of one card, a member chip on a merged fan-in run): it draws
  at its natural size and stays on its line rather than leaving it. A capped
  chip keeps its digits down to the same zoom as every other chip; they are
  simply drawn smaller. Low zoom is a third cause: below zoom 0.32 the chip
  exempt from the 0.35 gate (the trunk's aggregate chip) renders icon-only as
  well. All of them keep the rate on the hover title and the aria label. A
  digit-less square chip is intentional, not a missing rate.
- A fan-out branch chip, or a fan-in member chip that would land on the shared
  run, may be deliberately hidden. The rate remains on the target card's input
  row and on the edge's hover tooltip.
- A plain item edge may draw no chip at all: a bare stroke with no chip on it,
  not even an icon-only square, is the seating pass hiding a chip whose only
  remaining seat was more than one chip pitch off the line it labels (a
  crowded corridor, a foreign stroke or a neighbouring chip on every on-line
  seat). The rate stays on the target card's input row and on the edge's hover
  tooltip. A step of a pitch or less still reads as sitting beside its line and
  still draws.
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
