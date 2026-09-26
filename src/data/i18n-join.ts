import type { Locale } from "./i18n";

// A locale-keyed separator rather than Intl.ListFormat: en "conjunction" adds
// "and", and the en surfaces want a bare comma list.
const LIST_SEPARATOR: Record<Locale, string> = {
  en: ", ",
  zh: "、",
};

// zh sentences end in the full-width full stop, which already carries its own
// spacing; a space after it reads as a gap.
const SENTENCE_SEPARATOR: Record<Locale, string> = {
  en: " ",
  zh: "",
};

export function joinList(locale: Locale, items: ReadonlyArray<string>): string {
  return items.join(LIST_SEPARATOR[locale]);
}

export function joinSentences(
  locale: Locale,
  sentences: ReadonlyArray<string>,
): string {
  return sentences.join(SENTENCE_SEPARATOR[locale]);
}
