// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { InputsPanel } from "./InputsPanel";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

const PACK = {
  items: [{ id: "widget", icon: "widget" }],
  recipes: [],
} as unknown as RecipePack;

// 40/27 items per second -> *60 = 800/9 items per minute, a non-terminating
// decimal. The realized-demand readout must show the exact fraction (matching
// the canvas ProductNode), never the raw 88.8888888888889 float.
test("realized input demand renders as an exact fraction, not a raw float", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[]}
        onChange={() => {}}
        pack={PACK}
        assumedRawItemIds={["widget"]}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

// The override-row readout is a separate JSX path from the auto-row above and
// was changed by the same fix, so cover both override flavors.
test("realized demand on an uncapped override row renders as an exact fraction", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget" }]}
        onChange={() => {}}
        pack={PACK}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});

test("realized demand on a capped override row renders as an exact fraction", () => {
  render(
    <LocaleProvider locale="en">
      <InputsPanel
        itemOverrides={[{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
        realizedRateByItem={new Map([["widget", { num: "40", denom: "27" }]])}
      />
    </LocaleProvider>,
  );

  const readout = screen.getByTestId("input-realized-rate");
  expect(readout.textContent).toContain("800/9");
  expect(readout.textContent).not.toMatch(/\d\.\d{3,}/);
});
