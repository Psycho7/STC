---
name: render-exam
description: Use when asked to examine, audit, or regression-check the STC canvas rendering quality across solved plans with screenshots - e.g. "exam the rendering", "re-verify the render issues", "check rendering quality of plan X", or after render-affecting changes need a whole-plan visual sweep.
---

# Render-quality exam

Screenshot-based whole-plan exam of the STC canvas: capture agents sweep each plan with Playwright, evaluation agents critique the screenshots, the orchestrator verifies and files issues. The mechanical fan-out lives in the `render-quality-exam` named workflow; this skill is the judgment layer around it.

## Procedure

1. **Prep server** (production build avoids DEV render-hook hard-fails on residual-dirty plans):
   `bun run build`, then background `bun run preview --port 4174 --strictPort` (both scripts exist in package.json); poll the URL with curl until it returns 200 before continuing.
2. **Pick plans + generate share URLs.** Complex multi-target plans stress routing most. Known-good recipe ids and the encoder pattern: `test/e2e/scenarios.ts` (`scenarioHash` / `encodePlan` + `PACK`). `encodePlan` returns the complete fragment (starts with `v1.`), so a plan URL is `http://localhost:4174/#` + that string, nothing else. Write a small bun script emitting `[{id, url}]`.
3. **Smoke-test each URL** with one headless-chromium bun script before fanning out: fresh `browser.newPage()` PER PLAN, set `localStorage aef.locale=en` via addInitScript, wait for a `.react-flow__node-*` visible AND `.canvas-annot.bottom-right` containing `READY`, log counts of `.react-flow__node` / `.react-flow__edge`. Fix or drop plans that fail.
4. **Run the workflow** from the MAIN session (the Workflow tool is not available inside subagents): `Workflow({name: "render-quality-exam", args: {plans, repoDir, examDir: <repoDir>/.artifacts/exam}})`, where `repoDir` is the absolute root of the checkout the preview server serves (typically the current worktree). It captures (Opus, fit shot + wheel-zoom tile grid + hover shots) and evaluates (correctness / comprehension / UX) per plan, two plans at a time.
5. **Verify before filing.** Read the evidence screenshot for EVERY major finding yourself; drop or downgrade anything the pixels do not show. Evaluators are instructed to skip intentional behaviors (LOD chip hiding below zoom 0.35, hidden branch chips, hover dimming) - still double-check majors against that list.
6. **Group cross-plan** into one issue per defect FAMILY (same mechanism, not same plan). Typical yield: ~25 raw findings -> ~12 issues.
7. **File issues with screenshots.** Push evidence to an orphan assets branch via git plumbing (no checkout switch): `git hash-object -w` each PNG, `git mktree`, `git commit-tree`, `git branch exam-assets-<date>`, push; embed `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>` in bodies (owner/repo from `git remote get-url origin`); `gh issue create --body-file`. Include per-plan share hashes in a `<details>` block for reproduction.

## Gotchas (each cost a debug round)

| Trap | Rule |
| --- | --- |
| Hash-only `page.goto` on a reused page does NOT reload the plan | Fresh page per plan, and wait for `READY` status text |
| Wheel/drag panning can grab a node card and corrupt the layout | Never pan-drag; re-fit via the `.react-flow__controls-fitview` button, then wheel-zoom at a grid point (zoom keeps the world point under the mouse fixed) |
| Mouse resting over the canvas engages hover-dim after 150ms | Park the mouse at (3,3) and wait ~400ms before every screenshot |
| Chips are LOD-hidden below zoom 0.35 | Tile zoom must be >= ~0.85 for legible chip text; fit shot shows aggregates only |
| Workflow `args` may arrive JSON-stringified | The workflow script already guards with `typeof args === "string"` |
| 4 concurrent chromiums OOM this 7GB box | The workflow chunks plans in pairs; keep it |
| Repo convention forbids committed binaries | Captures go to gitignored `.artifacts/`; issue images to the orphan assets branch only |

## When NOT to use

- Single-component or single-defect checks: drive the app directly (see the visual-verification protocol) instead of a multi-agent sweep.
- Pixel-diff regression against pinned baselines: that is `test/e2e/placement-shots.spec.ts`.
