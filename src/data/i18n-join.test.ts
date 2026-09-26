import { expect, test } from "vitest";
import { joinList, joinSentences } from "./i18n-join";

test("en joins a list with a comma and a space", () => {
  expect(joinList("en", ["a", "b", "c"])).toBe("a, b, c");
});

test("zh joins a list with the ideographic comma and no space", () => {
  expect(joinList("zh", ["铜", "铁", "硅"])).toBe("铜、铁、硅");
});

test("a one-item list is the item itself", () => {
  expect(joinList("en", ["a"])).toBe("a");
  expect(joinList("zh", ["a"])).toBe("a");
});

test("en separates sentences with one space", () => {
  expect(joinSentences("en", ["One.", "Two."])).toBe("One. Two.");
});

test("zh puts no space after the ideographic full stop", () => {
  expect(joinSentences("zh", ["一。", "二。"])).toBe("一。二。");
});
