import { expect, test } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Issue #42: fixed row chrome left .rn-row .lbl 65-83px of a 150px half-card,
// so sibling rows sharing a long prefix ellipsized to the byte-identical
// visible string ("Dense Orig..." twice on equip4's Refining Unit). Guard the
// reader-facing failure directly: no two DIFFERENT item names inside one card
// may render the same visible string. Stronger and more stable than asserting
// zero clipped rows (some truncation is fine while strings stay distinct).
for (const id of ["default", "equip4"] as const) {
  test(`no within-card visible-string collisions: ${id}`, async ({ page }) => {
    const scenario = SCENARIOS.find((s) => s.id === id)!;
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      // The audit corpus polices the bus machinery, so every spec opts the
      // toggle on explicitly; the app default (off since the bus-lanes flip)
      // is a product decision this suite does not re-test.
      window.localStorage.setItem("aef.busLanes", "on");
    });
    await page.goto("/#" + (await scenarioHash(scenario)), {
      waitUntil: "load",
    });
    await page
      .locator(".rn-row .lbl")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const collisions = await page.evaluate(() => {
      const out: string[] = [];
      for (const card of document.querySelectorAll(".recipe-node")) {
        const seen = new Map<string, string>();
        for (const el of card.querySelectorAll<HTMLElement>(".rn-row .lbl")) {
          const full = el.textContent ?? "";
          let visible = full;
          if (el.scrollWidth > el.clientWidth + 1) {
            // Binary-search the longest prefix that fits with the ellipsis,
            // measured in the label's own font.
            const probe = document.createElement("span");
            const cs = getComputedStyle(el);
            probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font};letter-spacing:${cs.letterSpacing};`;
            document.body.appendChild(probe);
            let lo = 0;
            let hi = full.length;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              probe.textContent = full.slice(0, mid) + "\u2026";
              if (probe.getBoundingClientRect().width <= el.clientWidth)
                lo = mid;
              else hi = mid - 1;
            }
            visible = full.slice(0, lo) + "\u2026";
            probe.remove();
          }
          const prev = seen.get(visible);
          if (prev !== undefined && prev !== full) {
            out.push(`"${visible}": "${prev}" vs "${full}"`);
          }
          seen.set(visible, full);
        }
      }
      return out;
    });
    expect(collisions).toEqual([]);
  });
}
