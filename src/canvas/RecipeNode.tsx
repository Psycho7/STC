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
// per-machine port rate is qty * speed / time), scaled by the replica
// multiplier when the older path supplies one. Rational-multiplicity callers
// pass multiplier=undefined because the solver already scaled their rates.
// Exact Fraction math keeps non-integer speeds free of float junk; rates here
// are non-negative, so serializing .n/.d is safe.
function rowRateText(
  stoich: Stoich,
  recipeTime: number,
  speed: Fraction,
  multiplier: number,
): string {
  const perSec = new Fraction(stoich.qty)
    .mul(speed)
    .mul(multiplier)
    .div(recipeTime);
  return formatRationalPerMin({
    num: perSec.n.toString(),
    denom: perSec.d.toString(),
  });
}

export default function RecipeNode({ data }: NodeProps<RecipeNodeType>) {
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
  // Rows in ELK-resolved arrival order (falls back to declaration order). The
  // handle at geom.inHandleYs[i] and the row at slot i describe the same item,
  // and each row carries its own stoich for the rate text.
  const ins = orderByItem(recipe.in, inputOrder);
  const outs = orderByItem(recipe.out, outputOrder);
  const geom = measureRecipe(recipe);
  const scale = typeof multiplier === "number" ? multiplier : 1;

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

  // Header rate column: outputs[0] qty times machine speed over recipe.time,
  // times 60, scaled by the older multiplier path. Empty string hides the value
  // when there is no primary output. Uses recipe.out[0] (declared primary), not
  // the reordered side-column top, for the same reason as the header product.
  const primaryOut = recipe.out[0];
  const rateValText =
    primaryOut !== undefined
      ? rowRateText(primaryOut, recipe.time, speed, scale)
      : "";

  return (
    <div
      data-testid="recipe-node"
      data-recipe-id={recipe.id}
      className="recipe-node"
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
            <>
              <div className="machine-name">
                <span className="cn">{machineName}</span>
                {tier !== null ? <span className="tier">{tier}</span> : null}
              </div>
              <div className="machine-mid">{machine.id}</div>
            </>
          ) : null}
        </div>
        <div className="rn-rate-block">
          <div className="rate-val">{rateValText}</div>
          <div className="rate-lbl">UPM</div>
        </div>
      </div>

      {ins.map((p, i) => {
        const handleId = `in:${p.item}`;
        return (
          <Handle
            key={handleId}
            id={handleId}
            type="target"
            position={Position.Left}
            style={{ top: geom.inHandleYs[i] }}
          />
        );
      })}
      {ins.map((p, i) => (
        <PortGlyph
          key={`in-glyph:${p.item}`}
          kind={portTransportKinds?.get(`in:${p.item}`)}
          side="left"
          top={geom.inHandleYs[i]!}
          item={p.item}
        />
      ))}
      {outs.map((p, i) => {
        const handleId = `out:${p.item}`;
        return (
          <Handle
            key={handleId}
            id={handleId}
            type="source"
            position={Position.Right}
            style={{ top: geom.outHandleYs[i] }}
          />
        );
      })}
      {outs.map((p, i) => (
        <PortGlyph
          key={`out-glyph:${p.item}`}
          kind={portTransportKinds?.get(`out:${p.item}`)}
          side="right"
          top={geom.outHandleYs[i]!}
          item={p.item}
        />
      ))}

      <div className="rn-body">
        <div className="rn-side in">
          {ins.map((p) => {
            const label = i18n.displayName(p.item);
            return (
              // --row-accent tints the row's left accent tab to the item color
              // (canvas.css reads it in .rn-row.input::before) so the row pairs
              // by hue with its entering edge and port glyph.
              <div
                key={`in-row:${p.item}`}
                className="rn-row input"
                style={{ ["--row-accent" as string]: itemColor(p.item) }}
              >
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
            return (
              // --row-accent tints the row's right accent tab to the item color
              // (canvas.css reads it in .rn-row.output::after) so the row pairs
              // by hue with its leaving edge and port glyph.
              <div
                key={`out-row:${p.item}`}
                className="rn-row output"
                style={{ ["--row-accent" as string]: itemColor(p.item) }}
              >
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
        <div className="cycle">{recipe.time}s · cycle</div>
        <div className="pwr" />
      </div>

      {badgeText !== null ? (
        <span
          style={{
            position: "absolute",
            top: 4,
            right: 6,
            fontSize: 11,
            color: "#444",
          }}
        >
          {badgeText}
        </span>
      ) : null}
    </div>
  );
}
