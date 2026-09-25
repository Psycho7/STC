// The PNG export end to end: a real browser, a real rasterization, a real
// download. The unit suite runs under jsdom, where canvas rasterization is
// stubbed out, so this is the only place the image itself is proof of
// anything. The saved file is kept for visual inspection.
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { EXPORT_MARGIN, exportFrame } from "../../src/canvas/exportPng";
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

// Flow units a sample keeps from every card, chip, caption and edge stroke, so
// an antialiased border or a stroke's hit band never lands in the sample.
const TINT_SAMPLE_CLEARANCE = 16;
// Flow-unit pitch of the candidate grid laid over each paint rect.
const TINT_SAMPLE_PITCH = 12;
// How many member-only points the tint check reads.
const TINT_SAMPLE_COUNT = 12;
// Smallest per-channel distance from the background that counts as tinted.
// The paint is cyan at opacity 0.1 over a near-black canvas, which moves the
// green and blue channels by well over this; an untinted pixel moves by 0.
const TINT_MIN_DELTA = 4;

test("the export keeps the loop paint tint", async ({ page }, testInfo) => {
  const scenario = SCENARIOS.find((s) => s.id === "battery5-xiranite")!;
  await bootExamPage(page, {
    url: "/#" + (await scenarioHash(scenario)),
    locale: "en",
    readiness: "ready",
    settle: "both",
  });

  const bounds = await page.evaluate(() => window.__stcExam!.contentBounds());
  expect(bounds).not.toBeNull();
  const frame = exportFrame(bounds!);

  // Member-only points, in flow units: inside a paint rect, clear of every
  // card, chip and caption box, and with no edge under or near them. Read
  // from the live canvas, where hit testing and client rects are real.
  const points = await page.evaluate(
    ({ clearance, pitch }) => {
      const viewport = document.querySelector<HTMLElement>(
        ".react-flow__viewport",
      )!;
      const origin = viewport.parentElement!.getBoundingClientRect();
      const m = new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
      const zoom = m.a;
      const toScreen = (x: number, y: number) => ({
        x: origin.left + m.e + x * zoom,
        y: origin.top + m.f + y * zoom,
      });

      const boxes = Array.from(
        document.querySelectorAll(
          ".react-flow__node, .react-flow__edgelabel-renderer *, .loop-caption",
        ),
      ).map((el) => el.getBoundingClientRect());
      const pad = clearance * zoom;
      const nearBox = (s: { x: number; y: number }) =>
        boxes.some(
          (b) =>
            s.x > b.left - pad &&
            s.x < b.right + pad &&
            s.y > b.top - pad &&
            s.y < b.bottom + pad,
        );
      const nearEdge = (s: { x: number; y: number }) =>
        [
          [0, 0],
          [pad, 0],
          [-pad, 0],
          [0, pad],
          [0, -pad],
        ].some(([dx, dy]) =>
          document
            .elementsFromPoint(s.x + dx!, s.y + dy!)
            .some((el) => el.closest(".react-flow__edges") !== null),
        );

      const found: { x: number; y: number }[] = [];
      for (const rect of document.querySelectorAll(".loop-paint rect")) {
        const left = Number(rect.getAttribute("x"));
        const top = Number(rect.getAttribute("y"));
        const right = left + Number(rect.getAttribute("width"));
        const bottom = top + Number(rect.getAttribute("height"));
        for (let y = top + clearance; y <= bottom - clearance; y += pitch) {
          for (let x = left + clearance; x <= right - clearance; x += pitch) {
            const s = toScreen(x, y);
            if (!nearBox(s) && !nearEdge(s)) found.push({ x, y });
          }
        }
      }
      return found;
    },
    { clearance: TINT_SAMPLE_CLEARANCE, pitch: TINT_SAMPLE_PITCH },
  );
  expect(points.length).toBeGreaterThanOrEqual(TINT_SAMPLE_COUNT);
  const step = Math.floor(points.length / TINT_SAMPLE_COUNT);
  const samples = Array.from(
    { length: TINT_SAMPLE_COUNT },
    (_, i) => points[i * step]!,
  );

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("export-png").click();
  const file = await (await downloadPromise).path();
  await testInfo.attach("export-png", { path: file, contentType: "image/png" });

  // Decode in a blank page: the export's own frame maps a flow point to its
  // device pixel, and the top-left margin pixel is the bare background.
  const decoder = await page.context().newPage();
  const pixels = await decoder.evaluate(
    async ({ b64, px }) => {
      const img = new Image();
      img.src = "data:image/png;base64," + b64;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const read = ([x, y]: number[]) =>
        Array.from(ctx.getImageData(x!, y!, 1, 1).data.slice(0, 3));
      return { background: read([1, 1]), samples: px.map(read) };
    },
    {
      b64: (await readFile(file)).toString("base64"),
      px: samples.map((p) => [
        Math.round((p.x - bounds!.x + EXPORT_MARGIN) * frame.pixelRatio),
        Math.round((p.y - bounds!.y + EXPORT_MARGIN) * frame.pixelRatio),
      ]),
    },
  );
  await decoder.close();

  for (const [i, sample] of pixels.samples.entries()) {
    const delta = Math.max(
      ...sample.map((c, ch) => Math.abs(c - pixels.background[ch]!)),
    );
    expect(
      delta,
      `pixel ${JSON.stringify(sample)} at flow ${JSON.stringify(samples[i])} vs background ${JSON.stringify(pixels.background)}`,
    ).toBeGreaterThanOrEqual(TINT_MIN_DELTA);
  }
});
