import { afterEach, describe, expect, it, vi } from "vitest";
import { VALIDATE_ENV_VAR, devAsserts } from "./dev-asserts";

describe("devAsserts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is armed in development mode with the flag unset", () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv(VALIDATE_ENV_VAR, undefined);
    expect(devAsserts()).toBe(true);
  });

  it("is disarmed outside development mode with the flag unset", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv(VALIDATE_ENV_VAR, undefined);
    expect(devAsserts()).toBe(false);
  });

  it("is armed outside development mode when the flag is set to 1", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv(VALIDATE_ENV_VAR, "1");
    expect(devAsserts()).toBe(true);
  });

  // Only the exact value arms it: a stray "0" or "false" in the environment of a
  // production process must not turn the checks on.
  it.each(["0", "false", "true", "yes", ""])(
    "stays disarmed for the flag value %o",
    (value) => {
      vi.stubEnv("DEV", false);
      vi.stubEnv(VALIDATE_ENV_VAR, value);
      expect(devAsserts()).toBe(false);
    },
  );

  // The browser case (no `process` global at all) is not reachable from here:
  // vitest's own import.meta.env shim reads process.env, so removing the global
  // breaks the line above the guard rather than exercising it. The guard is
  // covered by the production bundle instead, which keeps the typeof test and
  // only reaches the lookup through it.
});
