// Chip metrics: what one edge-label chip DRAWS, as the seating pass and the
// renderers both need to know it -- the CSS chrome the .flow-chip box carries,
// the bounds on the body glyphs and the localized rate unit, the half-extents a
// seat reserves, and the text builders the chip families draw from their edge
// data.
//
// The split with chipSeating.ts: this module owns the BOX (how wide a chip is
// and what it says), the seating pass owns the POLICY (where the box may sit
// and how far it may move). Four production consumers read it -- the seat
// (reserves a box before render), BusEdge (draws the text and reads the
// share-form predicate off branchChipText's return), Canvas (exam reservation
// rows), and the exam width-bound spec.
//
// Locale-BLIND by construction: this module imports no i18n. The body is
// locale-independent ASCII from the real formatter, and of the unit it knows
// only WHETHER one follows (ChipText.unit) and HOW WIDE it can be
// (CHIP_UNIT_MAX_PX); the renderer owns which string. So switching locale never
// forces a relayout.

import type { Edge } from "@xyflow/react";

import { CHIP_BOX_HEIGHT, CHIP_BOX_WIDTH, MAX_CHIP_SCALE } from "./dimensions";
import { edgeRate, type BusEdgeData } from "./busRouting";
import { formatRatePerMin } from "../data/rate-format";

// Chip half-extents, in graph units. A chip counter-scales up to MAX_CHIP_SCALE
// about its centre, so its rendered box in graph space never exceeds
// MAX_CHIP_SCALE times its natural dimension; half of that is the half-extent two
// centres must stay apart on an axis to keep the boxes clear at every zoom down
// to the fit floor. The collision test sums the two boxes' half-extents per
// axis, so a wide-vs-wide pair needs the full MAX_CHIP_SCALE * CHIP_BOX_WIDTH
// of centre separation -- the earlier single fixed 60 flagged only
// near-coincident pairs and missed wide chips that overlap on screen from tens
// of graph units away.
export const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;
export const CHIP_HALF_W_WIDE = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;

// Half-width of a COLLAPSED (icon-only) chip's box. Such a chip is a square:
// the 16px item sprite plus the same 3px padding and 1px border the full chip
// carries (.flow-chip.icon-only in canvas.css), i.e. CHIP_BOX_HEIGHT on both
// axes, counter-scaled by the same cap. So its half-width IS the shared
// half-height.
const CHIP_HALF_W_ICON = CHIP_HALF_H;

// Chrome the .flow-chip box carries around its body text, in px at natural
// scale, straight off the CSS rule (canvas.css .flow-chip / .ico-16): a 16px
// item sprite, the 6px flex gap between sprite and text, 7px of padding per
// side, and a 1px border per side under box-sizing: border-box. A chip whose
// item has no sprite draws neither icon nor gap, and one on an item with no
// text draws no text -- both are charged regardless, which only makes the bound
// safer and keeps the layout pass free of the icon table. Re-derive alongside
// CHIP_BOX_WIDTH whenever that rule's padding, gap, border or sprite size
// changes.
export const CHIP_ICON_PX = 16;
export const CHIP_GAP_PX = 6;
export const CHIP_PAD_X_PX = 7;
export const CHIP_BORDER_PX = 1;
const CHIP_CHROME_PX =
  CHIP_ICON_PX + CHIP_GAP_PX + 2 * CHIP_PAD_X_PX + 2 * CHIP_BORDER_PX;

// Upper bound on one body glyph's advance, in px. A chip body is digits plus
// "." and "/" only (formatRatePerMin is locale-independent ASCII), set at 11px
// weight 700 in --font-num, and letter-spacing: -0.01em only subtracts. The
// font stack is remote ("Space Grotesk", then "JetBrains Mono", the Han faces,
// and generic monospace), so the bound has to survive a box where the webfont
// never arrived: measured in-browser at 11px/700, the WIDEST of those glyphs is
// 6.89px in Space Grotesk and in JetBrains Mono, 6.50px in generic monospace,
// and less in every other fallback. 7.5 keeps ~9% headroom over the worst.
export const CHIP_GLYPH_PX = 7.5;

// Upper bound on the localized rate unit a rate chip appends, in px. The
// supported set is Locale in src/data/i18n.ts: the UI ships en ("/min", a slash
// plus three Latin letters) and zh ("/分", a slash plus one Han glyph that
// stands for the whole word). The data sidecar (recipe-pack.i18n.json) carries
// two more than the UI ships, and the bound was measured against the widest
// unit over that larger set -- a Latin or Cyrillic slash-plus-three-letters
// form, 4 glyphs; the Han form, 2 glyphs, is the narrowest, not the widest.
// Keeping that wider measurement is a DELIBERATE superset: it is free headroom
// for a locale the UI has not shipped yet, and narrowing it would shrink every
// reserved box, which is a geometry change.
//
// The seat reserves the widest unit over the whole set rather than the active
// one, so one seat stays correct in every locale and switching locale never
// forces a relayout (layout.ts records the standing invariant that ids resolve
// to names at render time; this module imports no i18n). Measured in-browser at
// 11px/700 across the font stack (see the width-bound spec): 24.56px worst in
// the live font, 27.56px worst under substitution. 34 keeps ~23% headroom.
export const CHIP_UNIT_MAX_PX = 34;

// What one chip's box is going to DRAW, as the seat needs to know it: the body
// string the component builds, and whether the localized rate unit follows it.
// Mirrors the chip text in ItemEdge (rate + unit) and BusEdge (aggregate total +
// unit; a multi-member share "30/270", digits only, no unit), so the callers
// below build it from the same edge-data fields at seating time. The seat and
// the render must agree on the box AT REST; the rendered-width probe check is
// the cross-check that they do.
export type ChipText = { body: string; unit: boolean };

// The half-width one chip's seat reserves, in graph units. The rendered box is
// CHIP_CHROME_PX plus the body text plus the unit, clamped by the CSS
// max-width: 120px (which ellipsizes rather than growing past it), and it
// counter-scales up to MAX_CHIP_SCALE about its centre -- so the zoom-safe
// reserve is MAX_CHIP_SCALE times that natural width, and half of it is the
// half-extent every tier measures with.
//
// Why estimate at all: reserving CHIP_BOX_WIDTH for every chip charges the
// widest box the clamp allows to a chip that draws half of it, and that surplus
// is what makes a corridor read as blocked to the seat while it is open to the
// reader. Only the GLYPH width is estimated here; the digits come from the real
// formatter, so the string is exact and only its advance is bounded.
//
// Two fallbacks, both to the old worst case: a chip collapsed to its item sprite
// reserves the square icon box (exact, not an estimate), and a chip with no
// usable rate -- a fixture that omits it, an edge whose rate rounds to the empty
// string -- reserves CHIP_BOX_WIDTH, which draws nothing at all and so can only
// over-reserve. No lower clamp is needed: CHIP_CHROME_PX alone already exceeds
// the icon box.
export function chipSeatHalfW(
  text: ChipText | undefined,
  iconOnly: boolean,
): number {
  if (iconOnly) return CHIP_HALF_W_ICON;
  if (text === undefined || text.body === "") return CHIP_HALF_W_WIDE;
  const natural =
    CHIP_CHROME_PX +
    CHIP_GLYPH_PX * text.body.length +
    (text.unit ? CHIP_UNIT_MAX_PX : 0);
  return (MAX_CHIP_SCALE * Math.min(CHIP_BOX_WIDTH, natural)) / 2;
}

// The natural-scale width of the box one chip draws: the text box, or the
// CHIP_BOX_HEIGHT square once collapsed.
export function chipNaturalWidth(
  text: ChipText | undefined,
  iconOnly = false,
): number {
  return (2 * chipSeatHalfW(text, iconOnly)) / MAX_CHIP_SCALE;
}

// The chip text a plain rate chip draws: the item edge's own rate through the
// real display formatter, plus the unit (ItemEdge). The formatter returns "" for
// a zero rate, which is exactly when ItemEdge draws no chip -- the estimator
// takes that as "no usable rate" and reserves the worst case for an invisible
// box, which can only over-reserve. Exported for the item-chip seat, which
// reserves this text's box directly; the other two builders wrap it.
export function rateChipText(edge: Edge): ChipText | undefined {
  const rate = edgeRate(edge);
  return rate === undefined
    ? undefined
    : { body: formatRatePerMin(rate), unit: true };
}

// The chip text a fan-out trunk's AGGREGATE chip draws: the trunk total (falling
// back to this member's own rate, as BusEdge does) plus the unit. Only seated on
// a single-member trunk, where the total IS that member's rate (issue #39).
export function aggregateChipText(edge: Edge): ChipText | undefined {
  const total = (edge.data as BusEdgeData | undefined)?.busTotalRate;
  return total === undefined
    ? rateChipText(edge)
    : { body: formatRatePerMin(total), unit: true };
}

// The chip text a bus member's per-member chip (lane rise / fan-out branch)
// draws. The SHARE -- "30/270", digits only, no unit, because the unit would
// not fit the box beside a decimal pair and differs per locale, so the full
// localized wording rides the label and title instead (BusEdge, issue #45) --
// is a bus-LANE member's reading (R3, exam 2026-09-04): a lane rise names one
// share of a trunk total the reader cannot otherwise split. A formed FAN-OUT
// branch is a direct in-corridor leg drawn beside its unformed siblings' plain
// item edges, so it keeps the plain rate + unit those siblings read. A lone
// lane member is its own total and keeps the plain rate + unit reading too.
// The single source of the share-form predicate: BusEdge derives which of the
// two readings its per-member chip draws from THIS builder (unit === false is
// the share form), so the seat and the render agree on the box by
// construction. Consulted by every seat that reserves a member chip's box --
// the fan-out branch seat and, since Task 10, the lane rise seat -- and by the
// exam reservation rows for both member kinds.
export function branchChipText(edge: Edge): ChipText | undefined {
  const plain = rateChipText(edge);
  if (plain === undefined || plain.body === "") return plain;
  const data = edge.data as BusEdgeData | undefined;
  // Fan-out members never take the share form (see the doc comment above);
  // BusEdge reads the form from this return, never a predicate of its own.
  if (data?.fanout === true) return plain;
  if ((data?.busMemberCount ?? 1) <= 1) return plain;
  const total = data?.busTotalRate ?? edgeRate(edge)!;
  const shareTotal = formatRatePerMin(total);
  return shareTotal === ""
    ? plain
    : { body: `${plain.body}/${shareTotal}`, unit: false };
}

// One row per chip an edge CAN draw, keyed by the FlowChip testId, carrying the
// ChipText the seat measures and the natural-scale width it reserves
// (reservedPx: the un-counter-scaled bound, min(CHIP_BOX_WIDTH, estimated
// natural width)). Exam-only: the width-bound spec walks the rendered
// .flow-chip boxes and compares each against its row, which is what keeps
// CHIP_GLYPH_PX / CHIP_UNIT_MAX_PX honest when the .flow-chip CSS or a
// locale's unit string drifts. Render gates (zoom, hides, the icon-only
// collapse) are deliberately ignored here: the spec looks rows up by testId, so
// a row for a chip that never renders is inert, while a rendered chip with no
// row is a new chip family the estimator does not cover -- the spec fails it.
export type ExamChipReservation = {
  testId: string;
  body: string;
  unit: boolean;
  reservedPx: number;
};

export function examChipReservations(edges: Edge[]): ExamChipReservation[] {
  const out: ExamChipReservation[] = [];
  const push = (testId: string, text: ChipText | undefined): void => {
    if (text === undefined) return;
    out.push({
      testId,
      body: text.body,
      unit: text.unit,
      reservedPx: (2 * chipSeatHalfW(text, false)) / MAX_CHIP_SCALE,
    });
  };
  for (const edge of edges) {
    if (edge.type === "item") {
      push(`item-edge-label-${edge.id}`, rateChipText(edge));
    } else if (edge.type === "bus") {
      push(`bus-edge-label-${edge.id}-drop`, aggregateChipText(edge));
      push(`bus-edge-label-${edge.id}-rise`, branchChipText(edge));
    }
  }
  return out;
}
