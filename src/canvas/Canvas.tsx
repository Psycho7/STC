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
  type NodeMouseHandler,
  type EdgeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { flushSync } from "react-dom";
import RecipeNode from "./RecipeNode";
import GroupNode from "./GroupNode";
import LoopNode from "./LoopNode";
import ProductNode from "./ProductNode";
import ItemEdge, { edgeStrokeWidth, withFocusFlags } from "./ItemEdge";
import BusEdge from "./BusEdge";
import { contentBounds } from "./chipSeating";
import { examChipReservations } from "./chipMetrics";
import {
  ownsTrunkGroup,
  trunkGroupsOf,
  type BusAggregate,
  type TrunkMembership,
} from "./busRouting";
import type { RFAnyNode } from "./layout";
import type { GapRecord } from "./layerModel";
import { ExportModeProvider } from "./exportMode";
import { capturePlanPng, exportFrame, withInlinedSprites } from "./exportPng";
import { useI18n } from "../data/i18n-context";
import { pack } from "../data/load";
import { pushInto } from "../util/multimap";
import type { CSSProperties } from "react";
import { iconSheetUrl } from "./iconSprite";
import { HOVER_INTENT_MS } from "./dimensions";

// Camera handle the render-quality exam drives (see the gated effect in
// CanvasInner). The shape, and the `Window` augmentation that puts it on the
// page, are declared in ./exam-hook so this component and the CLIs that drive it
// share one contract.
import type { ExamHook } from "./exam-hook";

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
// explicit rect (the node cards PLUS the chip extents contentBounds computes),
// where fitView would frame the node cards alone and clip a chip standing on a
// routed leg outside them.
const FIT_BOUNDS_OPTIONS = { padding: FIT_VIEW_OPTIONS.padding };

// Debounce for the ResizeObserver re-fit so dragging the window edge (a burst of
// resize callbacks) coalesces into a single fitView instead of thrashing.
const RESIZE_REFIT_MS = 100;

// The solve + layout lifecycle state surfaced by the status annotation and the
// header chip. READY = idle, SOLVING = a generation is in flight, ERROR = the
// last solve or load failed.
export type CanvasStatus = "READY" | "SOLVING" | "ERROR";

// What the header's export button drives. Canvas owns the ReactFlowProvider and
// the container element, so App cannot reach the viewport node itself; this is
// the one imperative seam across that boundary.
export interface CanvasHandle {
  exportPng(): Promise<Blob>;
}

interface CanvasProps {
  ref?: Ref<CanvasHandle>;
  nodes: Node[];
  edges: Edge[];
  // The inter-layer gap reserves the layout produced, forwarded to the exam
  // hook and used nowhere else on the canvas: the chip anchors are already
  // stamped by the time these arrive, and only an audit outside the app needs
  // to know which room a chip was charged to.
  gaps?: ReadonlyArray<GapRecord>;
  status?: CanvasStatus;
  // Monotonically increasing counter bumped by App on every applied solve +
  // layout. A change means the node/edge arrays are a fresh plan, so the
  // viewport re-fits (once measured) rather than staying on the old camera.
  layoutGeneration?: number;
  onNodesChange?: OnNodesChange<Node>;
  onEdgesChange?: OnEdgesChange<Edge>;
  // Fired when a node drag ends, with the live node list from the React Flow
  // store; App re-seats the chips from it.
  onNodeDragStop?: (liveNodes: Node[]) => void;
}

// Which graph element the pointer is over. Drives the ego-network highlight:
// the hovered element plus its immediate neighbourhood stays lit, everything
// else gets the `dimmed` class. `null` = idle (no dimming at all).
type Hovered =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | null;

// Adjacency indexes derived once per `edges` array. Everything the highlight
// needs to expand a hovered element into its focus set: node -> incident edges,
// trunk -> member edges, and an id -> edge lookup (which also gives an edge's
// endpoints).
interface Adjacency {
  edgesByNode: Map<string, string[]>;
  edgesByTrunk: Map<string, string[]>;
  edgeById: Map<string, Edge>;
}

function withDimmed(className: string | undefined): string {
  return className ? `${className} dimmed` : "dimmed";
}

function withLitContainer(className: string | undefined): string {
  return className ? `${className} lit-container` : "lit-container";
}

// The dimmed / lit-container node copies handed to React Flow, one per source
// node and variant. A copy is a pure function of its source, so reusing it
// keeps the object React Flow sees stable across drag frames: a drag hands
// Canvas a new array every frame but touches only the dragged node, and every
// other node keeps its wrapper instead of re-rendering.
type FocusVariant = "dimmed" | "litContainer";
const focusCopies = new WeakMap<
  object,
  Partial<Record<FocusVariant, object>>
>();

function focusCopy<T extends object>(
  source: T,
  variant: FocusVariant,
  build: (source: T) => T,
): T {
  let copies = focusCopies.get(source);
  if (copies === undefined) {
    copies = {};
    focusCopies.set(source, copies);
  }
  const hit = copies[variant];
  if (hit !== undefined) return hit as T;
  const copy = build(source);
  copies[variant] = copy;
  return copy;
}

// Stamp the hover focus onto the nodes React Flow renders. Idle (`focus` null)
// returns the input array untouched. Exported for the unit test.
export function focusNodes(
  nodes: Node[],
  focus: { nodeIds: Set<string> } | null,
): Node[] {
  if (!focus) return nodes;
  // Container boxes (`type: "group"`) never dim while any of their child nodes
  // is in the focus set, so the frame around a lit cluster does not read as
  // faded. With no focused child they dim like any other node.
  const litContainers = new Set<string>();
  for (const node of nodes) {
    if (node.parentId && focus.nodeIds.has(node.id)) {
      litContainers.add(node.parentId);
    }
  }
  return nodes.map((node) => {
    if (focus.nodeIds.has(node.id)) return node;
    // A container lit only because a child is focused keeps a lit border but a
    // still-translucent fill, so it does not read as a bright empty slab over
    // its dimmed members.
    if (node.type === "group" && litContainers.has(node.id)) {
      return focusCopy(node, "litContainer", (n) => ({
        ...n,
        className: withLitContainer(n.className),
      }));
    }
    return focusCopy(node, "dimmed", (n) => ({
      ...n,
      className: withDimmed(n.className),
    }));
  });
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
        { ...edge, data: withFocusFlags(edge.data, { focused: true }) }
      : {
          ...edge,
          className: withDimmed(edge.className),
          // The edge label chips (rate / entry / bus drop-rise) portal out of
          // this wrapper via EdgeLabelRenderer, so the wrapper's `dimmed`
          // class never fades them. Thread the dim through edge data; the
          // chips map it onto their own .flow-chip.dimmed rule.
          data: withFocusFlags(edge.data, { dimmed: true }),
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
  ref,
  nodes,
  edges,
  gaps = [],
  status = "READY",
  layoutGeneration = 0,
  onNodesChange,
  onEdgesChange,
  onNodeDragStop,
}: CanvasProps) {
  const i18n = useI18n();
  const [hovered, setHovered] = useState<Hovered>(null);
  // True for the single render pass the PNG capture rasterizes: every
  // zoom-dependent level-of-detail gate reads 1 instead of the live zoom.
  const [exporting, setExporting] = useState(false);
  // The same flag, readable from the hover callbacks without re-creating them.
  const exportingRef = useRef(false);
  const { fitView, fitBounds, setViewport, getNodes } = useReactFlow();
  // The store holds the dropped positions before the `nodes` prop does.
  const handleNodeDragStop = useCallback(() => {
    onNodeDragStop?.(getNodes());
  }, [onNodeDragStop, getNodes]);
  const nodesInitialized = useNodesInitialized();
  const containerRef = useRef<HTMLDivElement>(null);

  // Latest node / edge props for the fit path, refreshed after every commit.
  // Kept in refs rather than closed over so `fitContent` below is referentially
  // stable: it is the sole dependency of the resize-observer effect, and
  // dragging a node hands Canvas a fresh node array on every pointer frame,
  // which would otherwise tear the observer down and re-subscribe it mid-drag
  // and throw away a pending debounced re-fit. Declared before the fit effects
  // so this runs first on the commit that carries a new plan.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  useEffect(() => {
    nodesRef.current = nodes;
    edgesRef.current = edges;
  });

  // Fit the viewport to the whole content -- node cards plus every chip box
  // contentBounds covers -- via fitBounds, so a chip standing outside the cards
  // is inside the frame instead of clipped at the rim.
  // Falls back to fitView on an empty graph (no bounds to frame). Which content
  // gets framed is read from the refs at call time, so the callers below decide
  // WHEN to fit and this decides only WHAT: a plan change re-fits through the
  // layout-generation effect, a pane resize through the observer, and a hover or
  // a node drag (both of which churn the arrays) fits not at all.
  const fitContent = useCallback(() => {
    const bounds = contentBounds(
      nodesRef.current as unknown as RFAnyNode[],
      edgesRef.current,
    );
    if (bounds === null) {
      void fitView(FIT_VIEW_OPTIONS);
      return;
    }
    void fitBounds(bounds, FIT_BOUNDS_OPTIONS);
  }, [fitView, fitBounds]);

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
      contentBounds: () =>
        contentBounds(nodes as unknown as RFAnyNode[], edges),
      // Per-chip seat-width reservations for the width-bound spec (it runs the
      // locales in Locale, src/data/i18n.ts); plain edge-data reads, as inert
      // as contentBounds.
      chipReservations: () => examChipReservations(edges),
      gapZones: () =>
        gaps.map((gap) => ({
          index: gap.index,
          left: gap.left,
          right: gap.right,
          sourceZone: {
            left: gap.sourceZone.left,
            right: gap.sourceZone.right,
          },
          columnZone: {
            left: gap.columnZone.left,
            right: gap.columnZone.right,
          },
          targetZone: {
            left: gap.targetZone.left,
            right: gap.targetZone.right,
          },
        })),
      commit: __STC_COMMIT__,
      pack: {
        sourceCommit: pack.source.sourceCommit,
        gameVersion: pack.source.gameVersion,
      },
    } satisfies ExamHook;
    return () => {
      delete window.__stcExam;
    };
  }, [setViewport, fitContent, nodes, edges, gaps]);

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
      // A pointer crossing the canvas while the rasterizer walks the DOM would
      // bake `dimmed` classes into part of the image. Hovering is inert until
      // the capture is done.
      if (exportingRef.current) return;
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

  // PNG export. The rect comes from the same refs and the same contentBounds
  // the fit path uses, so the image frames exactly what fitBounds would.
  // flushSync commits the full-detail pass and drops any hover dimming before
  // the rasterizer walks the DOM. The flag is cleared in a finally, so a
  // refused capture cannot strand the canvas in export mode.
  useImperativeHandle(
    ref,
    () => ({
      async exportPng(): Promise<Blob> {
        const container = containerRef.current;
        if (container === null) {
          throw new Error("Canvas is not mounted");
        }
        const bounds = contentBounds(
          nodesRef.current as unknown as RFAnyNode[],
          edgesRef.current,
        );
        if (bounds === null) {
          throw new Error("Nothing to export: the plan has no content");
        }
        const viewport = container.querySelector<HTMLElement>(
          ".react-flow__viewport",
        );
        if (viewport === null) {
          throw new Error("Nothing to export: the canvas viewport is missing");
        }
        const backgroundColor = getComputedStyle(container).backgroundColor;
        const frame = exportFrame(bounds);
        exportingRef.current = true;
        flushSync(() => {
          setExporting(true);
          clearHover();
        });
        try {
          return await withInlinedSprites(viewport, iconSheetUrl, () =>
            capturePlanPng(viewport, frame, backgroundColor),
          );
        } finally {
          exportingRef.current = false;
          setExporting(false);
        }
      },
    }),
    [clearHover],
  );

  // A plan can land with the pointer standing still (Enter in an already-focused
  // rate field, hash navigation), and no leave event fires
  // to cancel a hover still waiting out its intent delay. Cancel it here, since
  // it was aimed at the old graph. A hover that has already settled is left to
  // the focus memo below, which keeps it only while its element is still there.
  useEffect(() => {
    cancelPendingHover();
  }, [layoutGeneration, cancelPendingHover]);

  // Stable across renders so React Flow's memoized node and edge wrappers keep
  // their subtrees on a zoom tick or a drag frame: an inline lambda is a new
  // prop identity every render and re-reconciles the whole graph.
  const handleNodeMouseEnter = useCallback<NodeMouseHandler<Node>>(
    (_, node) => {
      // Group boxes are hover-inert: they own no edges, so lighting one dims
      // the whole graph for zero payoff. Skip them entirely.
      if (node.type === "group") return;
      scheduleHover({ kind: "node", id: node.id });
    },
    [scheduleHover],
  );
  const handleEdgeMouseEnter = useCallback<EdgeMouseHandler<Edge>>(
    (_, edge) => {
      scheduleHover({ kind: "edge", id: edge.id });
    },
    [scheduleHover],
  );

  // The Controls buttons pull their aria-labels from React Flow's
  // ariaLabelConfig (the <Controls> component only exposes the container label
  // directly), so localize them here rather than leaving the built-in English.
  const ariaLabelConfig = useMemo(
    () => ({
      "controls.ariaLabel": i18n.t("canvas.controls.panel"),
      "controls.zoomIn.ariaLabel": i18n.t("canvas.controls.zoom_in"),
      "controls.zoomOut.ariaLabel": i18n.t("canvas.controls.zoom_out"),
      "controls.fitView.ariaLabel": i18n.t("canvas.controls.fit_view"),
      "controls.interactive.ariaLabel": i18n.t("canvas.controls.interactive"),
    }),
    [i18n],
  );

  // Node ids in the current plan, for retiring a hover whose element the plan
  // swap took away. Memoized on the joined ids rather than on the node array so
  // a drag -- which hands Canvas fresh node objects every frame but never a
  // different id set -- does not churn the focus memo below.
  const nodeIdKey = nodes.map((n) => n.id).join("\u0000");
  const presentNodeIds = useMemo(
    () => new Set(nodeIdKey === "" ? [] : nodeIdKey.split("\u0000")),
    [nodeIdKey],
  );

  const adjacency = useMemo<Adjacency>(() => {
    const edgesByNode = new Map<string, string[]>();
    const edgesByTrunk = new Map<string, string[]>();
    const edgeById = new Map<string, Edge>();
    for (const edge of edges) {
      edgeById.set(edge.id, edge);
      pushInto(edgesByNode, edge.source, edge.id);
      pushInto(edgesByNode, edge.target, edge.id);
      // A trunk key names the port the trunk fans through: item + "|" + the
      // source unit for a fan-out, and item + "|" + the target unit + "|" + the
      // target row kind ("in" or "cat") for a fan-in, whose target end can take
      // one item on two rows. Every member of a trunk carries its key in
      // trunkGroups whatever shape the routing pass drew it as, so indexing on
      // that field -- rather than on the single trunkKey of the aggregate stamps,
      // which only the drawn bus members carry -- gives the trunk's whole
      // membership: its far members pinned to the column and its backward
      // members on their rails included, and a dual member filed under both of
      // its trunks.
      for (const key of trunkGroupsOf(
        edge.data as TrunkMembership | undefined,
      )) {
        pushInto(edgesByTrunk, key, edge.id);
      }
    }
    return { edgesByNode, edgesByTrunk, edgeById };
  }, [edges]);

  // The lit set for the current hover: node ids and edge ids that keep full
  // opacity. `null` when idle so the render path can skip mapping entirely and
  // hand React Flow the original arrays (no churn, zero `dimmed` classes).
  const focus = useMemo<{
    nodeIds: Set<string>;
    edgeIds: Set<string>;
  } | null>(() => {
    if (!hovered) return null;
    // A plan swap leaves the hover pointing at whatever the pointer was last
    // over. Retire it only when that element is gone from the new graph, where
    // the focus set would come back empty and dim everything; an element that
    // survived keeps its highlight, because React Flow keeps the same wrapper
    // mounted and no mouseenter would fire to light it again.
    const present =
      hovered.kind === "node"
        ? presentNodeIds.has(hovered.id)
        : adjacency.edgeById.has(hovered.id);
    if (!present) return null;
    const nodeIds = new Set<string>();
    const edgeIds = new Set<string>();
    const lightEdge = (edgeId: string): void => {
      edgeIds.add(edgeId);
      const edge = adjacency.edgeById.get(edgeId);
      if (edge) {
        nodeIds.add(edge.source);
        nodeIds.add(edge.target);
      }
    };
    if (hovered.kind === "node") {
      nodeIds.add(hovered.id);
      for (const edgeId of adjacency.edgesByNode.get(hovered.id) ?? []) {
        lightEdge(edgeId);
      }
    } else {
      const edge = adjacency.edgeById.get(hovered.id);
      const data = edge?.data as (BusAggregate & TrunkMembership) | undefined;
      lightEdge(hovered.id);
      // An edge belongs to one trunk group per trunk it is a member of -- two for
      // a dual member, which is a fan-out branch and a fan-in branch at once.
      // Each group is lit on its own terms, and only the HOVERED edge's groups
      // are read: a member lit here never has its own groups expanded, so a
      // shared member does not drag one trunk's siblings into another trunk's
      // highlight. Within a group, two hover modes split off which members light:
      //   TRUNK hover  -- the pointer is over this group's owner (the member that
      //     draws its shared trunk segment, junction, and aggregate chip). Light
      //     the whole group.
      //   BRANCH hover -- the pointer is over a non-owner member. Light only that
      //     branch plus the group's owner(s); sibling branches stay dimmed.
      // Ownership is asked per group: a member carries the aggregate stamps of at
      // most one of its trunks, so an unstamped far or backward member is a plain
      // branch of every group it is in.
      for (const group of trunkGroupsOf(data)) {
        const whole = ownsTrunkGroup(data, group);
        for (const edgeId of adjacency.edgesByTrunk.get(group) ?? []) {
          const memberData = adjacency.edgeById.get(edgeId)?.data as
            | (BusAggregate & TrunkMembership)
            | undefined;
          if (whole || ownsTrunkGroup(memberData, group)) lightEdge(edgeId);
        }
      }
    }
    return { nodeIds, edgeIds };
  }, [hovered, adjacency, presentNodeIds]);

  const displayNodes = useMemo<Node[]>(
    () => focusNodes(nodes, focus),
    [nodes, focus],
  );

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
      className={[
        "ak-canvas-theme",
        zoomBand(exporting ? 1 : zoom),
        exporting ? "exporting" : "",
        focus ? "hover-active" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        ...canvasThemeStyle,
        // The zoom-compensated edge stroke width, inherited by every edge path
        // (edgeStrokeStyle reads it), so a zoom tick restyles the edges here
        // instead of re-rendering each one.
        ["--edge-base-width" as string]: `${edgeStrokeWidth(exporting ? 1 : zoom)}px`,
      }}
    >
      <ExportModeProvider exporting={exporting}>
        <ReactFlow
          nodes={displayNodes}
          edges={displayEdges}
          {...(onNodesChange ? { onNodesChange } : {})}
          {...(onEdgesChange ? { onEdgesChange } : {})}
          onNodeDragStop={handleNodeDragStop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={clearHover}
          onEdgeMouseEnter={handleEdgeMouseEnter}
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
          <Controls aria-label={i18n.t("canvas.controls.panel")} />
        </ReactFlow>
      </ExportModeProvider>
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
