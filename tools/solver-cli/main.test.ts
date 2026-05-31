import { describe, expect, it } from "vitest";
import { runCli } from "./main";

// Smoke tests for the solver-cli. These call runCli() directly (no process
// spawning) and assert on the returned string. The headline plan is a single
// target at 0.1 items/sec, which exercises the full LP -> invariants -> optimality
// path in a deterministic way.

// NOTE: noOrphanLogicalNodes ok=false is EXPECTED on the stock pack because the
// copper_enr graph-assembly orphan is a known, documented out-of-scope finding.

const HEADLINE_ARGV = ["--plan", "xiranite_enr_powder=0.1", "--mode", "full"];

describe("solver-cli smoke", () => {
  it("returns a string (not a thrown error)", async () => {
    const out = await runCli(HEADLINE_ARGV);
    expect(typeof out).toBe("string");
    expect(out).not.toMatch(/^error:/);
  });

  it("contains required scalar keys", async () => {
    const out = await runCli(HEADLINE_ARGV);
    expect(out).toMatch(/^objective=/m);
    expect(out).toMatch(/^status=feasible/m);
    expect(out).toMatch(/^softFeasible=/m);
  });

  it("contains all invariant verdicts", async () => {
    const out = await runCli(HEADLINE_ARGV);
    expect(out).toMatch(/^massBalance ok=/m);
    expect(out).toMatch(/^targetsMet ok=/m);
    expect(out).toMatch(/^rawOnlyBoundary ok=/m);
    expect(out).toMatch(/^representable ok=/m);
    expect(out).toMatch(/^optimal ok=/m);
  });

  it("pins known noOrphanLogicalNodes ok=false for stock pack", async () => {
    const out = await runCli(HEADLINE_ARGV);
    // Expected false: copper_enr orphan is a documented graph-assembly finding.
    expect(out).toMatch(/^noOrphanLogicalNodes ok=false/m);
  });

  it("is deterministic: two calls with same args produce identical output", async () => {
    const argv = [...HEADLINE_ARGV];
    const out1 = await runCli(argv);
    const out2 = await runCli(argv);
    expect(out1).toBe(out2);
  });

  it("rates mode omits invariants section", async () => {
    const out = await runCli(["--plan", "xiranite_enr_powder=0.1", "--mode", "rates"]);
    expect(out).not.toMatch(/^# invariants/m);
    expect(out).toMatch(/^status=/m);
  });

  it("rejects missing --plan and --hash", async () => {
    const out = await runCli([]);
    expect(out).toMatch(/^error:/);
  });

  it("rejects both --plan and --hash", async () => {
    const out = await runCli(["--plan", "a=1", "--hash", "v1.abc"]);
    expect(out).toMatch(/^error:/);
  });

  it("parses explicit rational rate (num/denom)", async () => {
    // 6/60 = 0.1 per sec, same as the headline plan above.
    const out = await runCli(["--plan", "xiranite_enr_powder=6/60", "--mode", "rates"]);
    expect(out).toMatch(/^status=feasible/m);
  });

  // --- FIX 2: slash-branch validation ---

  it("rejects zero denominator in rational rate without throwing", async () => {
    const out = await runCli(["--plan", "xiranite_enr_powder=1/0", "--mode", "rates"]);
    expect(out).toMatch(/^error:/);
  });

  it("rejects non-numeric sides in rational rate without throwing", async () => {
    const out = await runCli(["--plan", "xiranite_enr_powder=abc/def", "--mode", "rates"]);
    expect(out).toMatch(/^error:/);
  });

  // --- FIX 1: flag-as-value detection ---

  it("rejects --plan followed immediately by a flag without throwing", async () => {
    // --plan --mode rates: --mode would be consumed as the plan value without the fix.
    const out = await runCli(["--plan", "--mode", "rates"]);
    expect(out).toMatch(/^error:/);
    expect(out).toContain("--plan requires a value");
  });

  // --- FIX 3: non-feasible full-mode guard ---

  it("returns clean error for full mode on unknown recipe (non-feasible/empty status)", async () => {
    // An unknown recipeId produces status=empty from the LP (no matching recipe
    // in the pack), so solveLp never reaches feasible. Without the guard,
    // solvePlanWithIntermediates would throw an infeasible exception. We verify
    // the guard intercepts it and returns a clean error string instead.
    const out = await runCli(["--plan", "no_such_recipe_id=1", "--mode", "full"]);
    expect(out).toMatch(/^error:/);
    expect(out).toContain("cannot run full invariants on a non-feasible solve");
    // Must not throw -- the test itself would fail if it did.
  });
});
