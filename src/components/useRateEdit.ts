import { useRef, useState } from "react";
import type React from "react";
import type { RationalString } from "../data/targets";
import { parsePerMinToRatePerSec } from "../data/rate-format";

// Everything a rate input needs from the protocol. `inputProps` is spread onto
// the input; every other attribute a row wants - its label, its description,
// its hint text, its ref, its testids - stays at the call site, which is what
// keeps panels with differing DOM intact.
export type RateField = {
  invalid: boolean;
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    "aria-invalid": true | undefined;
    className: "invalid" | undefined;
  };
};

export type RateEditConfig = {
  // "invalid": empty text fails to parse and takes the invalid path (targets).
  // "uncap":   empty text is a valid commit with parsed === undefined (inputs).
  emptyMeans: "invalid" | "uncap";
  // true  keeps the committed text as the display value (a committed "1/3"
  //       must not re-serialize into a float on the next render).
  // false drops it, so the row falls back to its fallbackText after commit.
  keepTextAfterCommit: boolean;
  // Called only after a successful parse. The hook never builds a plan row:
  // the caller decides spread-vs-rebuild and may call onChange from here.
  commit: (
    itemId: string,
    parsed: RationalString | undefined,
    text: string,
  ) => void;
};

export type RateEdit = {
  field: (itemId: string, fallbackText: string) => RateField;
  clearPendingEdit: (itemId: string) => void;
  carryPendingEdit: (oldItemId: string, newItemId: string) => void;
  seedCommittedText: (itemId: string, text: string) => void;
};

// The edit / commit / revert / invalid protocol behind one rate input family.
// One instance owns one disjoint family of rows: it carries its own invalid
// set, so a caller with two families (auto rows and override rows) needs two
// instances and must guarantee an item is never in both at once.
//
// Commits run from an event handler (blur or Enter), never during render, so a
// StrictMode double-render cannot double-commit.
export function useRateEdit(config: RateEditConfig): RateEdit {
  // In-flight edit values keyed by itemId. A row without an entry falls back
  // to the prop-derived value, so a new prop updates the visible rate without a
  // separate sync effect. Keying by id (not row index) keeps an uncommitted
  // edit attached to its row across removals and reorders. The text is
  // committed only on blur or Enter, and (when keepTextAfterCommit) the
  // committed string is kept here as the display value (re-serializing
  // ratePerSec would turn "1/3" into a float).
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  // Item ids whose text has not yet been committed. Guards the blur/Enter
  // commit so re-blurring an unedited field never re-fires a solve.
  // The owner remounts the panel (via a key keyed on plan identity) when it
  // navigates to a new plan, which drops all uncommitted local edit state, so
  // there is no cross-plan carryover to clear here.
  const dirty = useRef<Set<string>>(new Set());
  // Item ids whose last commit attempt failed to parse. Drives the input's
  // aria-invalid flag and the inline error message. Typing clears the flag; a
  // successful commit or a blur-revert clears it too.
  const [invalidIds, setInvalidIds] = useState<Set<string>>(new Set());

  function markInvalid(itemId: string, on: boolean) {
    setInvalidIds((prev) => {
      if (on === prev.has(itemId)) return prev;
      const next = new Set(prev);
      if (on) next.add(itemId);
      else next.delete(itemId);
      return next;
    });
  }

  function dropText(itemId: string) {
    setTexts((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Map(prev);
      next.delete(itemId);
      return next;
    });
  }

  function handleChange(itemId: string, value: string) {
    dirty.current.add(itemId);
    // Typing clears any prior invalid cue; the value is re-checked on commit.
    markInvalid(itemId, false);
    setTexts((prev) => new Map(prev).set(itemId, value));
  }

  // Commit the row's uncommitted text on blur (revert=true) or Enter
  // (revert=false). Only a dirty row acts; a successful parse commits and clears
  // the dirty/invalid flags. On a failed parse, Enter surfaces the invalid cue
  // and keeps the bad text so the user can fix it, while a blur reverts the
  // field to its last-good value so it never sticks on rejected input.
  function commitFromLocal(itemId: string, revert: boolean) {
    if (!dirty.current.has(itemId)) return;
    const text = texts.get(itemId);
    if (text === undefined) return;
    // Under "uncap" an empty field is a valid commit meaning "no rate limit";
    // under "invalid" it takes the failed-parse path like any other bad text.
    const uncap = config.emptyMeans === "uncap" && text.trim() === "";
    const parsed = uncap ? undefined : parsePerMinToRatePerSec(text);
    if (uncap || parsed !== undefined) {
      config.commit(itemId, parsed, text);
      dirty.current.delete(itemId);
      markInvalid(itemId, false);
      if (!config.keepTextAfterCommit) dropText(itemId);
      return;
    }
    if (revert) {
      dirty.current.delete(itemId);
      markInvalid(itemId, false);
      dropText(itemId);
    } else {
      markInvalid(itemId, true);
    }
  }

  return {
    field(itemId, fallbackText) {
      const invalid = invalidIds.has(itemId);
      return {
        invalid,
        inputProps: {
          value: texts.get(itemId) ?? fallbackText,
          onChange: (e) => handleChange(itemId, e.target.value),
          onBlur: () => commitFromLocal(itemId, true),
          onKeyDown: (e) => {
            if (e.key === "Enter") commitFromLocal(itemId, false);
          },
          "aria-invalid": invalid ? true : undefined,
          className: invalid ? "invalid" : undefined,
        },
      };
    },
    // Drop the in-flight edit text and dirty flag for a row that is going away,
    // so a stale entry can never redisplay on a later row that reuses the same
    // id.
    clearPendingEdit(itemId) {
      dirty.current.delete(itemId);
      markInvalid(itemId, false);
      dropText(itemId);
    },
    // An uncommitted edit follows the row to its new id, dirty flag and all, so
    // the user can still blur to commit it under the swapped item.
    carryPendingEdit(oldItemId, newItemId) {
      const pendingValue = texts.get(oldItemId);
      if (pendingValue === undefined) return;
      const wasDirty = dirty.current.delete(oldItemId);
      if (wasDirty) dirty.current.add(newItemId);
      setTexts((prev) => {
        const next = new Map(prev);
        next.delete(oldItemId);
        next.set(newItemId, pendingValue);
        return next;
      });
    },
    // Display text handed over from elsewhere, WITHOUT marking the row dirty, so
    // a seeded row will not re-commit on blur. One flow needs it: an auto row
    // promoting into an override row passes on the text the user typed, so the
    // new row shows that instead of the re-serialized Fraction.
    seedCommittedText(itemId, text) {
      setTexts((prev) => new Map(prev).set(itemId, text));
    },
  };
}
