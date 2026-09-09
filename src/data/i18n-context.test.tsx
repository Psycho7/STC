// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocaleProvider, useLocale } from "./i18n-context";
import { LOCALE_STORAGE_KEY } from "./storage-keys";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

// A tiny consumer that flips the locale so we can assert document.lang tracks
// the change, not just the initial mount.
function Switcher() {
  const { setLocale } = useLocale();
  return (
    <button onClick={() => setLocale("en")} data-testid="to-en">
      en
    </button>
  );
}

// Reports the locale the provider settled on.
function Reader() {
  const { locale } = useLocale();
  return <span data-testid="locale">{locale}</span>;
}

test("document lang matches the initial locale", () => {
  render(
    <LocaleProvider locale="zh">
      <div />
    </LocaleProvider>,
  );
  expect(document.documentElement.lang).toBe("zh");
});

test("document lang follows a locale change", () => {
  render(
    <LocaleProvider locale="zh">
      <Switcher />
    </LocaleProvider>,
  );
  expect(document.documentElement.lang).toBe("zh");
  fireEvent.click(screen.getByTestId("to-en"));
  expect(document.documentElement.lang).toBe("en");
});

// Locales the web UI dropped still sit in older browsers' localStorage, so a
// stored value outside the supported set has to fall back to the default.
test("an unsupported stored locale falls back to the default", () => {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, "ja");
  render(
    <LocaleProvider>
      <Reader />
    </LocaleProvider>,
  );
  expect(screen.getByTestId("locale").textContent).toBe("zh");
});
