// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RecipePack } from "@aef/schema";
import { usePickerFlow } from "./usePickerFlow";
import { LocaleProvider } from "../data/i18n-context";
import { loadI18n } from "../data/i18n";
import type { ProducerUnavailableCause } from "../data/plan";

afterEach(cleanup);

const PACK = { items: [], recipes: [], machines: [] } as unknown as RecipePack;

function wrapper({ children }: { children: ReactNode }) {
  return <LocaleProvider locale="en">{children}</LocaleProvider>;
}

function setup() {
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  const hook = renderHook(
    () => usePickerFlow<string, string>(PACK, PACK.items, new Map()),
    { wrapper },
  );
  return { trigger, hook };
}

test("closePicker clears the picker and hands focus back to its trigger", () => {
  const { trigger, hook } = setup();
  act(() => hook.result.current.openPicker(trigger, "row-a"));
  expect(hook.result.current.pickerFor).toBe("row-a");
  act(() => hook.result.current.closePicker());
  expect(hook.result.current.pickerFor).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("a pick into the prompt keeps the trigger for cancelPrompt", () => {
  const { trigger, hook } = setup();
  act(() => hook.result.current.openPicker(trigger, "add"));
  act(() => hook.result.current.openPrompt("item"));
  expect(hook.result.current.pickerFor).toBeNull();
  expect(hook.result.current.prompt).toBe("item");
  expect(document.activeElement).not.toBe(trigger);
  act(() => hook.result.current.cancelPrompt());
  expect(hook.result.current.prompt).toBeNull();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

test("an armed focus token is consumed by the matching row only", () => {
  const { hook } = setup();
  const el = document.createElement("input");
  document.body.appendChild(el);
  hook.result.current.armFocus("row-a", "rate");
  hook.result.current.focusOnMount(el, "row-a", "trigger");
  hook.result.current.focusOnMount(el, "row-b", "rate");
  expect(document.activeElement).not.toBe(el);
  hook.result.current.focusOnMount(el, "row-a", "rate");
  expect(document.activeElement).toBe(el);
  el.remove();
});

// The disabled hint, one case per cause kind: every kind the availability core
// can hand over has to explain itself in the picker, and the event wording is
// the one that must stay byte-identical to what the validation error names.
const CATALOGUE = [{ id: "gadget" }] as unknown as RecipePack["items"];

function hintFor(
  causes: ReadonlyArray<[string, ProducerUnavailableCause]>,
): string | undefined {
  const hook = renderHook(
    () => usePickerFlow<string, string>(PACK, CATALOGUE, new Map(causes)),
    { wrapper },
  );
  return hook.result.current.unavailableHint;
}

test("an event cause names the cohort the validation error also names", () => {
  expect(hintFor([["gadget", { kind: "event", cohort: "v1.5" }]])).toBe(
    loadI18n("en").t("picker.event.off", { cohorts: "v1.5" }),
  );
});

test("an area cause points at the area setting", () => {
  expect(hintFor([["gadget", { kind: "area", area: "tundra" }]])).toBe(
    loadI18n("en").t("picker.area.off"),
  );
});

test("a manual cause points at the recipe toggles", () => {
  expect(
    hintFor([["gadget", { kind: "manual", recipeId: "make_gadget" }]]),
  ).toBe(loadI18n("en").t("picker.manual.off"));
});

test("mixed causes explain each kind once, in precedence order", () => {
  const i18n = loadI18n("en");
  expect(
    hintFor([
      ["gadget", { kind: "manual", recipeId: "make_gadget" }],
      ["widget", { kind: "event", cohort: "v1.5" }],
      ["sprocket", { kind: "area", area: "tundra" }],
    ]),
  ).toBe(
    [
      i18n.t("picker.area.off"),
      i18n.t("picker.event.off", { cohorts: "v1.5" }),
      i18n.t("picker.manual.off"),
    ].join(" "),
  );
});

test("no hint when nothing dimmed is in the catalogue", () => {
  expect(hintFor([])).toBeUndefined();
  expect(
    hintFor([["absent", { kind: "event", cohort: "v1.5" }]]),
  ).toBeUndefined();
});

test("an unconsumed focus token lives for one commit", () => {
  const { hook } = setup();
  const el = document.createElement("input");
  document.body.appendChild(el);
  hook.result.current.armFocus("row-a", "rate");
  hook.rerender();
  hook.result.current.focusOnMount(el, "row-a", "rate");
  expect(document.activeElement).not.toBe(el);
  el.remove();
});
