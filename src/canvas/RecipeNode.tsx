import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import Fraction from "fraction.js";
import type { Recipe, Stoich } from "@aef/schema";
import { measureRecipe } from "./recipeGeometry";
import { useI18n } from "../data/i18n-context";
import { PortGlyph } from "./PortGlyph";
import { formatRationalPerMin } from "../data/rate-format";
import type { PortTransportKinds } from "./layout";
import type { ItemId } from "../pipeline/types";
import type { RationalString } from "../data/targets";
import { orderByItem } from "./orderByItem";
import { formatMultiplicityBadge } from "./multiplicity-badge";
import { useItemPack } from "./itemPackContext";
import { iconPosition } from "./iconSprite";
import { itemColor } from "./itemColor";

// Looks up the sprite position by icon id and renders an <ico><spr> pair.
// Returns null when no position is found, so the slot collapses instead of
// showing a misaligned default.
function Sprite({
  iconId,
  size,
}: {
  iconId: string | undefined;
  size: 16 | 20 | 28;
}) {
  const pos = iconPosition(iconId);
  if (pos === undefined) return null;
  return (
    <span className={`ico ico-${size}`}>
      <span className="spr" style={{ backgroundPosition: pos }} />
    </span>
  );
}

// Derive the tier chip ("T1", "T2", ...) from a trailing -t<digits> suffix on
// the machine id. The schema has no Machine.tier field, so the id is the only
// source. Returns null when there is no such suffix; callers leave the chip off.
function deriveTier(id: string): string | null {
  const m = id.match(/-t(\d+)$/i);
  return m ? `T${m[1]}` : null;
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
  // ELK-resolved per-side port order (item ids, top to bottom) attached by the
  // layout pass. When present, rows / handles / glyphs render in this order so
  // each entering edge's y-slot matches its arrival order; when absent (older
  // fixtures, boot path) we fall back to recipe.in / recipe.out declaration
  // order.
  inputOrder?: ItemId[];
  outputOrder?: ItemId[];
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
  const {
    recipe,
    multiplier,
    multiplicity,
    expanded,
    portTransportKinds,
    inputOrder,
    outputOrder,
  } = data;
  const i18n = useI18n();
  const { machineById } = useItemPack();
  // Rows in ELK-resolved arrival order (falls back to declaration order). Each
  // row carries its own stoich for the rate text. geom does not place the
  // handles (they center on the real DOM row via CSS); it only feeds node
  // sizing here and the offline routing model (busRouting / ELK), which the
  // pinned CSS keeps in sync with these rows.
  const ins = orderByItem(recipe.in, inputOrder);
  const outs = orderByItem(recipe.out, outputOrder);
  const geom = measureRecipe(recipe);
  // Aggregate scale across all machines. The render-pipeline path supplies a
  // rational `multiplicity`; the older boot path an integer `multiplier`; a
  // node with neither runs a single machine. Rows and the header multiply by
  // this so the node's numbers match its incident edge chips.
  const perMachine = new Fraction(1);
  const scale: Fraction = multiplicity
    ? new Fraction(`${multiplicity.num}/${multiplicity.denom}`)
    : typeof multiplier === "number"
      ? new Fraction(multiplier)
      : perMachine;

  // The machine shown is producers[0]. Multiple producers are not handled yet.
  const producerId = recipe.producers[0];
  const machine =
    producerId !== undefined ? machineById.get(producerId) : undefined;
  // The header product line is the first output's display name. This is the
  // recipe's declared primary output (recipe.out[0]), not the reordered
  // top-of-column output: the header identifies the recipe, while `outs` only
  // controls the arrival-sorted side-column order. Multiple outputs are not
  // handled yet.
  const outputItemId = recipe.out[0]?.item;
  const outputItemName =
    outputItemId !== undefined ? i18n.displayName(outputItemId) : "";
  const machineName = machine ? i18n.displayName(machine.id) : null;
  const tier = machine ? deriveTier(machine.id) : null;
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
      {/* Header: a 28px machine icon slot plus three text lines. The icon slot
          is a placeholder div carrying data-machine-icon for later sprite
          wiring. */}
      <div className="rn-head">
        <div className="rn-machine-block">
          <div className="machine-icon" data-machine-icon={machineIconKey}>
            <Sprite iconId={machine?.icon ?? producerId} size={28} />
          </div>
        </div>
        <div className="rn-recipe-block">
          <div className="product" title={outputItemName}>
            {outputItemName}
          </div>
          {machine !== undefined ? (
            <div className="machine-name">
              <span className="cn">{machineName}</span>
              {tier !== null ? <span className="tier">{tier}</span> : null}
            </div>
          ) : null}
        </div>
        {/* Machine multiplier: one reserved header cell beside the rate block,
            never an overlay. It is critical info, so it survives at every zoom
            band (the rate figures drop at zoom-low; this chip does not). */}
        {badgeText !== null ? (
          <span className="rn-mult-chip">{badgeText}</span>
        ) : null}
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
                <Sprite iconId={p.item} size={20} />
                <span className="lbl" title={label}>
                  {label}
                </span>
                <span className="rate">
                  {rowRateText(p, recipe.time, speed, scale)}
                </span>
              </div>
            );
          })}
        </div>
        <div className="rn-side out">
          {outs.map((p) => {
            const label = i18n.displayName(p.item);
            const handleId = `out:${p.item}`;
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
                <Sprite iconId={p.item} size={20} />
                <span className="lbl" title={label}>
                  {label}
                </span>
                <span className="rate">
                  {rowRateText(p, recipe.time, speed, scale)}
                </span>
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
