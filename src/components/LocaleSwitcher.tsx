import { useLocale, useI18n } from "../data/i18n-context";
import type { Locale } from "../data/i18n";

// Each option label is the native name of that language so users can pick
// regardless of the locale currently active.
const LOCALE_OPTIONS: ReadonlyArray<{ value: Locale; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ru", label: "Русский" },
];

export function LocaleSwitcher() {
  const { locale, setLocale } = useLocale();
  const i18n = useI18n();
  return (
    <select
      data-testid="locale-switcher"
      aria-label={i18n.t("app.locale.label")}
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      style={{ fontSize: 12, padding: "2px 4px" }}
    >
      {LOCALE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
