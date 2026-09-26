import { useRef, useState } from "react";
import type React from "react";
import type { RationalString } from "../data/targets";
import { parseRateText, type RateTextError } from "../data/rate-format";

// Everything a rate input needs from the protocol. `inputProps` is spread onto
// the input; every other attribute a row wants - its label, its description,
// its hint text, its ref, its testids - stays at the call site, which is what
// keeps panels with differing DOM intact.
export type RateField = {
  invalid: boolean;
  // Why the last commit attempt was refused; set exactly when invalid is.
  error: RateTextError | undefined;
  // Why the field dropped refused text on blur and is showing its last-good
  // value again; undefined when it did not. Not an error state: the value on
  // screen is valid, so the row reports it as a status rather than marking the
  // field invalid.
  reverted: RateTextError | undefined;
  inputProps: {
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: () => void;
    onFocus: () => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    "aria-invalid": true | undefined;
    className: "invalid" | undefined;
  };
};

// A union discriminated on emptyMeans, so commit's parsed type carries the
// empty-text contract: an "invalid" instance can never commit undefined (empty
// text takes the failed-parse path), and its callers need no non-null
// assertion; only an "uncap" instance commits undefined (the "no rate limit"
// commit for empty text).
export type RateEditConfig =
  | {
      // "invalid": empty text fails to parse and takes the invalid path
      // (targets).
      emptyMeans: "invalid";
      // true  keeps the committed text as the display value (a committed "1/3"
      //       must not re-serialize into a float on the next render).
      // false drops it, so the row falls back to its fallbackText after
      //       commit.
      keepTextAfterCommit: boolean;
      // Called only after a successful parse. The hook never builds a plan
      // row: the caller decides spread-vs-rebuild and may call onChange from
      // here.
      commit: (rowKey: string, parsed: RationalString, text: string) => void;
    }
  | {
      // "uncap": empty text is a valid commit with parsed === undefined
      // (inputs).
      emptyMeans: "uncap";
      keepTextAfterCommit: boolean;
      commit: (
        rowKey: string,
        parsed: RationalString | undefined,
        text: string,
      ) => void;
    };

export type RateEdit = {
  field: (rowKey: string, fallbackText: string) => RateField;
  clearPendingEdit: (rowKey: string) => void;
  carryPendingEdit: (oldRowKey: string, newRowKey: string) => void;
  seedCommittedText: (rowKey: string, text: string) => void;
  pruneEditsTo: (liveRowKeys: ReadonlySet<string>) => void;
};

// Set or clear (undefined) one row's reason in a reason map, keeping the map
// identity when nothing changes so an unchanged field does not re-render.
function setReason(
  setter: React.Dispatch<React.SetStateAction<Map<string, RateTextError>>>,
  rowKey: string,
  value: RateTextError | undefined,
): void {
  setter((prev) => {
    if (value === prev.get(rowKey)) return prev;
    const next = new Map(prev);
    if (value !== undefined) next.set(rowKey, value);
    else next.delete(rowKey);
    return next;
  });
}

// The edit / commit / revert / invalid protocol behind one rate input family.
// One instance owns one disjoint family of rows: it carries its own invalid
// set, so a caller with two families (auto rows and override rows) needs two
// instances and must guarantee a row key is never in both at once.
//
// The key is whatever identifies a row to the caller and is opaque here: an
// item id for the targets panel, an (item, pool) row key for the inputs one.
//
// Commits run from an event handler (blur or Enter), never during render, so a
// StrictMode double-render cannot double-commit.
export function useRateEdit(config: RateEditConfig): RateEdit {
  // In-flight edit values keyed by row key. A row without an entry falls back
  // to the prop-derived value, so a new prop updates the visible rate without a
  // separate sync effect. Keying by identity (not row index) keeps an uncommitted
  // edit attached to its row across removals and reorders. The text is
  // committed only on blur or Enter, and (when keepTextAfterCommit) the
  // committed string is kept here as the display value (re-serializing
  // ratePerSec would turn "1/3" into a float).
  const [texts, setTexts] = useState<Map<string, string>>(new Map());
  // Row keys whose text has not yet been committed. Guards the blur/Enter
  // commit so re-blurring an unedited field never re-fires a solve.
  // The owner remounts the panel (via a key keyed on plan identity) when it
  // navigates to a new plan, which drops all uncommitted local edit state, so
  // there is no cross-plan carryover to clear here.
  const dirty = useRef<Set<string>>(new Set());
  // Row keys whose last commit attempt was refused, with the reason. Drives the
  // input's aria-invalid flag and the inline error message. Typing clears the
  // flag; a successful commit or a blur-revert clears it too.
  const [invalidIds, setInvalidIds] = useState<Map<string, RateTextError>>(
    new Map(),
  );
  // Row keys whose last blur threw the typed text away and restored the
  // last-good value, with the reason. Drives the status line that makes that revert visible;
  // short-lived on purpose, since the state it reports is already gone from the
  // field: typing, refocusing, a later commit or the row leaving all clear it.
  const [revertedIds, setRevertedIds] = useState<Map<string, RateTextError>>(
    new Map(),
  );

  function dropText(rowKey: string) {
    setTexts((prev) => {
      if (!prev.has(rowKey)) return prev;
      const next = new Map(prev);
      next.delete(rowKey);
      return next;
    });
  }

  function handleChange(rowKey: string, value: string) {
    dirty.current.add(rowKey);
    // Typing clears any prior invalid cue; the value is re-checked on commit.
    setReason(setInvalidIds, rowKey, undefined);
    setReason(setRevertedIds, rowKey, undefined);
    setTexts((prev) => new Map(prev).set(rowKey, value));
  }

  // Commit the row's uncommitted text on blur (revert=true) or Enter
  // (revert=false). Only a dirty row acts; a successful parse commits and clears
  // the dirty/invalid flags. On a failed parse, Enter surfaces the invalid cue
  // and keeps the bad text so the user can fix it, while a blur reverts the
  // field to its last-good value so it never sticks on rejected input.
  function commitFromLocal(rowKey: string, revert: boolean) {
    if (!dirty.current.has(rowKey)) return;
    const text = texts.get(rowKey);
    if (text === undefined) return;
    function finishCommit(): void {
      dirty.current.delete(rowKey);
      setReason(setInvalidIds, rowKey, undefined);
      setReason(setRevertedIds, rowKey, undefined);
      if (!config.keepTextAfterCommit) dropText(rowKey);
    }
    // parseRateText owns what empty text and zero mean per emptyMeans; it
    // returns "empty" only under "uncap".
    const result = parseRateText(text, config.emptyMeans);
    if (result.kind === "error") {
      if (revert) {
        dirty.current.delete(rowKey);
        setReason(setInvalidIds, rowKey, undefined);
        // The field is valid again, so the row says what happened instead of
        // marking it wrong: a revert the user never sees reads as the panel
        // eating the edit.
        setReason(setRevertedIds, rowKey, result.error);
        dropText(rowKey);
      } else {
        setReason(setInvalidIds, rowKey, result.error);
        setReason(setRevertedIds, rowKey, undefined);
      }
      return;
    }
    // The narrowing on config carries the RateEditConfig union's contract
    // without a cast: only the "uncap" arm ever commits undefined.
    if (result.kind === "rate") config.commit(rowKey, result.rate, text);
    else if (config.emptyMeans === "uncap")
      config.commit(rowKey, undefined, text);
    finishCommit();
  }

  return {
    field(rowKey, fallbackText) {
      const error = invalidIds.get(rowKey);
      const invalid = error !== undefined;
      return {
        invalid,
        error,
        reverted: revertedIds.get(rowKey),
        inputProps: {
          value: texts.get(rowKey) ?? fallbackText,
          onChange: (e) => handleChange(rowKey, e.target.value),
          onBlur: () => commitFromLocal(rowKey, true),
          // Coming back to the field retires the revert notice: the user is
          // about to type over the restored value anyway.
          onFocus: () => setReason(setRevertedIds, rowKey, undefined),
          onKeyDown: (e) => {
            if (e.key === "Enter") commitFromLocal(rowKey, false);
          },
          "aria-invalid": invalid ? true : undefined,
          className: invalid ? "invalid" : undefined,
        },
      };
    },
    // Drop the in-flight edit text and dirty flag for a row that is going away,
    // so a stale entry can never redisplay on a later row that reuses the same
    // id.
    clearPendingEdit(rowKey) {
      dirty.current.delete(rowKey);
      setReason(setInvalidIds, rowKey, undefined);
      setReason(setRevertedIds, rowKey, undefined);
      dropText(rowKey);
    },
    // An uncommitted edit follows the row to its new key, dirty flag and all, so
    // the user can still blur to commit it under the swapped item.
    carryPendingEdit(oldRowKey, newRowKey) {
      const pendingValue = texts.get(oldRowKey);
      if (pendingValue === undefined) return;
      const wasDirty = dirty.current.delete(oldRowKey);
      if (wasDirty) dirty.current.add(newRowKey);
      setTexts((prev) => {
        const next = new Map(prev);
        next.delete(oldRowKey);
        next.set(newRowKey, pendingValue);
        return next;
      });
    },
    // Display text handed over from elsewhere, WITHOUT marking the row dirty, so
    // a seeded row will not re-commit on blur. One flow needs it: an auto row
    // promoting into an override row passes on the text the user typed, so the
    // new row shows that instead of the re-serialized Fraction.
    seedCommittedText(rowKey, text) {
      setTexts((prev) => new Map(prev).set(rowKey, text));
    },
    // Drop every pending / seeded entry whose row has left the family, whatever
    // removed it: clearPendingEdit covers only the explicit remove button, but
    // a row can also disappear when its backing collection changes under the
    // panel, and a surviving entry would resurface if the same item returns.
    pruneEditsTo(liveRowKeys) {
      for (const id of [...dirty.current]) {
        if (!liveRowKeys.has(id)) dirty.current.delete(id);
      }
      function pruneMap<V>(prev: Map<string, V>): Map<string, V> {
        const stale = [...prev.keys()].filter((id) => !liveRowKeys.has(id));
        if (stale.length === 0) return prev;
        const next = new Map(prev);
        for (const id of stale) next.delete(id);
        return next;
      }
      setInvalidIds(pruneMap);
      setRevertedIds(pruneMap);
      setTexts(pruneMap);
    },
  };
}
