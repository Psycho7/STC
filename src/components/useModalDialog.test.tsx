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

// The settings dialog opens with focus on its own container (tabIndex -1),
// which is not a stop, so the trap cannot rely on focus sitting on an edge.
function ContainerDialog() {
  const dialogRef = useRef<HTMLDivElement>(null);
  const trapTab = useModalDialog(dialogRef, vi.fn());
  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-label="settings"
      tabIndex={-1}
      onKeyDown={trapTab}
    >
      <button type="button">first</button>
      <button type="button">middle</button>
      <button type="button">last</button>
    </div>
  );
}

test.each([
  { from: "the container", shiftKey: false, lands: "first" },
  { from: "the container", shiftKey: true, lands: "last" },
  { from: "first", shiftKey: false, lands: "first" },
  { from: "first", shiftKey: true, lands: "last" },
  { from: "last", shiftKey: false, lands: "first" },
  { from: "last", shiftKey: true, lands: "last" },
])(
  "Tab (shift $shiftKey) from $from keeps focus inside the dialog",
  ({ from, shiftKey, lands }) => {
    render(<ContainerDialog />);
    const dialog = screen.getByRole("dialog", { name: "settings" });
    const start =
      from === "the container"
        ? dialog
        : screen.getByRole("button", { name: from });

    start.focus();
    fireEvent.keyDown(start, { key: "Tab", shiftKey });

    expect(dialog.contains(document.activeElement)).toBe(true);
    // A key the trap leaves alone is moved by the browser, not jsdom, so
    // focus stays put here; the wrapped cases land on the named stop.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: lands }),
    );
  },
);

test("Tab from a middle stop and non-Tab keys are left alone", () => {
  render(<Dialog onClose={vi.fn()} />);
  const first = screen.getByRole("button", { name: "first" });
  first.focus();
  expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
  expect(document.activeElement).toBe(first);
  expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(true);
});
