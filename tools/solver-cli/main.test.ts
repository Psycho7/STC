import { describe, expect, it } from "vitest";
import { runCli } from "./main";
import { pack } from "../../src/data/load";
import { defaultPlan, encodePlan } from "../../src/data/plan";
import { RENDER_INVARIANT_CHECKERS } from "../../src/pipeline/render/invariants";

// Smoke tests for the solver-cli. These call runCli() directly (no process
// spawning) and assert on the returned string. The headline plan is a single
// target at 0.1 items/sec, exercising the full LP -> invariants -> optimality
// path deterministically.

const HEADLINE_ARGV = ["--plan", "xiranite_enr_powder=0.1", "--mode", "full"];

describe("solver-cli smoke", () => {
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

  it("reports noOrphanLogicalNodes ok=true for the stock pack", async () => {
    const out = await runCli(HEADLINE_ARGV);
    // The SCC boundary demand split resolved the copper_enr phantom-replica
    // orphan, so the headline plan has no orphan logical nodes.
    expect(out).toMatch(/^noOrphanLogicalNodes ok=true/m);
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

  // --- slash-branch validation ---

  it.each([
    { name: "zero denominator", plan: "xiranite_enr_powder=1/0" },
    { name: "non-numeric sides", plan: "xiranite_enr_powder=abc/def" },
  ])("rejects $name in rational rate without throwing", async ({ plan }) => {
    const out = await runCli(["--plan", plan, "--mode", "rates"]);
    expect(out).toMatch(/^error:/);
  });

  // --- flag-as-value detection ---

  it("rejects --plan followed immediately by a flag without throwing", async () => {
    // Without the guard, --mode would be consumed as the --plan value.
    const out = await runCli(["--plan", "--mode", "rates"]);
    expect(out).toMatch(/^error:/);
    expect(out).toContain("--plan requires a value");
  });

  // --- --hash threads itemOverrides into the solve ---

  it("threads a decoded plan's itemOverrides through the --hash solve", async () => {
    // Build a plan with a plan:true override on xiranite_powder, a non-raw
    // direct input of the headline target. The override frees that item as a
    // boundary, so its producer chain drops out, which the override-free --plan
    // solve of the same target cannot reproduce. Equal output would mean the
    // override was dropped on the --hash path.
    const plan = defaultPlan(pack);
    plan.targets = [
      { itemId: "xiranite_enr_powder", ratePerSec: { num: "6", denom: "60" } },
    ];
    plan.itemOverrides = [{ itemId: "xiranite_powder", plan: true }];
    const hash = await encodePlan(plan);

    const withOverride = await runCli(["--hash", hash, "--mode", "rates"]);
    const noOverride = await runCli([
      "--plan",
      "xiranite_enr_powder=6/60",
      "--mode",
      "rates",
    ]);

    expect(withOverride).not.toMatch(/^error:/);
    expect(withOverride).not.toBe(noOverride);
    // With the override, xiranite_powder's producer is not solved for. Since
    // game v1.4 the LP's pick for that producer is the gas-route
    // phase_trans_2-xiranite_powder recipe.
    expect(noOverride).toMatch(/^phase_trans_2-xiranite_powder=/m);
    expect(withOverride).not.toMatch(/^phase_trans_2-xiranite_powder=/m);
  });

  it("returns clean error for full mode on unknown item", async () => {
    // The --plan path validates target itemIds against the pack and returns a
    // clean error string instead of letting the unknown id reach the solver.
    const out = await runCli(["--plan", "no_such_item_id=1", "--mode", "full"]);
    expect(out).toMatch(/^error:/);
    expect(out).toContain('unknown item "no_such_item_id"');
    // Must not throw; the test would fail if it did.
  });

  it("render mode produces units, edges, and render-invariants blocks", async () => {
    const out = await runCli(["--plan", "xiranite_enr_powder=0.1", "--mode", "render"]);
    expect(out).not.toMatch(/^error:/);
    expect(out).toContain("# units");
    expect(out).toContain("# edges");
    expect(out).toContain("# render-invariants");
    expect(out).toMatch(/edgeEndpointIntegrity ok=/);

    // Every checker in the exported table gets a verdict, in table order. A
    // checker added to checkRenderPlan but not to the table (or the reverse)
    // trips the CLI's count guard; this pins the labelling itself.
    const block = out.slice(out.indexOf("# render-invariants"));
    const labelled = [...block.matchAll(/^(\w+) ok=/gm)].map((m) => m[1]);
    expect(labelled).toEqual(RENDER_INVARIANT_CHECKERS.map((c) => c.name));
  });
});
