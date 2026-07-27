import { describe, expect, test } from "vitest";
import {
  contrastRatio,
  deltaE76,
  evalExpression,
  evalPayload,
  expectedDimmed,
  flattenBackdrop,
  paintColor,
  parseArgs,
  parseCssColor,
  relativeLuminance,
  resolveEndpoints,
  srgbToLab,
  usableSamples,
  type ColorRead,
  type HoverGraph,
} from "./probe";

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
    ).toEqual({ r: 15, g: 17, b: 20, a: 1 });
  });

  // Paint order runs root-outward, so a nearer translucent layer sits ON TOP of
  // a farther opaque one. Folding the other way would report the backdrop as
  // the far colour and mis-state every ratio measured through a scrim.
  test("composites a translucent layer over the opaque one below it", () => {
    const flat = flattenBackdrop(["rgba(255, 255, 255, 0.5)", "rgb(0, 0, 0)"]);
    expect(flat.r).toBeCloseTo(127.5, 5);
    expect(flat.a).toBe(1);
  });

  test("falls back to white when nothing is opaque", () => {
    expect(flattenBackdrop(["rgba(0, 0, 0, 0)"])).toEqual({
      r: 255,
      g: 255,
      b: 255,
      a: 1,
    });
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
  });

  test("is symmetric", () => {
    const a = { r: 124, g: 223, b: 252 };
    const b = { r: 15, g: 17, b: 20 };
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 12);
  });
});

describe("paintColor", () => {
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
    ...over,
  });

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

describe("srgbToLab / deltaE76", () => {
  test("puts white and black at the L ends", () => {
    expect(srgbToLab({ r: 255, g: 255, b: 255 }).L).toBeCloseTo(100, 4);
    expect(srgbToLab({ r: 0, g: 0, b: 0 }).L).toBeCloseTo(0, 6);
  });

  test("scores an identical pair at zero", () => {
    const lab = srgbToLab({ r: 124, g: 223, b: 252 });
    expect(deltaE76(lab, lab)).toBe(0);
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
