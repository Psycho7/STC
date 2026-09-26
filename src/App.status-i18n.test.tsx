// @vitest-environment jsdom
//
// The header status chip speaks the UI locale. The Status enum itself stays
// English (the canvas corner annotation and the exam tooling read it); only
// the chip's rendered text goes through i18n.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({
      nodes: [],
      edges: [],
      gaps: [],
      baseEdges: [],
    })),
  };
});

import App from "./App";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";
import { loadI18n } from "./data/i18n";
import { LOCALE_STORAGE_KEY } from "./data/storage-keys";

beforeEach(() => {
  // @xyflow/react's canvas requires ResizeObserver; jsdom has none.
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
  window.localStorage.clear();
});

async function statusChipText(locale: "en" | "zh"): Promise<string> {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  window.location.hash = "#" + (await encodePlan(defaultPlan(pack)));
  render(<App />);
  await screen.findAllByTestId("target-row");
  const chip = await screen.findByTestId("status-chip");
  await waitFor(() =>
    expect(chip.textContent).toBe(loadI18n(locale).t("app.status.ready")),
  );
  return chip.textContent ?? "";
}

test("the zh status chip reads the Chinese READY word", async () => {
  expect(await statusChipText("zh")).toBe("就绪");
});

test("the en status chip keeps READY", async () => {
  expect(await statusChipText("en")).toBe("READY");
});

test("the status words are localized in zh and unchanged in en", () => {
  const zh = loadI18n("zh");
  const en = loadI18n("en");
  expect([
    zh.t("app.status.ready"),
    zh.t("app.status.shortfall"),
    zh.t("app.status.error"),
    zh.t("app.status.solving"),
  ]).toEqual(["就绪", "产量不足", "错误", "求解中"]);
  expect([
    en.t("app.status.ready"),
    en.t("app.status.shortfall"),
    en.t("app.status.error"),
    en.t("app.status.solving"),
  ]).toEqual(["READY", "SHORTFALL", "ERROR", "SOLVING"]);
});

test("the zh empty-inputs hint carries no English word raw", () => {
  expect(loadI18n("zh").t("inputs.empty")).not.toMatch(/raw/i);
});
