import { expect, test } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Two guards over what a reader can actually make out on a card, run on every
// corpus plan in both supported locales.
//
// Titles (issues #42 / #84): no two different machine names may render the same
// visible title on one plan. It measures what the READER sees, not textContent,
// because comparing textContent is blind to raw-fallback titles, where CSS tail
// ellipsis clips a string the DOM still carries in full. So when a title
// overflows its box, a hidden span in its own font binary-searches the longest
// prefix that fits with an ellipsis, and that prefix is the visible string.
//
// Rows: no row's text may be painted over by another's (see the comment on
// OVERLAP_EPS_PX below), and no label already carrying an ellipsis may still
// overflow its box.

// The row half of this file no longer measures distinctness at all. Ruling I8
// of docs/plans/2026-09-15-catalyst-exam-fixes.md deletes the tail-keeping and
// partial-window elision tiers: every name is now cut at its tail, so two items
// whose names agree up to the cut render the same visible string BY DESIGN
// (the Jincao / Yazhen bottles, the heavy-xiranite residues). Reporting that as
// a collision would be reporting the ruling.
//
// What a reader can still lose is a row whose text is painted over, so that is
// what the rows are measured for now: the rate's box interpenetrating its own
// row's name box (the defect the absolute, opaque rate overlay used to cause,
// I1), and any two rows' text boxes lying on each other. Both are geometry, not
// strings, and neither can be satisfied by a naming decision. Strict
// interpenetration on BOTH axes: grid cells abut by construction, and two
// independently laid out client rects touch at subpixel rounding.
const OVERLAP_EPS_PX = 0.5;

// The app's locale switcher carries English and Chinese only (the ja and ru
// UI locales were dropped from the Locale union), so those are the two a page
// can actually boot into. The pack still ships ja and ru names, but nothing
// can render them, and a spec that set the key to "ru" would silently measure
// English.
const LOCALES = ["en", "zh"] as const;

test.describe("visible machine-title collisions", () => {
  for (const scenario of SCENARIOS) {
    for (const locale of LOCALES) {
      test(`${locale} ${scenario.id} titles`, async ({ page }) => {
        await bootExamPage(page, {
          url: "/#" + (await scenarioHash(scenario)),
          locale,
          area: scenario.area,
          readiness: "nodes",
          settle: "webfonts",
        });
        await page
          .locator(".machine-title .cn")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        const { collisions, titles } = await page.evaluate(() => {
          // Keyed by the RAW title string (the title attribute), so several
          // cards of one machine are legal and the guard compares only
          // genuinely different names. No allow-list: the only byte-identical
          // machine names (the settlement pair) never co-render in the corpus
          // and are invisible to a raw-name-keyed guard by construction --
          // the same data-defect class as the recorded row pair.
          const seen = new Map<string, string>();
          const out: { readout: string; a: string; b: string }[] = [];
          let titles = 0;
          for (const cn of document.querySelectorAll<HTMLElement>(
            ".machine-title .cn",
          )) {
            const full = cn.getAttribute("title") ?? "";
            if (full === "") continue;
            titles++;
            // Baseline is the RENDERED string (the helper owns it and it
            // fits by construction), mirroring the row guard; only the
            // raw+CSS-clipped titles overflow and take the probe below.
            let visible = cn.textContent ?? "";
            if (cn.scrollWidth > cn.clientWidth + 1) {
              const probe = document.createElement("span");
              const cs = getComputedStyle(cn);
              probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};`;
              document.body.appendChild(probe);
              let lo = 0;
              let hi = full.length;
              while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                probe.textContent = full.slice(0, mid) + "\u2026";
                if (probe.getBoundingClientRect().width <= cn.clientWidth)
                  lo = mid;
                else hi = mid - 1;
              }
              visible = full.slice(0, lo) + "\u2026";
              probe.remove();
            }
            const prev = seen.get(visible);
            if (prev === undefined) {
              seen.set(visible, full);
            } else if (prev !== full) {
              out.push({ readout: visible, a: prev, b: full });
            }
          }
          return { collisions: out, titles };
        });
        // Selector-drift guard: every corpus plan carries recipe cards.
        expect(titles).toBeGreaterThan(0);
        expect(
          collisions,
          `title collisions:\n${collisions
            .map((c) => `"${c.readout}": ${c.a} vs ${c.b}`)
            .join("\n")}`,
        ).toEqual([]);
      });
    }
  }
});

test.describe("row text overlaps", () => {
  for (const scenario of SCENARIOS) {
    for (const locale of LOCALES) {
      test(`${locale} ${scenario.id}`, async ({ page }) => {
        await bootExamPage(page, {
          url: "/#" + (await scenarioHash(scenario)),
          locale,
          area: scenario.area,
          readiness: "nodes",
          settle: "webfonts",
        });
        // The measured elements themselves: a card is on screen before its
        // rows are.
        await page
          .locator(".rn-row .lbl")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        const { overlaps, rows, overflowing } = await page.evaluate((eps) => {
          type Box = {
            what: string;
            x: number;
            y: number;
            right: number;
            bottom: number;
          };
          const boxes: Box[] = [];
          const overlaps: string[] = [];
          const overflowing: string[] = [];
          let rows = 0;
          for (const row of document.querySelectorAll(".rn-row")) {
            const handle = row.querySelector<HTMLElement>("[data-handleid]");
            const lbl = row.querySelector<HTMLElement>(".lbl");
            const rate = row.querySelector<HTMLElement>(".rate");
            if (handle === null || lbl === null || rate === null) continue;
            rows++;
            const id = handle.getAttribute("data-handleid") ?? "";
            const item = id.replace(/^(?:in|out|cat):/, "");
            if (item === "" || item === id) continue;
            const full = lbl.textContent ?? "";
            for (const [what, el] of [
              [`${item} name`, lbl],
              [`${item} rate`, rate],
            ] as const) {
              const r = el.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) continue;
              boxes.push({
                what,
                x: r.x,
                y: r.y,
                right: r.right,
                bottom: r.bottom,
              });
            }
            if (lbl.scrollWidth > lbl.clientWidth + 1) {
              // The helper OWNS the visible string, so a label carrying its
              // ellipsis must already fit its box: overflowing means the
              // budget the helper elided against was wider than the box the
              // row actually gives, and CSS is clipping a string that was
              // already cut once. That is how the sprite-column slip stayed
              // invisible (the budget asked iconPosition for the raw item id,
              // which misses the renamed icons, and handed the label the
              // sprite's width while the sprite was on screen using it).
              if (full.indexOf("\u2026") >= 0) {
                overflowing.push(
                  `${full} (${lbl.scrollWidth} > ${lbl.clientWidth})`,
                );
              }
            }
          }

          // Every text box on the page against every other. A row's own name
          // and rate are in the list alongside the other rows' pairs, so the
          // rate-over-name case needs no rule of its own.
          for (const [i, a] of boxes.entries()) {
            for (const b of boxes.slice(i + 1)) {
              const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
              const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
              if (dx > eps && dy > eps) {
                overlaps.push(
                  `${a.what} x ${b.what}: ${dx.toFixed(1)}x${dy.toFixed(1)}px`,
                );
              }
            }
          }
          return { overlaps, rows, overflowing };
        }, OVERLAP_EPS_PX);
        // Selector-drift guard: an audit that measured nothing proves
        // nothing. Every corpus plan carries at least one recipe row.
        expect(rows).toBeGreaterThan(0);
        expect(
          overflowing,
          `elided labels that still overflow their box:\n${overflowing.join("\n")}`,
        ).toEqual([]);
        expect(
          overlaps,
          `row text boxes standing on each other:\n${overlaps.join("\n")}`,
        ).toEqual([]);
      });
    }
  }
});
