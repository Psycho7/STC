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
row ending in a port handle with a small item glyph. Cyan product chips are
boundary inputs and outputs rather than machines. Group slabs and loop boxes are
containers, and the cards inside one are its members.

## Edges

An item edge is an orthogonal polyline with chamfered corners, coloured by the
item it carries. It leaves the source's right side and enters the target's left
side, so every arrowhead points right, into its target. Each item edge carries
one rate chip (the item icon and a rate per minute), and that chip belongs on its
own line.

## Bus lanes

Long edges route through shared horizontal lanes, drawn as faint tinted bands
labelled BUS above and below the block of nodes. A member drops into its lane,
runs along it, and rises at the column where it turns towards its target. Every
member of one trunk shares a lane y, so their runs overlap and the trunk draws as
a single stroke without any cross-edge coordination.

A multi-member trunk carries no aggregate total. Its members' rise chips spread
along the lane, and a junction dot marks the point each member branches off at.

A lone lane trunk draws no junction dot: nothing branches at its corner. What it
labels depends on how far it runs. On a long lone run only the rise chip draws,
down at the consumer end, and it survives the zoom gate the other chips are held
to; a drop chip restating that same rate a screen away reads as a second flow. On
a short lone run both the rise and the drop chip draw. And the drop chip returns
whenever the rise chip is hidden by the seating pass, so the trunk is never left
unlabelled.

## Fan-out and fan-in

Same-source edges heading one layer over share a junction column, marked with a
dot. Each member carries its own rate chip on its own branch, and no aggregate
rides the shared trunk.

Several such trunks can be forced into one corridor, and the columns are then
spread across it to keep them apart. Where that spread still leaves them closer
together than a chip is wide, the corridor is contested: no seat anywhere on such
a column sheds the sibling's stroke, so those branch chips seat and render
icon-only, the same collapsed render a short-leg branch gets. Their rates stay on
the target cards.

Fan-in merges are the mirror image. Several same-item edges joining one target
port share a run marked with a dot, and the member that draws the dot keeps its
own rate chip on that run. A merge carries no aggregate sigma chip: the owner's
own member chip is the only rate on it.

## Rate chips

No chip anywhere shows a bare summed total. Every rate chip states one edge's
rate. The single exception is a member chip on a multi-member bus trunk, which
reads as that member's share of the trunk ("30/270"); a lone member is its own
total and keeps the plain rate and unit. Totals otherwise live on the node cards'
rows, and a chip total and a card total are formatted the same way so they never
disagree.

A seating pass places each chip on the line it labels, sliding it along that line
past cards, dots and other chips. A chip that had to move is still bound to its
own polyline; one that reads as belonging to a neighbouring line is a defect.

## Intentional behaviours

Do not report these as defects.

- Rate chips are hidden below zoom 0.35. A fit shot of a dense plan therefore
  shows few chips or none, and card detail fades at low zoom by design.
- A chip on a leg too short for its box renders icon-only at any zoom, fan-out
  branch chips and item-edge chips alike, and so does a fan-out branch chip on a
  contested corridor. Both keep the rate on the hover title and the aria label. A
  digit-less square chip is intentional, not a missing rate.
- A fan-out branch chip, or a fan-in member chip that would land on the shared
  run, may be deliberately hidden. The rate remains on the target card's input
  row.
- A hover screenshot, where the capture took one, dims everything outside the
  hovered ego-network on purpose.

## Locale notes

Read this section as well when the capture's locale is not `en`.

Every surface is localized, the rate unit included: zh and ja write `/分` where
en writes `/min`. One capture should show one form of it. Chips, machine cards,
boundary cards, product-chip captions and the totals lines all draw from the same
formatter, so a mix within a single plan (`/分` beside `/min` beside `/MIN`) is a
defect and not a style.

CJK text carries its own failure modes, and they are what to look for in a
non-`en` capture:

- an interpunct (`·`) left clinging to the end or the start of a wrapped line
  instead of sitting between the terms it separates;
- a gap inside a name that should be contiguous, such as a card subtitle reading
  `致密 源石粉末` where the port row below it reads `致密源石粉末`;
- a line broken mid-term where the name should have been kept whole.

Judge legibility at the zoom the text is meant to be read at, not at fit zoom:
CJK glyphs carry more strokes in the same box than Latin ones and blur earlier.
