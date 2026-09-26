// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { RatePromptPopup } from "./RatePromptPopup";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

function renderPrompt(
  overrides: Partial<ComponentProps<typeof RatePromptPopup>> = {},
  locale: "en" | "zh" = "en",
) {
  const props: ComponentProps<typeof RatePromptPopup> = {
    item: { id: "iron_ore", name: "Iron Ore" },
    emptyMeans: "invalid",
    iconSheetUrl: "/icons.webp",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(
    <LocaleProvider locale={locale}>
      <RatePromptPopup {...props} />
    </LocaleProvider>,
  );
  return props;
}

function input(): HTMLInputElement {
  return screen.getByTestId("rate-prompt-input") as HTMLInputElement;
}

function confirmButton(): HTMLButtonElement {
  return screen.getByTestId("rate-prompt-confirm") as HTMLButtonElement;
}

test("opens with the rate input focused", () => {
  renderPrompt();
  expect(document.activeElement).toBe(input());
});

test("Enter confirms with the parsed rate", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "30");
  fireEvent.keyDown(input(), { key: "Enter" });
  // 30/min parses to the per-second rational 1/2, exactly as a panel row
  // commits it.
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "1", denom: "2" });
  expect(props.onCancel).not.toHaveBeenCalled();
});

test("a rational entry parses like the panel rows", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "1/3");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "1", denom: "180" });
});

test("the Add button confirms too", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "30");
  fireEvent.click(confirmButton());
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "1", denom: "2" });
});

test("Escape cancels and never confirms", () => {
  const props = renderPrompt();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(props.onCancel).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).not.toHaveBeenCalled();
});

test("backdrop click cancels; a click inside does not", () => {
  const props = renderPrompt();
  fireEvent.click(screen.getByText("Iron Ore"));
  expect(props.onCancel).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector(".rate-prompt-backdrop")!);
  expect(props.onCancel).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).not.toHaveBeenCalled();
});

test("the Cancel button cancels and never confirms", () => {
  const props = renderPrompt();
  fireEvent.click(screen.getByTestId("rate-prompt-cancel"));
  expect(props.onCancel).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).not.toHaveBeenCalled();
});

test("invalid mode refuses empty with the cue and stays open", async () => {
  const props = renderPrompt();
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(props.onCancel).not.toHaveBeenCalled();
  const cue = screen.getByRole("alert");
  expect(cue.textContent).toBe("Enter a number, e.g. 30 or 1/3");
  expect(input().getAttribute("aria-invalid")).toBe("true");
  // Nothing commits and the dialog is still up for another try.
  expect(input()).toBeTruthy();
});

test("invalid mode refuses zero with the cue", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "0");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(input()).toBeTruthy();
});

test("invalid mode refuses unparseable text with the cue", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "abc");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
});

test("typing clears the invalid cue and a fixed value then confirms", async () => {
  const props = renderPrompt();
  await userEvent.type(input(), "0");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(screen.getByRole("alert")).toBeTruthy();
  await userEvent.type(input(), "30");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input().getAttribute("aria-invalid")).toBeNull();
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "1", denom: "2" });
});

test("uncap mode confirms undefined on empty", () => {
  const props = renderPrompt({ emptyMeans: "uncap" });
  // The uncapped state is placeholdered like the inputs rows.
  expect(input().placeholder).toBe("Unlimited");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).toHaveBeenCalledWith(undefined);
  expect(props.onCancel).not.toHaveBeenCalled();
});

test("uncap mode confirms the zero cap on 0", async () => {
  const props = renderPrompt({ emptyMeans: "uncap" });
  await userEvent.type(input(), "0");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).toHaveBeenCalledTimes(1);
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "0", denom: "1" });
});

test("uncap mode still refuses unparseable text with the cue", async () => {
  const props = renderPrompt({ emptyMeans: "uncap" });
  await userEvent.type(input(), "abc");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(input()).toBeTruthy();
});

test("padded text confirms as the trimmed rate", async () => {
  const props = renderPrompt();
  fireEvent.change(input(), { target: { value: " 45 " } });
  fireEvent.keyDown(input(), { key: "Enter" });
  // 45/min = 3/4 per sec.
  expect(props.onConfirm).toHaveBeenCalledWith({ num: "3", denom: "4" });
});

test("non-numeric, zero and negative text each show their own message", async () => {
  const props = renderPrompt();
  const seen: string[] = [];
  for (const text of ["abc", "0", "-5"]) {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.keyDown(input(), { key: "Enter" });
    seen.push(screen.getByRole("alert").textContent!);
  }
  expect(seen).toEqual([
    "Enter a number, e.g. 30 or 1/3",
    "Enter a rate above 0",
    "A rate cannot be negative",
  ]);
  expect(props.onConfirm).not.toHaveBeenCalled();
});

test("uncap mode refuses a negative cap with the negative message", async () => {
  const props = renderPrompt({ emptyMeans: "uncap" });
  await userEvent.type(input(), "-5");
  fireEvent.keyDown(input(), { key: "Enter" });
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(screen.getByRole("alert").textContent).toBe(
    "A rate cannot be negative",
  );
});

test("Tab is trapped between the input and the buttons at both ends", () => {
  const props = renderPrompt();
  const cancel = screen.getByTestId("rate-prompt-cancel");
  // Forward off the last stop (Add) comes back to the first (the input).
  confirmButton().focus();
  fireEvent.keyDown(confirmButton(), { key: "Tab" });
  expect(document.activeElement).toBe(input());
  // Backward off the first goes to the last.
  fireEvent.keyDown(input(), { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(confirmButton());
  // A mid-ring move is left to the browser, exactly like the picker's trap.
  cancel.focus();
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(cancel);
  expect(props.onCancel).not.toHaveBeenCalled();
});

test("renders the note line only when the prop is set", () => {
  renderPrompt({ note: "empty = no limit" });
  expect(screen.getByTestId("rate-prompt-note").textContent).toBe(
    "empty = no limit",
  );
  cleanup();
  renderPrompt();
  expect(screen.queryByTestId("rate-prompt-note")).toBeNull();
});

test("invalid mode placeholders nothing, like the targets rows", () => {
  renderPrompt();
  expect(input().placeholder).toBe("");
});

test("zh strings render", () => {
  renderPrompt({ emptyMeans: "uncap", note: "留空 = 无限" }, "zh");
  expect(screen.getByRole("dialog", { name: "数量" })).toBeTruthy();
  expect(screen.getByLabelText("速率")).toBe(input());
  expect(screen.getByTestId("rate-prompt-cancel").textContent).toBe("取消");
  expect(screen.getByTestId("rate-prompt-confirm").textContent).toBe("添加");
  expect(input().placeholder).toBe("无限");
  expect(screen.getByTestId("rate-prompt-note").textContent).toBe(
    "留空 = 无限",
  );
});
