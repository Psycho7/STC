// The framing math behind the PNG export. The image is the content rect plus a
// fixed margin at unit scale, so these numbers are the whole contract between
// contentBounds and what the rasterizer is handed.
import { expect, test } from "vitest";
import {
  EXPORT_MARGIN,
  EXPORT_MAX_SIDE,
  EXPORT_PIXEL_RATIO,
  exportFilename,
  exportFrame,
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
  // 12000 flow units wide: at ratio 2 that is 24192 device pixels, past the
  // limit the rasterizer refuses.
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

test("the frame options override the defaults", () => {
  const frame = exportFrame(
    { x: 10, y: 10, width: 100, height: 100 },
    { margin: 5, pixelRatio: 3, maxSide: 1000 },
  );
  expect(frame.width).toBe(110);
  expect(frame.height).toBe(110);
  expect(frame.pixelRatio).toBe(3);
  expect(frame.transform).toBe("translate(-5px, -5px) scale(1)");
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
