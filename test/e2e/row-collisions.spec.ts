import { expect, test } from "@playwright/test";
import { bootExamPage } from "./viewport";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Issue #42 guarded no two different item names inside ONE card rendering
// the same visible string, on two scenarios, in en. Issue #84 widens it:
// the tail-preserving elision helper owns the visible row label, so
// textContent IS what the reader sees (no binary-search probe anymore), and
// the seen-map is per PAGE across the whole plan, over the full scenario
// corpus and both supported locales. The compared unit is the visible label plus
// the rate beside it, keyed by the item id the row's handle carries: no two
// DIFFERENT item ids may render the same label+rate readout in one plan.

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
            const readout = `${lbl.textContent ?? ""}|${rate.textContent ?? ""}`;
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
