import { expect, test } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Issue #42 guarded no two different item names inside ONE card rendering
// the same visible string. Issue #84 widens it to the whole plan, both
// supported locales, with a seen-map per PAGE keyed by the row's handle item id: no
// two DIFFERENT item ids may render the same visible label + rate readout
// in one plan. The refinement round 2 adds the TITLE surface: no two
// different machine names may render the same visible title prefix on one
// plan (the partial-tail tier was measured colliding the ru module titles
// -- "Modul upakovki" and "Modul formovki", Packaging and Moulding --
// onto one shared stem-plus-ending window).
//
// The guard measures what the READER sees, not textContent: the refinement
// round found that comparing textContent is blind to raw-fallback rows,
// where CSS tail ellipsis clips the string the DOM still carries in full
// (that blindness hid 25 collisions, identical on develop and on the first
// implementation). So the probe is the #42 measurement, lifted from one
// card to one page: when a .lbl overflows its box, a hidden span in the
// label's own font binary-searches the longest prefix that fits with an
// ellipsis, and that prefix is the visible string. Titles are single-line
// and take the same probe on `.machine-title .cn`.
//
// The products subtitle is NOT probed here: its two-line -webkit-line-clamp
// wraps, and a single-line binary search does not model what the clamp
// shows. That surface is guarded by the offline vitest replay over the
// pinned corpus fixture (test/canvas/subtitle-replay.test.ts), recorded in
// the elision plan.

// Known data defect, recorded in the plan for #84 as a residue: this pair
// carries byte-identical display names in every locale, so no elision
// rule can separate them. Needs a data or naming decision of its own; until
// then their collisions are reported, not failed.
const KNOWN_IDENTICAL_PAIRS = new Set([
  "glass_bottle|transfer_tundra_glass_bottle",
  "transfer_tundra_glass_bottle|glass_bottle",
]);

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
        await page.addInitScript(
          (l) => {
            window.localStorage.setItem("aef.locale", l);
            window.localStorage.setItem("aef.busLanes", "on");
          },
          locale,
        );
        await page.goto("/#" + (await scenarioHash(scenario)), {
          waitUntil: "load",
        });
        await page
          .locator(".machine-title .cn")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        await waitForWebfonts(page);
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
            let visible = full;
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

test.describe("visible row-label collisions", () => {
  for (const scenario of SCENARIOS) {
    for (const locale of LOCALES) {
      test(`${locale} ${scenario.id}`, async ({ page }) => {
        // The audit corpus polices the bus machinery, so every spec opts the
        // toggle on explicitly; the app default (off since the bus-lanes
        // flip) is a product decision this suite does not re-test.
        await bootExamPage(page, {
          url: "/#" + (await scenarioHash(scenario)),
          locale,
          busLanes: "on",
          readiness: "nodes",
          settle: "webfonts",
        });
        // The measured elements themselves: a card is on screen before its
        // rows are.
        await page
          .locator(".rn-row .lbl")
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        const { collisions, rows } = await page.evaluate(() => {
          const seen = new Map<string, string>();
          const out: { readout: string; a: string; b: string }[] = [];
          let rows = 0;
          for (const row of document.querySelectorAll(".rn-row")) {
            const handle = row.querySelector<HTMLElement>("[data-handleid]");
            const lbl = row.querySelector<HTMLElement>(".lbl");
            const rate = row.querySelector<HTMLElement>(".rate");
            if (handle === null || lbl === null || rate === null) continue;
            rows++;
            const id = handle.getAttribute("data-handleid") ?? "";
            const item = id.replace(/^(?:in|out):/, "");
            if (item === "" || item === id) continue;
            const full = lbl.textContent ?? "";
            let visible = full;
            if (lbl.scrollWidth > lbl.clientWidth + 1) {
              // Binary-search the longest prefix that fits with the
              // ellipsis, measured in the label's own font.
              const probe = document.createElement("span");
              const cs = getComputedStyle(lbl);
              probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};`;
              document.body.appendChild(probe);
              let lo = 0;
              let hi = full.length;
              while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                probe.textContent = full.slice(0, mid) + "\u2026";
                if (probe.getBoundingClientRect().width <= lbl.clientWidth)
                  lo = mid;
                else hi = mid - 1;
              }
              visible = full.slice(0, lo) + "\u2026";
              probe.remove();
            }
            const readout = `${visible}|${rate.textContent ?? ""}`;
            const prev = seen.get(readout);
            if (prev === undefined) {
              seen.set(readout, item);
            } else if (prev !== item) {
              out.push({ readout, a: prev, b: item });
            }
          }
          return { collisions: out, rows };
        });
        // Selector-drift guard: an audit that measured nothing proves
        // nothing. Every corpus plan carries at least one recipe row.
        expect(rows).toBeGreaterThan(0);
        const novel = collisions.filter(
          (c) => !KNOWN_IDENTICAL_PAIRS.has(`${c.a}|${c.b}`),
        );
        expect(
          novel,
          `label+rate collisions (beyond the recorded identical-name pair):\n${novel
            .map((c) => `"${c.readout}": ${c.a} vs ${c.b}`)
            .join("\n")}`,
        ).toEqual([]);
      });
    }
  }
});
