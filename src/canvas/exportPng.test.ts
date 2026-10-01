// The framing math behind the PNG export. The image is the content rect plus a
// fixed margin at unit scale, so these numbers are the whole contract between
// contentBounds and what the rasterizer is handed.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EXPORT_MARGIN,
  EXPORT_MAX_AREA,
  EXPORT_MAX_SIDE,
  EXPORT_PIXEL_RATIO,
  exportFilename,
  exportFrame,
  withInlinedSprites,
} from "./exportPng";

const toBlobSpy = vi.hoisted(() =>
  vi.fn(async () => new Blob(["png"], { type: "image/png" })),
);
vi.mock("html-to-image", () => ({ toBlob: toBlobSpy }));

test("the frame is the bounds plus a margin on every side", () => {
  const frame = exportFrame({ x: 100, y: 40, width: 800, height: 600 });
  expect(frame.width).toBe(800 + 2 * EXPORT_MARGIN);
  expect(frame.height).toBe(600 + 2 * EXPORT_MARGIN);
});

test("the transform moves the bounds origin to the margin, at unit scale", () => {
  const frame = exportFrame({ x: 100, y: 40, width: 800, height: 600 });
  expect(frame.transform).toBe(
    `translate(${EXPORT_MARGIN - 100}px, ${EXPORT_MARGIN - 40}px) scale(1)`,
  );
});

// A plan whose origin is left of / above the flow origin needs a positive
// translate past the margin, so the negative-coordinate case is not symmetric
// with the one above.
test("negative bounds coordinates translate the content back into frame", () => {
  const frame = exportFrame({ x: -250, y: -30, width: 400, height: 200 });
  expect(frame.transform).toBe(
    `translate(${EXPORT_MARGIN + 250}px, ${EXPORT_MARGIN + 30}px) scale(1)`,
  );
});

test("a frame within the device-pixel limit keeps the requested ratio", () => {
  const frame = exportFrame({ x: 0, y: 0, width: 2000, height: 1200 });
  expect(frame.pixelRatio).toBe(EXPORT_PIXEL_RATIO);
  expect(frame.width * frame.pixelRatio).toBeLessThanOrEqual(EXPORT_MAX_SIDE);
});

test("the ratio is clamped so the longest side stays inside the limit", () => {
  // 12000 flow units wide: at ratio 2 that is 24192 device pixels, past what a
  // canvas accepts.
  const frame = exportFrame({ x: 0, y: 0, width: 12000, height: 1000 });
  expect(frame.pixelRatio).toBeLessThan(EXPORT_PIXEL_RATIO);
  expect(Math.max(frame.width, frame.height) * frame.pixelRatio).toBeCloseTo(
    EXPORT_MAX_SIDE,
    6,
  );
});

test("the clamp measures the taller side too", () => {
  const frame = exportFrame({ x: 0, y: 0, width: 1000, height: 12000 });
  expect(frame.height * frame.pixelRatio).toBeCloseTo(EXPORT_MAX_SIDE, 6);
});

// Safari caps canvas area, not side length: a square-ish plan can sit well
// inside the side limit and still be refused on total pixels.
test("the ratio is clamped so the total area stays inside the limit", () => {
  const frame = exportFrame({ x: 0, y: 0, width: 6000, height: 5000 });
  expect(Math.max(frame.width, frame.height) * frame.pixelRatio).toBeLessThan(
    EXPORT_MAX_SIDE,
  );
  expect(frame.pixelRatio).toBeLessThan(EXPORT_PIXEL_RATIO);
  expect(
    frame.width * frame.pixelRatio * (frame.height * frame.pixelRatio),
  ).toBeCloseTo(EXPORT_MAX_AREA, 3);
});

test("the filename joins the target ids and stamps the local date", () => {
  expect(
    exportFilename(["copper_bottle", "iron_powder"], new Date(2026, 8, 7)),
  ).toBe("stc-copper_bottle-iron_powder-2026-09-07.png");
});

test("the filename pads single-digit months and days", () => {
  expect(exportFilename(["ore"], new Date(2026, 0, 1))).toBe(
    "stc-ore-2026-01-01.png",
  );
});

test("a long target list truncates to 60 slug characters", () => {
  const ids = [
    "aaaaaaaaaa",
    "bbbbbbbbbb",
    "cccccccccc",
    "dddddddddd",
    "eeeeeeeeee",
    "ffffffffff",
    "gggggggggg",
  ];
  const name = exportFilename(ids, new Date(2026, 8, 7));
  const slug = name.slice("stc-".length, -"-2026-09-07.png".length);
  expect(slug).toHaveLength(60);
  expect(ids.join("-").startsWith(slug)).toBe(true);
});

test("a plan with no targets falls back to the plan slug", () => {
  expect(exportFilename([], new Date(2026, 8, 7))).toBe(
    "stc-plan-2026-09-07.png",
  );
});

// Sprite inlining. The rasterizer copies every resolved background-image into
// the serialized SVG as a data URL, so leaving the shared sheet in place would
// give every icon on the canvas its own copy of it.
const CELL_URL = "data:image/png;base64,CELL";
const SHEET_URL = "/icons-abc123.webp";

const drawImage = vi.fn();
const toDataURL = vi.fn(() => CELL_URL);

function spriteRoot(...positions: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const position of positions) {
    const el = document.createElement("span");
    el.className = "spr";
    el.style.backgroundImage = `url("${SHEET_URL}")`;
    el.style.backgroundPosition = position;
    root.appendChild(el);
  }
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  drawImage.mockClear();
  toDataURL.mockClear();
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({ drawImage }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: toDataURL,
  });
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

test("every sprite carries its own cell as a data URL during the capture", async () => {
  const root = spriteRoot("-128px -64px", "0px 0px");

  await withInlinedSprites(root, SHEET_URL, async () => {
    for (const el of root.querySelectorAll<HTMLElement>(".spr")) {
      expect(el.style.backgroundImage).toContain(CELL_URL);
      expect(el.style.backgroundPosition).toBe("0px 0px");
    }
    expect(root.innerHTML).not.toContain(SHEET_URL);
  });

  // The cell origin is the negated background-position: the sheet is drawn
  // shifted up and left by exactly one cell's worth of offset.
  expect(drawImage.mock.calls[0]?.slice(1, 5)).toEqual([128, 64, 64, 64]);
});

test("the inline sprite styles are restored when the capture throws", async () => {
  const root = spriteRoot("-128px -64px");
  const sprite = root.querySelector<HTMLElement>(".spr")!;

  await expect(
    withInlinedSprites(root, SHEET_URL, () =>
      Promise.reject(new Error("canvas refused")),
    ),
  ).rejects.toThrow("canvas refused");

  expect(sprite.style.backgroundImage).toContain(SHEET_URL);
  expect(sprite.style.backgroundPosition).toBe("-128px -64px");
});

test("two sprites sharing a cell rasterize it once", async () => {
  const root = spriteRoot("-192px -256px", "-192px -256px");
  await withInlinedSprites(root, SHEET_URL, () => Promise.resolve());
  expect(toDataURL).toHaveBeenCalledTimes(1);
});

// Web-font embedding. Left to itself, html-to-image re-reads every stylesheet
// on each capture and embeds every @font-face of every family in use: all the
// CJK subsets of Noto Sans SC, hundreds of files. The export hands it a
// prebuilt string instead, holding only the faces the browser actually loaded
// for the families the canvas draws with.
const FONT_SHEET_URL = "https://fonts.googleapis.com/css2?family=x";
const LATIN_URL = "https://fonts.gstatic.com/latin.woff2";
const CJK_URL = "https://fonts.gstatic.com/cjk-unused.woff2";
const CINZEL_URL = "https://fonts.gstatic.com/cinzel.woff2";
const LATIN_RANGE = "U+0-FF, U+131";
const CJK_RANGE = "U+4E00-4E09";

interface FakeFace {
  family: string;
  weight: string;
  style: string;
  unicodeRange: string;
  status: string;
}

function fontFaceRule(face: FakeFace, url: string) {
  const props: Record<string, string> = {
    "font-family": `"${face.family}"`,
    "font-weight": face.weight,
    "font-style": face.style,
    "unicode-range": face.unicodeRange,
    src: `url("${url}") format("woff2")`,
  };
  const body = Object.entries(props)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  return {
    type: CSSRule.FONT_FACE_RULE,
    cssText: `@font-face { ${body} }`,
    style: { getPropertyValue: (name: string) => props[name] ?? "" },
  };
}

const LATIN: FakeFace = {
  family: "Noto Sans SC",
  weight: "400",
  style: "normal",
  unicodeRange: LATIN_RANGE,
  status: "loaded",
};
// Declared but never needed by any text on the page, so never downloaded.
const CJK_UNUSED: FakeFace = {
  ...LATIN,
  unicodeRange: CJK_RANGE,
  status: "unloaded",
};
// Loaded by the page chrome, but no canvas element draws with it.
const CINZEL: FakeFace = { ...LATIN, family: "Cinzel", weight: "700" };
// Another page-chrome face, loaded only when a test says so.
const CINZEL_BLACK: FakeFace = {
  ...CINZEL,
  weight: "900",
  status: "unloaded",
};
const CINZEL_BLACK_URL = "https://fonts.gstatic.com/cinzel-black.woff2";

// Each build walks document.styleSheets exactly once, so the read count is the
// build count.
let styleSheetReads = 0;

const fontFetch = vi.fn<(url: string) => Promise<Response>>(
  async () =>
    new Response("woff2", { headers: { "Content-Type": "font/woff2" } }),
);

// Returns the live face list, so a test can load a face between exports.
// `extra` declares more faces, each with its src URL.
function stubDocumentFonts(
  extra: readonly [FakeFace, string][] = [],
): FakeFace[] {
  const faces = [
    { ...LATIN },
    { ...CJK_UNUSED },
    { ...CINZEL },
    { ...CINZEL_BLACK },
    ...extra.map(([face]) => ({ ...face })),
  ];
  const sheets = [
    {
      href: FONT_SHEET_URL,
      cssRules: [
        fontFaceRule(LATIN, LATIN_URL),
        fontFaceRule(CJK_UNUSED, CJK_URL),
        fontFaceRule(CINZEL, CINZEL_URL),
        fontFaceRule(CINZEL_BLACK, CINZEL_BLACK_URL),
        ...extra.map(([face, url]) => fontFaceRule(face, url)),
      ],
    },
  ];
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      ready: Promise.resolve(),
      [Symbol.iterator]: () => faces.values(),
    },
  });
  Object.defineProperty(document, "styleSheets", {
    configurable: true,
    get: () => {
      styleSheetReads++;
      return sheets;
    },
  });
  vi.stubGlobal("fetch", fontFetch);
  return faces;
}

function canvasViewport(): HTMLElement {
  const viewport = document.createElement("div");
  const label = document.createElement("span");
  label.style.fontFamily = '"Noto Sans SC", sans-serif';
  viewport.appendChild(label);
  document.body.appendChild(viewport);
  return viewport;
}

// A fresh module per test: the font CSS is cached at module scope.
async function freshCapture() {
  vi.resetModules();
  const mod = await import("./exportPng");
  return mod.capturePlanPng;
}

const FRAME = exportFrame({ x: 0, y: 0, width: 100, height: 100 });

function fontEmbedCSSPassed(call: number): unknown {
  const options = toBlobSpy.mock.calls[call] as unknown as [
    HTMLElement,
    { fontEmbedCSS?: string },
  ];
  return options[1].fontEmbedCSS;
}

describe("font embedding", () => {
  beforeEach(() => {
    toBlobSpy.mockClear();
    fontFetch.mockClear();
    styleSheetReads = 0;
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
    Reflect.deleteProperty(document, "styleSheets");
    vi.unstubAllGlobals();
  });

  test("the font CSS is built once and handed to every capture", async () => {
    stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();

    await capturePlanPng(viewport, FRAME, "#000");
    await capturePlanPng(viewport, FRAME, "#000");
    await capturePlanPng(viewport, FRAME, "#000");

    expect(fontFetch).toHaveBeenCalledTimes(1);
    const css = fontEmbedCSSPassed(0);
    expect(typeof css).toBe("string");
    expect(css).toContain("data:font/woff2;base64,");
    expect(fontEmbedCSSPassed(1)).toBe(css);
    expect(fontEmbedCSSPassed(2)).toBe(css);
  });

  test("only loaded faces of the canvas's own families are embedded", async () => {
    stubDocumentFonts();
    const capturePlanPng = await freshCapture();

    await capturePlanPng(canvasViewport(), FRAME, "#000");

    expect(fontFetch.mock.calls.map(([url]) => url)).toEqual([LATIN_URL]);
    const css = fontEmbedCSSPassed(0) as string;
    expect(css).toContain(LATIN_RANGE);
    expect(css).not.toContain(CJK_RANGE);
    expect(css).not.toContain("Cinzel");
    expect(css).not.toContain(LATIN_URL);
  });

  // Switching the locale to zh, or a plan whose text needs another CJK subset,
  // makes the browser load faces that were not there at the first export.
  test("a face loaded after an export is embedded by the next one", async () => {
    const faces = stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();

    await capturePlanPng(viewport, FRAME, "#000");
    faces[1]!.status = "loaded";
    await capturePlanPng(viewport, FRAME, "#000");
    await capturePlanPng(viewport, FRAME, "#000");

    expect(fontEmbedCSSPassed(0)).not.toContain(CJK_RANGE);
    const rebuilt = fontEmbedCSSPassed(1) as string;
    expect(rebuilt).toContain(CJK_RANGE);
    expect(rebuilt).toContain(LATIN_RANGE);
    expect(fontEmbedCSSPassed(2)).toBe(rebuilt);
    // The rebuild fetches only the new face.
    expect(fontFetch.mock.calls.map(([url]) => url)).toEqual([
      LATIN_URL,
      CJK_URL,
    ]);
  });

  test("an export with no new face reuses the built CSS", async () => {
    stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();

    await capturePlanPng(viewport, FRAME, "#000");
    await capturePlanPng(viewport, FRAME, "#000");

    expect(styleSheetReads).toBe(1);
  });

  test("a face loaded only for the page chrome does not rebuild", async () => {
    const faces = stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();

    await capturePlanPng(viewport, FRAME, "#000");
    faces[3]!.status = "loaded";
    await capturePlanPng(viewport, FRAME, "#000");

    expect(styleSheetReads).toBe(1);
    expect(fontEmbedCSSPassed(1)).toBe(fontEmbedCSSPassed(0));
  });

  // Same loaded faces, but the canvas now draws with a family whose face was
  // loaded all along for the page chrome.
  test("a family the canvas starts drawing with rebuilds", async () => {
    stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();

    await capturePlanPng(viewport, FRAME, "#000");
    const title = document.createElement("span");
    title.style.fontFamily = "Cinzel, serif";
    viewport.appendChild(title);
    await capturePlanPng(viewport, FRAME, "#000");

    expect(styleSheetReads).toBe(2);
    expect(fontEmbedCSSPassed(0)).not.toContain("Cinzel");
    expect(fontEmbedCSSPassed(1)).toContain("Cinzel");
  });

  // A face dropped from one build is evicted, so the cache holds only the
  // faces of the latest build.
  test("a rebuild evicts the faces it no longer uses", async () => {
    stubDocumentFonts();
    const capturePlanPng = await freshCapture();
    const viewport = canvasViewport();
    const label = viewport.firstChild!;

    await capturePlanPng(viewport, FRAME, "#000");
    viewport.removeChild(label);
    await capturePlanPng(viewport, FRAME, "#000");
    viewport.appendChild(label);
    await capturePlanPng(viewport, FRAME, "#000");

    expect(fontFetch.mock.calls.map(([url]) => url)).toEqual([
      LATIN_URL,
      LATIN_URL,
    ]);
  });

  // Google Fonts serves one file for every weight of a family, so faces that
  // differ only in weight share a src URL.
  test("faces sharing a src URL fetch it once", async () => {
    stubDocumentFonts([[{ ...LATIN, weight: "700" }, LATIN_URL]]);
    const capturePlanPng = await freshCapture();

    await capturePlanPng(canvasViewport(), FRAME, "#000");

    expect(fontFetch.mock.calls.map(([url]) => url)).toEqual([LATIN_URL]);
    const css = fontEmbedCSSPassed(0) as string;
    expect(css).toContain("font-weight: 400");
    expect(css).toContain("font-weight: 700");
    expect(css).not.toContain(LATIN_URL);
  });

  // An empty string, not undefined: html-to-image only falls back to its own
  // stylesheet walk when the option is missing.
  test("a document without a font set embeds nothing and skips the fallback", async () => {
    const capturePlanPng = await freshCapture();

    await capturePlanPng(canvasViewport(), FRAME, "#000");

    expect(fontEmbedCSSPassed(0)).toBe("");
    expect(fontFetch).not.toHaveBeenCalled();
  });
});
