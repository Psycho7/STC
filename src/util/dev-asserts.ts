// Arming predicate for the pipeline's expensive internal checks (solver and
// render invariants, the augmented-LP-support seed guard, the edge-rate
// capacity guard).
//
// Two runtimes have to agree on it. Vite sets import.meta.env.DEV, so the dev
// server and vitest arm the checks; a production browser bundle never does.
// Bun leaves import.meta.env.DEV undefined, so tools/exam and tools/solver-cli
// ran every check disarmed even in validation runs -- STC_VALIDATE=1 arms them
// there explicitly.
//
// `process` is absent from a browser bundle and vite does not shim it, so the
// lookup is guarded by a typeof test and an optional `.env` rather than read
// directly: a page that ships a partial process shim must not crash the solver.
// The predicate is a call, not a constant, so a test can flip either input per
// case; the cost is that a production bundle keeps the checker code it can no
// longer prove unreachable.
export const VALIDATE_ENV_VAR = "STC_VALIDATE";

export function devAsserts(): boolean {
  if (import.meta.env.DEV) {
    return true;
  }

  if (typeof process === "undefined") {
    return false;
  }

  return process.env?.[VALIDATE_ENV_VAR] === "1";
}
