// Exact text measurement for the canvas label elision, with the char-class
// table (textWidth.ts) as the fallback.
//
// The elision helper needs a width for a string it has not rendered yet. The
// table answers that without a browser, but it answers with an UPPER BOUND --
// per-class maxima carrying headroom for every face the stacks can substitute
// -- and on the shipped corpus that bound runs ~25% over the truth, so 152 of
// 186 elided rows were losing characters they had room for. A canvas 2D
// context measures the same string in the same resolved faces the DOM lays
// out with: over the corpus, canvas and DOM agreed to within 0.01px on every
// distinct label.
//
// So production measures, and the table is what answers when measurement is
// not available: jsdom (no canvas metrics), any non-browser caller, and the
// window before a face the page asked for has arrived. The fallback direction
// is unchanged -- an over-wide answer elides early, which is safe, while an
// under-wide one overflows into CSS ellipsis and recreates the defect the
// helper exists to fix.
//
// Faces settle late. The Google Fonts stylesheet arrives after first paint, so
// the first measurement runs on fallback metrics and the real faces can be
// wider or narrower. Rather than guess, this module measures in whatever faces
// are resolved NOW and bumps a generation when that changes, which clears the
// elision cache and re-renders every label against the metrics actually in
// effect. A blocked CDN simply never bumps and the page keeps the fallback
// metrics it is already drawing.

import { useSyncExternalStore } from "react";
import { clearElisionCache } from "./elide";
import { estimateTextWidth, type TextWidthFont } from "./textWidth";

// The two CSS font stacks the elided surfaces render in. Named by their custom
// property so the family is read from the stylesheet rather than restated here:
// a stack edited in canvas.css must not need a matching edit in this module.
export type FontFamilyVar = "--font-ui" | "--font-num";

export type MeasuredFont = TextWidthFont & {
  family: FontFamilyVar;
  // Tracking from the surface's CSS rule, in em. The table ignores tracking
  // (its bound already covers it); an exact measurement must not.
  letterSpacingEm?: number;
};

let ctx: CanvasRenderingContext2D | null | undefined;

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  ctx = null;
  if (typeof document === "undefined") return ctx;
  try {
    const measured = document.createElement("canvas").getContext("2d");
    // jsdom hands back a context whose measureText reports 0 for every
    // string. A zero width would read as "everything fits" and switch the
    // helper off silently, so one probe decides whether this context can
    // measure at all.
    if (measured !== null) {
      measured.font = "12px sans-serif";
      if (measured.measureText("M").width > 0) ctx = measured;
    }
  } catch {
    ctx = null;
  }
  return ctx;
}

const familyCache = new Map<FontFamilyVar, string>();

function familyOf(name: FontFamilyVar): string | null {
  const hit = familyCache.get(name);
  if (hit !== undefined) return hit === "" ? null : hit;
  let value = "";
  if (typeof document !== "undefined") {
    value = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }
  familyCache.set(name, value);
  return value === "" ? null : value;
}

// Width of one string in one font: exact when a canvas can measure in the
// resolved faces, the char-class upper bound otherwise.
export function measureTextWidth(text: string, font: MeasuredFont): number {
  const c = context();
  const family = familyOf(font.family);
  if (c === null || family === null) return estimateTextWidth(text, font);
  c.font = `${font.weight} ${font.fontSize}px ${family}`;
  const tracking =
    font.letterSpacingEm === undefined
      ? 0
      : font.letterSpacingEm * font.fontSize * [...text].length;
  return c.measureText(text).width + tracking;
}

// A WidthFn bound to one font, for the elision helper.
export function widthFnFor(font: MeasuredFont): (text: string) => number {
  return (text) => measureTextWidth(text, font);
}

// Generation of the resolved font metrics. It changes when a face the page
// asked for finishes loading, which is the one event that invalidates every
// measurement taken before it.
let generation = 0;
const listeners = new Set<() => void>();
let watching = false;

function bump(): void {
  generation++;
  familyCache.clear();
  clearElisionCache();
  for (const listener of listeners) listener();
}

function watch(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  const fonts = document.fonts as FontFaceSet | undefined;
  if (fonts === undefined) return;
  // `ready` resolves as soon as nothing is loading, which on a cold load is
  // before the stylesheet has asked for anything, so the loadingdone event is
  // what actually reports a face arriving. Both are wired: ready covers the
  // case where every face was already in the browser's cache.
  fonts.addEventListener("loadingdone", bump);
  void fonts.ready.then(bump).catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): number {
  return generation;
}

// Re-render the calling component when the resolved font metrics change, so a
// label elided against fallback metrics is recomputed once its face arrives.
export function useFontMetrics(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
