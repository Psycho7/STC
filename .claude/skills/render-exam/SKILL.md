---
name: render-exam
description: Use when asked to examine, audit, or regression-check the STC canvas rendering quality across solved plans with screenshots - e.g. "exam the rendering", "re-verify the render issues", "check rendering quality of plan X", or after render-affecting changes need a whole-plan visual sweep.
---

# Render-quality exam

Whole-plan exam of the STC canvas. Capture is deterministic code (`tools/exam/capture.ts`), not
an agent: it walks a fixed camera grid at a fixed zoom and writes images plus a `scene.json`
ledger that states what it covered. Evaluation agents critique the images cold, refuters
disprove claims through `tools/exam/probe.ts`, and the orchestrator files issues. The
mechanical fan-out lives in the `render-quality-exam` named workflow; this skill is the
judgment layer around it.

Two rules hold the whole procedure up, because two earlier runs filed invalid findings for
want of them: a screenshot cannot tell "the app does nothing" from "my capture never touched
it", and a raw geometry count is not a defect.

## Procedure

1. **Prep server** (a production build avoids DEV render-hook hard-fails on residual-dirty
   plans):

   ```bash
   bun run build
   bun run preview --port 4174 --strictPort   # background it
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4174/   # poll until 200
   ```

   Port 4174 on purpose: Playwright's `webServer` owns 4173 for the e2e suite, so step 4 can
   run without disturbing the exam server.

2. **Generate plan hashes** from the scenario fixtures (`test/e2e/scenarios.ts`), which encode
   with the app's own encoder:

   ```bash
   bun -e 'const {SCENARIOS, scenarioHash} = await import("./test/e2e/scenarios.ts"); for (const s of SCENARIOS) console.log(`${s.id}\t${await scenarioHash(s)}`)'
   ```

   A hash from anywhere else works too; it is the plain `v1.` fragment, and the capture CLI
   builds the URL around it.

3. **Capture each plan**, one at a time (each run launches its own Chromium):

   ```bash
   bun run tools/exam/capture.ts --base-url http://localhost:4174 \
     --hash <planHash> --plan-id <id> --out .artifacts/exam
   ```

   Optional: `--target-zoom` (default 0.75), `--locale` (default `en`), `--max-tiles`
   (default 64), `--seam-margin` (default 64). Outputs land in `.artifacts/exam/<id>/` as
   `scene.json` plus an `images/` subdirectory holding `00-fit.png`,
   `10-tile-r<row>c<col>.png` and `20-corrective-<nnn>-<slug>.png` (the index is zero-padded
   to three digits). The split is structural: an evaluator is handed `images/` and judges the
   pixels cold, so the ledger it must not read is not in the directory it can list.
   No smoke test: capture fails fast by itself. Exit 2 means the base URL is not serving,
   exit 3 means the page never became examinable (drop the plan and report it), exit 1 is a
   harness failure. Exit 0 with `status: "partial"` is a real capture with named blind spots -
   keep it, and carry the blind spots forward.

4. **Run the geometry ratchets. These are the machine findings.**

   ```bash
   bun run test:e2e geometry-audit
   ```

   A finding here is a failure of `test/e2e/geometry-audit.spec.ts`, and nothing else: either a
   baseline EXCEEDANCE, or one of its hard zero-tolerance assertions (off-centre handles,
   mult-chip/rate-block overlaps, chip-vs-chip overlaps, chips clipped outside the pane,
   flow-chip-over-junction z-order, tier 1 segments entering a foreign raw card, the tundra
   ore-feed presence check). That spec already encodes every ruling this repo has made about
   acceptable geometry; the exam must not compute defects from its own numbers. Before calling a failure
   a finding, check it against the branch point: this suite carries known pre-existing
   failures, and a test that fails identically on the base commit is not something this exam
   found.

5. **Extract the ledger for the workflow.** The workflow gets measurements and coverage. It
   passes coverage on to the evaluators, because that is what lets them honour the
   no-absence-claims rule, and withholds the measurements: they judge the images cold.

   ```bash
   jq -s 'map({planId, status, targetZoom, coverage, measurements, crossingCensus})' .artifacts/exam/*/scene.json
   ```

   Surface these two now, and again in the final report:

   ```bash
   jq -r 'select(.status == "partial") | "\(.planId): \(.coverage.uncovered | length) uncovered, capHit=\(.coverage.capHit)"' .artifacts/exam/*/scene.json
   jq -r 'select(.consoleErrors | length > 0) | "\(.planId): \(.consoleErrors | join(" | "))"' .artifacts/exam/*/scene.json
   ```

6. **Run the workflow** from the MAIN session (the Workflow tool is not available inside
   subagents).

   The workflow's Evaluate phase is implemented; the args block below is finalised in the
   next change.

   `Workflow({name: "render-quality-exam", args: {plans, repoDir, examDir, measurements, coverage}})`,
   where `plans` is `[{id, hash}]`, `repoDir` is the absolute root of the checkout the preview
   server serves, and `examDir` is the absolute `.artifacts/exam` you captured into. It runs
   Evaluate (one agent per plan, images plus the coverage ledger), a code triage that joins
   findings to measurements by footprint, and Refute.

   Refuters answer through `tools/exam/probe.ts`, which boots one plan, optionally commands a
   camera (`--zoom` and `--center` together), and runs one named op:

   ```bash
   bun run tools/exam/probe.ts --base-url http://localhost:4174 --hash <planHash> \
     --op hover-edge --arg id='<edgeId>'
   ```

   Ops: `hover-edge`, `hover-node`, `contrast`, `delta-e`, `chip-binding`, `rect`,
   `computed-style`, `text-overflow`; `--eval <file.js>` is the escape hatch and `--shot
   <out.png>` writes evidence. A `--shot` after a hover op deliberately photographs the
   pointer where the op left it, so the image shows the dimmed state the finding was about.

7. **Verify, group, and file.** Read the evidence image for every major finding yourself;
   drop or downgrade what the pixels do not show, and drop any verdict that cites no probe
   command and output. Group cross-plan into one issue per defect FAMILY (same mechanism, not
   same plan). File with `gh issue create --body-file`, pushing PNGs to an orphan assets
   branch via git plumbing (no checkout switch): `git hash-object -w` each PNG, `git mktree`,
   `git commit-tree`, `git branch exam-assets-<date>`, push, then embed
   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>` in the bodies. Include
   per-plan share hashes in a `<details>` block for reproduction. Report to the human: every
   partial plan with its uncovered ids, every console error, and every plan that failed to
   capture.

## What `scene.json` is

A ledger of what was captured and measured, with no verdicts in it.

- `imagesDir` is the image subdirectory, relative to `scene.json` itself; `tiles[].file` is a
  bare file name, so an image resolves as `<plan dir>/<imagesDir>/<file>`. Keep it bare when
  citing one: the corroboration join matches an evaluator's cited name against `tiles[].file`.
- `tiles[].elements` places elements in CSS pixels within that image, but only those
  intersecting the tile's `safeRegion`: an element that reaches the pane only under the minimap
  or the zoom controls is in the image and NOT in this map, deliberately.
- Coordinate frames: `worldRect`, `contentRect` and `footprint` are React Flow world units;
  every other rect is pane-relative CSS pixels, which for a tile is that image's own frame.
- `measurements` are occurrences the geometry audits report, each pinned to a footprint. They
  exist to corroborate a finding someone else made, and to arm refuters. An empty array means
  measured and clean. A footprint is in world units, so it must be projected into image space
  before it can be compared to an evaluator's evidence rect: for the tile you are joining
  against, `x_css = x_world * viewportTransform.zoom + viewportTransform.x` (same for `y`),
  widths and heights scaled by `zoom`. Joining the raw footprint to a CSS-pixel rect compares
  two different coordinate systems and silently misses, which reads as an uncorroborated
  finding.
- `coverage` says what the capture proved it framed. `uncovered` is the list of blind spots.
- `consoleErrors` is collected from the first navigation onward.

## Gotchas (each cost a debug round)

| Trap | Rule |
| --- | --- |
| A plan captured at `status: "partial"` has blind spots | Report every id in `coverage.uncovered`; no evaluator finding and no issue may make an absence claim about one |
| Raw geometry measurements are not defects | `geometry-audit.spec.ts` permits large nonzero per-scenario counts of every measurement kind behind written rulings; a machine finding is that spec failing, never a row of `scene.json` |
| The exam's counts and the ratchet baselines are different numbers | Measurements are taken at `targetZoom`, baselines at the app's fit camera, and chips counter-scale; never compare the two, and never read a difference as a regression |
| `hoverEngaged: false` is a capture miss, not a product defect | Read `engagedElsewhere` and `samples`, then re-probe `engagedElsewhere.id` through `--arg id=`, or reframe with `--zoom`/`--center`, or reach for `--eval`; the probe picks its own sample fractions and no flag names a point |
| Only `decision.noResponse` is a hover defect | The probe emits its own rule in `decision.rule`: an empty `observedDimmed` against a non-empty `expectedDimmed` is a real "hover produced no response". A set DIFFERENCE between the two is NOT a defect - the app lights whole bus trunk groups while `expectedDimmed` is the graph's ego-network - so `decision.differs` is reported precisely so nobody files it |
| `00-fit.png` is shot at the app's fit zoom, not `targetZoom` | Chips are LOD-hidden below `lodGates.labelMinZoom`; compare `fit.zoom` against `lodGates` before believing anything the fit overview does not show |
| The exam runs `?exam=1`, query before fragment | Without it `window.__stcExam` is absent and both CLIs exit 3. The CLIs build the URL; a hand-written one is where this goes wrong |
| Repo convention forbids committed binaries | Captures go to gitignored `.artifacts/`; issue images to the orphan assets branch only |

## When NOT to use

- Single-component or single-defect checks: drive the app directly with `tools/exam/probe.ts`
  instead of a multi-agent sweep.
- Pixel-diff regression against pinned baselines: that is `test/e2e/placement-shots.spec.ts`.
