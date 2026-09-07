import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import type { Recipe, Stoich } from "@aef/schema";
import { measureRecipe } from "./recipeGeometry";
import { useI18n } from "../data/i18n-context";
import { PortGlyph } from "./PortGlyph";
import { CatalystGlyph } from "./CatalystGlyph";
import { formatRationalPerMin } from "../data/rate-format";
import type { PortTransportKinds } from "./layout";
import type { ItemId } from "../pipeline/types";
import {
  rationalFromString,
  type RationalString,
} from "../data/targets";
import { orderByItem } from "./orderByItem";
import { formatMultiplicityBadge } from "./multiplicity-badge";
import { useItemPack } from "./itemPackContext";
import { iconIdForItem, iconPosition } from "./iconSprite";
import { itemColor } from "./itemColor";
import { elideName } from "./elide";
import {
  measureTextWidth,
  useFontMetrics,
  widthFnFor,
  type MeasuredFont,
} from "./measureText";
import {
  RECIPE_HEAD_TITLE_COL,
  RECIPE_HEAD_BLOCK_PAD_X,
} from "./dimensions";

// Row-label elision budget, from the constants that shape the row (see
// .rn-row in canvas.css): half of the card body, minus the row's horizontal
// padding (6px per side plus the extra 2px on the port edge), minus the
// 20px item sprite and one flex gap when the sprite renders (Sprite returns
// null without an icon position, which drops both), minus one more flex gap
// and the rate string. Port glyphs and handles are absolutely positioned
// and cost no flex width. The rate estimate is an upper bound, so the label
// budget errs narrow -- eliding early is safe, overflowing into CSS
// ellipsis is the defect.
const ROW_PAD_X = 14;
const ROW_GAP = 5;
const ROW_SPRITE = 20;
const ROW_LABEL_FONT: MeasuredFont = {
  fontSize: 12,
  weight: 400,
  family: "--font-ui",
};
const ROW_RATE_FONT: MeasuredFont = {
  fontSize: 12,
  weight: 700,
  family: "--font-num",
  letterSpacingEm: -0.01,
};

// Header budgets from the pinned columns (dimensions.ts, ruling R3): the
// recipe block's content width, minus the multiplier chip and its gap when
// one rides the title line. The chip estimate adds the box chrome (2x5px
// padding + 2x1px border) and the 0.04em tracking on top of the number-face
// bound, so the title errs narrow on chip-bearing cards -- the safe
// direction for the same reason as the row rate.
const TITLE_FONT: MeasuredFont = {
  fontSize: 17,
  weight: 600,
  family: "--font-ui",
};
const PRODUCTS_FONT: MeasuredFont = {
  fontSize: 11,
  weight: 500,
  family: "--font-ui",
};
const CHIP_FONT: MeasuredFont = {
  fontSize: 12,
  weight: 700,
  family: "--font-num",
};
const CHIP_CHROME_X = 12;
const CHIP_TRACKING_EM = 0.04;
const TITLE_CHIP_GAP = 8;

function headerContentWidth(): number {
  return RECIPE_HEAD_TITLE_COL - 2 * RECIPE_HEAD_BLOCK_PAD_X;
}

function elideRowLabel(
  name: string,
  bodyWidth: number,
  rateText: string,
  hasSprite: boolean,
): string {
  const budget =
    bodyWidth / 2 -
    ROW_PAD_X -
    (hasSprite ? ROW_SPRITE + ROW_GAP : 0) -
    ROW_GAP -
    measureTextWidth(rateText, ROW_RATE_FONT);
  return elideName(
    name,
    budget,
    widthFnFor(ROW_LABEL_FONT),
    "row-12",
  );
}

// Looks up the sprite position by icon id and renders an <ico><spr> pair.
// Returns null when no position is found, so the slot collapses instead of
// showing a misaligned default. Every sprite in the app draws through this one
// component -- node icons and rows, the edge chips, the side-panel rows and the
// picker tiles -- so the markup the .ico / .spr rules select on has a single
// owner. `size` picks the .ico-N size class; every caller styles the slot from
// the wrapper it puts the sprite in, so the sprite span carries nothing else.
export function Sprite({
  iconId,
  size,
}: {
  iconId: string | undefined;
  size: 16 | 20 | 28 | 40;
}) {
  const pos = iconPosition(iconId);
  if (pos === undefined) return null;
  return (
    <span className={`ico ico-${size}`}>
      <span className="spr" style={{ backgroundPosition: pos }} />
    </span>
  );
}

// Data shape accepted by RecipeNode. Two callers coexist:
//  - The older App boot path passes { recipe, multiplier, expanded } and draws
//    an xN badge when multiplier > 1.
//  - The render-pipeline path passes { recipe, kind: "recipe", multiplicity }.
//    The badge formatter turns multiplicity into an integer or two-decimal
//    rational. The kind discriminator keeps callers explicit.
type RecipeNodeData = {
  recipe: Recipe;
  multiplier?: number;
  multiplicity?: RationalString;
  expanded?: boolean;
  kind?: "recipe";
  // Per-port transport kind, keyed by React Flow Handle id (e.g.
  // "in:copper_ore", "out:copper_powder"). Optional so older fixtures and tests
  // keep working without it.
  portTransportKinds?: PortTransportKinds;
  // ELK-resolved west port order (item ids, top to bottom) attached by the
  // layout pass. When present, the input rows / handles / glyphs render in this
  // order so each entering edge's y-slot matches its arrival order; when absent
  // (older fixtures, boot path) we fall back to recipe.in declaration order.
  // There is no output counterpart (ruling R4): output rows always read in
  // recipe.out declaration order, so two cards of one recipe read alike.
  inputOrder?: ItemId[];
};
type RecipeNodeType = Node<RecipeNodeData, "recipe">;

// Per-row rate label: items per cycle over cycle time, times the machine speed
// (the solver runs a machine at speed/time executions per second, so the
// per-machine port rate is qty * speed / time), times the `scale` factor. The
// render-pipeline path passes the solved rational multiplicity so rows and the
// header show the aggregate flow across all machines (matching the edge chips);
// scale=1 yields the per-machine figure. Exact Fraction math keeps non-integer
// speeds and multiplicities free of float junk; rates here are non-negative, so
// serializing .n/.d is safe.
function rowRateText(
  stoich: Stoich,
  recipeTime: number,
  speed: Fraction,
  scale: Fraction,
): string {
  const perSec = new Fraction(stoich.qty)
    .mul(speed)
    .mul(scale)
    .div(recipeTime);
  return formatRationalPerMin({
    num: perSec.n.toString(),
    denom: perSec.d.toString(),
  });
}

export default function RecipeNode({
  data,
  selected,
}: NodeProps<RecipeNodeType>) {
  // Every visible name below is elided against measured text widths, so the
  // card has to redraw when a late-arriving face changes those measurements.
  useFontMetrics();
  const {
    recipe,
    multiplier,
    multiplicity,
    expanded,
    portTransportKinds,
    inputOrder,
  } = data;
  const i18n = useI18n();
  const { machineById } = useItemPack();
  // Input rows in ELK-resolved arrival order (falls back to declaration
  // order); output rows in the recipe's declared order (ruling R4), so every
  // card of one recipe reads alike. Each row carries its own stoich for the
  // rate text. geom does not place the handles (they center on the real DOM
  // row via CSS); it only feeds node sizing here and the offline routing model
  // (busRouting / ELK), which the pinned CSS keeps in sync with these rows.
  const ins = orderByItem(recipe.in, inputOrder);
  const outs = recipe.out;
  // Port-less rows appended below the input ports (see the row markup). They
  // keep the recipe's declared order: no layout pass orders them, because no
  // edge arrives at one.
  const catalysts = recipe.catalyst ?? [];
  const geom = measureRecipe(recipe);
  // Aggregate scale across all machines. The render-pipeline path supplies a
  // rational `multiplicity`; the older boot path an integer `multiplier`; a
  // node with neither runs a single machine. Rows and the header multiply by
  // this so the node's numbers match its incident edge chips.
  const perMachine = new Fraction(1);
  const scale: Fraction = multiplicity
    ? rationalFromString(multiplicity)
    : typeof multiplier === "number"
      ? new Fraction(multiplier)
      : perMachine;

  // The machine shown is producers[0]. Multiple producers are not handled yet.
  const producerId = recipe.producers[0];
  const machine =
    producerId !== undefined ? machineById.get(producerId) : undefined;
  // Header title: the machine's display name. displayName falls back to the
  // raw id, so a missing machine record (corrupt fixture) still titles the
  // node.
  const machineName =
    producerId !== undefined ? i18n.displayName(producerId) : "";
  // Secondary line: every produced item, in declaration order. A recipe can
  // have multiple outputs, so all of them are listed; the line ellipsizes and
  // the title attribute keeps the full list hoverable.
  const productNames = recipe.out
    .map((p) => i18n.displayName(p.item))
    .join(" ·\u00A0");
  // Same speed factor the solver applies (multiplier.ts); a missing machine
  // record (corrupt fixture) falls back to 1, the only value the pack uses.
  const speed =
    machine !== undefined ? new Fraction(machine.speed) : new Fraction(1);
  // Later sprite wiring reads this attribute; falls back to the raw producer id
  // when the machine record is missing (corrupt fixture).
  const machineIconKey = machine?.icon ?? producerId ?? "";
  // With `multiplicity`, the render-pipeline path wins; otherwise the older boot
  // path uses `multiplier` for an integer-only badge, hidden while expanded.
  let badgeText: string | null = null;
  if (multiplicity) {
    badgeText = formatMultiplicityBadge(multiplicity);
  } else if (
    typeof multiplier === "number" &&
    multiplier > 1 &&
    !expanded
  ) {
    badgeText = `x${multiplier}`;
  }

  // Visible header strings: the elision helper owns them against the pinned
  // header budgets (title minus the chip and its gap when one rides the
  // line; products at the recipe block's full content width), and the title
  // attributes keep the full names for hover.
  const visibleMachineName = elideName(
    machineName,
    headerContentWidth() -
      (badgeText !== null
        ? measureTextWidth(badgeText, CHIP_FONT) +
          badgeText.length * CHIP_TRACKING_EM * CHIP_FONT.fontSize +
          CHIP_CHROME_X +
          TITLE_CHIP_GAP
        : 0),
    widthFnFor(TITLE_FONT),
    "title-17",
  );
  const visibleProductNames = recipe.out
    .map((p) =>
      elideName(
        i18n.displayName(p.item),
        headerContentWidth(),
        widthFnFor(PRODUCTS_FONT),
        "products-11",
      ),
    )
    .join(" \u00b7\u00a0");

  // Header rate column. The primary value is the aggregate (per-machine x
  // scale); the secondary line keeps the per-machine figure so the aggregate
  // stays reconcilable to one machine's throughput. Empty string hides the
  // value when there is no primary output. Uses recipe.out[0] (declared
  // primary), not the reordered side-column top, for the same reason as the
  // header product.
  const primaryOut = recipe.out[0];
  const rateValText =
    primaryOut !== undefined
      ? rowRateText(primaryOut, recipe.time, speed, scale)
      : "";
  const perMachineText =
    primaryOut !== undefined
      ? rowRateText(primaryOut, recipe.time, speed, perMachine)
      : "";
  // The "/min" suffix the catalyst rows carry, the same locale string the
  // product cards and rate chips use.
  const rateUnit = i18n.t("canvas.rate.unit");

  return (
    <div
      data-testid="recipe-node"
      data-recipe-id={recipe.id}
      className={selected ? "recipe-node selected" : "recipe-node"}
      style={{
        position: "relative",
        width: geom.width,
        minHeight: geom.height,
      }}
    >
      {/* Header: a 28px machine icon slot plus the machine title line. */}
      <div className="rn-head">
        <div className="rn-machine-block">
          <div className="machine-icon" data-machine-icon={machineIconKey}>
            <Sprite iconId={machine?.icon ?? producerId} size={28} />
          </div>
        </div>
        <div className="rn-recipe-block">
          {/* Title: machine name plus the machine-count multiplier chip. The
              chip is critical info, so it survives at every zoom band (the
              rate figures drop at zoom-low; this line does not). */}
          <div className="machine-title">
            <span className="cn" title={machineName}>
              {visibleMachineName}
            </span>
            {badgeText !== null ? (
              <span className="rn-mult-chip">{badgeText}</span>
            ) : null}
          </div>
          {productNames !== "" ? (
            <div className="rn-products" title={productNames}>
              {visibleProductNames}
            </div>
          ) : null}
        </div>
        <div className="rn-rate-block">
          <div className="rate-val">{rateValText}</div>
          <div className="rate-lbl">{i18n.t("node.upm")}</div>
          {rateValText !== "" ? (
            <div className="rate-sub">
              <span className="rate-sub-val">{perMachineText}</span>
              <span className="rate-sub-ea">{i18n.t("node.each")}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rn-body">
        <div className="rn-side in">
          {ins.map((p) => {
            const label = i18n.displayName(p.item);
            const handleId = `in:${p.item}`;
            // The visible label is the elided string (tail preserved when
            // the budget allows); the title attribute keeps the full name.
            const rateText = rowRateText(p, recipe.time, speed, scale);
            const visible = elideRowLabel(
              label,
              geom.width,
              rateText,
              // Through iconIdForItem, exactly as the Sprite below resolves
              // it: upstream renamed four item icons, and asking iconPosition
              // for the raw item id misses those four. The budget then hands
              // the label the sprite's 20px and its gap while the sprite is on
              // screen taking them, and the label overflows into the CSS
              // ellipsis the helper exists to keep it out of.
              iconPosition(iconIdForItem(p.item)) !== undefined,
            );
            return (
              // The Handle and PortGlyph live inside the row so the DOM row
              // center is the anchor truth (both center via CSS top:50% on the
              // position:relative row) instead of a computed constant offset.
              // --row-accent tints the row's left accent tab to the item color
              // (canvas.css reads it in .rn-row.input::before) so the row pairs
              // by hue with its entering edge and port glyph.
              <div
                key={`in-row:${p.item}`}
                className="rn-row input"
                style={{ ["--row-accent" as string]: itemColor(p.item) }}
              >
                <Handle
                  id={handleId}
                  type="target"
                  position={Position.Left}
                />
                <PortGlyph
                  kind={portTransportKinds?.get(handleId)}
                  side="left"
                  item={p.item}
                />
                <Sprite iconId={iconIdForItem(p.item)} size={20} />
                <span className="lbl" title={label}>
                  {visible}
                </span>
                <span className="rate">{rateText}</span>
              </div>
            );
          })}
          {catalysts.map((p) => {
            const label = i18n.displayName(p.item);
            return (
              // A catalyst row: an input the machine cycles rather than
              // consumes. It is drawn from the plan boundary and returned every
              // cycle, so it has no supplier, no edge, and therefore no Handle
              // -- a handle here would offer a connection nothing can make and
              // would move every port below it. It carries no `input` class
              // either, since that class paints the accent tab that promises an
              // entering edge. Appended after the port rows so no port's y
              // moves; recipeGeometry counts it toward the card height.
              <div key={`catalyst-row:${p.item}`} className="rn-row catalyst">
                <CatalystGlyph item={p.item} />
                <Sprite iconId={p.item} size={20} />
                <span className="lbl" title={label}>
                  {label}
                </span>
                {/* Per MACHINE, not the aggregate the port rows show, and the
                    only row that spells its unit out -- the suffix is what
                    marks the figure as reading on a different scale from the
                    numbers directly above it. */}
                <span className="rate">
                  {rowRateText(p, recipe.time, speed, perMachine)}
                  {rateUnit}
                </span>
              </div>
            );
          })}
        </div>
        <div className="rn-side out">
          {outs.map((p) => {
            const label = i18n.displayName(p.item);
            const handleId = `out:${p.item}`;
            const rateText = rowRateText(p, recipe.time, speed, scale);
            const visible = elideRowLabel(
              label,
              geom.width,
              rateText,
              // Through iconIdForItem, exactly as the Sprite below resolves
              // it: upstream renamed four item icons, and asking iconPosition
              // for the raw item id misses those four. The budget then hands
              // the label the sprite's 20px and its gap while the sprite is on
              // screen taking them, and the label overflows into the CSS
              // ellipsis the helper exists to keep it out of.
              iconPosition(iconIdForItem(p.item)) !== undefined,
            );
            return (
              // Handle and PortGlyph nested in the row (see input side above).
              // --row-accent tints the row's right accent tab to the item color
              // (canvas.css reads it in .rn-row.output::after) so the row pairs
              // by hue with its leaving edge and port glyph.
              <div
                key={`out-row:${p.item}`}
                className="rn-row output"
                style={{ ["--row-accent" as string]: itemColor(p.item) }}
              >
                <Handle
                  id={handleId}
                  type="source"
                  position={Position.Right}
                />
                <PortGlyph
                  kind={portTransportKinds?.get(handleId)}
                  side="right"
                  item={p.item}
                />
                <Sprite iconId={iconIdForItem(p.item)} size={20} />
                <span className="lbl" title={label}>
                  {visible}
                </span>
                <span className="rate">{rateText}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer: left half shows cycle time; right half (.pwr) is reserved for
          power. */}
      <div className="rn-footer">
        <div className="cycle">{i18n.t("node.cycle", { time: recipe.time })}</div>
        <div className="pwr" />
      </div>
    </div>
  );
}
