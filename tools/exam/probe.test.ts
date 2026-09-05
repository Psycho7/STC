import { describe, expect, test } from "vitest";
import {
  contrastRatio,
  deltaE76,
  evalExpression,
  evalPayload,
  expectedDimmed,
  flattenBackdrop,
  hoverDecision,
  judgeHoverSample,
  measureContrast,
  paintColor,
  paintSide,
  parseArgs,
  parseCssColor,
  relativeLuminance,
  resolveEndpoints,
  srgbToLab,
  usableSamples,
  type ColorRead,
  type HoverGraph,
  type HoverSampleRead,
} from "./probe-analysis";

const BASE = ["--base-url", "http://localhost:4174", "--hash", "p=1"];

function ok(argv: string[]) {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

describe("parseArgs", () => {
  test("defaults the locale and leaves the camera unset", () => {
    const opts = ok(BASE);
    expect(opts.locale).toBe("en");
    expect(opts.zoom).toBeNull();
    expect(opts.center).toBeNull();
    expect(opts.op).toBeNull();
  });

  // A selector argument routinely carries `=` inside an attribute predicate, so
  // splitting on every one would hand the op half a selector.
  test("splits --arg at the first equals only", () => {
    const opts = ok([
      ...BASE,
      "--op",
      "contrast",
      "--arg",
      'selector=.react-flow__edge[data-id="a=b"] path',
    ]);
    expect(opts.args.selector).toBe('.react-flow__edge[data-id="a=b"] path');
  });

  test("rejects a camera given only half", () => {
    expect(parseArgs([...BASE, "--zoom", "0.75"])).toMatch(
      /--zoom and --center must be given together/,
    );
    expect(parseArgs([...BASE, "--center", "10,20"])).toMatch(
      /--zoom and --center must be given together/,
    );
  });

  test("parses a camera", () => {
    const opts = ok([...BASE, "--zoom", "0.75", "--center", "10,-20.5"]);
    expect(opts.zoom).toBe(0.75);
    expect(opts.center).toEqual({ x: 10, y: -20.5 });
  });

  test("rejects a malformed centre", () => {
    expect(parseArgs([...BASE, "--zoom", "1", "--center", "10"])).toMatch(
      /--center must be/,
    );
  });

  // Number("") is 0 and finite, so a half-written centre would otherwise frame
  // the camera at a y the caller never typed and the output would report it as
  // a commanded camera.
  test("rejects a centre with a missing half", () => {
    expect(parseArgs([...BASE, "--zoom", "1", "--center", "10,"])).toMatch(
      /--center must be/,
    );
    expect(parseArgs([...BASE, "--zoom", "1", "--center", ",20"])).toMatch(
      /--center must be/,
    );
    expect(parseArgs([...BASE, "--zoom", "1", "--center", " , "])).toMatch(
      /--center must be/,
    );
  });

  test("rejects an unknown op and names the known ones", () => {
    const err = parseArgs([...BASE, "--op", "hover"]);
    expect(err).toMatch(/unknown op "hover"/);
    expect(err).toMatch(/hover-edge/);
  });

  test("rejects an op missing a required arg", () => {
    expect(parseArgs([...BASE, "--op", "delta-e", "--arg", "a=.x"])).toMatch(
      /op delta-e requires --arg b=/,
    );
  });

  test("rejects --arg with no op", () => {
    expect(parseArgs([...BASE, "--arg", "id=e1"])).toMatch(
      /--arg is only meaningful with --op/,
    );
  });

  test("requires the base url and the hash", () => {
    expect(parseArgs(["--hash", "p=1"])).toMatch(/--base-url is required/);
    expect(parseArgs(["--base-url", "http://x"])).toMatch(/--hash is required/);
  });

  test("rejects an unknown flag", () => {
    expect(parseArgs([...BASE, "--out", "x"])).toMatch(/unknown argument "--out"/);
  });
});

describe("parseCssColor", () => {
  test("reads what getComputedStyle serialises", () => {
    expect(parseCssColor("rgb(15, 17, 20)")).toEqual({ r: 15, g: 17, b: 20, a: 1 });
    expect(parseCssColor("rgba(255, 0, 0, 0.5)")).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 0.5,
    });
    expect(parseCssColor("rgb(255 0 0 / 25%)")).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 0.25,
    });
  });

  test("reads hex", () => {
    expect(parseCssColor("#0f1114")).toEqual({ r: 15, g: 17, b: 20, a: 1 });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  // The failure this guards: treating an unpainted stroke as black would invent
  // a foreground and report a contrast ratio for something that is not there.
  test("treats none and transparent as fully transparent, not black", () => {
    expect(parseCssColor("none")?.a).toBe(0);
    expect(parseCssColor("transparent")?.a).toBe(0);
  });

  test("returns null for something it cannot read", () => {
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
  });
});

describe("flattenBackdrop", () => {
  test("takes the nearest opaque ancestor", () => {
    expect(
      flattenBackdrop([
        "rgba(0, 0, 0, 0)",
        "rgb(15, 17, 20)",
        "rgb(255, 255, 255)",
      ]),
    ).toEqual({ color: { r: 15, g: 17, b: 20, a: 1 }, whiteFallback: false });
  });

  // Paint order runs root-outward, so a nearer translucent layer sits ON TOP of
  // a farther opaque one. Folding the other way would report the backdrop as
  // the far colour and mis-state every ratio measured through a scrim.
  test("composites a translucent layer over the opaque one below it", () => {
    const flat = flattenBackdrop(["rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)"]);
    expect(flat.color.r).toBeCloseTo(127.5, 5);
    expect(flat.color.a).toBe(1);
    expect(flat.whiteFallback).toBe(false);
  });

  // White is exactly the fallback that flatters a dark stroke, so a measurement
  // standing on it has to say so rather than leave the caller to infer it from
  // an all-255 `bg`.
  test("flags the white fallback when nothing in the chain is opaque", () => {
    expect(flattenBackdrop(["rgba(0, 0, 0, 0)"])).toEqual({
      color: { r: 255, g: 255, b: 255, a: 1 },
      whiteFallback: true,
    });
    // Partly covered still counts: the white shows through the gap.
    expect(flattenBackdrop(["rgba(0, 0, 0, 0.5)"]).whiteFallback).toBe(true);
  });
});

describe("contrastRatio", () => {
  test("matches the WCAG anchors", () => {
    const white = { r: 255, g: 255, b: 255 };
    const black = { r: 0, g: 0, b: 0 };
    expect(relativeLuminance(white)).toBeCloseTo(1, 10);
    expect(relativeLuminance(black)).toBeCloseTo(0, 10);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 6);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 10);
    // #777 on white is the published 4.48:1 borderline, which pins the transfer
    // function and the 0.05 offset rather than only the two endpoints.
    expect(contrastRatio({ r: 119, g: 119, b: 119 }, white)).toBeCloseTo(4.48, 2);
  });
});

const svg = (over: Partial<ColorRead>): ColorRead => ({
  found: true,
  isSvg: true,
  color: "rgb(255, 255, 255)",
  stroke: "none",
  fill: "none",
  opacity: "1",
  strokeOpacity: "1",
  fillOpacity: "1",
  bgStack: ["rgba(0, 0, 0, 0)", "rgb(15, 17, 20)"],
  backgroundImageAncestors: [],
  overlapping: [],
  overlappingCount: 0,
  ...over,
});

describe("paintColor", () => {

  // Every edge in the app is a stroked path with fill `none`, and the canvas
  // background is the backdrop the item palette holds its 4.5:1 floor against.
  test("takes an SVG stroke over the canvas background", () => {
    const paint = paintColor(svg({ stroke: "rgb(124, 223, 252)" }))!;
    expect(paint.fg).toEqual({ r: 124, g: 223, b: 252, a: 1 });
    expect(paint.bg).toEqual({ r: 15, g: 17, b: 20, a: 1 });
    expect(contrastRatio(paint.fg, paint.bg)).toBeGreaterThan(4.5);
  });

  test("falls back to the fill when there is no stroke", () => {
    const paint = paintColor(svg({ fill: "rgb(200, 100, 50)" }))!;
    expect(paint.fg).toEqual({ r: 200, g: 100, b: 50, a: 1 });
  });

  // A half-transparent stroke reads as half-way to the backdrop, so the ratio
  // must be computed from what is on screen rather than from the declared hue.
  test("folds stroke-opacity into the foreground", () => {
    const paint = paintColor(
      svg({ stroke: "rgb(255, 255, 255)", strokeOpacity: "0.5" }),
    )!;
    expect(paint.fg.r).toBeCloseTo((255 + 15) / 2, 5);
  });

  test("uses color for an HTML element", () => {
    const paint = paintColor(
      svg({ isSvg: false, color: "rgb(10, 20, 30)", stroke: "rgb(1, 2, 3)" }),
    )!;
    expect(paint.fg).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });
});

describe("measureContrast", () => {
  // The defect this op exists to catch: an edge stroke crossing an opaque node
  // card is NOT painted on the canvas background, and the ancestor walk cannot
  // see the card because a card is not an ancestor of the edge layer. Measuring
  // the ancestor chain alone reports a comfortable ratio for a stroke that is in
  // fact illegible where it crosses.
  test("measures a stroke against a card it crosses, not only its ancestors", () => {
    const measured = measureContrast(
      svg({
        stroke: "rgb(40, 44, 52)",
        overlapping: [
          {
            description: "div.recipe-node[data-id=n1]",
            color: "rgb(31, 33, 37)",
            overlapFraction: 0.4,
          },
        ],
        overlappingCount: 1,
      }),
    )!;
    // Against the near-black canvas the dark stroke still clears a bit; against
    // the card it is almost the same colour.
    expect(measured.ancestorRatio).toBeGreaterThan(measured.worstRatio);
    expect(measured.worstRatio).toBeLessThan(1.2);
    expect(measured.worstBackdrop).toBe("div.recipe-node[data-id=n1]");
    expect(measured.minOverlapForWorst).toBe(0.05);
    expect(measured.backdrops.map((b) => b.source)).toEqual([
      "ancestors",
      "div.recipe-node[data-id=n1]",
    ]);
    expect(measured.overlappingCount).toBe(1);
  });

  // A tinted band is not opaque, so what sits behind the stroke there is the
  // band composited onto the canvas rather than the band's declared colour.
  test("composites a translucent surface onto the ancestor backdrop", () => {
    const measured = measureContrast(
      svg({
        stroke: "rgb(255, 255, 255)",
        overlapping: [
          {
            description: "div.bus-band",
            color: "rgba(255, 255, 255, 0.5)",
            overlapFraction: 1,
          },
        ],
        overlappingCount: 1,
      }),
    )!;
    const band = measured.backdrops.find((b) => b.source === "div.bus-band")!;
    // 50% white over rgb(15, 17, 20) lands halfway, not at pure white.
    expect(band.color).toBe("rgb(135, 136, 138)");
  });

  // Nothing to composite against means the number stands on white, which is the
  // fallback that makes any dark stroke look excellent.
  test("surfaces the white fallback as its own flag", () => {
    const measured = measureContrast(
      svg({ stroke: "rgb(20, 20, 20)", bgStack: ["rgba(0, 0, 0, 0)"] }),
    )!;
    expect(measured.whiteFallback).toBe(true);
    expect(measured.ancestorBackdrop).toBe("rgb(255, 255, 255)");
  });

  // An overlapping surface whose colour cannot be parsed could be the one the
  // element is illegible against. Dropping it would leave a worstRatio that
  // silently excluded the worst case, so it is named for the caller to refuse on.
  test("names an overlapping surface whose colour it cannot parse", () => {
    const measured = measureContrast(
      svg({
        stroke: "rgb(255, 255, 255)",
        overlapping: [
          {
            description: "div.recipe-node",
            color: "color(display-p3 1 0 0)",
            overlapFraction: 1,
          },
        ],
        overlappingCount: 1,
      }),
    )!;
    expect(measured.unreadableBackdrops).toEqual([
      "div.recipe-node (color(display-p3 1 0 0))",
    ]);
  });

  // Bounding boxes are rectangles and strokes are not, so a box that clips a
  // corner of a card reports an overlap the eye never sees. Left in the headline
  // it would make every edge on the canvas read as a 1:1 contrast defect, and a
  // headline that is always alarming is one the caller learns to skip.
  test("keeps a sliver out of the headline but not out of the output", () => {
    const measured = measureContrast(
      svg({
        stroke: "rgb(255, 255, 255)",
        overlapping: [
          {
            description: "span.chip-text",
            color: "rgb(255, 255, 255)",
            overlapFraction: 0.0014,
          },
        ],
        overlappingCount: 1,
      }),
    )!;
    expect(measured.worstBackdrop).toBe("ancestors");
    expect(measured.worstRatio).toBeCloseTo(measured.ancestorRatio, 10);
    expect(measured.worstBackdropAnyOverlap).toBe("span.chip-text");
    expect(measured.worstRatioAnyOverlap).toBeCloseTo(1, 6);
    expect(measured.backdrops.map((b) => b.source)).toContain("span.chip-text");
  });

  // A gradient computes its background-color to transparent, so the ancestor
  // fold walks straight past it onto whatever opaque colour lies further up. The
  // chip boxes on this canvas are gradients, so the measured backdrop is not the
  // one the eye sees and only this list says so.
  test("names ancestors that paint a background image", () => {
    const measured = measureContrast(
      svg({ isSvg: false, backgroundImageAncestors: ["div.flow-chip"] }),
    )!;
    expect(measured.backgroundImageAncestors).toEqual(["div.flow-chip"]);
  });

  test("returns null when the element paints nothing readable", () => {
    expect(measureContrast(svg({ color: "color(display-p3 1 0 0)" }))).toBeNull();
  });
});

describe("paintSide", () => {
  // An opaque stroke's on-screen colour does not depend on what is behind it, so
  // a delta-E between two of them is a backdrop-free number however much they
  // overlap.
  test("calls an opaque paint backdrop-insensitive however much overlaps it", () => {
    const side = paintSide(
      svg({
        stroke: "rgb(124, 223, 252)",
        overlapping: [
          { description: "div.recipe-node", color: "rgb(31, 33, 37)", overlapFraction: 1 },
        ],
        overlappingCount: 1,
      }),
    )!;
    expect(side.alpha).toBe(1);
    expect(side.backdropSensitive).toBe(false);
    expect(side.color).toBe("rgb(124, 223, 252)");
  });

  // A translucent one takes on whatever it crosses, so the colour reported
  // against the ancestor chain is not the colour on screen.
  test("flags a translucent paint that overlaps a non-ancestor", () => {
    const side = paintSide(
      svg({
        stroke: "rgb(255, 255, 255)",
        strokeOpacity: "0.5",
        overlapping: [
          { description: "div.recipe-node", color: "rgb(31, 33, 37)", overlapFraction: 1 },
        ],
        overlappingCount: 1,
      }),
    )!;
    expect(side.alpha).toBe(0.5);
    expect(side.backdropSensitive).toBe(true);
  });

  test("leaves a translucent paint with nothing over it measurable", () => {
    const side = paintSide(svg({ stroke: "rgb(255, 255, 255)", strokeOpacity: "0.5" }))!;
    expect(side.backdropSensitive).toBe(false);
  });
});

describe("srgbToLab / deltaE76", () => {
  test("puts white and black at the L ends", () => {
    expect(srgbToLab({ r: 255, g: 255, b: 255 }).L).toBeCloseTo(100, 4);
    expect(srgbToLab({ r: 0, g: 0, b: 0 }).L).toBeCloseTo(0, 6);
    // Mid grey sits at L 53.59, not 50: the transfer function is not linear, and
    // an implementation that skipped it would land near the midpoint.
    expect(srgbToLab({ r: 128, g: 128, b: 128 }).L).toBeCloseTo(53.59, 2);
  });

  // The reference point the edge-palette separation work is stated in: two
  // colours a reviewer called confusable scored around 3, the fixed pair above
  // 7. The op has to reproduce that scale, not merely be monotone.
  test("scores a near pair below a distant one", () => {
    const near = deltaE76(
      srgbToLab({ r: 120, g: 120, b: 120 }),
      srgbToLab({ r: 124, g: 124, b: 124 }),
    );
    const far = deltaE76(
      srgbToLab({ r: 124, g: 223, b: 252 }),
      srgbToLab({ r: 232, g: 120, b: 40 }),
    );
    expect(near).toBeLessThan(3);
    expect(far).toBeGreaterThan(40);
  });
});

describe("resolveEndpoints", () => {
  const ids = new Set(["u:in:copper", "u:out:copper", "a to b", "c"]);

  test("reads React Flow's default edge label", () => {
    expect(resolveEndpoints("Edge from u:in:copper to u:out:copper", ids)).toEqual([
      "u:in:copper",
      "u:out:copper",
    ]);
  });

  // Splitting on the first " to " would name a node that does not exist; the
  // split is resolved against the ids the DOM actually rendered.
  test("splits where both halves are real node ids", () => {
    expect(resolveEndpoints("Edge from a to b to c", ids)).toEqual(["a to b", "c"]);
  });

  test("returns null when the label is not the default one", () => {
    expect(resolveEndpoints("copper 30/min", ids)).toBeNull();
    expect(resolveEndpoints("Edge from x to y", ids)).toBeNull();
  });
});

describe("expectedDimmed", () => {
  //   n1 --e1--> n2 --e2--> n3      n4 --e3--> n5      g (group container)
  const graph: HoverGraph = {
    nodes: [
      { id: "n1", type: "recipe" },
      { id: "n2", type: "recipe" },
      { id: "n3", type: "recipe" },
      { id: "n4", type: "recipe" },
      { id: "n5", type: "recipe" },
      { id: "g", type: "group" },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2" },
      { id: "e2", source: "n2", target: "n3" },
      { id: "e3", source: "n4", target: "n5" },
    ],
  };

  test("keeps the hovered edge's endpoints and their incident edges lit", () => {
    expect(expectedDimmed(graph, { kind: "edge", id: "e1" })).toEqual([
      "e3",
      "n3",
      "n4",
      "n5",
    ]);
  });

  test("keeps a hovered node's incident edges and their far endpoints lit", () => {
    expect(expectedDimmed(graph, { kind: "node", id: "n2" })).toEqual([
      "e3",
      "n4",
      "n5",
    ]);
  });

  // Canvas makes group boxes hover-inert and gives a container with a focused
  // child `lit-container` instead of `dimmed`. Counting them would put a known
  // non-defect in every expected set.
  test("leaves group containers out of the universe", () => {
    for (const id of ["e1", "e2", "e3"]) {
      expect(expectedDimmed(graph, { kind: "edge", id })).not.toContain("g");
    }
  });

  // The expectation is a LOWER bound: an ego-network that covers the whole graph
  // legitimately dims nothing, so an empty observed set is only a defect when
  // the expectation is non-empty.
  test("is empty when the ego-network covers the whole graph", () => {
    const line: HoverGraph = {
      nodes: [
        { id: "a", type: "recipe" },
        { id: "b", type: "recipe" },
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    };
    expect(expectedDimmed(line, { kind: "edge", id: "e" })).toEqual([]);
  });

  test("refuses an id that is not in the graph", () => {
    expect(() => expectedDimmed(graph, { kind: "edge", id: "e9" })).toThrow(
      /no edge "e9"/,
    );
    expect(() => expectedDimmed(graph, { kind: "node", id: "n9" })).toThrow(
      /no node "n9"/,
    );
  });
});

describe("judgeHoverSample", () => {
  const read = (over: Partial<HoverSampleRead>): HoverSampleRead => ({
    hoverActive: true,
    hit: { kind: "edge", id: "e1", topClass: "react-flow__edge-interaction" },
    dimmed: [],
    ...over,
  });

  test("engages when the pointer is on the element asked about", () => {
    expect(judgeHoverSample({ kind: "edge", id: "e1" }, read({}))).toEqual({
      engaged: true,
    });
  });

  // The failure this exists for: the app's hover flag lives on the canvas
  // container and is set by ANY hovered element. React Flow gives every edge a
  // 20px interaction stroke, so co-routed bus trunks overlap at the midpoint and
  // the topmost one takes the pointer. Reading the flag alone reports the edge
  // the caller asked about as responsive when a sibling answered.
  test("refuses an engagement that a co-routed sibling produced", () => {
    const verdict = judgeHoverSample(
      { kind: "edge", id: "e1" },
      read({ hit: { kind: "edge", id: "e2", topClass: "x" } }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/hover engaged, but the pointer was over edge "e2"/);
  });

  // A container's bounding-box centre is empty space over a CHILD node, and
  // containers are hover-inert by design, so "does this container respond?"
  // would come back true from the child that answered.
  test("refuses a container hover answered by the child under it", () => {
    const verdict = judgeHoverSample(
      { kind: "node", id: "group-1" },
      read({ hit: { kind: "node", id: "child-1", topClass: "recipe-node" } }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/pointer was over node "child-1"/);
  });

  // Chips re-enable pointer events so their exact-rate tooltip works, so a chip
  // sitting on the sample point takes the pointer and the edge never hovers.
  test("names a non-graph element that took the pointer", () => {
    const verdict = judgeHoverSample(
      { kind: "edge", id: "e1" },
      read({ hit: { kind: "other", id: null, topClass: "flow-chip nodrag" } }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/non-graph element \(flow-chip nodrag\)/);
  });

  // The disproof the op already holds: the app never dims what it lit, so a
  // dimmed target proves a different element is the lit one even when the DOM
  // hit test says otherwise.
  test("refuses when the target is in the dim set", () => {
    const verdict = judgeHoverSample(
      { kind: "edge", id: "e1" },
      read({ dimmed: ["e1", "n4"] }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/"e1" is in the dim set/);
  });

  test("reports a pointer on the target that never went hover-active", () => {
    const verdict = judgeHoverSample(
      { kind: "edge", id: "e1" },
      read({ hoverActive: false }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/never went hover-active/);
  });

  test("reports a sample that landed on nothing", () => {
    const verdict = judgeHoverSample(
      { kind: "edge", id: "e1" },
      read({ hoverActive: false, hit: null }),
    );
    expect(verdict.engaged).toBe(false);
    expect(verdict.reason).toMatch(/no hover, and the pointer was over nothing/);
  });
});

describe("hoverDecision", () => {
  // The only dim-set reading that is a defect on its own.
  test("calls an empty observed set against a non-empty expected one a defect", () => {
    const decision = hoverDecision([], ["n3", "n4"]);
    expect(decision.noResponse).toBe(true);
  });

  test("does not call an empty expected set a defect", () => {
    expect(hoverDecision([], []).noResponse).toBe(false);
  });

  // Expected and observed diverge in BOTH directions on bus edges, because the
  // app lights whole trunk groups while the expectation is the graph's
  // ego-network. A reader of stdout sees two long arrays that differ and needs
  // the rule stated to know that is not the finding.
  test("reports a set difference as a difference and not as a defect", () => {
    const decision = hoverDecision(["n1", "n9"], ["n1", "n2"]);
    expect(decision.differs).toBe(true);
    expect(decision.noResponse).toBe(false);
    expect(decision.rule).toMatch(/is NOT a defect/);
  });

  test("reports equal sets as not differing whatever their order", () => {
    expect(hoverDecision(["n2", "n1"], ["n1", "n2"]).differs).toBe(false);
  });
});

describe("usableSamples", () => {
  const pane = { x: 0, y: 60, width: 1920, height: 1020 };
  const point = (x: number, y: number) => ({ at: "len 0.5", x, y });

  test("accepts a point inside the pane", () => {
    expect(usableSamples([point(500, 500)], pane, [])).toEqual([true]);
  });

  test("rejects a point outside the pane", () => {
    expect(usableSamples([point(-10, 500), point(500, 10)], pane, [])).toEqual([
      false,
      false,
    ]);
  });

  // A point under the minimap hovers the minimap. Counting it as a failed
  // sample is how a working hover gets reported dead.
  test("rejects a point under a chrome overlay", () => {
    const minimap = { x: 1700, y: 800, width: 200, height: 150 };
    expect(usableSamples([point(1800, 920)], pane, [minimap])).toEqual([false]);
  });

  // Overlay rects arrive pane-relative and the points are in page coordinates:
  // comparing them in one frame would clear the wrong band of the screen.
  test("shifts overlays into the page frame", () => {
    // A pane that does not start at the page origin is the whole point: an
    // overlay at pane-relative (0, 0) covers page x 200..300, so the first
    // point is under it and the second is not. Comparing the two frames
    // directly would clear a band of screen that has no chrome on it.
    const offsetPane = { x: 200, y: 60, width: 1000, height: 900 };
    const controls = { x: 0, y: 0, width: 100, height: 100 };
    expect(
      usableSamples([point(250, 100), point(350, 100)], offsetPane, [controls]),
    ).toEqual([false, true]);
  });

  test("rejects a non-finite point", () => {
    expect(usableSamples([point(NaN, 500)], pane, [])).toEqual([false]);
  });
});

describe("evalExpression", () => {
  test("invokes a bare arrow function", () => {
    expect(evalExpression("() => 1 + 1")).toBe("(() => 1 + 1)()");
  });

  test("strips an export default and a trailing semicolon", () => {
    expect(evalExpression("export default () => document.title;\n")).toBe(
      "(() => document.title)()",
    );
  });
});

describe("evalPayload", () => {
  test("passes a small result through", () => {
    expect(evalPayload({ a: 1 })).toEqual({ truncated: false, value: { a: 1 } });
  });

  test("reports undefined as null rather than dropping the field", () => {
    expect(evalPayload(undefined)).toEqual({ truncated: false, value: null });
  });

  test("cuts an oversized result at the limit and says so", () => {
    const payload = evalPayload("x".repeat(50), 16);
    expect(payload.truncated).toBe(true);
    if (payload.truncated) expect(payload.json).toHaveLength(16);
  });

  test("keeps a result that lands exactly on the limit", () => {
    const value = "x".repeat(14);
    expect(evalPayload(value, 16)).toEqual({ truncated: false, value });
  });
});
