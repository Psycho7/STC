// End-to-end contract for the gas transport kind. These facts cannot be checked
// in jsdom: the computed dash pattern, the opacity the gas dim rule applies via
// :has(), and the stretched pattern the lit-state rule substitutes. Screenshots
// land in the gitignored .artifacts/ dir for eyeball review after a change.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

test.use({ viewport: { width: 1920, height: 1080 } });

const VW = 1920;
const VH = 1080;
const SHOTS = resolve(import.meta.dirname, "../../.artifacts/gas-visual");
mkdirSync(SHOTS, { recursive: true });

function findParentRoot(start: string): string {
  let dir = start;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "data/aef/recipe-pack.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    "Cannot locate parent root containing data/aef/recipe-pack.json",
  );
}

const PACK_META = (() => {
  const packPath = join(
    findParentRoot(resolve(import.meta.dirname)),
    "data/aef/recipe-pack.json",
  );
  const raw = JSON.parse(readFileSync(packPath, "utf8")) as {
    schemaVersion: string;
    source: { name: string; sourceCommit?: string };
  };
  return {
    id: raw.source.name,
    schemaVersion: raw.schemaVersion,
    sourceCommit: raw.source.sourceCommit ?? "",
  };
})();

async function encodeHash(wire: object): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(wire));
  const readable = new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
  const buf = await new Response(
    readable.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  const arr = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]!);
  const b64 = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return `v1.${b64}`;
}

// copper_jar consumes gas_inert, copper_enr2 consumes gas_copper_enr2 and
// gas_xiranite, and both chains pull liquid water and copper ore, so one plan
// puts all three carriers on the canvas at once.
async function gasPlanHash(): Promise<string> {
  return encodeHash({
    pack: [PACK_META.id, PACK_META.schemaVersion, PACK_META.sourceCommit],
    title: "",
    targets: [
      { itemId: "copper_jar", ratePerSec: { num: "1", denom: "2" } },
      { itemId: "copper_enr2", ratePerSec: { num: "1", denom: "2" } },
    ],
  });
}

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1200);
}

function normalizeDash(css: string): string {
  return css
    .replace(/px/g, "")
    .replace(/,\s*/g, " ")
    .trim();
}

// A point that is on the stroke by construction. Parsing the `d` start point
// instead lands behind a card or off screen once the pane is zoomed.
async function strokeMidpoint(
  locator: ReturnType<Page["locator"]>,
): Promise<{ x: number; y: number }> {
  return locator.evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2);
    const sp = path.ownerSVGElement!.createSVGPoint();
    sp.x = p.x;
    sp.y = p.y;
    const screen = sp.matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
}

test("gas edges stay distinct from pipe across idle, lit, and dimmed states", async ({
  page,
}) => {
  await page.goto(`/#${await gasPlanHash()}`, { waitUntil: "load" });
  await waitForCanvasReady(page);

  const gasPaths = page.locator(
    '.react-flow__edge path[data-transport-kind="gas"]',
  );
  const pipePaths = page.locator(
    '.react-flow__edge path[data-transport-kind="pipe"]',
  );
  const beltPaths = page.locator(
    '.react-flow__edge path[data-transport-kind="belt"]',
  );
  const gasCount = await gasPaths.count();
  const pipeCount = await pipePaths.count();
  const beltCount = await beltPaths.count();
  // The plan is only a valid witness if it actually puts all three on screen.
  expect(gasCount).toBeGreaterThan(0);
  expect(pipeCount).toBeGreaterThan(0);
  expect(beltCount).toBeGreaterThan(0);
  await page.screenshot({ path: join(SHOTS, "fit.png") });

  // Idle: dash-dot, and not the pipe dash.
  const idleDash = await gasPaths
    .first()
    .evaluate((el) => getComputedStyle(el).strokeDasharray);
  expect(normalizeDash(idleDash)).toBe("6 2 1 2");
  const pipeDash = await pipePaths
    .first()
    .evaluate((el) => getComputedStyle(el).strokeDasharray);
  expect(normalizeDash(pipeDash)).toBe("4 2");

  // Gas port glyph: hollow and rotated, so a diamond rather than a circle.
  expect(await page.locator('[data-glyph="gas"]').count()).toBeGreaterThan(0);
  const glyph = await page
    .locator('[data-glyph="gas"]')
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        transform: cs.transform,
        borderRadius: cs.borderRadius,
        background: cs.backgroundColor,
      };
    });
  expect(glyph.transform).not.toBe("none");
  expect(glyph.borderRadius).not.toBe("50%");
  expect(glyph.background).toBe("rgba(0, 0, 0, 0)");

  // Lit: the hover rule stretches the pattern so the widened stroke does not
  // render the dots as blobs.
  const gasPoint = await strokeMidpoint(gasPaths.first());
  await page.mouse.move(gasPoint.x, gasPoint.y);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, "hover-gas.png") });
  const lit = await gasPaths.first().evaluate((el) => ({
    dimmed: el.closest(".react-flow__edge")!.classList.contains("dimmed"),
    dash: getComputedStyle(el).strokeDasharray,
  }));
  // Guards against a vacuous pass: if the hover missed, nothing below means
  // anything.
  expect(lit.dimmed).toBe(false);
  expect(normalizeDash(lit.dash)).toBe("8 3 1.5 3");

  // Dimmed: gas fades to its own floor, not the shared 0.3 that would drop the
  // dot segments below visibility.
  const beltPoint = await strokeMidpoint(beltPaths.first());
  await page.mouse.move(beltPoint.x, beltPoint.y);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(SHOTS, "dim-gas.png") });
  const dim = await gasPaths.first().evaluate((el) => {
    const wrapper = el.closest(".react-flow__edge")!;
    return {
      dimmed: wrapper.classList.contains("dimmed"),
      opacity: getComputedStyle(wrapper).opacity,
    };
  });
  expect(dim.dimmed).toBe(true);
  expect(Number(dim.opacity)).toBeCloseTo(0.45, 2);

  // Zoomed comparison frame for eyeball review: gas, pipe, and belt together,
  // with a gas edge lit.
  for (let i = 0; i < 6; i++) {
    await page
      .locator(".react-flow__controls-zoomin")
      .click()
      .catch(() => {});
  }
  await page.waitForTimeout(800);
  let litShot = false;
  for (let i = 0; i < gasCount && !litShot; i++) {
    const pt = await strokeMidpoint(gasPaths.nth(i));
    // Left of 380 is the targets panel, above 120 is the HUD strip.
    if (pt.x < 380 || pt.x > VW - 10 || pt.y < 120 || pt.y > VH - 10) continue;
    await page.mouse.move(pt.x, pt.y);
    await page.waitForTimeout(400);
    const state = await gasPaths.nth(i).evaluate((el) => ({
      dimmed: el.closest(".react-flow__edge")!.classList.contains("dimmed"),
      dash: getComputedStyle(el).strokeDasharray,
    }));
    if (state.dimmed) continue;
    expect(normalizeDash(state.dash)).toBe("8 3 1.5 3");
    await page.screenshot({
      path: join(SHOTS, "zoomed-lit-carriers.png"),
      clip: {
        x: Math.max(0, Math.min(VW - 900, pt.x - 450)),
        y: Math.max(0, Math.min(VH - 400, pt.y - 200)),
        width: 900,
        height: 400,
      },
    });
    litShot = true;
  }
  expect(litShot).toBe(true);
});
