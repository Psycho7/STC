// The EXAM_EXTRA_SCENARIOS loader is the only door the rotating exam corpus
// enters the e2e specs through, and it runs at spec import time where a thrown
// error is the sole way to report a bad file. Its validation is therefore worth
// a suite of its own, here rather than under test/e2e/ (Vitest is kept out of
// that directory; the loader itself pulls in no Playwright runtime).
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { SCENARIOS, extraScenariosFromEnv } from "./e2e/scenarios";

const ENV = "EXAM_EXTRA_SCENARIOS";
const dir = mkdtempSync(join(tmpdir(), "stc-extra-scenarios-"));

function withFile(contents: string): string {
  const path = join(dir, `case-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, contents, "utf8");
  process.env[ENV] = path;
  return path;
}

// Loader-relative path spelling: the loader anchors a relative value at the
// repo root (two levels up from test/e2e), which is one level up from here.
function relativeToRepoRoot(absolute: string): string {
  return relative(resolve(import.meta.dirname, ".."), absolute);
}

const ROT = {
  id: "rot-bottled_food_3",
  title: "rot-bottled_food_3",
  targets: [{ itemId: "bottled_food_3", ratePerSec: { num: "1", denom: "2" } }],
  maxDiffPixels: 0,
};

// The variable may already be set in the developer's shell, which would make
// the unset case pass for the wrong reason. Clear it on both sides.
beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  delete process.env[ENV];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("extraScenariosFromEnv", () => {
  it("returns nothing when the variable is unset or empty", () => {
    expect(extraScenariosFromEnv()).toEqual([]);
    process.env[ENV] = "";
    expect(extraScenariosFromEnv()).toEqual([]);
  });

  it("loads an array of scenarios", () => {
    withFile(JSON.stringify([ROT]));
    expect(extraScenariosFromEnv()).toEqual([ROT]);
  });

  it("names the file when it cannot be read", () => {
    process.env[ENV] = join(dir, "absent.json");
    expect(() => extraScenariosFromEnv()).toThrow(/absent\.json/);
  });

  it("rejects a file that is not an array", () => {
    const path = withFile(JSON.stringify(ROT));
    expect(() => extraScenariosFromEnv()).toThrow(
      new RegExp(`${path}.*expected an array`),
    );
  });

  it("rejects an entry with no id, title or targets", () => {
    withFile(JSON.stringify([{ ...ROT, id: 42 }]));
    expect(() => extraScenariosFromEnv()).toThrow(/entry 0 has no string "id"/);
    withFile(JSON.stringify([{ ...ROT, title: "" }]));
    expect(() => extraScenariosFromEnv()).toThrow(/has no string "title"/);
    withFile(JSON.stringify([{ ...ROT, targets: [] }]));
    expect(() => extraScenariosFromEnv()).toThrow(/no non-empty "targets"/);
    withFile(JSON.stringify([{ ...ROT, maxDiffPixels: "0" }]));
    expect(() => extraScenariosFromEnv()).toThrow(/no numeric "maxDiffPixels"/);
  });

  it("rejects an id that collides with the fixed corpus", () => {
    withFile(JSON.stringify([{ ...ROT, id: SCENARIOS[0]!.id }]));
    expect(() => extraScenariosFromEnv()).toThrow(/collides/);
  });

  it("rejects an id repeated inside the file", () => {
    withFile(JSON.stringify([ROT, ROT]));
    expect(() => extraScenariosFromEnv()).toThrow(/entry 1 id .* collides/);
  });

  it("resolves a relative path against the repo root, not the cwd", () => {
    const abs = withFile(JSON.stringify([ROT]));
    // The same file named relative to the repo root loads identically, and the
    // error text reports the resolved absolute path.
    process.env[ENV] = relativeToRepoRoot(abs);
    expect(extraScenariosFromEnv()).toEqual([ROT]);
    process.env[ENV] = relativeToRepoRoot(join(dir, "absent.json"));
    expect(() => extraScenariosFromEnv()).toThrow(
      new RegExp(`${ENV}=${join(dir, "absent.json")}:`),
    );
  });
});
