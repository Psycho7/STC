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
});
