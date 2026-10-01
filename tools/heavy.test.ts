import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Drives tools/heavy.sh as a real process. Every run gets a private lock prefix
// under a fresh temp dir: the default /tmp/stc-heavy slots are shared by every
// agent on the machine, and a test holding them would stall real work.

const SCRIPT = fileURLToPath(new URL("./heavy.sh", import.meta.url));
const EX_USAGE = 64;
const EX_TEMPFAIL = 75;
// Five polls at STC_HEAVY_POLL_SECONDS=0.1: long enough that a waiter which was
// going to start wrongly would have done so.
const QUIET_WINDOW_MS = 500;
const MARKER_TIMEOUT_MS = 3000;

const HAS_FUSER = spawnSync("bash", ["-c", "command -v fuser"]).status === 0;

type Run = {
  child: ChildProcess;
  exited: Promise<{ code: number | null; stderr: string }>;
};

let dir: string;
let runs: Run[];

function gate(args: string[], env: Record<string, string> = {}): Run {
  const child = spawn("bash", [SCRIPT, ...args], {
    cwd: dir,
    // Its own process group, so cleanup can take down the command and anything
    // it left in the background along with the wrapper.
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      STC_HEAVY_LOCK_PREFIX: join(dir, "slot"),
      STC_HEAVY_POLL_SECONDS: "0.1",
      ...env,
    },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; stderr: string }>(
    (resolve) => child.on("close", (code) => resolve({ code, stderr })),
  );
  const run = { child, exited };
  runs.push(run);
  return run;
}

// A holder that marks itself started, then keeps its slot until released.
function holder(name: string): Run {
  return gate([
    "bash",
    "-c",
    `touch ${name}.started; while [ ! -e ${name}.release ]; do sleep 0.05; done`,
  ]);
}

const marker = (name: string) => join(dir, name);
const release = (name: string) => writeFileSync(marker(`${name}.release`), "");

async function waitFor(name: string): Promise<void> {
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (!existsSync(marker(name))) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${name}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stc-heavy-test-"));
  runs = [];
});

afterEach(async () => {
  // Also for runs that already exited: a background child they left behind is
  // still in their group.
  for (const run of runs) {
    if (run.child.pid !== undefined) {
      killGroup(run.child.pid);
    }
  }
  await Promise.all(runs.map((run) => run.exited));
  rmSync(dir, { recursive: true, force: true });
});

describe("tools/heavy.sh", () => {
  test("two holders run at once and a third waits for a slot", async () => {
    holder("a");
    holder("b");
    await waitFor("a.started");
    await waitFor("b.started");

    const third = gate(["touch", "c.started"]);
    await pause(QUIET_WINDOW_MS);
    expect(existsSync(marker("c.started"))).toBe(false);

    release("a");
    await waitFor("c.started");
    expect((await third.exited).code).toBe(0);
  });

  test("a slot stays held until the holder's background child exits too", async () => {
    // The wrapped command exits at once but leaves a child holding the lock fd.
    const first = gate([
      "bash",
      "-c",
      "sleep 30 >/dev/null 2>&1 & echo $! > child.pid",
    ]);
    expect((await first.exited).code).toBe(0);
    holder("b");
    await waitFor("b.started");

    gate(["touch", "c.started"]);
    await pause(QUIET_WINDOW_MS);
    expect(existsSync(marker("c.started"))).toBe(false);

    process.kill(Number(readFileSync(marker("child.pid"), "utf8")), "SIGKILL");
    await waitFor("c.started");
  });

  test("passes the wrapped command's exit code through", async () => {
    const run = gate(["bash", "-c", "exit 7"]);
    expect((await run.exited).code).toBe(7);
  });

  test("gives up with exit 75 after the max wait and names the holders", async () => {
    const a = holder("a");
    holder("b");
    await waitFor("a.started");
    await waitFor("b.started");

    const run = gate(["touch", "c.started"], {
      STC_HEAVY_MAX_WAIT_SECONDS: "1",
    });
    const { code, stderr } = await run.exited;

    expect(code).toBe(EX_TEMPFAIL);
    expect(existsSync(marker("c.started"))).toBe(false);
    expect(stderr).toContain("all 2 slots busy");
    expect(stderr).toContain("gave up after");
    // fuser is what names the holders; without it the report is just the
    // header, and the timeout itself still has to work.
    if (HAS_FUSER) {
      expect(stderr).toContain(join(dir, "slot.0.lock"));
      expect(stderr).toContain(String(a.child.pid));
    }
  });

  test("exits 64 with usage when given no command", async () => {
    const { code, stderr } = await gate([]).exited;
    expect(code).toBe(EX_USAGE);
    expect(stderr).toContain("usage: tools/heavy.sh");
  });
});
