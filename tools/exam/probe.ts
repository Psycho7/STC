// Constrained runtime probe for the render-quality exam.
// Usage:
//   bun run tools/exam/probe.ts --base-url <url> --hash <planHash> [--locale en]
//                               [--zoom <z> --center <wx>,<wy>]
//                               [--op <name> --arg k=v ...]
//                               [--eval <file.js>] [--shot <out.png>]
//
// Boots one page on a plan, optionally commands a camera, runs at most one named
// operation plus an optional free-form evaluation, and prints a single JSON
// object to stdout. Like the capture CLI it never builds and never starts a
// server: the caller owns both.
//
// This is the interface a refutation pass uses to DISPROVE a visual finding, so
// every op reports what it measured rather than a verdict, and an op that could
// not measure says so instead of returning a number that reads like one.
//
// Ops:
//   hover-edge     --arg id=<edgeId>
//   hover-node     --arg id=<nodeId>
//   contrast       --arg selector=<css>
//   delta-e        --arg a=<css> --arg b=<css>
//   chip-binding   --arg id=<chip testid or edge id>
//   rect           --arg id=<scene element id>
//   computed-style --arg selector=<css> --arg props=<comma list>
//   text-overflow  --arg selector=<css>
//
// Exit codes:
//   0  the probe ran and every requested step succeeded
//   1  harness failure (bad flags, missing element, browser error)
//   2  --base-url is not serving
//   3  the page never became examinable (no READY, no exam hook)
//
// hover-edge is the load-bearing op. Issue #30 ("edge hover produces no
// response on dense plans") was filed off two screenshot runs that hovered edges
// by ELEMENT; Playwright aims at an element's bounding-box CENTRE, which for an
// L- or Z-shaped orthogonal edge lies off the sub-2px stroke most of the time.
// The app was fine and a whole triage round went into disproving it. So this op
// never hovers an element: it walks the edge's own interaction path, samples
// points ON the geometry, and reports whether hover engaged at all. A false
// `hoverEngaged` is a statement about the PROBE, not about the product.

import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { collectScene, type SceneCollection } from "../../test/e2e/collect";
import { bootPage, examUrl, RIM_INSET } from "./capture";
import { safeRegion, viewportFor, type Rect, type Viewport } from "./tiling";

// The exam camera handle the app installs under `?exam=1`. Declared locally for
// the same reason capture.ts declares it: the app puts it on `Window` from a
// module this CLI has no reason to load, and the type is erased before any of
// it reaches the browser.
type ExamHook = { setViewport(v: Viewport): void };
type ExamWindow = Window & { __stcExam?: ExamHook };

const VIEWPORT_SETTLE_MS = 250;
// Past the app's 150ms hover-intent delay (Canvas.tsx HOVER_INTENT_MS) with
// margin, so a sample that IS on the stroke has actually settled into the dim
// state before it is judged. Shorter than this and a working hover reads as a
// dead one, which is exactly the mistake being corrected here.
const HOVER_SETTLE_MS = 250;
// Long enough for a pending hover to be cancelled and the previous one to clear
// before the first sample, so an engagement can only be attributed to the
// sample that caused it.
const HOVER_CLEAR_MS = 400;
// Where the pointer is parked to clear hover. A pane corner is the least likely
// point to sit on an element.
const PARK_POINT = { x: 3, y: 3 };
// Fractions of an edge's total arc length, tried in this order. The midpoint
// first because it is on the longest run of most orthogonal routes; the
// quarters next because a Z route's midpoint can land on the short middle jog
// under a chip; the ends last because they sit near a node card and a handle.
const EDGE_SAMPLE_FRACTIONS = [0.5, 0.25, 0.75, 0.1, 0.9];
// Sample points inside a node card, as fractions of its client rect. The centre
// first, then the quadrant midpoints, so a card whose centre is covered by a
// chip or a nested child still gets hovered.
const NODE_SAMPLE_FRACTIONS: Array<[number, number]> = [
  [0.5, 0.5],
  [0.25, 0.25],
  [0.75, 0.75],
  [0.25, 0.75],
  [0.75, 0.25],
];
// --eval budget. A probe evaluation is a one-liner against a settled page; five
// seconds is generous for that and short enough that a hung expression fails the
// run instead of the caller's patience.
const EVAL_TIMEOUT_MS = 5_000;
// Serialised --eval results are truncated here. 8 KB is well past any honest
// measurement and well short of a page dump that would drown the JSON the
// caller is reading the probe's own fields out of.
const EVAL_JSON_LIMIT = 8 * 1024;

const OP_ARGS = {
  "hover-edge": ["id"],
  "hover-node": ["id"],
  contrast: ["selector"],
  "delta-e": ["a", "b"],
  "chip-binding": ["id"],
  rect: ["id"],
  "computed-style": ["selector", "props"],
  "text-overflow": ["selector"],
} as const;
type OpName = keyof typeof OP_ARGS;

function isOpName(name: string): name is OpName {
  return Object.prototype.hasOwnProperty.call(OP_ARGS, name);
}

export type ProbeResult = {
  ok: boolean;
  transform: { x: number; y: number; zoom: number };
  op?: string;
  opResult?: unknown;
  evalResult?: unknown;
  consoleErrors: string[];
  // Present only when a step failed. The typed shape above is the contract; an
  // op that could not run has no result to report, and reporting a plausible
  // one would be worse than saying nothing.
  error?: string;
};

type Options = {
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

export function parseArgs(argv: string[]): Options | string {
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
        const x = Number(parts[0]);
        const y = Number(parts[1]);
        if (parts.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y))
          return `error: --center must be "<wx>,<wy>", got "${v}"`;
        center = { x, y };
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
// container is opaque (--ak-bg-canvas), so the base never shows through, and a
// contrast number that came out measured against white would be the loud symptom
// of the container having lost its background rather than a silent wrong answer.
export function flattenBackdrop(stack: readonly string[]): Rgba {
  let base: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = parseCssColor(stack[i]!);
    if (layer === null) continue;
    base = over(layer, base);
  }
  return base;
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

// What the element actually paints, folded onto its own backdrop so a
// translucent stroke is compared as it appears rather than as it is declared.
//
// SVG elements ignore CSS `background`, so their paint is the stroke when there
// is one and the fill otherwise - stroke first because every edge in this app is
// a stroked path with no fill, and the fill of such a path is `none`.
export function paintColor(read: ColorRead): { fg: Rgba; bg: Rgba } | null {
  const bg = flattenBackdrop(read.bgStack);
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
  const scale = (Number.isFinite(opacity) ? opacity : 1) * (Number.isFinite(extra) ? extra : 1);
  return { fg: over({ ...raw, a: raw.a * scale }, bg), bg };
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
// The question this set makes decidable is the one issue #30 turned on: the
// graph says N elements are outside the ego-network, so an empty observed set
// against a non-empty expected one is a real "hover produced no response",
// while an empty expected set explains an empty observed one outright.
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
// In-page collectors
//
// Same rule as test/e2e/collect.ts: each of these is handed to page.evaluate,
// which serialises the function SOURCE, so nothing from this module's scope
// travels with it. No value imports, no module constants, no hoisted helpers.
// Type-only references are erased and are safe.
// ---------------------------------------------------------------------------

type GraphDom = {
  nodes: Array<{ id: string; type: string }>;
  edges: Array<{ id: string; ariaLabel: string }>;
};

function readGraphDom(): GraphDom {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  ).map((el) => {
    const match = /react-flow__node-(\w+)/.exec(el.className);
    return { id: el.getAttribute("data-id") ?? "", type: match?.[1] ?? "" };
  });
  const edges = Array.from(document.querySelectorAll(".react-flow__edge")).map(
    (el) => ({
      id: el.getAttribute("data-id") ?? "",
      ariaLabel: el.getAttribute("aria-label") ?? "",
    }),
  );
  return { nodes, edges };
}

type HoverState = { hoverActive: boolean; dimmed: string[] };

// The hover signal is NOT on the hovered element: Canvas puts `hover-active` on
// the .ak-canvas-theme container and `dimmed` on the complement of the lit
// ego-network. Reading the hovered edge's own classes would find nothing and
// report a working hover as dead.
//
// The dim set is read over nodes and edges only. Chips and junction dots dim
// too, but through their owning edge's data, so they are a function of the edge
// set rather than independent evidence - and they are not in the adjacency
// universe the expectation is computed over, so including them would compare two
// different universes.
function readHoverState(): HoverState {
  const theme = document.querySelector(".ak-canvas-theme");
  const dimmed: string[] = [];
  for (const el of Array.from(
    document.querySelectorAll(".react-flow__node.dimmed"),
  )) {
    if (el.classList.contains("react-flow__node-group")) continue;
    const id = el.getAttribute("data-id");
    if (id !== null && id !== "") dimmed.push(id);
  }
  for (const el of Array.from(
    document.querySelectorAll(".react-flow__edge.dimmed"),
  )) {
    const id = el.getAttribute("data-id");
    if (id !== null && id !== "") dimmed.push(id);
  }
  return {
    hoverActive: theme !== null && theme.classList.contains("hover-active"),
    dimmed: dimmed.sort(),
  };
}

function readHoverActive(): boolean {
  const theme = document.querySelector(".ak-canvas-theme");
  return theme !== null && theme.classList.contains("hover-active");
}

// Points ON the edge's own geometry, in page coordinates.
//
// getPointAtLength walks the path's arc length, so every sample is on the
// stroke however the route bends; getScreenCTM maps the path's user space to
// the page, which is the frame the mouse is driven in. An id is matched by
// attribute rather than by an attribute SELECTOR because these ids carry `:`,
// `|` and `>` and would have to be escaped.
function edgeSamplePoints(spec: {
  id: string;
  fractions: number[];
}): SamplePoint[] | null {
  let wrapper: Element | null = null;
  for (const el of Array.from(document.querySelectorAll(".react-flow__edge"))) {
    if (el.getAttribute("data-id") === spec.id) {
      wrapper = el;
      break;
    }
  }
  if (wrapper === null) return null;
  const path =
    wrapper.querySelector<SVGPathElement>(".react-flow__edge-interaction") ??
    wrapper.querySelector<SVGPathElement>(".react-flow__edge-path");
  if (path === null) return null;
  const total = path.getTotalLength();
  const m = path.getScreenCTM();
  if (m === null || !(total > 0)) return null;
  return spec.fractions.map((f) => {
    const p = path.getPointAtLength(total * f);
    return {
      at: `len ${f}`,
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
    };
  });
}

function nodeSamplePoints(spec: {
  id: string;
  fractions: Array<[number, number]>;
}): SamplePoint[] | null {
  let node: HTMLElement | null = null;
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  )) {
    if (el.getAttribute("data-id") === spec.id) {
      node = el;
      break;
    }
  }
  if (node === null) return null;
  const r = node.getBoundingClientRect();
  return spec.fractions.map(([fx, fy]) => ({
    at: `rect ${fx},${fy}`,
    x: r.left + r.width * fx,
    y: r.top + r.height * fy,
  }));
}

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
};

function readColors(selector: string): ColorRead {
  const empty: ColorRead = {
    found: false,
    isSvg: false,
    color: "",
    stroke: "",
    fill: "",
    opacity: "",
    strokeOpacity: "",
    fillOpacity: "",
    bgStack: [],
  };
  const el = document.querySelector(selector);
  if (el === null) return empty;
  const cs = getComputedStyle(el);
  const bgStack: string[] = [];
  // Starts at the element itself: an HTML element paints its own background
  // behind its text, and an SVG element's background-color computes to
  // transparent, so one walk serves both without a special case.
  let cur: Element | null = el;
  while (cur !== null) {
    bgStack.push(getComputedStyle(cur).backgroundColor);
    cur = cur.parentElement;
  }
  return {
    found: true,
    isSvg: el.namespaceURI === "http://www.w3.org/2000/svg",
    color: cs.color,
    stroke: cs.stroke,
    fill: cs.fill,
    opacity: cs.opacity,
    strokeOpacity: cs.strokeOpacity,
    fillOpacity: cs.fillOpacity,
    bgStack,
  };
}

type ChipBinding = {
  found: boolean;
  edgeId: string | null;
  ownPathDistance: number | null;
  nearestOtherPathDistance: number | null;
  nearestOtherEdgeId: string | null;
};

// How far a chip sits from the edge it belongs to, against how far it sits from
// the nearest edge it does NOT belong to, in page pixels.
//
// Each path is sampled along its arc length at roughly 2px, so the reported
// distance is a sampled minimum: it can only over-state the true distance, and
// by at most about a pixel. That direction is the safe one - a chip called
// bound is bound.
function chipBinding(id: string): ChipBinding {
  const miss: ChipBinding = {
    found: false,
    edgeId: null,
    ownPathDistance: null,
    nearestOtherPathDistance: null,
    nearestOtherEdgeId: null,
  };
  let chip: HTMLElement | null = null;
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  )) {
    if (el.getAttribute("data-testid") === id || el.getAttribute("data-edge-id") === id) {
      chip = el;
      break;
    }
  }
  if (chip === null) return miss;
  const r = chip.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const edgeId = chip.getAttribute("data-edge-id");

  let own: number | null = null;
  let bestOther = Infinity;
  let bestOtherId: string | null = null;
  for (const p of Array.from(
    document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
  )) {
    const m = p.getScreenCTM();
    const total = p.getTotalLength();
    if (m === null || !(total > 0)) continue;
    const steps = Math.min(2000, Math.max(64, Math.ceil(total / 2)));
    let best = Infinity;
    for (let i = 0; i <= steps; i++) {
      const q = p.getPointAtLength((total * i) / steps);
      const d = Math.hypot(
        m.a * q.x + m.c * q.y + m.e - cx,
        m.b * q.x + m.d * q.y + m.f - cy,
      );
      if (d < best) best = d;
    }
    if (edgeId !== null && p.id === edgeId) own = best;
    else if (best < bestOther) {
      bestOther = best;
      bestOtherId = p.id;
    }
  }
  return {
    found: true,
    edgeId,
    ownPathDistance: own,
    nearestOtherPathDistance: bestOtherId === null ? null : bestOther,
    nearestOtherEdgeId: bestOtherId,
  };
}

function readComputedStyle(spec: {
  selector: string;
  props: string[];
}): Record<string, string> | null {
  const el = document.querySelector(spec.selector);
  if (el === null) return null;
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  // getPropertyValue takes the CSS property name, so a custom property
  // (--edge-base-width) and a standard one are read the same way.
  for (const prop of spec.props) out[prop] = cs.getPropertyValue(prop);
  return out;
}

function readTextOverflow(
  selector: string,
): { scrollWidth: number; clientWidth: number; clipped: boolean } | null {
  const el = document.querySelector<HTMLElement>(selector);
  if (el === null) return null;
  // Both widths are integers, so an element whose content is a fraction of a
  // pixel wider than its box reports a 1px overflow it does not have. Only a
  // difference above that rounding is called clipped.
  return {
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    clipped: el.scrollWidth - el.clientWidth > 1,
  };
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

type HoverResult = {
  hoverEngaged: boolean;
  pointsTried: number;
  samples: Array<{ at: string; x: number; y: number; usable: boolean; engaged: boolean }>;
  observedDimmed: string[];
  expectedDimmed: string[];
};

async function buildGraph(page: Page): Promise<HoverGraph> {
  const dom = await page.evaluate(readGraphDom);
  const nodeIds = new Set(dom.nodes.map((n) => n.id));
  const edges = dom.edges.map((e) => {
    const endpoints = resolveEndpoints(e.ariaLabel, nodeIds);
    if (endpoints === null) {
      // Failing loudly rather than dropping the edge: an unattributable edge
      // would quietly shrink the expected dim set, and a refuter that
      // under-states what must dim is how a real defect gets waved through.
      throw new Error(
        `cannot read endpoints for edge "${e.id}" from its aria-label ${JSON.stringify(e.ariaLabel)}; ` +
          `the probe derives adjacency from React Flow's default edge label`,
      );
    }
    return { id: e.id, source: endpoints[0], target: endpoints[1] };
  });
  return { nodes: dom.nodes, edges };
}

async function runHover(
  page: Page,
  kind: "edge" | "node",
  id: string,
): Promise<HoverResult> {
  const graph = await buildGraph(page);
  const expected = expectedDimmed(graph, { kind, id });

  const points =
    kind === "edge"
      ? await page.evaluate(edgeSamplePoints, {
          id,
          fractions: EDGE_SAMPLE_FRACTIONS,
        })
      : await page.evaluate(nodeSamplePoints, {
          id,
          fractions: NODE_SAMPLE_FRACTIONS,
        });
  if (points === null) {
    throw new Error(`no hoverable geometry for ${kind} "${id}"`);
  }

  const scene = await page.evaluate(collectScene);
  const usable = usableSamples(points, scene.paneRect, scene.overlays);

  // Start from a known-idle state so an engagement can only be attributed to a
  // sample this op moved to.
  await page.mouse.move(PARK_POINT.x, PARK_POINT.y);
  await page.waitForTimeout(HOVER_CLEAR_MS);

  const samples: HoverResult["samples"] = [];
  let engaged = false;
  let pointsTried = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!usable[i]) {
      samples.push({ ...p, usable: false, engaged: false });
      continue;
    }
    pointsTried++;
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HOVER_SETTLE_MS);
    engaged = await page.evaluate(readHoverActive);
    samples.push({ ...p, usable: true, engaged });
    if (engaged) break;
  }

  const state = await page.evaluate(readHoverState);
  return {
    hoverEngaged: state.hoverActive,
    pointsTried,
    samples,
    observedDimmed: state.dimmed,
    expectedDimmed: expected,
  };
}

async function runOp(
  page: Page,
  op: OpName,
  args: Record<string, string>,
): Promise<unknown> {
  switch (op) {
    case "hover-edge":
      return runHover(page, "edge", args.id!);
    case "hover-node":
      return runHover(page, "node", args.id!);
    case "contrast": {
      const read = await page.evaluate(readColors, args.selector!);
      if (!read.found) throw new Error(`no element matches ${args.selector!}`);
      const paint = paintColor(read);
      if (paint === null) {
        throw new Error(`could not read a paint colour from ${args.selector!}`);
      }
      return {
        ratio: contrastRatio(paint.fg, paint.bg),
        fg: formatRgb(paint.fg),
        bg: formatRgb(paint.bg),
      };
    }
    case "delta-e": {
      const reads = await Promise.all([
        page.evaluate(readColors, args.a!),
        page.evaluate(readColors, args.b!),
      ]);
      const paints = reads.map((read, i) => {
        const selector = i === 0 ? args.a! : args.b!;
        if (!read.found) throw new Error(`no element matches ${selector}`);
        const paint = paintColor(read);
        if (paint === null) {
          throw new Error(`could not read a paint colour from ${selector}`);
        }
        return paint;
      });
      return {
        deltaE76: deltaE76(srgbToLab(paints[0]!.fg), srgbToLab(paints[1]!.fg)),
        a: formatRgb(paints[0]!.fg),
        b: formatRgb(paints[1]!.fg),
      };
    }
    case "chip-binding": {
      const binding = await page.evaluate(chipBinding, args.id!);
      if (!binding.found) throw new Error(`no chip "${args.id!}" on the canvas`);
      return {
        edgeId: binding.edgeId,
        ownPathDistance: binding.ownPathDistance,
        nearestOtherPathDistance: binding.nearestOtherPathDistance,
        nearestOtherEdgeId: binding.nearestOtherEdgeId,
      };
    }
    case "rect": {
      const scene = await page.evaluate(collectScene);
      const el = scene.elements.find((e) => e.id === args.id!);
      if (el === undefined) {
        throw new Error(`no scene element "${args.id!}"`);
      }
      return { clientRect: el.clientRect, worldRect: el.worldRect };
    }
    case "computed-style": {
      const props = args
        .props!.split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      if (props.length === 0) throw new Error("--arg props is empty");
      const styles = await page.evaluate(readComputedStyle, {
        selector: args.selector!,
        props,
      });
      if (styles === null) throw new Error(`no element matches ${args.selector!}`);
      return styles;
    }
    case "text-overflow": {
      const overflow = await page.evaluate(readTextOverflow, args.selector!);
      if (overflow === null) throw new Error(`no element matches ${args.selector!}`);
      return overflow;
    }
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function paneFrame(scene: SceneCollection): Rect {
  return { x: 0, y: 0, width: scene.paneRect.width, height: scene.paneRect.height };
}

async function runEval(page: Page, file: string): Promise<EvalPayload> {
  const source = await readFile(file, "utf8");
  const expression = evalExpression(source);
  // page.evaluate has no per-call timeout, so the budget is imposed here. The
  // browser is closed on the way out either way, which is what stops a hung
  // expression from outliving the process.
  const value = await Promise.race([
    page.evaluate<unknown>(expression),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`--eval exceeded ${EVAL_TIMEOUT_MS}ms`)),
        EVAL_TIMEOUT_MS,
      ),
    ),
  ]);
  return evalPayload(value);
}

async function probe(
  browser: Browser,
  opts: Options,
): Promise<{ result: ProbeResult; code: number }> {
  let page: Page;
  let consoleErrors: string[];
  try {
    ({ page, consoleErrors } = await bootPage(browser, opts));
  } catch (err: unknown) {
    return {
      result: {
        ok: false,
        transform: { x: 0, y: 0, zoom: 0 },
        consoleErrors: [],
        error: `never reached READY at ${examUrl(opts.baseUrl, opts.hash)}: ${String(err)}`,
      },
      code: 3,
    };
  }

  const hookPresent = await page.evaluate(
    () => (window as ExamWindow).__stcExam !== undefined,
  );
  if (!hookPresent) {
    return {
      result: {
        ok: false,
        transform: { x: 0, y: 0, zoom: 0 },
        consoleErrors,
        error:
          "no window.__stcExam; the page must be loaded with ?exam=1 before the fragment",
      },
      code: 3,
    };
  }

  let error: string | undefined;

  const { zoom, center } = opts;
  if (zoom !== null && center !== null) {
    const scene = await page.evaluate(collectScene);
    const safe = safeRegion(
      paneFrame(scene),
      scene.overlays.map((o) => ({ x: o.x, y: o.y, width: o.width, height: o.height })),
      RIM_INSET,
    );
    await page.evaluate((v: Viewport) => {
      (window as ExamWindow).__stcExam!.setViewport(v);
    }, viewportFor(center, zoom, safe));
    await page.waitForTimeout(VIEWPORT_SETTLE_MS);
  }

  let opResult: unknown;
  if (opts.op !== null) {
    try {
      opResult = await runOp(page, opts.op, opts.args);
    } catch (err: unknown) {
      error = `op ${opts.op}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let evalResult: EvalPayload | undefined;
  if (opts.evalFile !== null && error === undefined) {
    try {
      evalResult = await runEval(page, opts.evalFile);
    } catch (err: unknown) {
      error = `eval ${opts.evalFile}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Shot last and with the pointer LEFT WHERE THE OP PUT IT: a hover op's
  // evidence is the dimmed render it produced, and parking the pointer first
  // would photograph the idle canvas the finding was never about.
  if (opts.shot !== null && error === undefined) {
    await mkdir(path.dirname(path.resolve(opts.shot)), { recursive: true });
    await page.locator(".react-flow").screenshot({ path: opts.shot, scale: "css" });
  }

  const transform = (await page.evaluate(collectScene)).transform;
  return {
    result: {
      ok: error === undefined,
      transform,
      ...(opts.op !== null ? { op: opts.op } : {}),
      ...(opResult !== undefined ? { opResult } : {}),
      ...(evalResult !== undefined ? { evalResult } : {}),
      consoleErrors,
      ...(error !== undefined ? { error } : {}),
    },
    code: error === undefined ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(1);
  }

  if (!(await reachable(parsed.baseUrl))) {
    console.error(`error: --base-url is not serving: ${parsed.baseUrl}`);
    process.exit(2);
  }

  // The browser is closed BEFORE the process exits, not in a finally around the
  // exit: process.exit skips finally blocks, and the launched Chromium would
  // outlive the run.
  const browser = await chromium.launch();
  let outcome: { result: ProbeResult; code: number };
  try {
    outcome = await probe(browser, parsed);
  } catch (err: unknown) {
    console.error("fatal:", err);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(JSON.stringify(outcome.result, null, 2));
  process.exit(outcome.code);
}
