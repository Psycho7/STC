// The PNG export end to end: a real browser, a real rasterization, a real
// download. The unit suite runs under jsdom, where canvas rasterization is
// stubbed out, so this is the only place the image itself is proof of
// anything. The saved file is kept for visual inspection.
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { exportFrame } from "../../src/canvas/exportPng";
import { SCENARIOS, scenarioHash } from "./scenarios";
import { bootExamPage } from "./viewport";

test.use({ viewport: { width: 1600, height: 1000 } });

// A PNG starts with the 8-byte signature, then the IHDR chunk: 4 length bytes,
// 4 type bytes, then the big-endian width and height. So width is at byte 16
// and height at byte 20.
const IHDR_WIDTH_OFFSET = 16;

function pngSize(bytes: Buffer): { width: number; height: number } {
  return {
    width: bytes.readUInt32BE(IHDR_WIDTH_OFFSET),
    height: bytes.readUInt32BE(IHDR_WIDTH_OFFSET + 4),
  };
}

test("the export button downloads the plan canvas as a framed PNG", async ({
  page,
}, testInfo) => {
  const scenario = SCENARIOS.find((s) => s.id === "default")!;
  await bootExamPage(page, {
    url: "/#" + (await scenarioHash(scenario)),
    locale: "en",
    readiness: "ready",
    settle: "both",
  });

  const bounds = await page.evaluate(() => window.__stcExam!.contentBounds());
  expect(bounds).not.toBeNull();
  const frame = exportFrame(bounds!);

  const button = page.getByTestId("export-png");
  await expect(button).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await button.click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(
    /^stc-.+-\d{4}-\d{2}-\d{2}\.png$/,
  );

  // Attached rather than written to a fixed path: the report keeps the image
  // where the run's own artifacts live, for whoever inspects it afterwards.
  const file = await download.path();
  await testInfo.attach("export-png", { path: file, contentType: "image/png" });

  // The canvas element's width/height are set from width * pixelRatio, and the
  // DOM truncates a fractional dimension, so the image is the floor of the
  // frame in device pixels.
  const bytes = await readFile(file);
  expect(pngSize(bytes)).toEqual({
    width: Math.floor(frame.width * frame.pixelRatio),
    height: Math.floor(frame.height * frame.pixelRatio),
  });
});
