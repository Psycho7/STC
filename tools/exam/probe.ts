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
//   chip-binding   --arg id=<chip testid, or an edge id that names exactly one chip>
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
// Whatever happens, a JSON object reaches stdout: an op or an evaluation that
// hangs is bounded, and the tail of the run is bounded too, because a refuter
// that gets no output at all learns nothing and a refuter that gets a number it
// cannot trust learns something false.
//
// hover-edge is the load-bearing op. A "hover produces no response on dense
// plans" finding was once filed off two screenshot runs that hovered edges by
// ELEMENT; Playwright aims at an element's bounding-box CENTRE, which for an
// L- or Z-shaped orthogonal edge lies off the sub-2px stroke most of the time.
// The app was fine and a whole triage round went into disproving it. So this op
// never hovers an element: it walks the edge's own interaction path and samples
// points ON the geometry.
//
// Engaging is not enough on its own, though. The app's hover flag lives on the
// canvas container and is set by ANY hovered element, so a sample that lands on
// a neighbour would answer for the element the caller asked about. React Flow
// gives every edge a 20px interaction stroke, so co-routed bus trunks overlap at
// the midpoint and the topmost one takes the pointer; a container node's centre
// is empty space over a child, and containers are hover-inert by design. So each
// sample also reports WHICH element took the pointer, and a sample only counts
// as engaged when that element is the one asked for. A false `hoverEngaged` is a
// statement about the PROBE, not about the product; an engagement attributed to
// something else is reported as exactly that.

import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { collectScene, type SceneCollection } from "../../test/e2e/collect";
import { bootPage, RIM_INSET } from "./capture";
import { examUrl } from "./capture-helpers";
import { HOVER_INTENT_MS } from "../../src/canvas/dimensions";
// Not for a value: importing the app's hook module pulls in the `Window`
// augmentation that types `window.__stcExam` inside the page.evaluate callbacks
// below, so this driver and the page it drives share one declaration instead of
// a copy that can drift. The module declares types and nothing else, so no
// canvas code follows it in.
import "../../src/canvas/exam-hook";
import {
  deltaE76,
  evalExpression,
  evalPayload,
  expectedDimmed,
  hoverDecision,
  judgeHoverSample,
  measureContrast,
  paintSide,
  parseArgs,
  parseCssColor,
  resolveEndpoints,
  srgbToLab,
  usableSamples,
  type ColorRead,
  type EvalPayload,
  type HoverDecision,
  type HoverGraph,
  type HoverSampleRead,
  type OpName,
  type OverlappingSurface,
  type ProbeOptions,
  type SamplePoint,
} from "./probe-analysis";
import { safeRegion, viewportFor, type Rect, type Viewport } from "./tiling";

const VIEWPORT_SETTLE_MS = 250;
// Past the app's hover-intent delay with margin, so a sample that IS on the
// stroke has actually settled into the dim state before it is judged. Shorter
// than this and a working hover reads as a dead one, which is exactly the
// mistake being corrected here. Derived from the app's own constant so raising
// the intent delay cannot leave this behind it.
const HOVER_SETTLE_MS = HOVER_INTENT_MS + 100;
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
// Budget for the closing transform read, and for closing the browser.
//
// A hung expression pins the renderer's main thread, so EVERY later evaluate
// queues behind it and never resolves. Bounding only --eval would turn a silent
// hang into a hang whose error message is never emitted, which is strictly
// worse: the caller waits forever for a diagnosis that already exists.
const TAIL_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type ProbeResult = {
  ok: boolean;
  // Null when the camera could not be read: the page never booted, or the
  // closing read was still queued behind a hung evaluation when its budget ran
  // out. Zeros would read as a real camera at the origin.
  transform: { x: number; y: number; zoom: number } | null;
  op?: string;
  opResult?: unknown;
  evalResult?: unknown;
  consoleErrors: string[];
  // Present only when a step failed. The typed shape above is the contract; an
  // op that could not run has no result to report, and reporting a plausible
  // one would be worse than saying nothing.
  error?: string;
};

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

// The hover signal is NOT on the hovered element: Canvas puts `hover-active` on
// the .ak-canvas-theme container and `dimmed` on the complement of the lit
// ego-network. Reading the hovered edge's own classes would find nothing and
// report a working hover as dead.
//
// The container flag says only that SOMETHING is hovered, so the element under
// the pointer is read here too. Without it a sample landing on a co-routed
// sibling, on a chip, or on a child inside a container box would answer for the
// element the caller asked about.
//
// The dim set is read over nodes and edges only. Chips and junction dots dim
// too, but through their owning edge's data, so they are a function of the edge
// set rather than independent evidence - and they are not in the adjacency
// universe the expectation is computed over, so including them would compare two
// different universes.
function readHoverAt(point: { x: number; y: number }): HoverSampleRead {
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

  // elementFromPoint takes viewport coordinates, which is the frame the sample
  // points and the mouse both live in. An edge wrapper is never inside a node
  // wrapper or the other way round, so at most one of the two matches; anything
  // else (a chip, a band, the pane) is a real answer too, because those take the
  // pointer instead of the element underneath and that is why a sample missed.
  const top = document.elementFromPoint(point.x, point.y);
  let hit: HoverSampleRead["hit"] = null;
  if (top !== null) {
    const edge = top.closest(".react-flow__edge");
    const node = top.closest(".react-flow__node");
    const owner = edge ?? node;
    hit = {
      kind: edge !== null ? "edge" : node !== null ? "node" : "other",
      id: owner === null ? null : owner.getAttribute("data-id"),
      topClass: (top.getAttribute("class") ?? top.tagName.toLowerCase()).slice(0, 120),
    };
  }

  return {
    hoverActive: theme !== null && theme.classList.contains("hover-active"),
    hit,
    dimmed: dimmed.sort(),
  };
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

// Cap on the surfaces shipped back from the page. Sorted by overlap first, so
// the cut only ever drops the least relevant ones.
const MAX_OVERLAPPING_COLLECTED = 16;

function readColors(spec: { selector: string; limit: number }): ColorRead {
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
    backgroundImageAncestors: [],
    overlapping: [],
    overlappingCount: 0,
  };
  const el = document.querySelector(spec.selector);
  if (el === null) return empty;
  const cs = getComputedStyle(el);
  const bgStack: string[] = [];
  // Starts at the element itself: an HTML element paints its own background
  // behind its text, and an SVG element's background-color computes to
  // transparent, so one walk serves both without a special case.
  //
  // background-IMAGE is invisible to that fold: a gradient computes its
  // background-color to transparent, so an element sitting on one is measured
  // against whatever opaque colour lies further up and the number comes out
  // wrong with nothing to show for it. The chip boxes on this canvas are
  // gradients today. Named rather than folded, because a gradient has no single
  // colour to fold.
  const ancestors = new Set<Element>();
  const painted: string[] = [];
  let cur: Element | null = el;
  while (cur !== null) {
    ancestors.add(cur);
    const cs2 = getComputedStyle(cur);
    bgStack.push(cs2.backgroundColor);
    if (cs2.backgroundImage !== "none" && cs2.backgroundImage !== "") {
      const cls = (cur.getAttribute("class") ?? "").trim();
      painted.push(
        (
          cur.tagName.toLowerCase() +
          (cls === "" ? "" : "." + cls.split(/\s+/).join("."))
        ).slice(0, 120),
      );
    }
    cur = cur.parentElement;
  }

  // Painted surfaces the ancestor walk cannot see. The rect test runs FIRST:
  // getBoundingClientRect is cheap and getComputedStyle is not, and on a dense
  // plan the pane holds thousands of elements of which a handful overlap.
  const box = el.getBoundingClientRect();
  const boxArea = box.width * box.height;
  const surfaces: OverlappingSurface[] = [];
  for (const cand of Array.from(document.querySelectorAll("*"))) {
    if (ancestors.has(cand)) continue;
    // Descendants paint on top of their own parent's background and cannot be
    // the thing behind it.
    if (el.contains(cand)) continue;
    const r = cand.getBoundingClientRect();
    const w = Math.min(box.right, r.right) - Math.max(box.left, r.left);
    const h = Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top);
    if (!(w > 0) || !(h > 0)) continue;
    const cs2 = getComputedStyle(cand);
    // String test, not colour maths: Chromium serialises a fully transparent
    // background as "rgba(r, g, b, 0)". Anything that survives is parsed on the
    // Node side where it can be unit tested.
    let color = cs2.backgroundColor;
    const bare =
      color === "" ||
      color === "transparent" ||
      color.replace(/\s+/g, "").endsWith(",0)");
    if (bare) {
      if (cand.namespaceURI !== "http://www.w3.org/2000/svg") continue;
      // Only SVG elements that actually rasterise a fill. `fill` is inherited,
      // so a <g> or an <svg> wrapper reports its children's paint while covering
      // their whole union - which would name every edge group as a surface
      // behind every other edge and drown the real card fills.
      const shapes =
        "path circle ellipse rect line polygon polyline text tspan use image";
      if (!shapes.split(" ").includes(cand.tagName.toLowerCase())) continue;
      color = cs2.fill;
      if (color === "" || color === "none") continue;
    }
    const cls = (cand.getAttribute("class") ?? "").trim();
    const dataId = cand.getAttribute("data-id");
    const description = (
      cand.tagName.toLowerCase() +
      (cls === "" ? "" : "." + cls.split(/\s+/).join(".")) +
      (dataId === null || dataId === "" ? "" : `[data-id=${dataId}]`)
    ).slice(0, 120);
    surfaces.push({
      description,
      color,
      overlapFraction: boxArea > 0 ? Math.min(1, (w * h) / boxArea) : 1,
    });
  }
  surfaces.sort((a, b) => b.overlapFraction - a.overlapFraction);

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
    backgroundImageAncestors: painted,
    overlapping: surfaces.slice(0, spec.limit),
    overlappingCount: surfaces.length,
  };
}

type ChipMatch = { testId: string | null; edgeId: string | null };

type ChipBindingRead = {
  // Every chip the id resolves to, in document order. A bus edge renders TWO
  // chips carrying the same data-edge-id (a drop chip and a rise chip), so an
  // edge id is routinely ambiguous and the caller has to be told which chips it
  // could have meant instead of being handed one of them.
  matches: ChipMatch[];
  // Only measured when exactly one chip matched.
  measurement: {
    testId: string | null;
    edgeId: string | null;
    ownPathDistance: number | null;
    nearestOtherPathDistance: number | null;
    nearestOtherEdgeId: string | null;
    // The arc-length step each of those two distances was sampled at. A sampled
    // minimum over-states the true distance by at most half a step, so this is
    // the reported numbers' real precision.
    ownSampleStepPx: number | null;
    nearestOtherSampleStepPx: number | null;
  } | null;
};

// How far a chip sits from the edge it belongs to, against how far it sits from
// the nearest edge it does NOT belong to, in page pixels.
//
// Each path is walked along its arc length at 2px, CAPPED at a fixed number of
// samples: past about 4000px of path the walk gets coarser than 2px, and a
// 12000px bus trunk is sampled at 6px. The reported distance is therefore a
// sampled minimum that over-states the true distance by up to half the step,
// which is why the step is reported alongside it. Over-stating is the safe
// direction - a chip called bound is bound - but this repo's placement rulings
// are stated in single-digit pixels, so the caller has to see the step to know
// whether the number can carry the ruling.
function chipBinding(id: string): ChipBindingRead {
  const MAX_STEPS = 2000;
  const chips: HTMLElement[] = [];
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  )) {
    if (el.getAttribute("data-testid") === id || el.getAttribute("data-edge-id") === id) {
      chips.push(el);
    }
  }
  const matches: ChipMatch[] = chips.map((el) => ({
    testId: el.getAttribute("data-testid"),
    edgeId: el.getAttribute("data-edge-id"),
  }));
  if (chips.length !== 1) return { matches, measurement: null };

  const chip = chips[0]!;
  const r = chip.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const edgeId = chip.getAttribute("data-edge-id");

  let own: number | null = null;
  let ownStep: number | null = null;
  let bestOther = Infinity;
  let bestOtherId: string | null = null;
  let bestOtherStep: number | null = null;
  for (const p of Array.from(
    document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
  )) {
    const m = p.getScreenCTM();
    const total = p.getTotalLength();
    if (m === null || !(total > 0)) continue;
    const steps = Math.min(MAX_STEPS, Math.max(64, Math.ceil(total / 2)));
    // Page pixels per sample. getScreenCTM's scale is folded in, so this is the
    // step in the frame the distances are reported in and not in user space.
    const scale = Math.hypot(m.a, m.b);
    const stepPx = (total / steps) * scale;
    let best = Infinity;
    for (let i = 0; i <= steps; i++) {
      const q = p.getPointAtLength((total * i) / steps);
      const d = Math.hypot(
        m.a * q.x + m.c * q.y + m.e - cx,
        m.b * q.x + m.d * q.y + m.f - cy,
      );
      if (d < best) best = d;
    }
    if (edgeId !== null && p.id === edgeId) {
      own = best;
      ownStep = stepPx;
    } else if (best < bestOther) {
      bestOther = best;
      bestOtherId = p.id;
      bestOtherStep = stepPx;
    }
  }
  // Rounded to the tenth of a pixel. The raw double carries seventeen
  // significant digits for a number whose real precision is half a sample step,
  // and printing that invites a ruling the measurement cannot support.
  const round = (n: number | null): number | null =>
    n === null ? null : Math.round(n * 10) / 10;
  return {
    matches,
    measurement: {
      testId: chip.getAttribute("data-testid"),
      edgeId,
      ownPathDistance: round(own),
      nearestOtherPathDistance: bestOtherId === null ? null : round(bestOther),
      nearestOtherEdgeId: bestOtherId,
      ownSampleStepPx: round(ownStep),
      nearestOtherSampleStepPx: round(bestOtherStep),
    },
  };
}

export type StyleProbe = {
  value: string;
  // "value"                  the property is set and this is it
  // "unset-custom-property"  a `--x` the element does not carry
  // "unset"                  a standard property that computed to nothing
  // "unknown-property"       the engine does not know this name; almost always
  //                          a typo, which getPropertyValue reports the same
  //                          way as a genuinely unset property
  status: "value" | "unset-custom-property" | "unset" | "unknown-property";
};

function readComputedStyle(spec: {
  selector: string;
  props: string[];
}): Record<string, StyleProbe> | null {
  const el = document.querySelector(spec.selector);
  if (el === null) return null;
  const cs = getComputedStyle(el);
  const out: Record<string, StyleProbe> = {};
  // getPropertyValue takes the CSS property name, so a custom property
  // (--edge-base-width) and a standard one are read the same way. It also
  // returns "" for both a misspelled standard property and an unset custom one,
  // so the two are separated here: CSS.supports knows the engine's property
  // names, and a checker that mistypes one must not read the empty answer as
  // "the app does not set it".
  for (const prop of spec.props) {
    const value = cs.getPropertyValue(prop);
    if (value !== "") {
      out[prop] = { value, status: "value" };
      continue;
    }
    if (prop.startsWith("--")) {
      out[prop] = { value, status: "unset-custom-property" };
      continue;
    }
    let known = false;
    try {
      known = CSS.supports(`${prop}: initial`);
    } catch {
      known = false;
    }
    out[prop] = { value, status: known ? "unset" : "unknown-property" };
  }
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

type HoverSampleResult = {
  at: string;
  x: number;
  y: number;
  usable: boolean;
  // The canvas-wide flag: something is hovered, not necessarily the target.
  hoverActive: boolean;
  hit: HoverSampleRead["hit"];
  // The target engaged at this point.
  engaged: boolean;
  reason?: string;
};

type HoverResult = {
  // True only when the element the caller asked about is the one that engaged.
  hoverEngaged: boolean;
  // Set when hover engaged but on something else, which is the case a bare
  // hoverEngaged would have reported as a working hover on the target.
  engagedElsewhere: HoverSampleRead["hit"] | null;
  // The target sits in the dim set: the app never dims what it lit, so this is
  // standing proof that a different element is the lit one.
  targetDimmed: boolean;
  pointsTried: number;
  samples: HoverSampleResult[];
  observedDimmed: string[];
  // Which element the reported dim set belongs to. Equal to the target when the
  // target engaged; otherwise the dim set describes whatever the last usable
  // sample landed on, and reading it as the target's would be the same mistake
  // one layer down.
  dimSetOwner: HoverSampleRead["hit"] | null;
  expectedDimmed: string[];
  decision: HoverDecision;
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

  const target = { kind, id };
  const samples: HoverSampleResult[] = [];
  let pointsTried = 0;
  let winner: HoverSampleRead | null = null;
  let last: HoverSampleRead | null = null;
  let elsewhere: HoverSampleRead["hit"] | null = null;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!usable[i]) {
      samples.push({ ...p, usable: false, hoverActive: false, hit: null, engaged: false });
      continue;
    }
    pointsTried++;
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(HOVER_SETTLE_MS);
    const read = await page.evaluate(readHoverAt, { x: p.x, y: p.y });
    last = read;
    const verdict = judgeHoverSample(target, read);
    samples.push({
      ...p,
      usable: true,
      hoverActive: read.hoverActive,
      hit: read.hit,
      engaged: verdict.engaged,
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    });
    if (verdict.engaged) {
      winner = read;
      break;
    }
    // Kept only when something else DID take the pointer. Every remaining point
    // is still tried: a midpoint stolen by a co-routed sibling says nothing
    // about the quarter points, which is the whole reason there are five.
    if (read.hoverActive && read.hit !== null) elsewhere = read.hit;
  }

  const state = winner ?? last;
  const observedDimmed = state?.dimmed ?? [];
  return {
    hoverEngaged: winner !== null,
    engagedElsewhere: winner === null ? elsewhere : null,
    targetDimmed: observedDimmed.includes(id),
    pointsTried,
    samples,
    observedDimmed,
    dimSetOwner: state?.hit ?? null,
    expectedDimmed: expected,
    decision: hoverDecision(observedDimmed, expected),
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
      const read = await page.evaluate(readColors, {
        selector: args.selector!,
        limit: MAX_OVERLAPPING_COLLECTED,
      });
      if (!read.found) throw new Error(`no element matches ${args.selector!}`);
      const measured = measureContrast(read);
      if (measured === null) {
        throw new Error(`could not read a paint colour from ${args.selector!}`);
      }
      if (measured.unreadableBackdrops.length > 0) {
        throw new Error(
          `${args.selector!} overlaps a surface whose colour could not be parsed ` +
            `(${measured.unreadableBackdrops.join("; ")}); ` +
            `it could be the one the element is illegible against, so no ratio is reported`,
        );
      }
      return measured;
    }
    case "delta-e": {
      const reads = await Promise.all([
        page.evaluate(readColors, {
          selector: args.a!,
          limit: MAX_OVERLAPPING_COLLECTED,
        }),
        page.evaluate(readColors, {
          selector: args.b!,
          limit: MAX_OVERLAPPING_COLLECTED,
        }),
      ]);
      const sides = reads.map((read, i) => {
        const selector = i === 0 ? args.a! : args.b!;
        if (!read.found) throw new Error(`no element matches ${selector}`);
        const side = paintSide(read);
        if (side === null) {
          throw new Error(`could not read a paint colour from ${selector}`);
        }
        // A translucent paint takes on whatever is behind it, and what is behind
        // it here is not the ancestor chain. Two colours composited against the
        // wrong backdrop can be reported as well separated while they read as
        // the same hue on screen, so the op declines instead.
        if (side.backdropSensitive) {
          throw new Error(
            `${selector} paints at alpha ${side.alpha} over ${side.overlappingCount} ` +
              `overlapping surface(s) that are not its ancestors, so its on-screen colour ` +
              `depends on which one it crosses; measure it where nothing overlaps it`,
          );
        }
        return side;
      });
      const a = sides[0]!;
      const b = sides[1]!;
      return {
        deltaE76: deltaE76(
          srgbToLab(parseCssColor(a.color)!),
          srgbToLab(parseCssColor(b.color)!),
        ),
        a,
        b,
      };
    }
    case "chip-binding": {
      const binding = await page.evaluate(chipBinding, args.id!);
      if (binding.matches.length === 0) {
        throw new Error(`no chip "${args.id!}" on the canvas`);
      }
      if (binding.measurement === null) {
        const ids = binding.matches
          .map((m) => m.testId ?? "(no data-testid)")
          .join(", ");
        throw new Error(
          `"${args.id!}" resolves to ${binding.matches.length} chips (${ids}); ` +
            `pass one of those testids to --arg id so the measurement names the chip it made`,
        );
      }
      return binding.measurement;
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
      return {
        properties: styles,
        // Hoisted out of the per-property records so a mistyped property name is
        // visible at a glance rather than only to a reader who checks `status`
        // on every entry.
        unknownProperties: Object.entries(styles)
          .filter(([, probe]) => probe.status === "unknown-property")
          .map(([prop]) => prop),
      };
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

// page.evaluate has no per-call timeout, so every budget in this file is imposed
// here. The timer is cleared on the winning path so a bounded call that returned
// promptly does not hold the event loop open for its whole budget.
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runEval(page: Page, file: string): Promise<EvalPayload> {
  const source = await readFile(file, "utf8");
  const expression = evalExpression(source);
  const value = await withTimeout(
    page.evaluate<unknown>(expression),
    EVAL_TIMEOUT_MS,
    "--eval",
  );
  return evalPayload(value);
}

async function probe(
  browser: Browser,
  opts: ProbeOptions,
): Promise<{ result: ProbeResult; code: number }> {
  let page: Page;
  let consoleErrors: string[];
  try {
    ({ page, consoleErrors } = await bootPage(browser, opts));
  } catch (err: unknown) {
    return {
      result: {
        ok: false,
        transform: null,
        consoleErrors: [],
        error: `never reached READY at ${examUrl(opts.baseUrl, opts.hash)}: ${String(err)}`,
      },
      code: 3,
    };
  }

  const hookPresent = await page.evaluate(
    () => window.__stcExam !== undefined,
  );
  if (!hookPresent) {
    return {
      result: {
        ok: false,
        transform: null,
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
      window.__stcExam!.setViewport(v);
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

  // Bounded, and bounded for the same reason --eval is. A hung expression pins
  // the renderer's main thread, so this read queues behind it forever; without a
  // budget the run would never return, the browser would never close, and the
  // error explaining the hang would never be printed. An unbounded tail turns a
  // diagnosed failure back into a silent one.
  let transform: ProbeResult["transform"] = null;
  try {
    transform = (
      await withTimeout(
        page.evaluate(collectScene),
        TAIL_TIMEOUT_MS,
        "reading the closing transform",
      )
    ).transform;
  } catch (err: unknown) {
    const message = `transform: ${err instanceof Error ? err.message : String(err)}`;
    // Appended, never overwritten: when an op or an evaluation already failed,
    // that failure is the cause and this is its symptom.
    error = error === undefined ? message : `${error}; ${message}`;
  }

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

  const browser = await chromium.launch();
  let outcome: { result: ProbeResult; code: number };
  try {
    outcome = await probe(browser, parsed);
  } catch (err: unknown) {
    // A fatal still prints the contract shape. A caller parsing stdout gets an
    // object with the reason in it either way, and a bare stderr line would make
    // "the harness crashed" look identical to "the process was killed".
    outcome = {
      result: {
        ok: false,
        transform: null,
        consoleErrors: [],
        error: `fatal: ${err instanceof Error ? err.message : String(err)}`,
      },
      code: 1,
    };
  }

  // Printed BEFORE the browser is closed. Closing a browser whose renderer is
  // still spinning on a hung expression is the one step left that could stall,
  // and the caller's answer must not be behind it.
  console.log(JSON.stringify(outcome.result, null, 2));
  // Closed BEFORE the process exits, not in a finally around the exit:
  // process.exit skips finally blocks, and the launched Chromium would outlive
  // the run. Bounded, because that is exactly the case being defended against.
  try {
    await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, "closing the browser");
  } catch (err: unknown) {
    console.error(`warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(outcome.code);
}
