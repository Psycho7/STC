// In-page DOM collectors, shared by the geometry-audit ratchets and the render
// exam harness. Every function here is handed to `page.evaluate`, which
// serialises the function SOURCE and runs it inside the browser: nothing from
// this module's scope travels with it. So each collector must stay entirely
// self-contained - no outer-scope references to VALUES: no value imports, no
// module-level constants, no helpers hoisted out of a function body. Any such
// reference is undefined in the browser and fails at run time, not at compile
// time. Helpers that a collector needs are inlined inside it, even when two
// collectors want the same one. Type-only declarations and `import type` are
// erased before the source ever reaches the browser, so sharing those is safe.

export type AuditChipRect = {
  label: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type RowCenter = {
  nodeId: string;
  item: string;
  rowClass: string;
  rowCenterY: number;
  handleCenterY: number | null;
};

// Per recipe node that shows a machine-multiplier chip: the chip's box and the
// adjacent rate-block box. Audit issue 5 was the old absolute .rn-mult-badge
// overlapping the rate figures; the promoted header cell must keep them apart.
export type MultPair = {
  nodeId: string;
  chip: AuditChipRect;
  rate: AuditChipRect;
};

export type AuditData = {
  chips: AuditChipRect[];
  rows: RowCenter[];
  multPairs: MultPair[];
  recipeNodeCount: number;
  // The React Flow pane's client rect: the visible viewport every chip must sit
  // inside at fit zoom (the camera-fit content-bounds assertion).
  containerRect: { x: number; y: number; right: number; bottom: number };
  // Computed stacking order inside the shared .react-flow__edgelabel-renderer
  // layer, where both flow chips and bus junction dots are portaled. `auto`
  // maps to 0 so a chip with no explicit z-index compares strictly against the
  // dot's numeric one (an auto-vs-auto comparison would pass vacuously while DOM
  // order still lets a sibling member edge's dot paint over the owner's chip).
  flowChipZ: number[];
  busJunctionZ: number[];
};

export function collectAudit(): AuditData {
  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label:
        el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "(chip)",
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });

  const toRect = (el: HTMLElement, label: string): AuditChipRect => {
    const r = el.getBoundingClientRect();
    return {
      label,
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };

  const recipeNodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node-recipe"),
  );
  const rows: RowCenter[] = [];
  const multPairs: MultPair[] = [];
  for (const node of recipeNodes) {
    const nodeId = node.getAttribute("data-id") ?? "(node)";
    const chipEl = node.querySelector<HTMLElement>(".rn-mult-chip");
    const rateEl = node.querySelector<HTMLElement>(".rn-rate-block");
    if (chipEl !== null && rateEl !== null) {
      multPairs.push({
        nodeId,
        chip: toRect(chipEl, "mult-chip"),
        rate: toRect(rateEl, "rate-block"),
      });
    }
    for (const row of Array.from(
      node.querySelectorAll<HTMLElement>(".rn-row"),
    )) {
      const rr = row.getBoundingClientRect();
      const handle = row.querySelector<HTMLElement>(".react-flow__handle");
      const hr = handle?.getBoundingClientRect() ?? null;
      rows.push({
        nodeId,
        item: row.querySelector(".lbl")?.getAttribute("title") ?? row.className,
        rowClass: row.className,
        rowCenterY: rr.y + rr.height / 2,
        handleCenterY: hr === null ? null : hr.y + hr.height / 2,
      });
    }
  }

  const zOf = (el: HTMLElement): number => {
    const v = getComputedStyle(el).zIndex;
    return v === "auto" ? 0 : Number(v);
  };
  const layer = ".react-flow__edgelabel-renderer ";
  const flowChipZ = Array.from(
    document.querySelectorAll<HTMLElement>(layer + ".flow-chip"),
  ).map(zOf);
  const busJunctionZ = Array.from(
    document.querySelectorAll<HTMLElement>(layer + ".bus-junction"),
  ).map(zOf);

  const rf = document.querySelector<HTMLElement>(".react-flow");
  const rfRect = rf!.getBoundingClientRect();
  return {
    chips,
    rows,
    multPairs,
    recipeNodeCount: recipeNodes.length,
    containerRect: {
      x: rfRect.x,
      y: rfRect.y,
      right: rfRect.right,
      bottom: rfRect.bottom,
    },
    flowChipZ,
    busJunctionZ,
  };
}

export type EdgeGeom = { id: string; d: string };
export type NodeGeom = {
  nodeId: string;
  type: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type ChipGeom = {
  edgeId: string;
  label: string;
  kind: "label" | "bus" | "bus-drop";
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export type Geometry = {
  edges: EdgeGeom[];
  nodes: NodeGeom[];
  chips: ChipGeom[];
};

// Read the live flow-coordinate geometry: every edge path's id + `d`, every
// node's raw card rect, and every edge-owned chip box (data-edge-id, the
// FlowChip ownership hook). Rects come from getBoundingClientRect mapped back
// through the inverse viewport transform (translate + uniform scale), so cards,
// chips, and edge segments are directly comparable. Self-contained for
// page.evaluate (no outer-scope references).
export function collectGeometry(): Geometry {
  const rf = document.querySelector<HTMLElement>(".react-flow");
  const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
  const rfRect = rf!.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(vp!).transform);
  const k = m.a;
  const tx = m.e;
  const ty = m.f;
  const toGraphX = (clientX: number): number =>
    (clientX - rfRect.left - tx) / k;
  const toGraphY = (clientY: number): number => (clientY - rfRect.top - ty) / k;

  const edges = Array.from(
    document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
  ).map((p) => ({ id: p.id, d: p.getAttribute("d") ?? "" }));

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const cls = el.className;
    const match = /react-flow__node-(\w+)/.exec(cls);
    return {
      nodeId: el.getAttribute("data-id") ?? "(node)",
      type: match?.[1] ?? "(type)",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip[data-edge-id]"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const testId = el.getAttribute("data-testid") ?? "";
    return {
      edgeId: el.getAttribute("data-edge-id") ?? "",
      label: el.getAttribute("aria-label") ?? "(chip)",
      // Chip families: the trunk-seated aggregate chip ("bus-drop", testid
      // suffix -drop), audited against foreign cards with a trunk-member
      // exemption; lane-anchored bus rise/branch chips ("bus", out of scope for
      // the corridor invariants); and item rate chips ("label"). Only rate
      // chips ride the clear-segment anchor.
      kind: (testId.startsWith("bus-edge-")
        ? testId.endsWith("-drop")
          ? "bus-drop"
          : "bus"
        : "label") as "label" | "bus" | "bus-drop",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  return { edges, nodes, chips };
}
