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

// z is the COMPUTED z-index of the edge's own React Flow group svg (each edge
// renders in its own <svg style={{zIndex}}>; "auto" maps to 0). Collected
// because React Flow's paint order is (zIndex, DOM order), NOT DOM order
// alone -- the crossing-cue coverage audit needs the same key the render
// layer stamps cue owners by.
export type EdgeGeom = { id: string; d: string; z: number };
export type NodeGeom = {
  nodeId: string;
  type: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  // Item ids of the node's ports, in DOM order per side, read off the React Flow
  // handle ids RecipeNode / LoopNode / ProductNode emit ("in:<item>" /
  // "out:<item>"). DOM order IS the model row order (the components map the
  // already-ordered port arrays), so an item's index here is the row index the
  // routing model resolves it to -- what the endpoint-parity audit needs to
  // rebuild a port y without reading the drawn row box. Empty for a node kind
  // that carries no per-item handles.
  inPorts: string[];
  outPorts: string[];
};
export type ChipGeom = {
  edgeId: string;
  // The chip's own data-testid (`item-edge-label-<edge>`,
  // `bus-edge-label-<edge>-rise|-drop`). An edge can own TWO chips, so the edge
  // id alone does not name the box a report is about; the seating census names
  // this instead.
  testId: string;
  label: string;
  kind: "label" | "bus" | "bus-drop";
  left: number;
  top: number;
  right: number;
  bottom: number;
};
// One DRAWN bus band: the tinted lane strip BusBands paints per band, keyed by
// the `bus-band-top` / `bus-band-bottom` testid it emits, with its box in graph
// coordinates. The band is the air a lane's rise / drop chips are supposed to
// stay inside, so the census needs it in the same frame as the chip boxes.
export type BandGeom = {
  testId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
// One DRAWN junction dot: its data-testid hook (`bus-junction-<edge>` for the
// lane / fan-out trunk families, `fanin-junction-<edge>` for the merge dot,
// `fanout-junction-<edge>` for the declined-fan-out divergence dot) plus its box
// in graph coordinates. The dot is sized in graph units from a zoom-clamped
// screen radius, so its measured box already carries the extent it renders at
// THIS camera - no radius has to be recomputed audit-side.
export type DotGeom = {
  testId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
// One DRAWN crossing cue (exam-surfaced Task 9): the background-coloured disk
// an edge renderer emits where its polyline properly crosses a different
// flow's. The cue is an SVG circle inside the edge's group, so its cx/cy
// attributes are ALREADY graph coordinates (the same user space the path `d`
// strings live in) and are read as attributes rather than through
// getBoundingClientRect - no camera round-trip, no sub-pixel loss. `edgeId`
// is the React Flow edge group the circle lives in, recovered via its
// .react-flow__edge-path sibling's id.
export type CrossingCueGeom = { edgeId: string; x: number; y: number };
export type Geometry = {
  edges: EdgeGeom[];
  nodes: NodeGeom[];
  chips: ChipGeom[];
  dots: DotGeom[];
  bands: BandGeom[];
  crossingCues: CrossingCueGeom[];
  // The live camera zoom, needed to state a screen-pixel visibility tolerance
  // in the graph frame the rects above live in.
  zoom: number;
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
  ).map((p) => {
    // The z lives on the edge's OWN wrapper svg (EdgeWrapper renders
    // <svg style={{zIndex}}>); the class name .react-flow__edge belongs to the
    // g INSIDE it, whose z-index is always auto, so read the svg via
    // ownerSVGElement and never via closest().
    const zRaw = getComputedStyle(p.ownerSVGElement!).zIndex;
    return { id: p.id, d: p.getAttribute("d") ?? "", z: Number(zRaw) || 0 };
  });

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const cls = el.className;
    const match = /react-flow__node-(\w+)/.exec(cls);
    const inPorts: string[] = [];
    const outPorts: string[] = [];
    for (const h of Array.from(
      el.querySelectorAll<HTMLElement>("[data-handleid]"),
    )) {
      const hid = h.getAttribute("data-handleid") ?? "";
      if (hid.startsWith("in:")) inPorts.push(hid.slice(3));
      else if (hid.startsWith("out:")) outPorts.push(hid.slice(4));
    }
    return {
      nodeId: el.getAttribute("data-id") ?? "(node)",
      type: match?.[1] ?? "(type)",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
      inPorts,
      outPorts,
    };
  });

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip[data-edge-id]"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const testId = el.getAttribute("data-testid") ?? "";
    return {
      edgeId: el.getAttribute("data-edge-id") ?? "",
      testId: testId !== "" ? testId : "(chip)",
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

  const dots = Array.from(
    document.querySelectorAll<HTMLElement>(".bus-junction"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      testId: el.getAttribute("data-testid") ?? "(dot)",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  // Bands are read with the SAME toGraphX/toGraphY as the rects above, so a band
  // and a chip box compare directly. BusBands renders at most one div per band,
  // and only for a band that holds a routed trunk, so this list is empty on a
  // plan with no bus lanes.
  const bands = Array.from(
    document.querySelectorAll<HTMLElement>(".bus-band"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      testId: el.getAttribute("data-testid") ?? "(band)",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  // Crossing cues (Task 9): SVG circles inside the edge groups, so their cx/cy
  // attributes are already graph coordinates. The owning edge is the group the
  // circle lives in, named by that group's .react-flow__edge-path id - the same
  // id `edges` above carries, so a cue and a path join directly.
  const crossingCues = Array.from(
    document.querySelectorAll<SVGCircleElement>(
      '[data-testid="edge-crossing-cue"]',
    ),
  ).map((el) => ({
    edgeId:
      el
        .closest(".react-flow__edge")
        ?.querySelector<SVGPathElement>(".react-flow__edge-path")?.id ?? "",
    x: Number(el.getAttribute("cx")),
    y: Number(el.getAttribute("cy")),
  }));

  return { edges, nodes, chips, dots, bands, crossingCues, zoom: k };
}

// One rendered thing the exam has to be able to point a camera at. `clientRect`
// is in PANE-RELATIVE CSS pixels: the element's box measured from the top-left
// of the .react-flow pane, the same frame `overlays` uses, so an element and an
// overlay can be compared directly. `worldRect` is the same box mapped back
// through the inverse viewport transform, which is the frame setViewport speaks.
// Chips counter-scale about their centre, so their worldRect shrinks as the pane
// zooms in - that is the true graph-space footprint, not a measurement error.
export type SceneElement = {
  id: string;
  kind: "node" | "edge" | "chip" | "junction" | "band" | "glyph" | "group";
  itemId?: string;
  label?: string;
  clientRect: { x: number; y: number; width: number; height: number };
  worldRect: { x: number; y: number; width: number; height: number };
  // World-unit vertices of an edge path, parsed from its `d`. Edges only.
  polyline?: Array<[number, number]>;
};

// The full inventory of a single rendered frame: the live camera, the pane box
// the camera paints into, the chrome overlays that occlude it, and every
// element the capture CLI must prove it covered.
export type SceneCollection = {
  transform: { x: number; y: number; zoom: number };
  // .react-flow's own box, in PAGE (browser viewport) coordinates - the one
  // field that is not pane-relative, because a consumer needs it to convert a
  // pane-relative rect back to a page coordinate (screenshot clip, mouse move).
  paneRect: { x: number; y: number; width: number; height: number };
  // Floating chrome above the pane, in PANE-RELATIVE coordinates (same frame as
  // every element's clientRect): anything under one of these is occluded no
  // matter where the camera sits.
  overlays: Array<{
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  elements: SceneElement[];
};

// Inventory every rendered element on the canvas, in both screen and world
// frames, so the capture CLI can prove a shot set covers all of them.
// Self-contained for page.evaluate (no outer-scope value references).
//
// Ids come from the DOM hook each family already emits (data-id, the path
// element id, data-testid), because those stay stable across a re-render of the
// same plan. Two families need help: the group boxes live INSIDE a
// .react-flow__node wrapper and would otherwise reuse that node's data-id, so
// they carry a `group-` prefix; bands and glyphs emit no per-element hook and
// are numbered by document order. Anything still colliding gets a `-2`, `-3`
// suffix, since a duplicate id would silently collapse two elements into one
// coverage entry.
export function collectScene(): SceneCollection {
  const rf = document.querySelector<HTMLElement>(".react-flow");
  const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
  const rfRect = rf!.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(vp!).transform);
  const k = m.a;
  const tx = m.e;
  const ty = m.f;
  const toWorldX = (clientX: number): number =>
    (clientX - rfRect.left - tx) / k;
  const toWorldY = (clientY: number): number => (clientY - rfRect.top - ty) / k;

  const elements: SceneElement[] = [];
  const usedIds = new Set<string>();
  const add = (spec: {
    kind: SceneElement["kind"];
    id: string;
    fallbackId: string;
    el: Element;
    label?: string | null;
    itemId?: string | null;
    polyline?: Array<[number, number]>;
  }): void => {
    let id = spec.id !== "" ? spec.id : spec.fallbackId;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    usedIds.add(id);
    const r = spec.el.getBoundingClientRect();
    const label = spec.label ?? "";
    const itemId = spec.itemId ?? "";
    elements.push({
      id,
      kind: spec.kind,
      ...(itemId !== "" ? { itemId } : {}),
      ...(label !== "" ? { label } : {}),
      clientRect: {
        x: r.left - rfRect.left,
        y: r.top - rfRect.top,
        width: r.width,
        height: r.height,
      },
      worldRect: {
        x: toWorldX(r.left),
        y: toWorldY(r.top),
        width: r.width / k,
        height: r.height / k,
      },
      ...(spec.polyline !== undefined ? { polyline: spec.polyline } : {}),
    });
  };

  // Collapsed visible text, capped so a whole node card does not become a label.
  const textOf = (el: Element): string =>
    (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80);

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  );
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    add({
      kind: "node",
      id: el.getAttribute("data-id") ?? "",
      fallbackId: `node-${i}`,
      el,
      label: textOf(el),
      itemId:
        el.querySelector("[data-item-id]")?.getAttribute("data-item-id") ??
        null,
    });
  }

  // Edge `d` coordinates are already in the viewport's frame, so the polyline
  // needs no transform. Same coordinate-pair scan geometry.ts's parsePath uses,
  // inlined because page context cannot see that module.
  const edges = Array.from(
    document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
  );
  for (let i = 0; i < edges.length; i++) {
    const p = edges[i]!;
    const d = p.getAttribute("d") ?? "";
    const polyline: Array<[number, number]> = [
      ...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g),
    ].map((mm): [number, number] => [Number(mm[1]), Number(mm[2])]);
    add({
      kind: "edge",
      id: p.id,
      fallbackId: `edge-${i}`,
      el: p,
      polyline,
    });
  }

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  );
  for (let i = 0; i < chips.length; i++) {
    const el = chips[i]!;
    add({
      kind: "chip",
      id:
        el.getAttribute("data-testid") ?? el.getAttribute("data-edge-id") ?? "",
      fallbackId: `chip-${i}`,
      el,
      label: el.getAttribute("aria-label") ?? el.getAttribute("title"),
    });
  }

  const junctions = Array.from(
    document.querySelectorAll<HTMLElement>(".bus-junction"),
  );
  for (let i = 0; i < junctions.length; i++) {
    const el = junctions[i]!;
    add({
      kind: "junction",
      id: el.getAttribute("data-testid") ?? "",
      fallbackId: `junction-${i}`,
      el,
    });
  }

  // BusBands already emits data-testid="bus-band-<lane>", keyed on the LANE
  // index. Synthesising the same string from document order would put a
  // different element behind an id that a testid locator also resolves, so read
  // the attribute and only fall back to a plainly distinct document-order id.
  const bands = Array.from(document.querySelectorAll<HTMLElement>(".bus-band"));
  for (let i = 0; i < bands.length; i++) {
    const el = bands[i]!;
    add({
      kind: "band",
      id: el.getAttribute("data-testid") ?? "",
      fallbackId: `band-${i}`,
      el,
    });
  }

  const glyphs = Array.from(
    document.querySelectorAll<HTMLElement>("[data-glyph]"),
  );
  for (let i = 0; i < glyphs.length; i++) {
    const el = glyphs[i]!;
    add({
      kind: "glyph",
      id: `glyph-${i}`,
      fallbackId: `glyph-${i}`,
      el,
      label: el.getAttribute("data-glyph"),
    });
  }

  const groups = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.rf-group-box, [data-testid="loop-node"]',
    ),
  );
  for (let i = 0; i < groups.length; i++) {
    const el = groups[i]!;
    const owner =
      el.closest(".react-flow__node")?.getAttribute("data-id") ?? "";
    add({
      kind: "group",
      id: owner !== "" ? `group-${owner}` : "",
      fallbackId: `group-${i}`,
      el,
      label: textOf(el),
    });
  }

  const overlays: SceneCollection["overlays"] = [];
  // Chrome that paints an opaque or near-opaque fill over pane content. The
  // minimap only mounts above the dense-plan node threshold, and the React Flow
  // attribution badge only exists because Canvas sets no proOptions; emit each
  // when it is there and stay silent when it is not. Rects are converted to the
  // pane frame so they compare directly against every element's clientRect.
  //
  // .canvas-frame is deliberately NOT here: it spans the whole pane, but it is
  // pointer-events: none and paints only a vignette that is fully transparent
  // across the interior plus ~1% white scanlines, so it tints rather than hides.
  // Collecting it would mark every element occluded and make this list useless.
  for (const [name, selector] of [
    ["controls", ".react-flow__controls"],
    ["minimap", ".react-flow__minimap"],
    ["attribution", ".react-flow__attribution"],
  ] as const) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null) continue;
    const r = el.getBoundingClientRect();
    overlays.push({
      name,
      x: r.left - rfRect.left,
      y: r.top - rfRect.top,
      width: r.width,
      height: r.height,
    });
  }

  return {
    transform: { x: tx, y: ty, zoom: k },
    paneRect: {
      x: rfRect.x,
      y: rfRect.y,
      width: rfRect.width,
      height: rfRect.height,
    },
    overlays,
    elements,
  };
}
