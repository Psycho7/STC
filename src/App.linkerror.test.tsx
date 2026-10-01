// @vitest-environment jsdom
//
// A share link whose payload fails to decode reads as a friendly localized
// reason on both surfaces - the banner over a drawn plan and the splash on
// first load - while the raw decoder text stays in a collapsed <details> for
// bug reports.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [] })),
  };
});

vi.mock("./canvas/Canvas", () => ({ default: () => null }));

import App from "./App";
import { loadI18n, type Locale } from "./data/i18n";
import { describePlanLoadError, loadPlan } from "./data/plan";
import { pack } from "./data/load";

// Envelope and base64url are well-formed, but the bytes are not a gzip
// stream, so the decoder throws with its own raw message. The message text
// depends on the runtime's inflater ("incorrect header check" in a browser), so
// the expected raw line is taken from the loader itself.
const BAD_GZIP_HASH = "#v1.AAAAAAAAAAAAAAAA";

async function rawDecoderText(): Promise<string> {
  const outcome = await loadPlan(BAD_GZIP_HASH, pack);
  if (outcome.kind !== "error" || outcome.error.kind !== "malformed-hash") {
    throw new Error("bad-gzip hash unexpectedly decoded");
  }
  expect(outcome.error.reason).toMatch(/^wire decode failed:/);
  return describePlanLoadError(outcome.error);
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function expectFriendlyWithRawDetails(
  alert: HTMLElement,
  locale: Locale,
) {
  const i18n = loadI18n(locale);
  const details = alert.querySelector("details");
  expect(details).not.toBeNull();
  expect(details!.open).toBe(false);
  const summary = details!.querySelector("summary");
  expect(summary?.textContent).toBe(i18n.t("app.error.details"));
  // The raw decoder text lives only inside the collapsed details.
  const raw = await rawDecoderText();
  expect(details!.textContent).toBe(`${summary!.textContent}${raw}`);
  const outside = (alert.textContent ?? "").replace(
    details!.textContent ?? "",
    "",
  );
  expect(outside).toContain(i18n.t("app.error.link-broken"));
  expect(outside).not.toMatch(/wire decode|parse URL hash/);
}

for (const locale of ["en", "zh"] as const) {
  test(`${locale}: a bad-gzip link on first load shows the friendly reason on the splash`, async () => {
    window.localStorage.setItem("aef.locale", locale);
    window.location.hash = BAD_GZIP_HASH;
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      loadI18n(locale).t("app.error.corrupt"),
    );
    await expectFriendlyWithRawDetails(alert, locale);
  });

  test(`${locale}: a bad-gzip link over a drawn plan shows the friendly reason on the banner`, async () => {
    window.localStorage.setItem("aef.locale", locale);
    render(<App />);
    await screen.findAllByTestId("target-row");
    await waitFor(() => expect(window.location.hash).not.toBe(""));

    window.location.hash = BAD_GZIP_HASH;

    const alert = await screen.findByRole("alert");
    await expectFriendlyWithRawDetails(alert, locale);
    expect(screen.getAllByTestId("target-row").length).toBe(3);
  });
}
