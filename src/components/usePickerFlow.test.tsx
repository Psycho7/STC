// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { RecipePack } from "@aef/schema";
import { usePickerFlow } from "./usePickerFlow";
import { LocaleProvider } from "../data/i18n-context";

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
