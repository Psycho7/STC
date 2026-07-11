import { test, expect, type Page } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";

// The P1 acceptance gate for the placement campaign: a DOM-geometry audit run
// against the live client rects the user actually sees. Two invariants per
// scenario at fit zoom on 1920x1080:
//   (a) no two .flow-chip boxes overlap (chips counter-scale about their centre,
//       so their client rects are the on-screen boxes - no unscaling needed);
//   (b) every recipe handle sits vertically centred on its .rn-row (handles are
//       row-embedded, xyflow centres them with top:50% translate(-50%,-50%)).
// Nothing is selected during measurement: a selected node draws a 2px border vs
// the normal 1px, which shifts rects. The spec only loads and reads - no clicks.

test.use({ viewport: { width: 1920, height: 1080 } });

// Chips can legitimately abut edge-to-edge when the trunk pitch equals the
// max-scale box height (boxes touch at zoom <= 0.5). A shared boundary
// (a.bottom == b.top) is not an overlap, so require strict interpenetration of
// more than this many pixels on BOTH axes before flagging a pair.
const OVERLAP_EPS_PX = 0.5;
// Row-embedded handles centre on their row via CSS; the only slack is subpixel
// rounding of two independently laid-out client rects.
const HANDLE_CENTER_TOL_PX = 1;

type ChipRect = {
  label: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type RowCenter = {
  nodeId: string;
  item: string;
  rowClass: string;
  rowCenterY: number;
  handleCenterY: number | null;
};

// Per recipe node that shows a machine-multiplier chip: the chip's box and the
// adjacent rate-block box. Audit issue 5 was the old absolute .rn-mult-badge
// overlapping the rate figures; the promoted header cell must keep them apart.
type MultPair = {
  nodeId: string;
  chip: ChipRect;
  rate: ChipRect;
};

type AuditData = {
  chips: ChipRect[];
  rows: RowCenter[];
  multPairs: MultPair[];
  recipeNodeCount: number;
};

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 30_000 });
}

// Fit-view is a one-shot, no-animation camera move applied once layout lands.
// Measuring mid-move would read stale rects, so block until the viewport
// transform holds identical across two animation frames.
async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (vp === null) return false;
      const now = vp.style.transform;
      const prev = (vp as unknown as { __auditPrevTransform?: string })
        .__auditPrevTransform;
      (vp as unknown as { __auditPrevTransform?: string }).__auditPrevTransform =
        now;
      return prev !== undefined && prev === now && now !== "";
    },
    undefined,
    { timeout: 10_000, polling: "raf" },
  );
}

function collectAudit(): AuditData {
  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label:
        el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "(chip)",
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });

  const toRect = (el: HTMLElement, label: string): ChipRect => {
    const r = el.getBoundingClientRect();
    return {
      label,
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };

  const recipeNodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node-recipe"),
  );
  const rows: RowCenter[] = [];
  const multPairs: MultPair[] = [];
  for (const node of recipeNodes) {
    const nodeId = node.getAttribute("data-id") ?? "(node)";
    const chipEl = node.querySelector<HTMLElement>(".rn-mult-chip");
    const rateEl = node.querySelector<HTMLElement>(".rn-rate-block");
    if (chipEl !== null && rateEl !== null) {
      multPairs.push({
        nodeId,
        chip: toRect(chipEl, "mult-chip"),
        rate: toRect(rateEl, "rate-block"),
      });
    }
    for (const row of Array.from(
      node.querySelectorAll<HTMLElement>(".rn-row"),
    )) {
      const rr = row.getBoundingClientRect();
      const handle = row.querySelector<HTMLElement>(".react-flow__handle");
      const hr = handle?.getBoundingClientRect() ?? null;
      rows.push({
        nodeId,
        item:
          row.querySelector(".lbl")?.getAttribute("title") ??
          row.className,
        rowClass: row.className,
        rowCenterY: rr.y + rr.height / 2,
        handleCenterY: hr === null ? null : hr.y + hr.height / 2,
      });
    }
  }

  return { chips, rows, multPairs, recipeNodeCount: recipeNodes.length };
}

// Strict interpenetration on both axes, beyond the abutment epsilon.
function overlapPx(
  a: ChipRect,
  b: ChipRect,
): { dx: number; dy: number } | null {
  const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  if (dx > OVERLAP_EPS_PX && dy > OVERLAP_EPS_PX) return { dx, dy };
  return null;
}

function fmtRect(r: ChipRect): string {
  return `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}]`;
}

test.describe("DOM geometry audit", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
  });

  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      await page.goto(`/#${hash}`, { waitUntil: "load" });
      await waitForCanvasReady(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForStableViewport(page);

      const { chips, rows, multPairs, recipeNodeCount } =
        await page.evaluate(collectAudit);

      // (a) Zero pairwise chip overlaps. Collect the full inventory so one run
      // reports every offending pair, not just the first.
      const overlaps: string[] = [];
      for (let i = 0; i < chips.length; i++) {
        for (let j = i + 1; j < chips.length; j++) {
          const hit = overlapPx(chips[i]!, chips[j]!);
          if (hit !== null) {
            overlaps.push(
              `"${chips[i]!.label}" ${fmtRect(chips[i]!)} vs ` +
                `"${chips[j]!.label}" ${fmtRect(chips[j]!)} ` +
                `overlap ${hit.dx.toFixed(1)}x${hit.dy.toFixed(1)}px`,
            );
          }
        }
      }

      // (b) Every row handle centred on its row (vertical axis).
      const offCenter: string[] = [];
      for (const row of rows) {
        if (row.handleCenterY === null) {
          offCenter.push(
            `${row.nodeId} row "${row.item}" (${row.rowClass}) has no handle`,
          );
          continue;
        }
        const delta = Math.abs(row.handleCenterY - row.rowCenterY);
        if (delta > HANDLE_CENTER_TOL_PX) {
          offCenter.push(
            `${row.nodeId} row "${row.item}" (${row.rowClass}) ` +
              `handle centre off by ${delta.toFixed(2)}px ` +
              `(row ${row.rowCenterY.toFixed(1)}, handle ${row.handleCenterY.toFixed(1)})`,
          );
        }
      }

      // (c) The machine-multiplier chip and the rate block never overlap. The
      // promoted header cell replaced the old absolute .rn-mult-badge overlay
      // (audit issue 5); the two boxes must stay disjoint on every node that
      // shows a chip.
      const chipCollisions: string[] = [];
      for (const pair of multPairs) {
        const hit = overlapPx(pair.chip, pair.rate);
        if (hit !== null) {
          chipCollisions.push(
            `${pair.nodeId}: mult-chip ${fmtRect(pair.chip)} overlaps ` +
              `rate-block ${fmtRect(pair.rate)} by ` +
              `${hit.dx.toFixed(1)}x${hit.dy.toFixed(1)}px`,
          );
        }
      }

      // Handle centring is a per-node CSS invariant independent of chip layout;
      // assert it first so that if a scenario also has chip overlaps, reaching
      // the overlap assertion still confirms the handles were centred.
      expect(
        offCenter,
        `${scenario.id}: ${offCenter.length} off-centre handle(s) among ${rows.length} rows in ${recipeNodeCount} recipe node(s):\n${offCenter.join("\n")}`,
      ).toEqual([]);
      expect(
        chipCollisions,
        `${scenario.id}: ${chipCollisions.length} mult-chip/rate-block overlap(s) among ${multPairs.length} chipped node(s):\n${chipCollisions.join("\n")}`,
      ).toEqual([]);
      expect(
        overlaps,
        `${scenario.id}: ${overlaps.length} chip overlap(s) among ${chips.length} chips:\n${overlaps.join("\n")}`,
      ).toEqual([]);
    });
  }
});
