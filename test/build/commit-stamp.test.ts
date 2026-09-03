import { describe, expect, test } from "vitest";
import {
  formatCommitStamp,
  resolveCommitStamp,
  UNKNOWN_COMMIT,
} from "../../tools/build/commit-stamp";

describe("formatCommitStamp", () => {
  test("stamps a clean checkout with the short sha", () => {
    expect(formatCommitStamp({ headSha: "fea16ad" })).toBe("fea16ad");
  });

  test("marks a dirty worktree", () => {
    expect(formatCommitStamp({ headSha: "fea16ad", dirty: true })).toBe(
      "fea16ad-dirty",
    );
  });

  // The env override carries a full sha in CI. Cutting it here is what makes a
  // deployed meta tag comparable to a locally built one by eye.
  test("cuts the environment override to the short shape", () => {
    expect(
      formatCommitStamp({
        envCommit: "fea16adcafe0123456789abcdef01234567890ab",
      }),
    ).toBe("fea16ad");
  });

  // A dirty flag alongside an override is CI reporting on its own checkout,
  // which is not what the deployed commit is: the override wins outright.
  test("ignores the dirty flag when overridden", () => {
    expect(
      formatCommitStamp({
        envCommit: "abcdef1",
        headSha: "fea16ad",
        dirty: true,
      }),
    ).toBe("abcdef1");
  });

  test("ignores a blank override", () => {
    expect(formatCommitStamp({ envCommit: "  ", headSha: "fea16ad" })).toBe(
      "fea16ad",
    );
  });

  // git output arrives with its trailing newline.
  test("trims the git newline", () => {
    expect(formatCommitStamp({ headSha: "fea16ad\n" })).toBe("fea16ad");
  });

  test("falls back when git could not answer", () => {
    expect(formatCommitStamp({})).toBe(UNKNOWN_COMMIT);
    expect(formatCommitStamp({ headSha: "" })).toBe(UNKNOWN_COMMIT);
  });
});

describe("resolveCommitStamp", () => {
  test("prefers the environment override", () => {
    expect(resolveCommitStamp({ STC_COMMIT: "0123456789abcdef" })).toBe(
      "0123456",
    );
  });

  // Without an override it reads the repository this test runs in, which is a
  // git checkout; the shape is what is pinned, not the value.
  test("reads a stamp with no override set", () => {
    expect(resolveCommitStamp({})).toMatch(/^([0-9a-f]{7,}(-dirty)?|unknown)$/);
  });
});
