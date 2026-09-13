import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EnvironmentId } from "@aef/schema";
import {
  ENV_CAP_WIDTH,
  ENV_ROW_HEIGHT,
  envBannerLayers,
  type EnvBannerLayer,
} from "./envBanner";

// The two plate colours the tokens carry, so the suite exercises the real
// parameter values rather than one arbitrary hue.
const PLATE_COLORS: Record<EnvironmentId, string> = {
  stable: "#36c0fc",
  acidic: "#ffbe04",
};

const ENVIRONMENTS = ["stable", "acidic"] as const;

// Every layer the interface emits for one environment: three top-plate
// layers (glyph plus two caps) and two bottom-plate caps.
function allLayers(environment: EnvironmentId): EnvBannerLayer[] {
  const layers = envBannerLayers(environment, PLATE_COLORS[environment]);
  return [
    layers.top.glyph,
    layers.top.leftCap,
    layers.top.rightCap,
    layers.bottom.leftCap,
    layers.bottom.rightCap,
  ];
}

// Parse an SVG string as XML and return its root, failing the test on any
// parser error so a malformed template cannot pass as "well-formed".
function svgRoot(svg: string): Element {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0);
  expect(doc.documentElement.tagName).toBe("svg");
  return doc.documentElement;
}

describe("envBanner", () => {
  test("native row height and cap width constants", () => {
    expect(ENV_ROW_HEIGHT).toBe(18);
    expect(ENV_CAP_WIDTH).toBe(72);
  });

  test("every emitted SVG is well-formed XML rooted at svg, per environment", () => {
    for (const environment of ENVIRONMENTS) {
      const layers = allLayers(environment);
      expect(layers).toHaveLength(5);
      for (const layer of layers) {
        const root = svgRoot(layer.svg);
        expect(root.namespaceURI).toBe("http://www.w3.org/2000/svg");
      }
    }
  });

  test("the stable glyph path carries fill-rule evenodd", () => {
    const { top } = envBannerLayers("stable", PLATE_COLORS.stable);
    const paths = [...svgRoot(top.glyph.svg).getElementsByTagName("path")];
    // Two paths: triangles plus notches under evenodd, then the square dots.
    expect(paths).toHaveLength(2);
    const evenodd = paths.filter(
      (path) => path.getAttribute("fill-rule") === "evenodd",
    );
    expect(evenodd).toHaveLength(1);
    expect(evenodd[0]!.getAttribute("d")).toContain("ZM");
  });

  test("the acidic glyph contains four teardrop subpaths", () => {
    const { top } = envBannerLayers("acidic", PLATE_COLORS.acidic);
    const paths = [...svgRoot(top.glyph.svg).getElementsByTagName("path")];
    // The measured teardrop: a radius-12 circle plus two tangents, tip
    // up-right. Each drop is its own path, translated onto a 30-unit grid.
    const TEARDROP_D = "M29 0L23.5 19.3A12 12 0 1 1 9.5 4.3Z";
    expect(paths).toHaveLength(4);
    for (const path of paths) {
      expect(path.getAttribute("d")).toBe(TEARDROP_D);
    }
    const offsets = paths
      .map((path) => path.getAttribute("transform")?.match(/^translate\(/))
      .filter(Boolean);
    expect(offsets).toHaveLength(4);
  });

  test("cap and glyph viewBoxes are pinned", () => {
    for (const environment of ENVIRONMENTS) {
      const layers = envBannerLayers(environment, PLATE_COLORS[environment]);
      // Two-row caps on the top plate, single-row on the bottom.
      expect(svgRoot(layers.top.leftCap.svg).getAttribute("viewBox")).toBe(
        "0 0 72 36",
      );
      expect(svgRoot(layers.top.rightCap.svg).getAttribute("viewBox")).toBe(
        "0 0 72 36",
      );
      expect(svgRoot(layers.bottom.leftCap.svg).getAttribute("viewBox")).toBe(
        "0 0 72 18",
      );
      expect(svgRoot(layers.bottom.rightCap.svg).getAttribute("viewBox")).toBe(
        "0 0 72 18",
      );
    }
    const stable = envBannerLayers("stable", PLATE_COLORS.stable);
    const acidic = envBannerLayers("acidic", PLATE_COLORS.acidic);
    expect(svgRoot(stable.top.glyph.svg).getAttribute("viewBox")).toBe(
      "0 0 58 51",
    );
    expect(svgRoot(acidic.top.glyph.svg).getAttribute("viewBox")).toBe(
      "0 0 59 59",
    );
  });

  test("every layer also ships as a single-quoted CSS url data URI of its svg", () => {
    const PREFIX = "url('data:image/svg+xml;utf8,";
    for (const environment of ENVIRONMENTS) {
      for (const layer of allLayers(environment)) {
        expect(layer.uri.startsWith(PREFIX)).toBe(true);
        expect(layer.uri.endsWith("')")).toBe(true);
        const encoded = layer.uri.slice(PREFIX.length, -"')".length);
        expect(decodeURIComponent(encoded)).toBe(layer.svg);
      }
    }
  });

  test("the plate colour is a parameter, never a module hue", () => {
    const warm = envBannerLayers("stable", "#123456");
    const cool = envBannerLayers("stable", "#00aa00");
    // Caps carry the caller's colour; different colours give different SVGs.
    expect(warm.top.leftCap.svg).toContain('<g fill="#123456">');
    expect(cool.top.leftCap.svg).toContain('<g fill="#00aa00">');
    expect(warm.bottom.rightCap.svg).not.toBe(cool.bottom.rightCap.svg);
    // Glyphs are ink-only, so they do not vary with the plate colour.
    expect(warm.top.glyph.svg).toBe(cool.top.glyph.svg);
    expect(warm.top.glyph.svg).toContain("#0f1216");
    expect(warm.top.glyph.svg).not.toContain("#123456");
  });

  test("the only colour literal in the module is the ink constant", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/canvas/envBanner.ts"),
      "utf8",
    )
      // Prose goes first so a colour merely NAMED in a comment cannot stand
      // in for the declaration.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const literals = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals).toEqual(["#0f1216"]);
  });
});
