import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import type { CSSProperties } from "react";
import type { EnvironmentId, Recipe, Stoich } from "@aef/schema";
import { measureRecipe } from "./recipeGeometry";
import { envBannerLayers } from "./envBanner";
import { useI18n } from "../data/i18n-context";
import { PortGlyph } from "./PortGlyph";
import { formatFractionPerMin } from "../data/rate-format";
import { catalystChargeOf } from "../solver/catalyst";
import { executionsPerMachine } from "../solver/multiplier";
import type { PortTransportKinds } from "./layout";
import type { ItemId } from "../pipeline/types";
import { portId } from "../pipeline/render/port-ids";
import { rationalFromString, type RationalString } from "../data/targets";
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
import { RECIPE_HEAD_TITLE_COL, RECIPE_HEAD_BLOCK_PAD_X } from "./dimensions";

// Row-label elision budget, from the constants that shape the row (see
// .rn-row in canvas.css): half of the card body, minus the row's horizontal
// padding (6px per side plus the extra 2px on the port edge), minus the
// 20px item sprite when it renders (Sprite returns null without an icon
// position, which collapses the column to zero), minus the two grid gaps
// (charged whether or not the sprite column has content), minus the MEASURED
// width of this row's rate text. The rate is a grid cell of its own now and
// is never clipped (ruling I1), so the name is what gives way. Port glyphs
// and handles are absolutely positioned and cost no column.
//
//   |<- pad ->|sprite|gap|      name      |gap| rate |<- pad ->|
//
// The rate is measured in the chip number face without its -0.01em tracking,
// which overstates it slightly -- the safe direction, as for the title.
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

// The gas-environment plate, the card's first row: the plate SVGs bake the
// plate colour into their data URIs (an SVG fill cannot resolve a CSS var), so
// the token VALUE is read from the stylesheet at runtime. The tokens never
// change at runtime, so the whole four-property style is memoised per
// environment on first render.
const ENV_PLATE_TOKEN: Record<EnvironmentId, string> = {
  stable: "--ak-env-stable",
  acidic: "--ak-env-acidic",
};

const envPlateStyles = new Map<EnvironmentId, CSSProperties>();

function envPlateStyle(environment: EnvironmentId): CSSProperties {
  const cached = envPlateStyles.get(environment);
  if (cached !== undefined) {
    return cached;
  }

  const plate = getComputedStyle(document.documentElement)
    .getPropertyValue(ENV_PLATE_TOKEN[environment])
    .trim();
  const layers = envBannerLayers(environment, plate);
  const style: CSSProperties = {
    ["--rn-env-plate" as string]: plate,
    ["--rn-env-glyph" as string]: layers.glyph.uri,
    ["--rn-env-cap-left" as string]: layers.leftCap.uri,
    ["--rn-env-cap-right" as string]: layers.rightCap.uri,
  };
  envPlateStyles.set(environment, style);
  return style;
}

function elideRowLabel(
  name: string,
  bodyWidth: number,
  hasSprite: boolean,
  rate: string,
): string {
  const budget =
    bodyWidth / 2 -
    ROW_PAD_X -
    (hasSprite ? ROW_SPRITE : 0) -
    2 * ROW_GAP -
    measureTextWidth(rate, ROW_RATE_FONT);
  return elideName(name, budget, widthFnFor(ROW_LABEL_FONT), "row-12");
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
export type RecipeNodeData = {
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

// One machine's worth, the scale a per-machine row rate is read at.
const ONE = new Fraction(1);

// Per-row rate label: items per cycle times one machine's executions per second
// (the solver runs a machine at speed/time executions per second, so the
// per-machine port rate is qty * speed / time), times the `scale` factor. The
// render-pipeline path passes the solved rational multiplicity so rows show
// the aggregate flow across all machines (matching the edge chips); scale=1
// yields the per-machine figure. Exact Fraction math keeps non-integer
// speeds and multiplicities free of float junk.
function rowRateText(
  stoich: Stoich,
  executions: Fraction,
  scale: Fraction,
): string {
  return formatFractionPerMin(
    new Fraction(stoich.qty).mul(executions).mul(scale),
  );
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
  // node with neither runs a single machine. Rows multiply by this so the
  // node's numbers match its incident edge chips.
  const scale: Fraction = multiplicity
    ? rationalFromString(multiplicity)
    : typeof multiplier === "number"
      ? new Fraction(multiplier)
      : new Fraction(1);

  // The machine shown is producers[0]. Multiple producers are not handled yet.
  const producerId = recipe.producers[0];
  const machine =
    producerId !== undefined ? machineById.get(producerId) : undefined;
  // Header title: the machine's display name. displayName falls back to the
  // raw id, so a missing machine record (corrupt fixture) still titles the
  // node.
  const machineName =
    producerId !== undefined ? i18n.displayName(producerId) : "";
  // Same speed factor the solver applies (multiplier.ts); a missing machine
  // record (corrupt fixture) falls back to 1, the only value the pack uses.
  const executions = executionsPerMachine(recipe, machine ?? { speed: 1 });
  // Later sprite wiring reads this attribute; falls back to the raw producer id
  // when the machine record is missing (corrupt fixture).
  const machineIconKey = machine?.icon ?? producerId ?? "";
  // With `multiplicity`, the render-pipeline path wins; otherwise the older boot
  // path uses `multiplier` for an integer-only badge, hidden while expanded.
  let badgeText: string | null = null;
  if (multiplicity) {
    badgeText = formatMultiplicityBadge(multiplicity);
  } else if (typeof multiplier === "number" && multiplier > 1 && !expanded) {
    badgeText = `x${multiplier}`;
  }

  // Visible header string: the elision helper owns it against the pinned
  // header budget (title minus the chip and its gap when one rides the
  // line), and the title attribute keeps the full name for hover.
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
  // Environment requirement: the data attribute marks the requirement and the
  // hover title names the environment. An absent field means no requirement,
  // so neither attribute is written.
  const environment = recipe.environment;
  const envLabel =
    environment === undefined
      ? undefined
      : i18n.t(environment === "stable" ? "env.stable" : "env.acidic");

  return (
    <div
      data-testid="recipe-node"
      data-recipe-id={recipe.id}
      className={selected ? "recipe-node selected" : "recipe-node"}
      {...(environment !== undefined
        ? { "data-environment": environment, title: envLabel }
        : {})}
      style={{
        position: "relative",
        width: geom.width,
        minHeight: geom.height,
      }}
    >
      {/* The environment plate: the card's first row, above the header, one
          ENV_ROW_HEIGHT tall and the card's content width. canvas.css paints
          the caps and the glyph from the custom properties, and the haze
          behind the whole card from its ::before. In flow, so measureRecipe's
          height and every port y-slot below it already count it. */}
      {environment !== undefined ? (
        <div
          className="rn-env"
          aria-hidden="true"
          style={envPlateStyle(environment)}
        />
      ) : null}
      {/* Header: the 40px machine icon block plus the machine title line. */}
      <div className="rn-head">
        <div className="rn-machine-block">
          <div className="machine-icon" data-machine-icon={machineIconKey}>
            <Sprite iconId={machine?.icon ?? producerId} size={40} />
          </div>
        </div>
        <div className="rn-recipe-block">
          {/* Title: machine name plus the machine-count multiplier chip. The
              chip is critical info, so it survives at every zoom band. */}
          <div className="machine-title">
            <span className="cn" title={machineName}>
              {visibleMachineName}
            </span>
            {badgeText !== null ? (
              <span className="rn-mult-chip">{badgeText}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="rn-body">
        <div className="rn-side in">
          {ins.map((p) => {
            const label = i18n.displayName(p.item);
            const handleId = portId("in", p.item);
            // The visible label is the elided string (tail preserved when
            // the budget allows); the title attribute keeps the full name.
            const rate = rowRateText(p, executions, scale);
            const visible = elideRowLabel(
              label,
              geom.width,
              // Through iconIdForItem, exactly as the Sprite below resolves
              // it: upstream renamed four item icons, and asking iconPosition
              // for the raw item id misses those four. The budget then hands
              // the label the sprite's 20px while the sprite is on screen
              // taking it, and the label overflows into the CSS ellipsis the
              // helper exists to keep it out of.
              iconPosition(iconIdForItem(p.item)) !== undefined,
              rate,
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
                <Handle id={handleId} type="target" position={Position.Left} />
                <PortGlyph
                  kind={portTransportKinds?.get(handleId)}
                  side="left"
                  item={p.item}
                />
                <Sprite iconId={iconIdForItem(p.item)} size={20} />
                <span className="lbl" title={label}>
                  {visible}
                </span>
                <span className="rate">{rate}</span>
              </div>
            );
          })}
          {catalysts.map((p, i) => {
            const label = i18n.displayName(p.item);
            const handleId = portId("cat", p.item);
            // The charge is held per MACHINE, not per cycle: a machine at 40%
            // still holds a whole charge, so the card's aggregate counts whole
            // machines. The solver's catalystChargeOf owns that formula, and
            // the row reads it there so the card, the account and the edge
            // chip cannot drift apart.
            const perMachine = rowRateText(p, executions, ONE);
            const aggregate = formatFractionPerMin(
              catalystChargeOf(scale, p, recipe, machine ?? { speed: 1 }),
            );
            const visible = elideRowLabel(
              label,
              geom.width,
              iconPosition(iconIdForItem(p.item)) !== undefined,
              aggregate,
            );
            return (
              // A catalyst row: an input the machine cycles rather than
              // consumes. It is supplied from the item's catalyst boundary card
              // like any raw draw, so it takes a target Handle of its own -- in
              // the `cat:` namespace, because the same item can also sit on an
              // input row above -- and wears that port's transport glyph. It
              // carries no `input` class: the two differ by their accent tab,
              // solid there and ticked here (canvas.css), both tinted from
              // --row-accent. The rows form their own block below the port
              // rows, opened by the first row's gap and divider (cat-first), so
              // no port's y moves; recipeGeometry counts the block's height.
              <div
                key={`catalyst-row:${p.item}`}
                className={
                  i === 0 ? "rn-row catalyst cat-first" : "rn-row catalyst"
                }
                style={{ ["--row-accent" as string]: itemColor(p.item) }}
                title={i18n.t("canvas.catalyst.perMachine", {
                  rate: perMachine,
                })}
              >
                <Handle id={handleId} type="target" position={Position.Left} />
                <PortGlyph
                  kind={portTransportKinds?.get(handleId)}
                  side="left"
                  item={p.item}
                />
                <Sprite iconId={iconIdForItem(p.item)} size={20} />
                <span className="lbl" title={label}>
                  {visible}
                </span>
                {/* The same column and bare-number form as an input row: the
                    aggregate draw across every machine the card stands for.
                    canvas.css colours it from the .catalyst class, since the
                    row carries no .input class. */}
                <span className="rate">{aggregate}</span>
              </div>
            );
          })}
        </div>
        <div className="rn-side out">
          {outs.map((p) => {
            const label = i18n.displayName(p.item);
            const handleId = portId("out", p.item);
            const rate = rowRateText(p, executions, scale);
            const visible = elideRowLabel(
              label,
              geom.width,
              // Through iconIdForItem, exactly as the Sprite below resolves
              // it (see the input side above).
              iconPosition(iconIdForItem(p.item)) !== undefined,
              rate,
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
                <Handle id={handleId} type="source" position={Position.Right} />
                <PortGlyph
                  kind={portTransportKinds?.get(handleId)}
                  side="right"
                  item={p.item}
                />
                <Sprite iconId={iconIdForItem(p.item)} size={20} />
                <span className="lbl" title={label}>
                  {visible}
                </span>
                <span className="rate">{rate}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
