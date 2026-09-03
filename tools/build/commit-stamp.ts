// The app commit the bundle was built from, resolved once at config load and
// baked into the build as `__STC_COMMIT__` and as an `<meta name="stc-commit">`
// tag.
//
// Why the app needs to say this at all: the render exam drives a deployed
// preview, and nothing else on the page proves which build is being served -
// the side rail's REV is the recipe pack's vendor commit, not this repo's. A
// deploy that lagged or failed would otherwise be examined silently as if it
// were the tip.
//
// The formatting half is kept pure so the three cases that matter (an
// environment override, a dirty worktree, no git at all) are pinned by unit
// test rather than by whatever the machine running the build happens to be.

import { execFileSync } from "node:child_process";

// What a build with no reachable git history stamps. A literal rather than an
// empty string: a reader comparing a scene against a deployment must be able to
// tell "this build could not name itself" from "this field was never written".
export const UNKNOWN_COMMIT = "unknown";

// Every stamp is cut to this many characters before the dirty suffix, so a CI
// build (which is handed a full 40-character sha) and a local build (which
// reads an abbreviated one) agree in shape and can be compared by eye.
const SHORT_LEN = 7;

export type CommitStampInput = {
  // The override an environment sets. Wins over the git reading outright: CI
  // knows the commit it checked out, and for a pull request that is the head
  // sha rather than the synthetic merge commit git would report.
  envCommit?: string | undefined;
  // `git rev-parse --short=7 HEAD`, or undefined when git could not answer.
  headSha?: string | undefined;
  // Whether the worktree carries a tracked change. The suffix it produces is
  // what tells an exam of uncommitted local work apart from an exam of a tip.
  dirty?: boolean | undefined;
};

export function formatCommitStamp(input: CommitStampInput): string {
  const env = input.envCommit?.trim();
  if (env) return env.slice(0, SHORT_LEN);
  const head = input.headSha?.trim();
  if (!head) return UNKNOWN_COMMIT;
  const short = head.slice(0, SHORT_LEN);
  return input.dirty ? `${short}-dirty` : short;
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    // A git that fails (no repository, no binary) must fall through to the
    // fallback rather than print to the build's stderr.
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// Read the stamp from the environment, falling back to git and then to
// UNKNOWN_COMMIT. Runs at config load, which includes every vitest run, so it
// must never throw and never require a git checkout. `run` is the seam the
// tests drive: a real git is not a thing a unit test can put into a chosen
// state.
export function resolveCommitStamp(
  env: Record<string, string | undefined> = process.env,
  run: (args: string[]) => string = git,
): string {
  const envCommit = env.STC_COMMIT;
  if (envCommit?.trim()) return formatCommitStamp({ envCommit });

  // The two reads get their own try each. A rev-parse that already answered is
  // knowledge about the build, and a status that fails afterwards does not take
  // it away: falling back to UNKNOWN_COMMIT there would attribute the bundle to
  // no commit at all over a question that was only ever about the suffix.
  let headSha: string;
  try {
    headSha = run(["rev-parse", "--short=7", "HEAD"]);
  } catch {
    return formatCommitStamp({});
  }

  // --untracked-files=no on purpose. This repo keeps untracked working
  // documents around by convention, so a plain --porcelain would report a
  // change on every developer machine and stamp every local build -dirty
  // forever - which costs the suffix the one job it has, telling uncommitted
  // work apart from a tip. Only tracked edits change what the bundle contains.
  let dirty = false;
  try {
    dirty =
      run(["status", "--porcelain", "--untracked-files=no"]).trim() !== "";
  } catch {
    dirty = false;
  }
  return formatCommitStamp({ headSha, dirty });
}
