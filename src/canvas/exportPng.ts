import { toBlob } from "html-to-image";
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
