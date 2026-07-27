// Deterministic render-exam capture CLI.
// Usage:
//   bun run tools/exam/capture.ts --base-url <url> --hash <planHash> --plan-id <id> --out <dir>
//                                 [--target-zoom 0.75] [--locale en]
//                                 [--max-tiles 64] [--seam-margin 64]
//
// Drives a real browser against an already-running preview server, walks a
// camera grid over the solved plan at a fixed zoom, and writes the images plus
// scene.json. It never builds and never starts a server: the caller owns both,
// so a capture cannot silently shoot a stale bundle.
//
// --max-tiles caps the PLANNED grid only. Corrective shots draw on a further
// reserve of CORRECTIVE_RESERVE tiles above the cap, so a plan whose grid fills
// the budget exactly still gets a corrective pass; the reserve is echoed in the
// ledger as coverage.correctiveReserve.
//
// Exit codes:
//   0  captured; status is "complete" or a labelled "partial"
//   1  harness failure (bad flags, degenerate geometry, browser error)
//   2  --base-url is not serving
//   3  the page never became examinable (no READY, no exam hook, empty graph)
//
// A partial capture exits 0 on purpose. A plan that was only 90% covered is
// still worth examining, provided the ledger says which 10% is missing; failing
// the command would throw away the nine tenths that are good.

import { chromium, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import {
  collectGeometry,
  collectScene,
  type Geometry,
  type SceneCollection,
  type SceneElement,
} from "../../test/e2e/collect";
import {
  LABEL_MIN_ZOOM,
  CHIP_ICON_ONLY_MAX_ZOOM,
} from "../../src/canvas/ItemEdge";
import {
  computeCoverage,
  safeRegion,
  tileGrid,
  viewportFor,
  type CoverageElement,
  type Rect,
  type TileSpec,
  type Viewport,
} from "./tiling";
import {
  measurementsFor,
  worldRectKey,
  writeScene,
  type OverlayMask,
  type SceneDoc,
  type TileRecord,
} from "./scene";

// The exam camera handle the app installs under `?exam=1`. Declared locally
// rather than imported: the app declares it on `Window` from a module this CLI
// has no reason to load, and these three methods are the whole contract. The
// type is erased before any of it reaches the browser, so referring to it from
// inside a page.evaluate callback is safe.
type ExamHook = {
  setViewport(v: Viewport): void;
  fitView(): void;
  contentBounds(): Rect | null;
};
type ExamWindow = Window & { __stcExam?: ExamHook };

const VIEWPORT = { width: 1920, height: 1080 };
const DEVICE_SCALE_FACTOR = 2;
// Pulled back from every pane edge before a tile is judged: content flush
// against a screenshot border reads as clipped even when it is whole. Exported
// so the probe CLI frames a commanded camera against the same safe region a
// tile was shot in; two different insets would put the probe's centre somewhere
// the capture never framed.
export const RIM_INSET = 8;
// Neighbouring tiles share this fraction of a tile, so an element sitting on one
// tile's seam lands well inside its neighbour.
const TILE_OVERLAP = 0.15;
// React Flow's camera move is a synchronous transform, but the chip layer
// re-renders off the store's zoom; this is the settle before a shot.
const SETTLE_MS = 250;
// Past HOVER_INTENT_MS with margin. The pointer is parked in a pane corner
// before every shot so no hover-dim state is ever captured, and a shot taken
// inside the intent window would catch the transition.
const HOVER_CLEAR_MS = 400;
// Where the pointer is parked. Any point works as long as it is stable; a
// corner is the least likely to sit on an element.
const PARK_POINT = { x: 3, y: 3 };
// One corrective pass adds a tile per uncovered element; a second sees whether
// those tiles revealed anything new. Elements that survive their own corrective
// tile are bigger than a tile or otherwise unframeable, and further rounds
// cannot help them, so the loop stops rather than burning the tile budget.
const MAX_CORRECTIVE_ROUNDS = 3;
// Tiles the corrective pass may spend ABOVE --max-tiles. The planned grid is
// capped, and charging corrective shots to the same budget would leave a plan
// whose grid lands exactly on the cap with no corrective pass at all - which is
// the case that needs one most, since contentBounds unions chip extents as
// fixed world constants while a chip's true footprint at a zoom below 1 is
// larger, so the planned band systematically under-covers periphery chips.
const CORRECTIVE_RESERVE = 8;
// How far the achieved zoom may sit from the commanded one before the capture is
// called a failure, RELATIVE to the commanded zoom (floored at 1 so sub-1 zooms
// keep the absolute slack). The transform is assigned verbatim by d3-zoom, so
// this is not a tolerance for clamping - but the achieved value is read back out
// of getComputedStyle, which Chromium serialises to 6 significant digits, and
// that quantisation is the dominant term: at zoom 1.2345678 the read-back is
// 1.23457, already 2.2e-6 off. A future reader must not tighten this on the
// belief that the slack is float noise; scaling with the commanded value is what
// keeps a zoom above 1 from failing a capture that was in fact exact.
const ZOOM_EPS_RELATIVE = 1e-5;

// Element families a reviewer must read whole in a single shot: half a chip in
// one tile and half in another is two unreadable halves. Everything else (edge
// paths, bus bands, group slabs) may legitimately span shots.
//
// Exhaustive over the collector's kinds on purpose. A Set lookup would default a
// kind nobody classified to the permissive class, silently weakening coverage
// for it; as a total record, a new collector kind is a compile error here.
const KIND_CLASS: Record<SceneElement["kind"], "point" | "extended"> = {
  node: "point",
  chip: "point",
  junction: "point",
  glyph: "point",
  edge: "extended",
  band: "extended",
  group: "extended",
};

type Options = {
  baseUrl: string;
  hash: string;
  planId: string;
  out: string;
  targetZoom: number;
  locale: string;
  maxTiles: number;
  seamMargin: number;
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Options | string {
  let baseUrl: string | undefined;
  let hash: string | undefined;
  let planId: string | undefined;
  let out: string | undefined;
  let targetZoom = 0.75;
  let locale = "en";
  let maxTiles = 64;
  let seamMargin = 64;

  const value = (i: number): string | null => {
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) return null;
    return next;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = value(i);
    switch (a) {
      case "--base-url":
        if (v === null) return "error: --base-url requires a value";
        baseUrl = argv[++i];
        break;
      case "--hash":
        if (v === null) return "error: --hash requires a value";
        hash = argv[++i];
        break;
      case "--plan-id":
        if (v === null) return "error: --plan-id requires a value";
        planId = argv[++i];
        break;
      case "--out":
        if (v === null) return "error: --out requires a value";
        out = argv[++i];
        break;
      case "--target-zoom": {
        if (v === null) return "error: --target-zoom requires a value";
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n <= 0)
          return `error: --target-zoom must be a positive number, got "${v}"`;
        targetZoom = n;
        break;
      }
      case "--locale":
        if (v === null) return "error: --locale requires a value";
        locale = argv[++i]!;
        break;
      case "--max-tiles": {
        if (v === null) return "error: --max-tiles requires a value";
        const n = Number(argv[++i]);
        if (!Number.isInteger(n) || n < 1)
          return `error: --max-tiles must be an integer >= 1, got "${v}"`;
        maxTiles = n;
        break;
      }
      case "--seam-margin": {
        if (v === null) return "error: --seam-margin requires a value";
        const n = Number(argv[++i]);
        if (!Number.isFinite(n) || n < 0)
          return `error: --seam-margin must be a non-negative number, got "${v}"`;
        seamMargin = n;
        break;
      }
      default:
        return `error: unknown argument "${a}"`;
    }
  }

  if (baseUrl === undefined) return "error: --base-url is required";
  if (hash === undefined) return "error: --hash is required";
  if (planId === undefined) return "error: --plan-id is required";
  if (out === undefined) return "error: --out is required";

  return {
    baseUrl,
    hash,
    planId,
    out,
    targetZoom,
    locale,
    maxTiles,
    seamMargin,
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export type BootOptions = { baseUrl: string; hash: string; locale: string };

// The query string must precede the fragment: the app reads `?exam=1` from
// window.location.search, and anything after the `#` is fragment, not query.
export function examUrl(baseUrl: string, hash: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const frag = hash.startsWith("#") ? hash.slice(1) : hash;
  return `${base}/?exam=1#${frag}`;
}

// Open a page on the plan and wait until it is examinable. Mirrors the settled
// wait sequence of the placement screenshot spec, which is the recipe that made
// those shots reproducible across machines. Throws if any stage times out; the
// caller decides what a boot failure means.
export async function bootPage(
  browser: Browser,
  opts: BootOptions,
): Promise<{ page: Page; consoleErrors: string[] }> {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
  });
  const page = await context.newPage();

  // Attached before the first navigation so a boot-time error is not missed.
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    consoleErrors.push(`pageerror: ${err.message}`);
  });

  // The locale is read from localStorage in the i18n provider's initial state,
  // so it has to be set before the app boots or label text and its metrics
  // change under the camera.
  await page.addInitScript((locale: string) => {
    window.localStorage.setItem("aef.locale", locale);
  }, opts.locale);

  await page.goto(examUrl(opts.baseUrl, opts.hash), { waitUntil: "load" });

  await page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page
    .locator(".canvas-annot.bottom-right", { hasText: "READY" })
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  return { page, consoleErrors };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function paneFrame(scene: SceneCollection): Rect {
  // The pane in its OWN frame. Element clientRects and overlay rects are both
  // reported relative to the pane's top-left, so the pane's page position must
  // not be mixed back in here.
  return {
    x: 0,
    y: 0,
    width: scene.paneRect.width,
    height: scene.paneRect.height,
  };
}

function overlayRects(scene: SceneCollection): Rect[] {
  return scene.overlays.map((o) => ({
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
  }));
}

function overlayMasks(scene: SceneCollection): OverlayMask[] {
  return scene.overlays.map((o) => ({
    name: o.name,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
  }));
}

// The world rect a tile actually proves, which is the safe region mapped back
// through the ACHIEVED transform - not the tile the grid asked for. Coverage is
// then a statement about pixels that exist rather than about a camera command.
function achievedWorldRect(safe: Rect, transform: Viewport): Rect {
  return {
    x: (safe.x - transform.x) / transform.zoom,
    y: (safe.y - transform.y) / transform.zoom,
    width: safe.width / transform.zoom,
    height: safe.height / transform.zoom,
  };
}

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// Element ids come from the DOM and carry separators a path cannot; keep the
// mapping total and stable so two runs name the same file.
function slug(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "element" : cleaned.slice(0, 80);
}

// The file one corrective shot writes to. The slug alone is not enough: it is
// truncated, and ids that differ only past the cut collide - bus chip ids are
// "bus-edge-label-<edgeId>-drop" and "...-rise", so the two chips of one long
// edge id slug identically. Two records would then name one image and one of
// them would describe a picture that no longer exists. The index makes the name
// unique whatever the ids are, because no two corrective shots share one; the
// slug stays on for the reader.
export function correctiveFileName(index: number, id: string): string {
  return `20-corrective-${String(index).padStart(3, "0")}-${slug(id)}.png`;
}

// The commanded viewport is supposed to land verbatim: setViewport forwards to
// d3-zoom's zoom.transform, and the scale extent binds gestures and fitView, not
// that path. If it ever does not, nothing downstream notices on its own - tile
// rects and element rects are both derived from the ACHIEVED transform, so the
// coverage math stays self-consistent and still reports "complete" while the
// document swears the images are at the commanded zoom and the evaluator reads
// LOD tier off that number. There is no honest ledger to write for a clamped
// shot, so the run fails instead.
export function assertZoomAchieved(
  file: string,
  commanded: number,
  achieved: number,
): void {
  if (
    Math.abs(achieved - commanded) <=
    ZOOM_EPS_RELATIVE * Math.max(1, commanded)
  ) {
    return;
  }
  throw new Error(
    `${file}: commanded zoom ${commanded} but the viewport achieved ${achieved}; ` +
      `the camera was clamped or ignored, so no image can be labelled with the commanded zoom`,
  );
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------

type Shot = { record: TileRecord; worldRect: Rect; scene: SceneCollection };

type ShotRequest = {
  file: string;
  kind: TileRecord["kind"];
  row?: number;
  col?: number;
  center: { x: number; y: number };
};

async function shoot(
  page: Page,
  dir: string,
  cameraSafe: Rect,
  targetZoom: number,
  req: ShotRequest,
): Promise<Shot> {
  const commanded = viewportFor(req.center, targetZoom, cameraSafe);
  await page.evaluate((v: Viewport) => {
    (window as ExamWindow).__stcExam!.setViewport(v);
  }, commanded);
  await page.waitForTimeout(SETTLE_MS);
  // Park the pointer before the shot so no hover-dim state is captured: the
  // dimmed complement is a real render state, and catching it here would make
  // every unlit element look like a contrast defect.
  await page.mouse.move(PARK_POINT.x, PARK_POINT.y);
  await page.waitForTimeout(HOVER_CLEAR_MS);
  // scale: "css" makes image pixels equal CSS pixels, so every rect in the
  // ledger indexes the image directly despite deviceScaleFactor 2 (which stays
  // at 2 so text rasterises at retina quality for the reader).
  await page
    .locator(".react-flow")
    .screenshot({ path: path.join(dir, req.file), scale: "css" });

  const scene = await page.evaluate(collectScene);
  assertZoomAchieved(req.file, commanded.zoom, scene.transform.zoom);
  const pane = paneFrame(scene);
  // Recomputed per shot rather than reused from the planning pass: the chrome
  // that occludes the pane is measured, not assumed, and a tile records the safe
  // region that actually applied to it.
  const safe = safeRegion(pane, overlayRects(scene), RIM_INSET);

  // Published against the safe region, not the raw pane. An element that only
  // reaches the pane under the minimap or the zoom controls is in the image but
  // not visible in it, and the evaluator indexes images by exactly these rects -
  // it would be reading chrome and calling it an element.
  const elements: Record<string, Rect> = {};
  for (const el of scene.elements) {
    if (!intersects(el.clientRect, safe)) continue;
    elements[el.id] = el.clientRect;
  }

  return {
    record: {
      file: req.file,
      kind: req.kind,
      ...(req.row !== undefined ? { row: req.row } : {}),
      ...(req.col !== undefined ? { col: req.col } : {}),
      viewportTransform: scene.transform,
      safeRegion: safe,
      overlayMasks: overlayMasks(scene),
      elements,
    },
    worldRect: achievedWorldRect(safe, scene.transform),
    scene,
  };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function coverageElementsFrom(
  inventory: Map<string, SceneElement>,
): CoverageElement[] {
  return [...inventory.values()].map((el) => ({
    id: el.id,
    kind: KIND_CLASS[el.kind],
    worldRect: el.worldRect,
    ...(el.polyline !== undefined ? { polyline: el.polyline } : {}),
  }));
}

// Chip ids and owning-edge ids come from two different collectors, and only the
// geometry one reports the owner. Joining on the rounded world rect (worldRectKey,
// shared with the measurement pass, which recovers chip identity the same way) is
// safe only WITHIN one shot: both collections are then taken at the same camera
// with nothing changing in between, so the two views of one chip agree to the
// pixel. Across cameras they do not - a world rect is translation-invariant in
// exact arithmetic, but getBoundingClientRect is subpixel-quantised, and a shift
// of a hundredth of a world unit is enough to move a rounded key. A chip with no
// match simply carries no edgeId - a wrong owner would be worse than none.
function edgeIdByChipRect(geom: Geometry): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of geom.chips) {
    if (c.edgeId === "") continue;
    map.set(worldRectKey(c.left, c.top, c.right, c.bottom), c.edgeId);
  }
  return map;
}

// Fold one shot into the running collections: elements not seen before, the
// owning edge of any chip among them, and any edge path not seen before. The
// geometry read happens at THIS shot's camera, which is what keeps the chip join
// exact; reading it once and joining later would go silently sparse on every
// element first seen at a different tile.
async function absorbShot(
  page: Page,
  shot: Shot,
  inventory: Map<string, SceneElement>,
  chipOwner: Map<string, string>,
  edgePaths: Map<string, string>,
): Promise<void> {
  const geom = await page.evaluate(collectGeometry);
  const owners = edgeIdByChipRect(geom);
  for (const el of shot.scene.elements) {
    if (inventory.has(el.id)) continue;
    inventory.set(el.id, el);
    if (el.kind !== "chip") continue;
    const r = el.worldRect;
    const owner = owners.get(
      worldRectKey(r.x, r.y, r.x + r.width, r.y + r.height),
    );
    if (owner !== undefined) chipOwner.set(el.id, owner);
  }
  for (const edge of geom.edges) {
    if (!edgePaths.has(edge.id)) edgePaths.set(edge.id, edge.d);
  }
}

async function capture(opts: Options): Promise<number> {
  const dir = path.join(opts.out, opts.planId);
  await mkdir(dir, { recursive: true });

  const browser = await chromium.launch();
  try {
    let page: Page;
    let consoleErrors: string[];
    try {
      ({ page, consoleErrors } = await bootPage(browser, opts));
    } catch (err: unknown) {
      console.error(
        `error: ${opts.planId} never reached READY at ${examUrl(opts.baseUrl, opts.hash)}: ${String(err)}`,
      );
      return 3;
    }

    const hookPresent = await page.evaluate(
      () => (window as ExamWindow).__stcExam !== undefined,
    );
    if (!hookPresent) {
      console.error(
        `error: ${opts.planId} has no window.__stcExam; the page must be loaded with ?exam=1 before the fragment`,
      );
      return 3;
    }

    const contentRect = await page.evaluate(
      () => (window as ExamWindow).__stcExam!.contentBounds(),
    );
    if (contentRect === null) {
      console.error(`error: ${opts.planId} has an empty graph (no content bounds)`);
      return 3;
    }

    // Fit through the app's own fit path, so the overview frames exactly what
    // the app frames. Its zoom is clamped where a commanded viewport is not,
    // which is why the achieved transform is read back rather than derived.
    await page.evaluate(() => {
      (window as ExamWindow).__stcExam!.fitView();
    });
    await page.waitForTimeout(SETTLE_MS);
    await page.mouse.move(PARK_POINT.x, PARK_POINT.y);
    await page.waitForTimeout(HOVER_CLEAR_MS);
    await page
      .locator(".react-flow")
      .screenshot({ path: path.join(dir, "00-fit.png"), scale: "css" });
    const fitScene = await page.evaluate(collectScene);

    const paneAtFit = paneFrame(fitScene);
    const cameraSafe = safeRegion(paneAtFit, overlayRects(fitScene), RIM_INSET);
    if (cameraSafe.width <= 0 || cameraSafe.height <= 0) {
      console.error(
        `error: ${opts.planId} has no usable safe region: the pane (${paneAtFit.width}x${paneAtFit.height}) is fully occluded by chrome`,
      );
      return 1;
    }

    const fitRecord: TileRecord = {
      file: "00-fit.png",
      kind: "fit",
      viewportTransform: fitScene.transform,
      safeRegion: cameraSafe,
      overlayMasks: overlayMasks(fitScene),
      elements: Object.fromEntries(
        fitScene.elements
          .filter((el) => intersects(el.clientRect, cameraSafe))
          .map((el) => [el.id, el.clientRect]),
      ),
    };

    // A RangeError here is a harness failure, not a plan finding: it means the
    // content rect or the safe region came out degenerate, and no tiling of it
    // would mean anything. Let it reach the top-level handler.
    const grid = tileGrid(
      contentRect,
      cameraSafe,
      opts.targetZoom,
      TILE_OVERLAP,
    );
    const planned: TileSpec[] = grid.slice(0, opts.maxTiles);
    let capHit = grid.length > opts.maxTiles;

    // The fit overview is recorded but never counted: it is shot at a different
    // zoom, where the LOD state legitimately differs, so it can neither vouch
    // for an element at the target zoom nor spend the tile budget. Hence
    // `tiles.length - 1` wherever the cap is compared.
    const tiles: TileRecord[] = [fitRecord];
    const tileWorldRects: Rect[] = [];
    // The inventory has to be built at the TARGET zoom, not at fit: per-member
    // rate chips do not mount below the label LOD gate, and chips and junction
    // dots counter-scale, so their world footprint is zoom-specific. A plan
    // computed from a fit-zoom walk would cover elements that do not exist and
    // miss the ones that do.
    const inventory = new Map<string, SceneElement>();
    const chipOwner = new Map<string, string>();
    const edgePaths = new Map<string, string>();
    // The zoom the tile rects were actually built from. Equal to the commanded
    // one or the shot would have thrown, but the seam margin is converted to
    // world units with it anyway: one computation must not mix a commanded zoom
    // with rects measured at an achieved one.
    let shotZoom = opts.targetZoom;

    for (const tile of planned) {
      const shotResult = await shoot(page, dir, cameraSafe, opts.targetZoom, {
        file: `10-tile-r${tile.row}c${tile.col}.png`,
        kind: "tile",
        row: tile.row,
        col: tile.col,
        center: tile.center,
      });
      tiles.push(shotResult.record);
      tileWorldRects.push(shotResult.worldRect);
      shotZoom = shotResult.record.viewportTransform.zoom;
      await absorbShot(page, shotResult, inventory, chipOwner, edgePaths);
    }

    const seamMarginWorld = opts.seamMargin / shotZoom;
    let coverage = computeCoverage(
      coverageElementsFrom(inventory),
      tileWorldRects,
      seamMarginWorld,
    );

    let correctiveTiles = 0;
    // Elements that have already had a tile centred on them, so the loop below
    // can tell "not tried yet" from "tried and still uncovered".
    const attempted = new Set<string>();
    for (let round = 0; round < MAX_CORRECTIVE_ROUNDS; round++) {
      if (coverage.uncovered.length === 0) break;
      // An element that has already had a tile centred on it and is still
      // uncovered cannot be rescued by centring on it again: it is larger than
      // one tile at this zoom, or its geometry is not finite. Retrying would
      // spend the whole budget re-shooting the same failure.
      const pending = coverage.uncovered.filter(
        (u) => !attempted.has(u.id) && inventory.has(u.id),
      );
      if (pending.length === 0) break;

      for (const u of pending) {
        if (tiles.length - 1 >= opts.maxTiles + CORRECTIVE_RESERVE) {
          capHit = true;
          break;
        }
        attempted.add(u.id);
        const el = inventory.get(u.id)!;
        const shotResult = await shoot(page, dir, cameraSafe, opts.targetZoom, {
          file: correctiveFileName(correctiveTiles, u.id),
          kind: "corrective",
          center: centreOf(el.worldRect),
        });
        tiles.push(shotResult.record);
        tileWorldRects.push(shotResult.worldRect);
        correctiveTiles++;
        await absorbShot(page, shotResult, inventory, chipOwner, edgePaths);
      }

      coverage = computeCoverage(
        coverageElementsFrom(inventory),
        tileWorldRects,
        seamMarginWorld,
      );
    }

    // Measured at the camera the last shot left behind, which is the TARGET
    // zoom: chips counter-scale, so their world footprints are zoom-specific and
    // the frame that matters is the one the images were taken in. That
    // counter-scaling is the whole reason a chip-tier count here differs from
    // one taken at the app's fit camera - the LOD gate runs the other way, since
    // it suppresses chips BELOW its threshold and so can only lower a count at a
    // low fit zoom, never raise it. Both collectors are read
    // back to back with no camera move between them, which is what the chip join
    // inside measurementsFor requires. Whole-document collectors, so a tile
    // camera still returns the entire graph and not just what is on screen.
    const measured = measurementsFor(
      await page.evaluate(collectGeometry),
      await page.evaluate(collectScene),
    );

    const elements: SceneDoc["elements"] = {};
    for (const id of [...inventory.keys()].sort()) {
      const el = inventory.get(id)!;
      elements[id] = {
        kind: el.kind,
        ...(el.itemId !== undefined ? { itemId: el.itemId } : {}),
        ...(el.label !== undefined ? { label: el.label } : {}),
        worldRect: el.worldRect,
      };
    }

    const doc: SceneDoc = {
      planId: opts.planId,
      hash: opts.hash,
      url: examUrl(opts.baseUrl, opts.hash),
      locale: opts.locale,
      status: coverage.uncovered.length === 0 ? "complete" : "partial",
      viewport: {
        ...VIEWPORT,
        deviceScaleFactor: DEVICE_SCALE_FACTOR,
        screenshotScale: "css",
      },
      fit: fitScene.transform,
      contentRect,
      targetZoom: opts.targetZoom,
      lodGates: {
        labelMinZoom: LABEL_MIN_ZOOM,
        chipIconOnlyMaxZoom: CHIP_ICON_ONLY_MAX_ZOOM,
      },
      tiles,
      elements,
      edges: [...edgePaths].map(([id, d]) => ({ id, d })),
      chips: [...inventory.values()]
        .filter((el) => el.kind === "chip")
        .map((el) => {
          const owner = chipOwner.get(el.id);
          return {
            id: el.id,
            ...(owner !== undefined ? { edgeId: owner } : {}),
            text: el.label ?? "",
            worldRect: el.worldRect,
          };
        }),
      measurements: measured.measurements,
      crossingCensus: measured.crossingCensus,
      coverage: {
        targetZoom: opts.targetZoom,
        coveredCount: coverage.covered.length,
        uncovered: coverage.uncovered,
        correctiveTiles,
        correctiveReserve: CORRECTIVE_RESERVE,
        capHit,
      },
      consoleErrors,
    };

    const file = await writeScene(dir, doc);
    console.log(
      `${opts.planId}: ${doc.status}, ${tiles.length - 1} tiles (${correctiveTiles} corrective), ` +
        `${coverage.covered.length} covered, ${coverage.uncovered.length} uncovered -> ${file}`,
    );
    for (const u of coverage.uncovered) {
      console.log(`  uncovered ${u.kind} ${u.id}: ${u.reason}`);
    }
    return 0;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (import.meta.main) {
  const parsed = parseArgs(process.argv.slice(2));
  if (typeof parsed === "string") {
    console.error(parsed);
    process.exit(1);
  }

  // Checked before the browser launches: a base URL that is not serving is by
  // far the most common way to run this, and a Playwright timeout would report
  // it as a missing node thirty seconds later.
  if (!(await reachable(parsed.baseUrl))) {
    console.error(`error: --base-url is not serving: ${parsed.baseUrl}`);
    process.exit(2);
  }

  try {
    process.exit(await capture(parsed));
  } catch (err: unknown) {
    console.error("fatal:", err);
    process.exit(1);
  }
}
