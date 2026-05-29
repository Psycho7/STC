import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { loadI18n, type I18nIndex, type Locale } from "./i18n";

const STORAGE_KEY = "aef.locale";
const SUPPORTED: ReadonlySet<Locale> = new Set(["en", "ja", "ru", "zh"]);

type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readStoredLocale(): Locale | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw && SUPPORTED.has(raw as Locale)) return raw as Locale;
  } catch {
    // Some private-mode browsers throw on localStorage access, so just give up
    // and fall through.
  }
  return null;
}

function writeStoredLocale(next: Locale): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(STORAGE_KEY, next);
  } catch {
    // If we can't persist the choice it's no big deal; the in-memory state
    // still drives the rest of the session.
  }
}

export function LocaleProvider({
  children,
  locale: forcedLocale,
}: {
  children: ReactNode;
  // Pass a locale to start with that one instead of the stored or default
  // choice. Tests use this to pin a known locale; in production it's left off
  // so the stored preference takes over.
  locale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(
    () => forcedLocale ?? readStoredLocale() ?? "zh",
  );
  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale: (next) => {
        setLocaleState(next);
        writeStoredLocale(next);
      },
    }),
    [locale],
  );
  return (
    <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  // When there's no provider around (for example in headless unit tests), hand
  // back the default locale and a no-op setter so callers don't have to guard
  // for a null context.
  if (!ctx) return { locale: "zh", setLocale: () => {} };
  return ctx;
}

export function useI18n(): I18nIndex {
  const { locale } = useLocale();
  return loadI18n(locale);
}
