import {
  ReactFlow,
  Controls,
  type Node,
  type Edge,
  type OnNodesChange,
  type OnEdgesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RecipeNode from "./RecipeNode";
import GroupNode from "./GroupNode";
import LoopNode from "./LoopNode";
import ProductNode from "./ProductNode";
import ItemEdge from "./ItemEdge";
import BusEdge from "./BusEdge";
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
const edgeTypes = { item: ItemEdge, bus: BusEdge };

// Let fitView zoom far enough out that a big production graph fits on screen.
// React Flow's default minZoom of 0.5 clamps the fit, so large plans overflow
// the viewport and get cut off; 0.05 lets the whole graph shrink to fit. Padding
// keeps a small margin around the fitted graph so nodes do not touch the frame.
const FIT_VIEW_OPTIONS = { padding: 0.12 };

// Delay before a hover registers, so sweeping the pointer across the canvas does
// not strobe the dim state on every element crossed. A leave within the window
// cancels the pending hover.
const HOVER_INTENT_MS = 150;

// The solve + layout lifecycle state surfaced by the status annotation and the
// header chip. READY = idle, SOLVING = a generation is in flight, ERROR = the
// last solve or load failed.
export type CanvasStatus = "READY" | "SOLVING" | "ERROR";

interface CanvasProps {
  nodes: Node[];
  edges: Edge[];
  status?: CanvasStatus;
  onNodesChange?: OnNodesChange<Node>;
  onEdgesChange?: OnEdgesChange<Edge>;
}

// Which graph element the pointer is over. Drives the ego-network highlight:
// the hovered element plus its immediate neighbourhood stays lit, everything
// else gets the `dimmed` class. `null` = idle (no dimming at all).
type Hovered = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

// Adjacency indexes derived once per `edges` array. Everything the highlight
// needs to expand a hovered element into its focus set: node -> incident edges,
// edge -> endpoints, trunk -> member edges, and an id -> edge lookup.
interface Adjacency {
  edgesByNode: Map<string, string[]>;
  endpointsByEdge: Map<string, [string, string]>;
  edgesByTrunk: Map<string, string[]>;
  edgeById: Map<string, Edge>;
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function withDimmed(className: string | undefined): string {
  return className ? `${className} dimmed` : "dimmed";
}

function withLitContainer(className: string | undefined): string {
  return className ? `${className} lit-container` : "lit-container";
}

export default function Canvas({
  nodes,
  edges,
  status = "READY",
  onNodesChange,
  onEdgesChange,
}: CanvasProps) {
  const i18n = useI18n();
  const [hovered, setHovered] = useState<Hovered>(null);

  // Hover intent: a pending timer holds the next hover for HOVER_INTENT_MS. A
  // leave (or a new enter) cancels any pending timer so quick pointer travel
  // never settles the dim state.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingHover = useCallback(() => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  const scheduleHover = useCallback(
    (next: Hovered) => {
      cancelPendingHover();
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null;
        setHovered(next);
      }, HOVER_INTENT_MS);
    },
    [cancelPendingHover],
  );
  const clearHover = useCallback(() => {
    cancelPendingHover();
    setHovered(null);
  }, [cancelPendingHover]);
  useEffect(() => cancelPendingHover, [cancelPendingHover]);

  const adjacency = useMemo<Adjacency>(() => {
    const edgesByNode = new Map<string, string[]>();
    const endpointsByEdge = new Map<string, [string, string]>();
    const edgesByTrunk = new Map<string, string[]>();
    const edgeById = new Map<string, Edge>();
    for (const edge of edges) {
      edgeById.set(edge.id, edge);
      endpointsByEdge.set(edge.id, [edge.source, edge.target]);
      pushInto(edgesByNode, edge.source, edge.id);
      pushInto(edgesByNode, edge.target, edge.id);
      const trunkKey = (edge.data as { trunkKey?: unknown } | undefined)
        ?.trunkKey;
      if (edge.type === "bus" && typeof trunkKey === "string") {
        pushInto(edgesByTrunk, trunkKey, edge.id);
      }
    }
    return { edgesByNode, endpointsByEdge, edgesByTrunk, edgeById };
  }, [edges]);

  // The lit set for the current hover: node ids and edge ids that keep full
  // opacity. `null` when idle so the render path can skip mapping entirely and
  // hand React Flow the original arrays (no churn, zero `dimmed` classes).
  const focus = useMemo<{
    nodeIds: Set<string>;
    edgeIds: Set<string>;
  } | null>(() => {
    if (!hovered) return null;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const lightEdge = (edgeId: string): void => {
      edgeIds.add(edgeId);
      const endpoints = adjacency.endpointsByEdge.get(edgeId);
      if (endpoints) {
        nodeIds.add(endpoints[0]);
        nodeIds.add(endpoints[1]);
      }
    };
    if (hovered.kind === "node") {
      nodeIds.add(hovered.id);
      for (const edgeId of adjacency.edgesByNode.get(hovered.id) ?? []) {
        lightEdge(edgeId);
      }
    } else {
      const edge = adjacency.edgeById.get(hovered.id);
      const trunkKey = (edge?.data as { trunkKey?: unknown } | undefined)
        ?.trunkKey;
      // A bus edge lights its whole trunk (every same-trunkKey edge + their
      // endpoints); any other edge lights just itself and its two endpoints.
      const trunkEdges =
        edge?.type === "bus" && typeof trunkKey === "string"
          ? adjacency.edgesByTrunk.get(trunkKey)
          : undefined;
      for (const edgeId of trunkEdges ?? [hovered.id]) lightEdge(edgeId);
    }
    return { nodeIds, edgeIds };
  }, [hovered, adjacency]);

  // Container boxes (`type: "group"`) never dim while any of their child nodes
  // is in the focus set, so the frame around a lit cluster does not read as
  // faded. With no focused child they dim like any other node.
  const litContainers = useMemo<Set<string> | null>(() => {
    if (!focus) return null;
    const lit = new Set<string>();
    for (const node of nodes) {
      if (node.parentId && focus.nodeIds.has(node.id)) lit.add(node.parentId);
    }
    return lit;
  }, [focus, nodes]);

  const displayNodes = useMemo<Node[]>(() => {
    if (!focus || !litContainers) return nodes;
    return nodes.map((node) => {
      if (focus.nodeIds.has(node.id)) return node;
      // A container lit only because a child is focused keeps a lit border but a
      // still-translucent fill, so it does not read as a bright empty slab over
      // its dimmed members.
      if (node.type === "group" && litContainers.has(node.id)) {
        return { ...node, className: withLitContainer(node.className) };
      }
      return { ...node, className: withDimmed(node.className) };
    });
  }, [nodes, focus, litContainers]);

  const displayEdges = useMemo<Edge[]>(() => {
    if (!focus) return edges;
    return edges.map((edge) =>
      focus.edgeIds.has(edge.id)
        ? edge
        : {
            ...edge,
            className: withDimmed(edge.className),
            // The edge label chips (rate / entry / bus drop-rise) portal out of
            // this wrapper via EdgeLabelRenderer, so the wrapper's `dimmed`
            // class never fades them. Thread the dim through edge data; the
            // chips map it onto their own .flow-chip.dimmed rule.
            data: { ...edge.data, dimmed: true },
          },
    );
  }, [edges, focus]);

  return (
    <div
      className={focus ? "ak-canvas-theme hover-active" : "ak-canvas-theme"}
      style={canvasThemeStyle}
    >
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
        nodes={displayNodes}
        edges={displayEdges}
        {...(onNodesChange ? { onNodesChange } : {})}
        {...(onEdgesChange ? { onEdgesChange } : {})}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeMouseEnter={(_, node) => {
          // Group boxes are hover-inert: they own no edges, so lighting one dims
          // the whole graph for zero payoff. Skip them entirely.
          if (node.type === "group") return;
          scheduleHover({ kind: "node", id: node.id });
        }}
        onNodeMouseLeave={clearHover}
        onEdgeMouseEnter={(_, edge) => scheduleHover({ kind: "edge", id: edge.id })}
        onEdgeMouseLeave={clearHover}
        onPaneClick={clearHover}
        fitView
        minZoom={0.05}
        fitViewOptions={FIT_VIEW_OPTIONS}
      >
        <Controls />
      </ReactFlow>
      <div className="canvas-frame" aria-hidden="true" />
      <div className="cb tl" aria-hidden="true" />
      <div className="cb tr" aria-hidden="true" />
      <div className="cb bl" aria-hidden="true" />
      <div className="cb br" aria-hidden="true" />
      <div className="canvas-annot top-left">
        BLUEPRINT VIEW · LEFT ALIGN GUIDES
      </div>
      {/* Rendered recipe units only: the node array also carries group
          containers and product chips, and clustering may aggregate replicas
          into class units - hence UNITS, not REPLICAS. */}
      <div className="canvas-annot top-right">
        {`UNITS:${nodes.filter((n) => n.type === "recipe").length}`}
      </div>
      <div className="canvas-annot bottom-right">{`STATUS · ${status}`}</div>
    </div>
  );
}
