import { toBlob } from "html-to-image";

// Flow-unit margin kept on every side of the exported rect, so the outermost
// card border and rate chip do not sit flush against the image edge.
export const EXPORT_MARGIN = 48;

// Device pixels per flow unit. 2 is the retina-grade default: legible when the
// PNG is pasted into a chat or a doc at half size.
export const EXPORT_PIXEL_RATIO = 2;

// html-to-image refuses a canvas whose longest side exceeds this (its own
// canvasDimensionLimit). Clamping the ratio here rather than letting the
// library silently rescale keeps the frame math the same in the export and in
// the test that pins it.
export const EXPORT_MAX_SIDE = 16384;

// The rect to export, in flow units: what contentBounds returns.
export interface ExportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Everything the rasterizer needs to frame one export: the CSS-pixel size of
// the image, the device-pixel multiplier, and the transform that must replace
// the live viewport transform so the rect lands at the frame origin.
export interface ExportFrame {
  width: number;
  height: number;
  pixelRatio: number;
  transform: string;
}

export interface ExportFrameOptions {
  margin?: number;
  pixelRatio?: number;
  maxSide?: number;
}

// Frame the export rect. The capture rasterizes the React Flow viewport element
// with this transform forced on it, which is the library's documented recipe:
// the viewport's own pan/zoom is replaced by a unit-scale translation that puts
// bounds.x/y at the margin, so the image is the plan at 1:1 regardless of where
// the camera happened to be parked.
export function exportFrame(
  bounds: ExportBounds,
  opts: ExportFrameOptions = {},
): ExportFrame {
  const margin = opts.margin ?? EXPORT_MARGIN;
  const requestedRatio = opts.pixelRatio ?? EXPORT_PIXEL_RATIO;
  const maxSide = opts.maxSide ?? EXPORT_MAX_SIDE;

  const width = bounds.width + 2 * margin;
  const height = bounds.height + 2 * margin;
  const pixelRatio = Math.min(
    requestedRatio,
    maxSide / Math.max(width, height),
  );

  return {
    width,
    height,
    pixelRatio,
    transform: `translate(${margin - bounds.x}px, ${margin - bounds.y}px) scale(1)`,
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
