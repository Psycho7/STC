import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../data/i18n-context";
import type { RationalString } from "../data/targets";
// The same rule the panel rate rows commit through (useRateEdit calls it),
// so "30", "1/3" and a refused 0 behave identically in the prompt and in a row.
import {
  parseRateText,
  RATE_ERROR_KEY,
  type RateTextError,
} from "../data/rate-format";
import { iconIdForItem } from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { useModalDialog } from "./useModalDialog";

type Props = {
  // The item that was just picked. The caller resolves the display name (the
  // panels show localized names) so this stays presentational.
  item: { id: string; name: string };
  // Optional tag beside the item name. The inputs panel passes the catalyst
  // badge when the picked row will land in the item's catalyst pool (its
  // general side is already listed), so the user sees which pool the row is
  // about to join before confirming.
  badge?: string | undefined;
  // Optional one-line hint under the input; the inputs panel passes
  // ratePrompt.noLimit ("empty = no limit") in uncap mode.
  note?: string | undefined;
  // What an empty field means on confirm:
  //  - "invalid": empty, zero, negative and unparseable all show their cue
  //    inline and the dialog stays open; nothing commits until a positive
  //    rate is entered (targets).
  //  - "uncap": empty commits undefined (an uncapped override), zero commits
  //    the zero cap, negative and unparseable show their cue (inputs).
  emptyMeans: "invalid" | "uncap";
  iconSheetUrl: string;
  onConfirm: (rate: RationalString | undefined) => void;
  onCancel: () => void;
};

export function RatePromptPopup({
  item,
  badge,
  note,
  emptyMeans,
  iconSheetUrl,
  onConfirm,
  onCancel,
}: Props) {
  const i18n = useI18n();
  const [text, setText] = useState("");
  // Why the last confirm attempt was refused. Typing clears it, like the panel
  // rate rows; a refused dialog stays open so the user can fix the value.
  const [error, setError] = useState<RateTextError | undefined>(undefined);
  const invalid = error !== undefined;
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Autofocus the rate input on open; a document-level Escape cancels.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const trapTab = useModalDialog(dialogRef, onCancel);

  function confirmRate() {
    const result = parseRateText(text, emptyMeans);
    if (result.kind === "error") {
      setError(result.error);
      return;
    }
    onConfirm(result.kind === "rate" ? result.rate : undefined);
  }

  return createPortal(
    // The portal escapes .ak-app-shell where --icons-url lives, so the backdrop
    // re-declares it or the sprite renders blank.
    <div
      className="rate-prompt-backdrop"
      style={{ ["--icons-url" as string]: `url(${iconSheetUrl})` }}
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        className="rate-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={i18n.t("ratePrompt.title")}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="rate-prompt-item">
          <Sprite iconId={iconIdForItem(item.id)} size={28} />
          <span className="rate-prompt-item-name" title={item.name}>
            {item.name}
          </span>
          {badge !== undefined ? (
            <span className="catalyst" data-testid="rate-prompt-catalyst">
              {badge}
            </span>
          ) : null}
        </div>
        <div className="rate-prompt-rate">
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            data-testid="rate-prompt-input"
            aria-label={i18n.t("inputs.rate.label")}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? "rate-prompt-invalid" : undefined}
            className={invalid ? "invalid" : undefined}
            // The inputs rows placeholder the uncapped state; the targets rows
            // carry none, so neither does the invalid-mode prompt.
            placeholder={
              emptyMeans === "uncap" ? i18n.t("inputs.unlimited") : undefined
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmRate();
            }}
          />
          <span className="rate-prompt-unit">{i18n.t("inputs.rate.unit")}</span>
        </div>
        {error !== undefined ? (
          <span
            className="rate-prompt-error"
            id="rate-prompt-invalid"
            role="alert"
            data-testid="rate-prompt-invalid"
          >
            {i18n.t(RATE_ERROR_KEY[error])}
          </span>
        ) : null}
        {note !== undefined ? (
          <div className="rate-prompt-note" data-testid="rate-prompt-note">
            {note}
          </div>
        ) : null}
        <div className="rate-prompt-actions">
          <button
            type="button"
            className="rate-prompt-button"
            data-testid="rate-prompt-cancel"
            onClick={onCancel}
          >
            {i18n.t("ratePrompt.cancel")}
          </button>
          <button
            type="button"
            className="rate-prompt-button primary"
            data-testid="rate-prompt-confirm"
            onClick={confirmRate}
          >
            {i18n.t("ratePrompt.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
