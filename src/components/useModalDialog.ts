import { useEffect } from "react";
// Aliased: the bare name would shadow the DOM KeyboardEvent the document-level
// Escape listener below is typed against.
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";

// Everything inside the dialog that Tab can reach.
function tabbables(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled])",
    ),
  ].filter((el) => el.tabIndex >= 0);
}

// The keyboard contract every modal popup shares: a document-level Escape
// closes it, and the returned handler (for the dialog's onKeyDown) confines
// Tab to the dialog. It acts on Tab alone, so a dialog with keys of its own
// calls it first and then handles the rest.
export function useModalDialog(
  dialogRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): (e: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (e) => {
    if (e.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    // aria-modal alone does not confine Tab. Without this, Tab off the last
    // stop leaves the dialog for the page behind the backdrop, which the user
    // cannot see and can only come back from by tabbing the whole way round.
    const stops = tabbables(root);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    // Focus off every stop (the container itself, which a dialog focuses on
    // open) must wrap too: the browser would step from there to whatever
    // precedes or follows the dialog in the page.
    const onStop = stops.includes(document.activeElement as HTMLElement);
    const at = e.shiftKey ? first : last;
    if (onStop && document.activeElement !== at) return;
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  };
}
