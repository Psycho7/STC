// Pure analysis for the render-exam probe: the colour maths, the hover
// expectation and verdicts, and the --eval payload plumbing. Everything here is
// a function of values the probe already read out of the page, with no browser
// and no I/O, which is what makes it unit testable.
//
// Split out of probe.ts rather than left beside the ops it serves for two
// reasons. It is the whole of what the tests can reach, so the boundary is the
// one the test file already draws. And bun caches the transpiled output of any
// source file over 50 KiB; on this project the cached path mis-loads the app's
// `?url` asset import, which probe.ts reaches transitively through the capture
// CLI, so the second run of an oversized probe.ts dies before main(). Keep both
// files well under that size.

import { type Rect } from "./tiling";

// Serialised --eval results are truncated here. 8 KB is well past any honest
// measurement and well short of a page dump that would drown the JSON the
// caller is reading the probe's own fields out of.
const EVAL_JSON_LIMIT = 8 * 1024;

// A painted surface that overlaps the measured element without being one of its
// ancestors, so the ancestor walk would never see it.
export type OverlappingSurface = {
  // Enough of the DOM to name it in the output: tag, classes, data-id.
  description: string;
  // Its computed background-color, or the fill when it is an SVG shape with no
  // background (SVG ignores CSS background).
  color: string;
  // Share of the measured element's box the overlap covers.
  overlapFraction: number;
};

export type ColorRead = {
  found: boolean;
  isSvg: boolean;
  color: string;
  stroke: string;
  fill: string;
  opacity: string;
  strokeOpacity: string;
  fillOpacity: string;
  // background-color of the element and every ancestor, element first.
  bgStack: string[];
  // Ancestors that paint a background-IMAGE. A gradient computes its
  // background-color to transparent, so bgStack cannot see it at all.
  backgroundImageAncestors: string[];
  // Painted non-ancestors overlapping the element, worst overlap first, capped.
  overlapping: OverlappingSurface[];
  // How many were found before the cap, so a truncated list still says so.
  overlappingCount: number;
};

// ---------------------------------------------------------------------------
// Colour maths (pure, Node side)
//
// Every colour comes out of the page as a computed-style STRING and is measured
// here rather than in the browser: page callbacks must be self-contained (their
// source is serialised, nothing from module scope travels with them), so maths
// left in the page would have to be inlined per collector and could not be unit
// tested at all.
// ---------------------------------------------------------------------------

export type Rgba = { r: number; g: number; b: number; a: number };

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

// Handles what getComputedStyle actually serialises in Chromium (`rgb(r, g, b)`
// and `rgba(r, g, b, a)`), plus the hex and keyword forms a caller might hand in
// directly. `none` and `transparent` are fully transparent, not black: treating
// them as black would silently invent a backdrop.
export function parseCssColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s === "" || s === "none" || s === "transparent") return TRANSPARENT;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex !== null) {
    const h = hex[1]!;
    const expand = (c: string): number => parseInt(c + c, 16);
    if (h.length === 3 || h.length === 4) {
      return {
        r: expand(h[0]!),
        g: expand(h[1]!),
        b: expand(h[2]!),
        a: h.length === 4 ? expand(h[3]!) / 255 : 1,
      };
    }
    if (h.length === 6 || h.length === 8) {
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn === null) return null;
  const parts = fn[1]!
    .split(/[,/\s]+/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (parts.length < 3) return null;
  const chan = (p: string): number =>
    p.endsWith("%") ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p);
  const alpha = (p: string | undefined): number =>
    p === undefined ? 1 : p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p);
  const rgba = {
    r: chan(parts[0]!),
    g: chan(parts[1]!),
    b: chan(parts[2]!),
    a: alpha(parts[3]),
  };
  return Object.values(rgba).every((n) => Number.isFinite(n)) ? rgba : null;
}

// Source-over composite. The result's alpha is the composited alpha, so a stack
// of translucent layers can be folded left to right without an opaque base.
export function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return TRANSPARENT;
  const mix = (t: number, b: number): number =>
    (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

// Fold an ancestor chain of background-colors (element first, documentElement
// last) into the one opaque colour that paints behind the element.
//
// The walk runs from the ROOT inward, so a nearer translucent layer composites
// over the farther ones in paint order. White is the base because that is what a
// page with no opaque background composites onto; on this canvas the theme
// container is opaque (--ak-bg-canvas), so the base never shows through.
//
// When it DOES show through, `whiteFallback` says so. White is exactly the
// fallback that makes a dark stroke look excellent, so a measurement standing on
// it would over-report the ratio and clear a real contrast defect. Today a flat
// container background resolves the stack; a future gradient (which computes to
// a transparent background-color) would invert every measurement here, and the
// flag is what makes that visible in the output instead of inferable from `bg`.
export function flattenBackdrop(stack: readonly string[]): {
  color: Rgba;
  whiteFallback: boolean;
} {
  let acc: Rgba = TRANSPARENT;
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = parseCssColor(stack[i]!);
    if (layer === null) continue;
    acc = over(layer, acc);
  }
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  return { color: over(acc, white), whiteFallback: acc.a < 1 };
}

// WCAG 2.1 relative luminance.
export function relativeLuminance(c: { r: number; g: number; b: number }): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

export function contrastRatio(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type Lab = { L: number; a: number; b: number };

// sRGB -> CIE Lab under D65, the reference white sRGB is defined against.
export function srgbToLab(c: { r: number; g: number; b: number }): Lab {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = lin(c.r);
  const g = lin(c.g);
  const b = lin(c.b);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function deltaE76(a: Lab, b: Lab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

export function formatRgb(c: Rgba): string {
  const round = (n: number): number => Math.round(n);
  return `rgb(${round(c.r)}, ${round(c.g)}, ${round(c.b)})`;
}

// What the element paints, BEFORE it is composited onto anything. Kept separate
// from the backdrop so one element can be measured against several candidate
// backdrops without re-reading the page.
//
// SVG elements ignore CSS `background`, so their paint is the stroke when there
// is one and the fill otherwise - stroke first because every edge in this app is
// a stroked path with no fill, and the fill of such a path is `none`.
export function rawPaint(read: ColorRead): Rgba | null {
  const opacity = Number(read.opacity === "" ? "1" : read.opacity);
  let raw: Rgba | null = null;
  let extra = 1;
  if (read.isSvg) {
    const stroke = parseCssColor(read.stroke);
    if (stroke !== null && stroke.a > 0) {
      raw = stroke;
      extra = Number(read.strokeOpacity === "" ? "1" : read.strokeOpacity);
    } else {
      const fill = parseCssColor(read.fill);
      if (fill !== null && fill.a > 0) {
        raw = fill;
        extra = Number(read.fillOpacity === "" ? "1" : read.fillOpacity);
      }
    }
  }
  raw ??= parseCssColor(read.color);
  if (raw === null) return null;
  const scale =
    (Number.isFinite(opacity) ? opacity : 1) * (Number.isFinite(extra) ? extra : 1);
  return { ...raw, a: raw.a * scale };
}

// The element's paint folded onto its ANCESTOR backdrop, which is the right
// backdrop for HTML text inside a chip or a card and the wrong one for anything
// the canvas paints over a sibling. Callers that care about the difference use
// measureContrast; this stays for the single-backdrop reads.
export function paintColor(
  read: ColorRead,
): { fg: Rgba; bg: Rgba; whiteFallback: boolean } | null {
  const raw = rawPaint(read);
  if (raw === null) return null;
  const backdrop = flattenBackdrop(read.bgStack);
  return {
    fg: over(raw, backdrop.color),
    bg: backdrop.color,
    whiteFallback: backdrop.whiteFallback,
  };
}

export type BackdropMeasurement = {
  // "ancestors" for the folded ancestor chain, otherwise the DOM description of
  // the overlapping element the backdrop came from.
  source: string;
  color: string;
  // Share of the measured element's box the overlap covers. Null for the
  // ancestor backdrop, which covers all of it by construction.
  overlapFraction: number | null;
  fg: string;
  ratio: number;
};

export type ContrastMeasurement = {
  // The worst ratio over the ancestor backdrop plus every candidate that covers
  // at least MIN_OVERLAP_FOR_WORST of the element. This is the number to read:
  // it can only under-state how good the contrast is, and under-stating costs a
  // wasted check while over-stating clears a real defect.
  worstRatio: number;
  worstBackdrop: string;
  // The same over EVERY candidate, however little it covers. Held apart because
  // a sliver clipping a stroke's bounding box by a tenth of a percent would
  // otherwise be the headline on every measurement, and a headline that is
  // always alarming is one the caller learns to skip.
  worstRatioAnyOverlap: number;
  worstBackdropAnyOverlap: string;
  minOverlapForWorst: number;
  // Against the ancestor chain alone, so the three can be told apart.
  ancestorRatio: number;
  ancestorBackdrop: string;
  whiteFallback: boolean;
  // Ancestors painting a gradient or an image. Their colour is not in
  // ancestorBackdrop and cannot be: a gradient has no single colour. A non-empty
  // list means the real backdrop is not the one measured here.
  backgroundImageAncestors: string[];
  backdrops: BackdropMeasurement[];
  overlappingCount: number;
  // Overlapping surfaces whose colour could not be parsed. A skipped surface
  // could be the one the element is illegible against, so the op refuses rather
  // than reporting a worstRatio that quietly excluded it.
  unreadableBackdrops: string[];
};

// How many overlapping surfaces are listed. Past this the JSON stops being
// readable and the extra entries add nothing: they are sorted by overlap, so
// the ones that matter are already at the front.
const MAX_BACKDROPS_REPORTED = 8;

// Share of the measured element a candidate must cover to count toward
// worstRatio. Bounding boxes are rectangles and strokes are not, so a box that
// merely clips a corner of another element reports an overlap the eye never
// sees; everything below this still appears in `backdrops` and in
// worstRatioAnyOverlap, so nothing is hidden, it is only not the headline.
const MIN_OVERLAP_FOR_WORST = 0.05;

// Contrast against every surface the element is plausibly read against.
//
// The ancestor chain is only one of them. On this canvas the thing behind an
// edge stroke is routinely NOT an ancestor - node cards it crosses are opaque,
// bus bands are tinted, the dot grid sits underneath - and measuring against the
// ancestor chain alone reports the canvas background for a stroke that is in
// fact painted over a card.
//
// The overlapping surfaces are CANDIDATES, not proven backdrops: paint order is
// not decidable from a rect test, so an element painted in FRONT of the measured
// one is listed too. That direction is the safe one. A candidate that is really
// in front can only lower worstRatio, which costs a wasted check; excluding a
// candidate that is really behind would clear a real defect.
export function measureContrast(read: ColorRead): ContrastMeasurement | null {
  const raw = rawPaint(read);
  if (raw === null) return null;
  const ancestor = flattenBackdrop(read.bgStack);

  const unreadable: string[] = [];
  const layers: Array<{ source: string; color: Rgba; overlap: number | null }> = [
    { source: "ancestors", color: ancestor.color, overlap: null },
  ];
  for (const surface of read.overlapping) {
    const parsed = parseCssColor(surface.color);
    if (parsed === null) {
      unreadable.push(`${surface.description} (${surface.color})`);
      continue;
    }
    if (parsed.a === 0) continue;
    layers.push({
      source: surface.description,
      // A translucent surface is itself read against the ancestor chain, so the
      // backdrop it forms is the composite and not its own declared colour.
      color: over(parsed, ancestor.color),
      overlap: surface.overlapFraction,
    });
  }

  const backdrops: BackdropMeasurement[] = layers.map((layer) => {
    const fg = over(raw, layer.color);
    return {
      source: layer.source,
      color: formatRgb(layer.color),
      overlapFraction: layer.overlap,
      fg: formatRgb(fg),
      ratio: contrastRatio(fg, layer.color),
    };
  });
  const lower = (a: BackdropMeasurement, b: BackdropMeasurement) =>
    b.ratio < a.ratio ? b : a;
  const worstAny = backdrops.reduce(lower);
  // The ancestor entry is always in the running: it is the backdrop wherever
  // nothing else covers the element, which is most of it.
  const worst = backdrops
    .filter(
      (b) =>
        b.overlapFraction === null || b.overlapFraction >= MIN_OVERLAP_FOR_WORST,
    )
    .reduce(lower);

  return {
    worstRatio: worst.ratio,
    worstBackdrop: worst.source,
    worstRatioAnyOverlap: worstAny.ratio,
    worstBackdropAnyOverlap: worstAny.source,
    minOverlapForWorst: MIN_OVERLAP_FOR_WORST,
    ancestorRatio: backdrops[0]!.ratio,
    ancestorBackdrop: backdrops[0]!.color,
    whiteFallback: ancestor.whiteFallback,
    backgroundImageAncestors: read.backgroundImageAncestors,
    backdrops: backdrops.slice(0, MAX_BACKDROPS_REPORTED),
    overlappingCount: read.overlappingCount,
    unreadableBackdrops: unreadable,
  };
}

export type PaintSide = {
  color: string;
  // The element's own paint alpha. At 1 the composited colour does not depend on
  // what is behind it, which is what makes a delta-E between two opaque strokes
  // a backdrop-free number.
  alpha: number;
  backdrop: string;
  whiteFallback: boolean;
  backgroundImageAncestors: string[];
  // True when the paint is translucent AND something non-ancestral overlaps it,
  // so the colour that reaches the eye is not the one reported here.
  backdropSensitive: boolean;
  overlappingCount: number;
};

export function paintSide(read: ColorRead): PaintSide | null {
  const raw = rawPaint(read);
  if (raw === null) return null;
  const backdrop = flattenBackdrop(read.bgStack);
  return {
    color: formatRgb(over(raw, backdrop.color)),
    alpha: raw.a,
    backdrop: formatRgb(backdrop.color),
    whiteFallback: backdrop.whiteFallback,
    backgroundImageAncestors: read.backgroundImageAncestors,
    backdropSensitive: raw.a < 1 && read.overlappingCount > 0,
    overlappingCount: read.overlappingCount,
  };
}

// ---------------------------------------------------------------------------
// Hover expectation (pure, Node side)
// ---------------------------------------------------------------------------

export type HoverGraph = {
  nodes: Array<{ id: string; type: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
};

// React Flow labels an edge wrapper `Edge from <source> to <target>` whenever
// the edge carries no ariaLabel of its own, which none of this app's edges do.
// That string is the only place the DOM states the graph's own adjacency, and
// the probe needs adjacency from a source INDEPENDENT of the hover code it is
// testing - deriving the expectation from the app's own focus computation would
// make the op agree with the app by construction.
//
// The split is resolved against the known node ids rather than on the first
// " to ": an id containing that substring would otherwise silently name a node
// that does not exist.
export function resolveEndpoints(
  ariaLabel: string,
  nodeIds: ReadonlySet<string>,
): [string, string] | null {
  const prefix = "Edge from ";
  if (!ariaLabel.startsWith(prefix)) return null;
  const body = ariaLabel.slice(prefix.length);
  for (let i = body.indexOf(" to "); i !== -1; i = body.indexOf(" to ", i + 1)) {
    const source = body.slice(0, i);
    const target = body.slice(i + 4);
    if (nodeIds.has(source) && nodeIds.has(target)) return [source, target];
  }
  return null;
}

// The dim set the graph says should appear, given a hovered element: everything
// outside the hovered element's ego-network, where the ego-network is its
// endpoints plus every edge incident to them.
//
// This is a REFERENCE, not a prediction of the app's focus rule, and the two are
// meant to differ:
//   - For a plain edge the app lights less than this (the hovered edge and its
//     two endpoints only), so the app dims a superset of what is expected.
//   - For a bus member the app lights the whole trunk group, which reaches
//     endpoints outside the ego-network, so the expected set can name elements
//     the app leaves lit and the observed set can name siblings the expectation
//     kept lit. Measured on battery5-xiranite: hovering a gas tap trunk owner
//     lights three sibling tap nodes this set expects dimmed, and dims one
//     downstream tap edge it expects lit.
// Predicting the app's rule exactly would mean re-implementing the code under
// test inside its own refuter, and the two would then agree by construction.
// The question this set makes decidable is the one a "hover produces no
// response" finding turns on: the graph says N elements are outside the
// ego-network, so an empty observed set against a non-empty expected one is a
// real "hover produced no response", while an empty expected set explains an
// empty observed one outright. That rule is emitted with the result rather than
// left in this comment, because a reader of stdout sees two large arrays that
// differ and has no other way to know a difference is not the defect.
//
// Group containers are outside the universe: Canvas makes them hover-inert and
// gives a container with a focused child `lit-container` instead of `dimmed`,
// so counting them would put a known non-defect in every expected set.
export function expectedDimmed(
  graph: HoverGraph,
  hovered: { kind: "edge" | "node"; id: string },
): string[] {
  const incident = new Map<string, string[]>();
  for (const edge of graph.edges) {
    for (const node of [edge.source, edge.target]) {
      const list = incident.get(node);
      if (list) list.push(edge.id);
      else incident.set(node, [edge.id]);
    }
  }

  const lit = new Set<string>();
  const lightNode = (nodeId: string): void => {
    lit.add(nodeId);
    for (const edgeId of incident.get(nodeId) ?? []) lit.add(edgeId);
  };
  if (hovered.kind === "edge") {
    const edge = graph.edges.find((e) => e.id === hovered.id);
    if (edge === undefined) {
      throw new Error(`no edge "${hovered.id}" in the rendered graph`);
    }
    lightNode(edge.source);
    lightNode(edge.target);
  } else {
    const node = graph.nodes.find((n) => n.id === hovered.id);
    if (node === undefined) {
      throw new Error(`no node "${hovered.id}" in the rendered graph`);
    }
    lightNode(hovered.id);
    // A hovered node lights its incident edges, and the app lights those edges'
    // far endpoints too, so they belong in the ego-network.
    for (const edgeId of incident.get(hovered.id) ?? []) {
      const edge = graph.edges.find((e) => e.id === edgeId)!;
      lit.add(edge.source);
      lit.add(edge.target);
    }
  }

  const universe = [
    ...graph.nodes.filter((n) => n.type !== "group").map((n) => n.id),
    ...graph.edges.map((e) => e.id),
  ];
  return universe.filter((id) => !lit.has(id)).sort();
}

// What one sample point saw: the canvas-wide hover flag, the element that
// actually took the pointer there, and the dim set at that instant.
export type HoverSampleRead = {
  hoverActive: boolean;
  hit: { kind: "edge" | "node" | "other"; id: string | null; topClass: string } | null;
  dimmed: string[];
};

export type HoverVerdict = {
  engaged: boolean;
  // Why the sample did not engage the asked-for element. Absent when it did.
  reason?: string;
};

// Whether a sample engaged THE ELEMENT THE CALLER ASKED ABOUT.
//
// `hoverActive` alone answers "is anything hovered", which is not the question:
// the app sets it for any hovered element, so a sample landing on a co-routed
// sibling would report the asked-for edge as responsive. Two independent checks
// have to agree:
//   - the element under the pointer is the target, read straight out of the DOM;
//   - the target is not in the dim set, because the app never dims what it lit,
//     so a dimmed target is proof that something else engaged.
// Either one failing is reported as what it is rather than folded into a false.
export function judgeHoverSample(
  target: { kind: "edge" | "node"; id: string },
  read: HoverSampleRead,
): HoverVerdict {
  const where =
    read.hit === null
      ? "nothing"
      : read.hit.id !== null
        ? `${read.hit.kind} "${read.hit.id}"`
        : `a non-graph element (${read.hit.topClass})`;
  if (read.hit === null || read.hit.kind !== target.kind || read.hit.id !== target.id) {
    return {
      engaged: false,
      reason: read.hoverActive
        ? `hover engaged, but the pointer was over ${where}, not ${target.kind} "${target.id}"`
        : `no hover, and the pointer was over ${where}`,
    };
  }
  if (!read.hoverActive) {
    return {
      engaged: false,
      reason: `the pointer was over ${target.kind} "${target.id}" but the canvas never went hover-active`,
    };
  }
  if (read.dimmed.includes(target.id)) {
    return {
      engaged: false,
      reason: `${target.kind} "${target.id}" is in the dim set while hover is active, so a different element is the one lit`,
    };
  }
  return { engaged: true };
}

export type HoverDecision = {
  rule: string;
  observedEmpty: boolean;
  expectedEmpty: boolean;
  // The only dim-set reading that is a defect on its own.
  noResponse: boolean;
  // Stated so a reader does not have to diff two long arrays to find out that
  // they differ, or read a difference as the finding.
  differs: boolean;
};

// The decision rule, emitted with the result. Expected and observed legitimately
// diverge in BOTH directions on bus edges, because the app lights whole trunk
// groups while the expectation is the graph's ego-network.
export function hoverDecision(
  observed: readonly string[],
  expected: readonly string[],
): HoverDecision {
  const obs = new Set(observed);
  const exp = new Set(expected);
  const differs =
    obs.size !== exp.size || [...exp].some((id) => !obs.has(id));
  return {
    rule:
      "an empty observedDimmed against a non-empty expectedDimmed is a real 'hover produced no response'; " +
      "a set DIFFERENCE between observedDimmed and expectedDimmed is NOT a defect, because the app lights whole bus trunk groups while expectedDimmed is the graph's ego-network",
    observedEmpty: observed.length === 0,
    expectedEmpty: expected.length === 0,
    noResponse: observed.length === 0 && expected.length > 0,
    differs,
  };
}

export type SamplePoint = { at: string; x: number; y: number };

// Which sample points the mouse can actually be moved to: inside the pane and
// clear of the floating chrome. A point under the minimap hovers the minimap,
// and a point outside the pane hovers nothing at all - either one would be
// counted as a failed sample and could push a working hover to `false`.
//
// `pane` is in PAGE coordinates (where the sample points and the mouse live);
// `overlays` come from the scene collector in PANE-RELATIVE coordinates, and are
// shifted here rather than by the caller so the two frames are converted in one
// place.
export function usableSamples(
  points: readonly SamplePoint[],
  pane: Rect,
  overlays: readonly Rect[],
): boolean[] {
  return points.map((p) => {
    if (
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y) ||
      p.x < pane.x ||
      p.y < pane.y ||
      p.x > pane.x + pane.width ||
      p.y > pane.y + pane.height
    ) {
      return false;
    }
    return !overlays.some(
      (o) =>
        p.x >= pane.x + o.x &&
        p.x <= pane.x + o.x + o.width &&
        p.y >= pane.y + o.y &&
        p.y <= pane.y + o.y + o.height,
    );
  });
}

// ---------------------------------------------------------------------------
// --eval plumbing (pure, Node side)
// ---------------------------------------------------------------------------

// The file holds ONE self-contained arrow function taking no arguments. It is
// turned into an immediately-invoked expression here rather than handed to
// Playwright as a bare function string, so what comes back is the function's
// RESULT and not an unserialisable function handle.
export function evalExpression(source: string): string {
  const body = source
    .replace(/^\s*export\s+default\s+/, "")
    .trim()
    .replace(/;+$/, "");
  return `(${body})()`;
}

export type EvalPayload =
  | { truncated: false; value: unknown }
  | { truncated: true; json: string };

// A result that does not fit the budget is reported as the leading slice of its
// JSON with the cut flagged. Emitting the value untruncated would let one
// evaluation bury the probe's own fields; emitting nothing would hide that
// there was a result at all.
export function evalPayload(value: unknown, limit = EVAL_JSON_LIMIT): EvalPayload {
  const json = JSON.stringify(value);
  if (json === undefined) return { truncated: false, value: null };
  if (json.length <= limit) return { truncated: false, value };
  return { truncated: true, json: json.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// The op table and the command line
//
// Both live here rather than beside main() so the argv suite reads them without
// loading the CLI, which drags in Playwright and a browser driver for what is a
// few milliseconds of string work.
//
// OP_ARGS is the op list's one definition on this side. The same names are
// written again in the workflow's falsifier schema and twice in the skill doc,
// and only a parity test holds those to this table - an op renamed here and
// nowhere else leaves an evaluator naming a probe run that cannot be made.
// ---------------------------------------------------------------------------

export const OP_ARGS = {
  "hover-edge": ["id"],
  "hover-node": ["id"],
  contrast: ["selector"],
  "delta-e": ["a", "b"],
  "chip-binding": ["id"],
  rect: ["id"],
  "computed-style": ["selector", "props"],
  "text-overflow": ["selector"],
} as const;
export type OpName = keyof typeof OP_ARGS;

function isOpName(name: string): name is OpName {
  return Object.prototype.hasOwnProperty.call(OP_ARGS, name);
}

export type ProbeOptions = {
  baseUrl: string;
  hash: string;
  locale: string;
  zoom: number | null;
  center: { x: number; y: number } | null;
  op: OpName | null;
  args: Record<string, string>;
  evalFile: string | null;
  shot: string | null;
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): ProbeOptions | string {
  let baseUrl: string | undefined;
  let hash: string | undefined;
  let locale = "en";
  let zoom: number | null = null;
  let center: { x: number; y: number } | null = null;
  let op: OpName | null = null;
  const args: Record<string, string> = {};
  let evalFile: string | null = null;
  let shot: string | null = null;

  const value = (i: number): string | null => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = value(i);
    switch (a) {
      case "--base-url":
        if (v === null) return "error: --base-url requires a value";
        baseUrl = argv[++i];
        break;
      case "--hash":
        if (v === null) return "error: --hash requires a value";
        hash = argv[++i];
        break;
      case "--locale":
        if (v === null) return "error: --locale requires a value";
        locale = argv[++i]!;
        break;
      case "--zoom": {
        if (v === null) return "error: --zoom requires a value";
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n <= 0)
          return `error: --zoom must be a positive number, got "${v}"`;
        zoom = n;
        break;
      }
      case "--center": {
        if (v === null) return "error: --center requires a value";
        const parts = argv[++i]!.split(",");
        // Each half must be a number that was actually written. Number("") is 0
        // and finite, so "10," would otherwise parse as the origin's y and
        // silently frame a camera the caller never asked for.
        const bad =
          parts.length !== 2 ||
          parts.some((p) => p.trim() === "" || !Number.isFinite(Number(p)));
        if (bad) return `error: --center must be "<wx>,<wy>", got "${v}"`;
        center = { x: Number(parts[0]), y: Number(parts[1]) };
        break;
      }
      case "--op": {
        if (v === null) return "error: --op requires a value";
        const name = argv[++i]!;
        if (!isOpName(name))
          return `error: unknown op "${name}"; known ops: ${Object.keys(OP_ARGS).join(", ")}`;
        op = name;
        break;
      }
      case "--arg": {
        if (v === null) return "error: --arg requires a k=v value";
        const pair = argv[++i]!;
        const eq = pair.indexOf("=");
        // Split at the FIRST `=` only: a selector argument routinely carries
        // more of them, and splitting on every one would drop half the selector.
        if (eq <= 0) return `error: --arg must be "k=v", got "${pair}"`;
        args[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case "--eval":
        if (v === null) return "error: --eval requires a file path";
        evalFile = argv[++i]!;
        break;
      case "--shot":
        if (v === null) return "error: --shot requires a file path";
        shot = argv[++i]!;
        break;
      default:
        return `error: unknown argument "${a}"`;
    }
  }

  if (baseUrl === undefined) return "error: --base-url is required";
  if (hash === undefined) return "error: --hash is required";
  // Either both or neither: a zoom with no centre has nothing to frame, and a
  // centre with no zoom would silently keep whatever zoom the fit left, which
  // reads in the output as a camera the caller commanded.
  if ((zoom === null) !== (center === null))
    return "error: --zoom and --center must be given together";
  if (op === null && Object.keys(args).length > 0)
    return "error: --arg is only meaningful with --op";
  if (op !== null) {
    for (const required of OP_ARGS[op]) {
      if (args[required] === undefined)
        return `error: op ${op} requires --arg ${required}=<value>`;
    }
  }

  return { baseUrl, hash, locale, zoom, center, op, args, evalFile, shot };
}
