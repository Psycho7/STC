import type { EnvironmentId } from "@aef/schema";

// Vector reproduction of the game's gas-environment banner (the 292x72
// building-name plate, of which the banner occupies 260x36). Every
// coordinate below was measured off the game PNG's alpha masks and verified
// against the PNG at 6x, so the numbers are measured constants: do not
// re-derive or tidy them.
//
//   one row, left cap        one row, right cap
//   |\ |\___________        ___________/ /|
//   | \|          |    ...  |          |/ |    plus a faint two-column
//   |  |          |         |          |  |    "barcode" of ticks at the
//                                          outer end of each cap
//
// The stretched solid between the caps is CSS, not SVG: the caps are fixed
// ratio, the middle is `calc(100% - 2 * capWidth)`.

export const ENV_ROW_HEIGHT = 18;
export const ENV_CAP_WIDTH = 72;

const TOP_PLATE_ROWS = 2;
const BOTTOM_PLATE_ROWS = 1;

// The only colour the module owns: everything drawn in ink.
const INK = "#0f1216";

// The tick barcode beside each cap end: six faint two-column bars per row.
const TICK_BARS_PER_ROW = 6;
const TICK_INK_OPACITY = 0.28;

// One addressable plate layer: the bare SVG string, and the same image
// wrapped as a CSS url() data URI. The URI keeps single quotes inside
// url() so it can sit in an inline style attribute unescaped.
export interface EnvBannerLayer {
  svg: string;
  uri: string;
}

// The frame's two plates. The top plate is two rows tall and carries the
// environment glyph between the caps; the bottom plate is a single row
// without a glyph.
export interface EnvBannerLayers {
  top: {
    glyph: EnvBannerLayer;
    leftCap: EnvBannerLayer;
    rightCap: EnvBannerLayer;
  };
  bottom: {
    leftCap: EnvBannerLayer;
    rightCap: EnvBannerLayer;
  };
}

const svgUri = (svg: string): string =>
  `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;

const layer = (svg: string): EnvBannerLayer => ({ svg, uri: svgUri(svg) });

// One closed polygon as an SVG path.
const poly = (points: number[][]): string =>
  `<path d="M${points.map((p) => p.join(" ")).join("L")}Z"/>`;

// One banner row. The left cap opens with the two right triangles and
// closes with the strip's anchor edge (a parallelogram whose ends slope
// 1:1, the same slope as the triangles); the right cap mirrors it with two
// left-pointing triangles.
function rowShapes(y0: number, side: "left" | "right"): string {
  if (side === "left") {
    return (
      poly([
        [0, y0],
        [17, y0],
        [17, y0 + 17],
      ]) +
      poly([
        [18, y0],
        [35, y0],
        [35, y0 + 17],
      ]) +
      poly([
        [36, y0],
        [ENV_CAP_WIDTH, y0],
        [ENV_CAP_WIDTH, y0 + ENV_ROW_HEIGHT],
        [54, y0 + ENV_ROW_HEIGHT],
      ])
    );
  }

  return (
    poly([
      [0, y0],
      [18, y0],
      [36, y0 + ENV_ROW_HEIGHT],
      [0, y0 + ENV_ROW_HEIGHT],
    ]) +
    poly([
      [36, y0],
      [36, y0 + 17],
      [52, y0 + 17],
    ]) +
    poly([
      [54, y0],
      [54, y0 + 17],
      [70, y0 + 17],
    ])
  );
}

// Six faint bars in two columns beside one row. The x offset is the outer
// end of the cap: past the strip on the left cap, before the triangles on
// the right cap.
function tickShapes(x: number, y0: number): string {
  let bars = "";
  for (let i = 0; i < TICK_BARS_PER_ROW; i++) {
    const y = y0 + 2.5 + i * 2.2;
    bars += `<rect x="${x}" y="${y.toFixed(1)}" width="2.6" height="1.3"/>`;
    bars += `<rect x="${x + 4.2}" y="${y.toFixed(1)}" width="5" height="1.3"/>`;
  }
  return bars;
}

interface CapGeometry {
  shapes: string;
  ticks: string;
  height: number;
}

function capGeometry(side: "left" | "right", rows: number): CapGeometry {
  const rowStarts = Array.from({ length: rows }, (_, r) => r * ENV_ROW_HEIGHT);
  return {
    shapes: rowStarts.map((y) => rowShapes(y, side)).join(""),
    ticks: rowStarts
      .map((y) => tickShapes(side === "left" ? 60 : 2, y))
      .join(""),
    height: rows * ENV_ROW_HEIGHT,
  };
}

// All colour-free geometry is built once at module load; the plate colour
// only enters the wrapping <g fill> when a layer set is requested. The
// bottom-plate cap is the top-plate cap with the viewBox truncated to one
// row.
const CAP_GEOMETRY: Record<
  "top" | "bottom",
  Record<"left" | "right", CapGeometry>
> = {
  top: {
    left: capGeometry("left", TOP_PLATE_ROWS),
    right: capGeometry("right", TOP_PLATE_ROWS),
  },
  bottom: {
    left: capGeometry("left", BOTTOM_PLATE_ROWS),
    right: capGeometry("right", BOTTOM_PLATE_ROWS),
  },
};

function capLayer(
  plate: "top" | "bottom",
  side: "left" | "right",
  plateColor: string,
): EnvBannerLayer {
  const geo = CAP_GEOMETRY[plate][side];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ENV_CAP_WIDTH} ${geo.height}"` +
    ` width="${ENV_CAP_WIDTH}" height="${geo.height}">` +
    `<g fill="${plateColor}">${geo.shapes}</g>` +
    `<g fill="${INK}" opacity="${TICK_INK_OPACITY}">${geo.ticks}</g>` +
    `</svg>`;
  return layer(svg);
}

// Stable glyph, a 58x51 twin-peak: two triangles under evenodd so the
// overlap below their crossing reads as the V, a notch under each peak, and
// a square dot below each notch.
const STABLE_GLYPH_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 58 51" width="58" height="51">` +
  `<path fill="${INK}" fill-rule="evenodd" ` +
  `d="M17 0L35 39L0 39ZM40 0L57 39L21 39ZM14 31h7v8h-7zM36 31h7v8h-7z"/>` +
  `<path fill="${INK}" d="M14 40h7v11h-7zM36 40h7v11h-7z"/></svg>`;

// Acidic glyph, 59x59: four teardrops (a radius-12 circle with two
// tangents, tip up-right) on a 30-unit grid.
const TEARDROP_PITCH = 30;

function teardrop(dx: number, dy: number): string {
  return `<path transform="translate(${dx} ${dy})" d="M29 0L23.5 19.3A12 12 0 1 1 9.5 4.3Z"/>`;
}

const ACIDIC_GLYPH_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 59 59" width="59" height="59">` +
  `<g fill="${INK}">` +
  `${teardrop(0, 0)}${teardrop(TEARDROP_PITCH, 0)}` +
  `${teardrop(0, TEARDROP_PITCH)}${teardrop(TEARDROP_PITCH, TEARDROP_PITCH)}` +
  `</g></svg>`;

// The glyphs are ink-only, so they prebuild to load-time constants.
const GLYPHS: Record<EnvironmentId, EnvBannerLayer> = {
  stable: layer(STABLE_GLYPH_SVG),
  acidic: layer(ACIDIC_GLYPH_SVG),
};

// The layer set for one environment. plateColor is the caller's environment
// token value; the module never hardcodes a hue.
export function envBannerLayers(
  environment: EnvironmentId,
  plateColor: string,
): EnvBannerLayers {
  return {
    top: {
      glyph: GLYPHS[environment],
      leftCap: capLayer("top", "left", plateColor),
      rightCap: capLayer("top", "right", plateColor),
    },
    bottom: {
      leftCap: capLayer("bottom", "left", plateColor),
      rightCap: capLayer("bottom", "right", plateColor),
    },
  };
}
