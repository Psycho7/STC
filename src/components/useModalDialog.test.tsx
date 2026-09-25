// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { useModalDialog } from "./useModalDialog";

afterEach(cleanup);

function Dialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const trapTab = useModalDialog(dialogRef, onClose);
  return (
    <div ref={dialogRef} role="dialog" onKeyDown={trapTab}>
      <button type="button">first</button>
      <button type="button" disabled>
        disabled
      </button>
      <button type="button" tabIndex={-1}>
        untabbable
      </button>
      <input aria-label="last" />
    </div>
  );
}

// The settings dialog's locale control is a <select>, so the trap has to
// count one as a stop; here it is the first, and the wrap proves it.
function SelectDialog() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const trapTab = useModalDialog(dialogRef, vi.fn());
  return (
    <div ref={dialogRef} role="dialog" onKeyDown={trapTab}>
      <select aria-label="locale">
        <option value="en">English</option>
      </select>
      <button type="button">close</button>
    </div>
  );
}

test("a document-level Escape calls onClose", () => {
  const onClose = vi.fn();
  render(<Dialog onClose={onClose} />);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the Escape listener is removed on unmount", () => {
  const onClose = vi.fn();
  const { unmount } = render(<Dialog onClose={onClose} />);
  unmount();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
});

test("Tab off the last stop wraps to the first, Shift+Tab the other way", () => {
  render(<Dialog onClose={vi.fn()} />);
  const first = screen.getByRole("button", { name: "first" });
  const last = screen.getByRole("textbox", { name: "last" });

  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(first);

  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

test("a select is a Tab stop, so Shift+Tab off it wraps to the last stop", () => {
  render(<SelectDialog />);
  const select = screen.getByRole("combobox", { name: "locale" });
  const close = screen.getByRole("button", { name: "close" });

  select.focus();
  fireEvent.keyDown(select, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(close);
});

test("Tab from a middle stop and non-Tab keys are left alone", () => {
  render(<Dialog onClose={vi.fn()} />);
  const first = screen.getByRole("button", { name: "first" });
  first.focus();
  expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(first);
  expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(true);
});
