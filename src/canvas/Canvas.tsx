import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  useReactFlow,
  useNodesInitialized,
  useStore,
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

// Debounce for the ResizeObserver re-fit so dragging the window edge (a burst of
// resize callbacks) coalesces into a single fitView instead of thrashing.
const RESIZE_REFIT_MS = 100;

// The solve + layout lifecycle state surfaced by the status annotation and the
// header chip. READY = idle, SOLVING = a generation is in flight, ERROR = the
// last solve or load failed.
export type CanvasStatus = "READY" | "SOLVING" | "ERROR";

interface CanvasProps {
  nodes: Node[];
  edges: Edge[];
  status?: CanvasStatus;
  // Monotonically increasing counter bumped by App on every applied solve +
  // layout. A change means the node/edge arrays are a fresh plan, so the
  // viewport re-fits (once measured) rather than staying on the old camera.
  layoutGeneration?: number;
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

// How long the copy button holds its transient result before reverting to the
// default label.
const COPY_FEEDBACK_MS = 1500;

// Level-of-detail band derived from the live React Flow zoom. At the fit zoom of
// a dense plan (roughly 0.35-0.55) per-machine metadata and card chrome shrink
// below legibility, so the canvas theme container carries a band class that
// canvas.css uses to brighten cards, drop sub-legible text layers, and fade the
// dot grid. "zoom-low" is the aggressive overview treatment (< 0.4), "zoom-mid"
// a lighter touch (0.4-0.8), and "" leaves full detail at higher zoom.
export function zoomBand(zoom: number): "" | "zoom-low" | "zoom-mid" {
  if (zoom < 0.4) return "zoom-low";
  if (zoom < 0.8) return "zoom-mid";
  return "";
}

// Wrap the canvas in a ReactFlowProvider so CanvasInner can reach the React Flow
// instance (useReactFlow) and the node-measurement signal (useNodesInitialized)
// to drive imperative fitView on plan changes and container resizes.
export default function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  nodes,
  edges,
  status = "READY",
  layoutGeneration = 0,
  onNodesChange,
  onEdgesChange,
}: CanvasProps) {
  const i18n = useI18n();
  const [hovered, setHovered] = useState<Hovered>(null);
  const { fitView } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const containerRef = useRef<HTMLDivElement>(null);
  // Live zoom drives the low-zoom LOD band on the theme container. Reading
  // transform[2] (zoom only) re-renders on zoom changes but not on pan.
  const zoom = useStore((state) => state.transform[2]);

  // Re-fit the viewport once per layout generation, but only after React Flow
  // has measured the new nodes (async): fitting synchronously on the prop change
  // would frame zero-size nodes. `fittedGen` guards against re-fitting on the
  // repeated nodesInitialized signals within one generation (hover re-renders,
  // for example).
  const fittedGen = useRef<number | null>(null);
  useEffect(() => {
    if (!nodesInitialized) return;
    if (fittedGen.current === layoutGeneration) return;
    fittedGen.current = layoutGeneration;
    void fitView(FIT_VIEW_OPTIONS);
  }, [nodesInitialized, layoutGeneration, fitView]);

  // Re-fit when the canvas container changes size (window resize, side-panel
  // toggle) so the graph keeps filling the pane instead of drifting into a
  // corner. Debounced so a drag-resize does not fire a fit on every frame.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // ResizeObserver fires once with the initial size on observe(); the
    // generation effect already frames the first render, so skip that callback
    // and re-fit only on genuine later size changes.
    let seenInitial = false;
    const observer = new ResizeObserver(() => {
      if (!seenInitial) {
        seenInitial = true;
        return;
      }
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void fitView(FIT_VIEW_OPTIONS);
      }, RESIZE_REFIT_MS);
    });
    observer.observe(el);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitView]);

  // Transient result of the last copy-share click. "copied" / "failed" replace
  // the button label for COPY_FEEDBACK_MS so the click is never silent, then it
  // reverts to "idle".
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCopyState = useCallback((next: "copied" | "failed") => {
    setCopyState(next);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopyState("idle");
    }, COPY_FEEDBACK_MS);
  }, []);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );
  const handleCopyShare = useCallback(() => {
    // navigator.clipboard is absent in non-secure contexts (plain-http LAN) and
    // in jsdom. Surface that as a failure rather than a silent no-op.
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      flashCopyState("failed");
      return;
    }
    clipboard.writeText(window.location.href).then(
      () => flashCopyState("copied"),
      () => flashCopyState("failed"),
    );
  }, [flashCopyState]);
  const copyLabel =
    copyState === "copied"
      ? i18n.t("canvas.copy_share.copied")
      : copyState === "failed"
        ? i18n.t("canvas.copy_share.failed")
        : i18n.t("canvas.copy_share");

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
      ref={containerRef}
      className={["ak-canvas-theme", zoomBand(zoom), focus ? "hover-active" : ""]
        .filter(Boolean)
        .join(" ")}
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
          data-testid="copy-share"
          onClick={handleCopyShare}
          aria-label={copyLabel}
        >
          {copyLabel}
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
        minZoom={0.05}
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
