import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import type { Recipe, Stoich } from "@aef/schema";
import { measureRecipe } from "./recipeGeometry";
import { useI18n } from "../data/i18n-context";
import { PortGlyph } from "./PortGlyph";
import { formatRationalPerMin } from "../data/rate-format";
import type { PortTransportKinds } from "./layout";
import type { RationalString } from "../data/targets";
import { formatMultiplicityBadge } from "./multiplicity-badge";
import { useItemPack } from "./itemPackContext";
import { iconPosition } from "./iconSprite";

// Sprite component: looks up the sprite position by icon id and renders an
// <ico><spr> pair. Returns null when no position is found, so the slot collapses
// instead of showing a misaligned default.
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

// Derive the tier chip ("T1", "T2", and so on) from a trailing -t<digits>
// suffix on the machine id. The schema has no Machine.tier field today, so the
// id is the only source. Returns null when there is no such suffix, in which
// case callers leave the chip off.
function deriveTier(id: string): string | null {
  const m = id.match(/-t(\d+)$/i);
  return m ? `T${m[1]}` : null;
}

// Data shape accepted by RecipeNode.
//
// Two callers coexist:
//  - The older App boot path passes { recipe, multiplier, expanded } and draws
//    an xN badge inside the node when multiplier > 1.
//  - The render-pipeline path passes { recipe, kind: "recipe", multiplicity }.
//    The badge formatter turns the multiplicity field into an integer or a
//    two-decimal rational. The kind discriminator stays around to keep callers
//    explicit.
type RecipeNodeData = {
  recipe: Recipe;
  multiplier?: number;
  multiplicity?: RationalString;
  expanded?: boolean;
  kind?: "recipe";
  // Per-port transport kind, keyed by the React Flow Handle id
  // (for example "in:copper_ore", "out:copper_powder"). Optional so older
  // fixtures and tests keep working without it.
  portTransportKinds?: PortTransportKinds;
};
type RecipeNodeType = Node<RecipeNodeData, "recipe">;

// Per-row rate label: items per cycle over cycle time, scaled by the replica
// multiplier when the older path supplies one. Rational-multiplicity callers
// pass multiplier=undefined here because the solver already scaled their rates
// upstream.
function rowRateText(
  stoich: Stoich,
  recipeTime: number,
  multiplier: number,
): string {
  const rps = {
    num: String(stoich.qty * multiplier),
    denom: String(recipeTime),
  };
  return formatRationalPerMin(rps);
}

export default function RecipeNode({ data }: NodeProps<RecipeNodeType>) {
  const { recipe, multiplier, multiplicity, expanded, portTransportKinds } =
    data;
  const i18n = useI18n();
  const { machineById } = useItemPack();
  const ins = recipe.in;
  const outs = recipe.out;
  const geom = measureRecipe(recipe);
  const scale = typeof multiplier === "number" ? multiplier : 1;

  // The machine shown is producers[0]. Affordances for multiple producers are
  // not built yet.
  const producerId = recipe.producers[0];
  const machine =
    producerId !== undefined ? machineById.get(producerId) : undefined;
  // The header product line is the display name of the first output.
  // Affordances for multiple outputs are not built yet.
  const outputItemId = outs[0]?.item;
  const outputItemName =
    outputItemId !== undefined ? i18n.displayName(outputItemId) : "";
  const machineName = machine ? i18n.displayName(machine.id) : null;
  const tier = machine ? deriveTier(machine.id) : null;
  // Later sprite wiring reads this attribute; it falls back to the raw producer
  // id when the machine record is missing (corrupt fixture).
  const machineIconKey = machine?.icon ?? producerId ?? "";
  // When `multiplicity` is present the render-pipeline path wins; otherwise the
  // older boot path uses `multiplier` for an integer-only badge that is hidden
  // while expanded.
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

  // Header rate column: outputs[0] qty over recipe.time, times 60, scaled by
  // the older multiplier path. An empty string hides the value when the recipe
  // has no primary output.
  const primaryOut = outs[0];
  const rateValText =
    primaryOut !== undefined
      ? formatRationalPerMin({
          num: String(primaryOut.qty * scale),
          denom: String(recipe.time),
        })
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
          wiring; there is no icon-rendering primitive yet. */}
      <div className="rn-head">
        <div className="rn-machine-block">
          <div className="machine-icon" data-machine-icon={machineIconKey}>
            <Sprite iconId={machine?.icon ?? producerId} size={28} />
          </div>
        </div>
        <div className="rn-recipe-block">
          <div className="product">{outputItemName}</div>
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
        />
      ))}

      <div className="rn-body">
        <div className="rn-side in">
          {ins.map((p) => (
            <div key={`in-row:${p.item}`} className="rn-row input">
              <Sprite iconId={p.item} size={20} />
              <span className="lbl">{i18n.displayName(p.item)}</span>
              <span className="rate">{rowRateText(p, recipe.time, scale)}</span>
            </div>
          ))}
        </div>
        <div className="rn-side out">
          {outs.map((p) => (
            <div key={`out-row:${p.item}`} className="rn-row output">
              <Sprite iconId={p.item} size={20} />
              <span className="lbl">{i18n.displayName(p.item)}</span>
              <span className="rate">{rowRateText(p, recipe.time, scale)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Footer: the left half shows cycle time; the right half (.pwr) is
          reserved for power, which waits on extractor work. */}
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
