import { toBlob } from "html-to-image";
import { bytesToBase64 } from "../data/encoding/base64url";
import type { ContentRect } from "./chipSeating";

// Flow-unit margin kept on every side of the exported rect, so the outermost
// card border and rate chip do not sit flush against the image edge.
export const EXPORT_MARGIN = 48;

// Device pixels per flow unit. 2 is the retina-grade default: legible when the
// PNG is pasted into a chat or a doc at half size.
export const EXPORT_PIXEL_RATIO = 2;

// Longest side a browser canvas accepts (html-to-image's own
// canvasDimensionLimit, which it enforces by rescaling behind our back).
// Clamping the ratio here and passing skipAutoScale keeps the frame math the
// same in the export and in the test that pins it.
export const EXPORT_MAX_SIDE = 16384;

// Total device pixels a browser canvas accepts. Safari caps area rather than
// side length; 2^26 is the iOS 18 cap and the tightest limit worth honouring.
export const EXPORT_MAX_AREA = 67_108_864;

// Everything the rasterizer needs to frame one export: the CSS-pixel size of
// the image, the device-pixel multiplier, and the transform that must replace
// the live viewport transform so the rect lands at the frame origin.
export interface ExportFrame {
  width: number;
  height: number;
  pixelRatio: number;
  transform: string;
}

// Frame the export rect. The capture rasterizes the React Flow viewport element
// with this transform forced on it, which is the library's documented recipe:
// the viewport's own pan/zoom is replaced by a unit-scale translation that puts
// bounds.x/y at the margin, so the image is the plan at 1:1 regardless of where
// the camera happened to be parked.
export function exportFrame(bounds: ContentRect): ExportFrame {
  const width = bounds.width + 2 * EXPORT_MARGIN;
  const height = bounds.height + 2 * EXPORT_MARGIN;
  const pixelRatio = Math.min(
    EXPORT_PIXEL_RATIO,
    EXPORT_MAX_SIDE / Math.max(width, height),
    Math.sqrt(EXPORT_MAX_AREA / (width * height)),
  );

  return {
    width,
    height,
    pixelRatio,
    transform: `translate(${EXPORT_MARGIN - bounds.x}px, ${EXPORT_MARGIN - bounds.y}px) scale(1)`,
  };
}

// Longest slug the filename carries. Long enough to name a handful of target
// items, short enough that the whole name survives a download dialog.
const FILENAME_SLUG_MAX = 60;

export function exportFilename(
  targetItemIds: readonly string[],
  date: Date,
): string {
  const slug = targetItemIds.join("-").slice(0, FILENAME_SLUG_MAX) || "plan";
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `stc-${slug}-${yyyy}-${mm}-${dd}.png`;
}

// Every .spr span is a 64x64 window into the shared icon sheet, placed by its
// inline background-position.
const SPRITE_CELL = 64;

let iconSheet: Promise<HTMLImageElement> | null = null;

function loadIconSheet(sheetUrl: string): Promise<HTMLImageElement> {
  iconSheet ??= (async () => {
    const image = new Image();
    image.src = sheetUrl;
    await image.decode();
    return image;
  })();
  return iconSheet;
}

const cellUrlByOrigin = new Map<string, string>();

// "-128px -64px" places the sheet 128/64 px up and left, i.e. the cell at
// sheet coordinates (128, 64).
function cellOrigin(backgroundPosition: string): { x: number; y: number } {
  const [x = "0", y = "0"] = backgroundPosition.trim().split(/\s+/);
  return { x: -(parseFloat(x) || 0), y: -(parseFloat(y) || 0) };
}

function cellDataUrl(sheet: HTMLImageElement, x: number, y: number): string {
  const key = `${x},${y}`;
  const cached = cellUrlByOrigin.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_CELL;
  canvas.height = SPRITE_CELL;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("PNG export cannot read a 2D canvas context");
  }
  ctx.drawImage(
    sheet,
    x,
    y,
    SPRITE_CELL,
    SPRITE_CELL,
    0,
    0,
    SPRITE_CELL,
    SPRITE_CELL,
  );

  const url = canvas.toDataURL("image/png");
  cellUrlByOrigin.set(key, url);
  return url;
}

// html-to-image inlines every element's computed style and rewrites each
// background-image URL with the full data URL of whatever it points at. Left
// alone, every icon on the canvas would carry its own copy of the 510 KB sheet
// and a large plan would serialize hundreds of megabytes of SVG. Swap each
// sprite for a data URL of just its own cell first: the pixels drawn are
// identical, so the capture cannot tell the difference.
export async function withInlinedSprites<T>(
  root: HTMLElement,
  sheetUrl: string,
  capture: () => Promise<T>,
): Promise<T> {
  const sprites = Array.from(root.querySelectorAll<HTMLElement>(".spr"));
  const previous = sprites.map((el) => ({
    image: el.style.backgroundImage,
    position: el.style.backgroundPosition,
  }));

  try {
    const sheet = await loadIconSheet(sheetUrl);
    for (const el of sprites) {
      const position =
        getComputedStyle(el).backgroundPosition || el.style.backgroundPosition;
      const origin = cellOrigin(position);
      el.style.backgroundImage = `url("${cellDataUrl(sheet, origin.x, origin.y)}")`;
      el.style.backgroundPosition = "0px 0px";
    }
    return await capture();
  } finally {
    sprites.forEach((el, i) => {
      const before = previous[i]!;
      el.style.backgroundImage = before.image;
      el.style.backgroundPosition = before.position;
    });
  }
}

// The @font-face CSS the export embeds, reused while the canvas's set of loaded
// faces stays the same. Left to itself, html-to-image rebuilds it on every capture
// from every face declared for a family in use: all of Noto Sans SC's CJK
// subsets, hundreds of font files, where a plan draws with a dozen. Only faces
// the browser has loaded, in families the canvas draws with, are kept. A face
// that loads later (a switch to zh, a plan needing another CJK subset) changes
// the signature and the next export rebuilds.
let fontEmbedCSS: { signature: string; css: Promise<string> } | null = null;

// One entry per embedded face, so a rebuild fetches only the new faces.
const faceCSSByKey = new Map<string, Promise<string>>();

// One entry per font file. Google Fonts serves one file for every weight of a
// family, so faces that differ only in weight fetch and encode it once.
const dataUrlByUrl = new Map<string, Promise<string>>();

// A face declared without a unicode-range covers every code point, and
// FontFace reports it that way.
const ALL_CODE_POINTS = "U+0-10FFFF";

const CSS_URL = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

function unquote(family: string): string {
  return family.trim().replace(/["']/g, "");
}

// Identity of a face, comparable between a FontFace and its @font-face rule.
function faceKey(
  family: string,
  weight: string,
  style: string,
  unicodeRange: string,
): string {
  const range = (unicodeRange || ALL_CODE_POINTS).replace(/\s+/g, "");
  return [
    unquote(family),
    weight || "normal",
    style || "normal",
    range.toUpperCase(),
  ].join("|");
}

function canvasFamilies(root: HTMLElement): Set<string> {
  const families = new Set<string>();
  for (const el of [root, ...root.querySelectorAll("*")]) {
    for (const family of getComputedStyle(el).fontFamily.split(",")) {
      families.add(unquote(family));
    }
  }
  return families;
}

// A cross-origin sheet without CORS (say, one a browser extension injects)
// refuses to list its rules. It declares none of the app's fonts, so skip it.
function readableRules(sheet: CSSStyleSheet): CSSRule[] {
  try {
    return Array.from(sheet.cssRules);
  } catch {
    return [];
  }
}

async function fetchDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`PNG export could not fetch the font ${url}`);
  }
  // Raw bytes work in any realm; a file reader rejects a Blob from another
  // one, which is what fetch returns under jsdom.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const type = response.headers.get("Content-Type") ?? "";
  return `data:${type};base64,${bytesToBase64(bytes)}`;
}

function sourceUrls(cssText: string, baseUrl: string): string[] {
  return Array.from(
    cssText.matchAll(CSS_URL),
    (match) => new URL(match[2]!, baseUrl).href,
  );
}

// A failed fetch is not cached, so the next export tries the file again.
function cachedDataUrl(url: string): Promise<string> {
  let dataUrl = dataUrlByUrl.get(url);
  if (dataUrl === undefined) {
    dataUrl = fetchDataUrl(url);
    dataUrlByUrl.set(url, dataUrl);
    dataUrl.catch(() => dataUrlByUrl.delete(url));
  }
  return dataUrl;
}

async function inlineUrls(cssText: string, baseUrl: string): Promise<string> {
  const dataUrls = await Promise.all(
    sourceUrls(cssText, baseUrl).map(cachedDataUrl),
  );
  let next = 0;
  return cssText.replace(CSS_URL, () => `url("${dataUrls[next++]}")`);
}

// A failed fetch is not cached, so the next export tries the face again.
function faceCSS(key: string, cssText: string, baseUrl: string) {
  let css = faceCSSByKey.get(key);
  if (css === undefined) {
    css = inlineUrls(cssText, baseUrl);
    faceCSSByKey.set(key, css);
    css.catch(() => faceCSSByKey.delete(key));
  }
  return css;
}

// `used` holds the face keys to embed: loaded, and in a canvas family.
async function buildFontEmbedCSS(used: ReadonlySet<string>): Promise<string> {
  // Evict faces this build drops, so the cache never outgrows one build.
  for (const key of faceCSSByKey.keys()) {
    if (!used.has(key)) {
      faceCSSByKey.delete(key);
    }
  }

  const faces: Promise<string>[] = [];
  const urls = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    for (const rule of readableRules(sheet)) {
      if (rule.type !== CSSRule.FONT_FACE_RULE) {
        continue;
      }
      const style = (rule as CSSFontFaceRule).style;
      const key = faceKey(
        style.getPropertyValue("font-family"),
        style.getPropertyValue("font-weight"),
        style.getPropertyValue("font-style"),
        style.getPropertyValue("unicode-range"),
      );
      if (!used.has(key)) {
        continue;
      }
      const baseUrl = sheet.href ?? document.baseURI;
      faces.push(faceCSS(key, rule.cssText, baseUrl));
      for (const url of sourceUrls(rule.cssText, baseUrl)) {
        urls.add(url);
      }
    }
  }
  // Files are evicted like faces: only the latest build's files stay.
  for (const url of dataUrlByUrl.keys()) {
    if (!urls.has(url)) {
      dataUrlByUrl.delete(url);
    }
  }
  return (await Promise.all(faces)).join("\n");
}

// The signature is the canvas's loaded faces, so a face the page chrome loads
// does not rebuild, and a family the canvas starts drawing with does.
async function planFontEmbedCSS(viewport: HTMLElement): Promise<string> {
  // jsdom has no font set, so there is nothing to embed there.
  if (!("fonts" in document)) {
    return "";
  }
  await document.fonts.ready;

  const families = canvasFamilies(viewport);
  const used: string[] = [];
  for (const face of document.fonts) {
    if (face.status === "loaded" && families.has(unquote(face.family))) {
      used.push(
        faceKey(face.family, face.weight, face.style, face.unicodeRange),
      );
    }
  }
  const signature = used.sort().join("\n");

  if (fontEmbedCSS?.signature !== signature) {
    const css = buildFontEmbedCSS(new Set(used));
    fontEmbedCSS = { signature, css };
    css.catch(() => {
      if (fontEmbedCSS?.css === css) {
        fontEmbedCSS = null;
      }
    });
  }
  return fontEmbedCSS.css;
}

// Rasterize the framed viewport. `backgroundColor` is the canvas theme's own
// computed colour: the viewport element itself is transparent, so without it
// the PNG comes out with a see-through background that reads as white wherever
// it is pasted.
export async function capturePlanPng(
  viewport: HTMLElement,
  frame: ExportFrame,
  backgroundColor: string,
): Promise<Blob> {
  const blob = await toBlob(viewport, {
    width: frame.width,
    height: frame.height,
    pixelRatio: frame.pixelRatio,
    backgroundColor,
    // The ratio is already clamped to what a canvas accepts; without this the
    // library rescales behind the clamp and the image stops matching the frame.
    skipAutoScale: true,
    fontEmbedCSS: await planFontEmbedCSS(viewport),
    style: {
      width: `${frame.width}px`,
      height: `${frame.height}px`,
      transform: frame.transform,
    },
  });
  if (blob === null) {
    throw new Error("PNG export produced no image data");
  }
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
