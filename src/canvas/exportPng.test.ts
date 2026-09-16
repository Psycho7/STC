// The framing math behind the PNG export. The image is the content rect plus a
// fixed margin at unit scale, so these numbers are the whole contract between
// contentBounds and what the rasterizer is handed.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  EXPORT_MARGIN,
  EXPORT_MAX_AREA,
  EXPORT_MAX_SIDE,
  EXPORT_PIXEL_RATIO,
  exportFilename,
  exportFrame,
  withInlinedSprites,
} from "./exportPng";

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
