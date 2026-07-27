import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
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
import BusBands from "./BusBands";
import { contentBounds } from "./chipSeating";
import type { RFAnyNode } from "./layout";
import { useI18n } from "../data/i18n-context";
import type { CSSProperties } from "react";
import { iconSheetUrl } from "./iconSprite";

// Camera handle the render-quality exam drives (see the gated effect in
// CanvasInner). Declared globally because the driver reaches it through the page
// window, not through a module import.
declare global {
  interface Window {
    __stcExam?: {
      setViewport(v: { x: number; y: number; zoom: number }): void;
      fitView(): void;
      contentBounds(): {
        x: number;
        y: number;
        width: number;
        height: number;
      } | null;
    };
  }
}

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

// fitBounds padding matches FIT_VIEW_OPTIONS: a fraction of the fitted extent
// kept as margin so content does not touch the frame. fitBounds frames an
// explicit rect (the node cards PLUS the seated chip extents contentBounds
// computes), where fitView would frame the node cards alone and clip a chip
// cascaded below the deepest lane band or nudged past a border card.
const FIT_BOUNDS_OPTIONS = { padding: 0.12 };

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

// A bus member owns its trunk's shared drawings (the trunk segment, junction
// dot, and aggregate chip) unless explicitly flagged otherwise. Undefined counts
// as owner, matching BusEdge's `busChipOwner ?? true`, so an un-annotated fixture
// keeps the whole-group highlight. One helper unifies the hovered-edge and
// sibling-edge checks that would otherwise split into `!== false` / `=== true`.
function isOwner(data: { busChipOwner?: unknown } | undefined): boolean {
  return data?.busChipOwner !== false;
}

function withDimmed(className: string | undefined): string {
  return className ? `${className} dimmed` : "dimmed";
}

function withLitContainer(className: string | undefined): string {
  return className ? `${className} lit-container` : "lit-container";
}

// Stamp the hover focus onto the edges React Flow renders. Idle (`focus` null)
// returns the input array untouched, so nothing re-renders while the pointer is
// off the graph. Exported for the unit test: Canvas owns its ReactFlowProvider
// and takes no viewport prop, so the zoom-dependent half of this cannot be
// driven from a rendered Canvas.
export function focusEdges(
  edges: Edge[],
  focus: { edgeIds: Set<string> } | null,
): Edge[] {
  if (!focus) return edges;
  return edges.map((edge) =>
    focus.edgeIds.has(edge.id)
      ? // The lit edge announces itself so its chips can outrank the zoom
        // level-of-detail gates and show the rate the hover is asking for.
        { ...edge, data: { ...edge.data, focused: true } }
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
}

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

// Above this node count the overview minimap appears. Small plans fit legibly
// on their own, so the minimap is only worth its footprint on the dense plans
// that overflow a readable-zoom viewport.
const MINIMAP_MIN_NODES = 15;

// Minimap node fill by role, so the overview reads recipes, boundary products,
// and loop containers apart. Literal colors (not CSS vars): the minimap paints
// them as SVG fill attributes, where var() does not resolve. These track the
// canvas palette: a light gray card, a cyan boundary chip, a dim container.
const MINIMAP_RECIPE = "#5a5f68";
const MINIMAP_PRODUCT = "#7cdffc";
const MINIMAP_CONTAINER = "#343841";
const MINIMAP_MASK = "rgba(15, 17, 20, 0.72)";

function minimapNodeColor(node: Node): string {
  if (node.type === "product") return MINIMAP_PRODUCT;
  if (node.type === "group" || node.type === "loop") return MINIMAP_CONTAINER;
  return MINIMAP_RECIPE;
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
  const { fitView, fitBounds, setViewport } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const containerRef = useRef<HTMLDivElement>(null);

  // Fit the viewport to the whole content -- node cards plus every seated chip
  // and lane band contentBounds covers -- via fitBounds, so a chip cascaded below
  // the deepest lane band is inside the frame instead of clipped at the rim.
  // Falls back to fitView on an empty graph (no bounds to frame). Depends on the
  // node/edge props; these change only on a new plan (hover mutates the local
  // display arrays, not the props), so the fit effects below stay quiet during
  // hover and re-fit only when the plan actually changes.
  const fitContent = useCallback(() => {
    const bounds = contentBounds(nodes as unknown as RFAnyNode[], edges);
    if (bounds === null) {
      void fitView(FIT_VIEW_OPTIONS);
      return;
    }
    void fitBounds(bounds, FIT_BOUNDS_OPTIONS);
  }, [nodes, edges, fitView, fitBounds]);

  // Exam hook: the render-quality exam needs exact camera placement to tile a
  // plan reproducibly, and wheel zoom cannot translate the view (it pins the
  // world point under the cursor). Nothing here mutates plan data; it is camera
  // control plus the same contentBounds the fit path already uses, so the
  // shipped bundle carries it inert unless a URL asks for it by name. The effect
  // re-runs on every nodes/edges change because contentBounds closes over both:
  // a hook left installed from an earlier plan would hand the driver a stale
  // rect and it would tile the wrong region.
  //
  // A commanded viewport lands exactly: setViewport forwards to d3-zoom's
  // zoom.transform, which assigns the transform verbatim, and scaleExtent binds
  // only the gesture handlers, so minZoom 0.05 (on the ReactFlow element below)
  // and React Flow's default maxZoom of 2 bind user gestures and the fit path,
  // not this hook. fitView is the one that clamps, because it delegates to
  // fitBounds and getViewportForBounds, and setViewport's discarded Promise
  // hides when the transition settles: a driver must read back the achieved
  // transform rather than assume its own fit zoom is viewport over bounds width.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("exam") !== "1") return;
    window.__stcExam = {
      setViewport: (v) => {
        void setViewport(v);
      },
      fitView: () => {
        fitContent();
      },
      contentBounds: () => contentBounds(nodes as unknown as RFAnyNode[], edges),
    };
    return () => {
      delete window.__stcExam;
    };
  }, [setViewport, fitContent, nodes, edges]);

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
    fitContent();
  }, [nodesInitialized, layoutGeneration, fitContent]);

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
        fitContent();
      }, RESIZE_REFIT_MS);
    });
    observer.observe(el);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitContent]);

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

  // The Controls buttons and MiniMap pull their aria-labels from React Flow's
  // ariaLabelConfig (the <Controls> component only exposes the container label
  // directly), so localize them here rather than leaving the built-in English.
  const ariaLabelConfig = useMemo(
    () => ({
      "controls.ariaLabel": i18n.t("canvas.controls.panel"),
      "controls.zoomIn.ariaLabel": i18n.t("canvas.controls.zoom_in"),
      "controls.zoomOut.ariaLabel": i18n.t("canvas.controls.zoom_out"),
      "controls.fitView.ariaLabel": i18n.t("canvas.controls.fit_view"),
      "controls.interactive.ariaLabel": i18n.t("canvas.controls.interactive"),
      "minimap.ariaLabel": i18n.t("canvas.minimap"),
    }),
    [i18n],
  );

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
      // trunkKey is item + "|" + source, so a lane trunk and a fan-out trunk
      // leaving the SAME (item, source) port share ONE trunkKey and merge into a
      // single hover group here. Each sub-trunk still keeps its own aggregate
      // chip showing that sub-trunk's OWN total (its members' summed rate), not
      // the port's full outflow across both.
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
      const data = edge?.data as
        | { trunkKey?: unknown; busChipOwner?: unknown }
        | undefined;
      const trunkKey = data?.trunkKey;
      // A bus edge belongs to a trunk (every same-trunkKey member). Two hover
      // modes split off which members light:
      //   TRUNK hover  -- the pointer is over the trunk owner (the member that
      //     draws the shared trunk segment, junction, and aggregate chip). Light
      //     the whole group, today's behaviour. `busChipOwner` absent counts as
      //     owner so an un-annotated fixture keeps the whole-group highlight.
      //   BRANCH hover -- the pointer is over a non-owner member. Light only that
      //     branch plus the trunk owner(s); sibling branches stay dimmed. A lane
      //     and a fan-out sub-trunk may share one trunkKey (merged group); each
      //     sub-trunk keeps its own owner, so branch mode lights every member
      //     whose `busChipOwner === true` and dims the rest across both.
      const trunkEdges =
        edge?.type === "bus" && typeof trunkKey === "string"
          ? adjacency.edgesByTrunk.get(trunkKey)
          : undefined;
      if (trunkEdges) {
        if (isOwner(data)) {
          for (const edgeId of trunkEdges) lightEdge(edgeId);
        } else {
          lightEdge(hovered.id);
          for (const edgeId of trunkEdges) {
            if (edgeId === hovered.id) continue;
            const sibData = adjacency.edgeById.get(edgeId)?.data as
              | { busChipOwner?: unknown }
              | undefined;
            if (isOwner(sibData)) lightEdge(edgeId);
          }
        }
      } else {
        lightEdge(hovered.id);
      }
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

  const displayEdges = useMemo<Edge[]>(
    () => focusEdges(edges, focus),
    [edges, focus],
  );

  // Memoized on nodes: the annotation re-renders every zoom tick (this
  // component subscribes to zoom), but the unit count changes only with nodes.
  const unitCount = useMemo(
    () => nodes.filter((n) => n.type === "recipe").length,
    [nodes],
  );

  return (
    <div
      ref={containerRef}
      className={["ak-canvas-theme", zoomBand(zoom), focus ? "hover-active" : ""]
        .filter(Boolean)
        .join(" ")}
      style={canvasThemeStyle}
    >
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
        ariaLabelConfig={ariaLabelConfig}
        // Keep nodes mouse-draggable and Tab-focusable (tabIndex stays 0), but
        // stop the arrow keys from nudging a selected node out of the ELK
        // layout. React Flow gates the arrow-key move handler on this flag; it
        // leaves keyboard focus traversal intact.
        disableKeyboardA11y
      >
        <BusBands nodes={nodes} edges={edges} />
        <Controls aria-label={i18n.t("canvas.controls.panel")} />
        {nodes.length > MINIMAP_MIN_NODES ? (
          <MiniMap
            pannable
            zoomable
            nodeColor={minimapNodeColor}
            maskColor={MINIMAP_MASK}
          />
        ) : null}
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
      <div className="canvas-annot top-right">{`UNITS:${unitCount}`}</div>
      <div className="canvas-annot bottom-right">{`STATUS · ${status}`}</div>
    </div>
  );
}
