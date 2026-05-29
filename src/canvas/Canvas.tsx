import {
  ReactFlow,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import RecipeNode from "./RecipeNode";
import GroupNode from "./GroupNode";
import LoopNode from "./LoopNode";
import ProductNode from "./ProductNode";
import ItemEdge from "./ItemEdge";
import { useI18n } from "../data/i18n-context";
import type { CSSProperties } from "react";
import { iconSheetUrl } from "./iconSprite";

const canvasThemeStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  position: "relative",
  ["--icons-url" as string]: `url(${iconSheetUrl})`,
};

// Node type table covers both the older fixtures (recipe + group only) and the
// current render pipeline (recipe + loop). Edge type "item" is the
// label renderer; older edges with no type fall back to React Flow's default
// rendering.
const nodeTypes = {
  recipe: RecipeNode,
  group: GroupNode,
  loop: LoopNode,
  product: ProductNode,
};
const edgeTypes = { item: ItemEdge };

interface CanvasProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange?: OnNodesChange<Node>;
  onEdgesChange?: OnEdgesChange<Edge>;
}

export default function Canvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
}: CanvasProps) {
  const i18n = useI18n();

  return (
    <div className="ak-canvas-theme" style={canvasThemeStyle}>
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          zIndex: 10,
          display: "flex",
          gap: 8,
        }}
      >
        <button
          type="button"
          onClick={() => {
            // navigator.clipboard is missing in jsdom and in non-secure
            // browser contexts, so optional-chain it and let the click quietly
            // do nothing there.
            void navigator.clipboard?.writeText(window.location.href);
          }}
          aria-label={i18n.t("canvas.copy_share")}
        >
          {i18n.t("canvas.copy_share")}
        </button>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        {...(onNodesChange ? { onNodesChange } : {})}
        {...(onEdgesChange ? { onEdgesChange } : {})}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
      />
      <div className="canvas-frame" aria-hidden="true" />
      <div className="cb tl" aria-hidden="true" />
      <div className="cb tr" aria-hidden="true" />
      <div className="cb bl" aria-hidden="true" />
      <div className="cb br" aria-hidden="true" />
      <div className="canvas-annot top-left">
        BLUEPRINT VIEW · LEFT ALIGN GUIDES
      </div>
      <div className="canvas-annot top-right">{`REPLICAS:${nodes.length}`}</div>
      <div className="canvas-annot bottom-right">STATUS · READY</div>
    </div>
  );
}
