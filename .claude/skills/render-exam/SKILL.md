---
name: render-exam
description: Use when asked to examine, audit, or regression-check the STC canvas rendering quality across solved plans with screenshots - e.g. "exam the rendering", "re-verify the render issues", "check rendering quality of plan X", or after render-affecting changes need a whole-plan visual sweep.
---

# Render-quality exam

Whole-plan exam of the STC canvas. Capture is deterministic code (`tools/exam/capture.ts`), not
an agent: it drives an already-running server, walks a fixed camera grid at a fixed zoom, and
writes images plus a `scene.json` ledger that states what it covered and which build and recipe
pack it shot. Evaluation agents critique the images cold against `docs/render-conventions.md`,
refuters disprove claims through `tools/exam/probe.ts`, and the orchestrator files issues. The
mechanical fan-out lives in the `render-quality-exam` named workflow; this skill is the judgment
layer around it.

Two rules hold the whole procedure up, because two earlier runs filed invalid findings for
want of them: a screenshot cannot tell "the app does nothing" from "my capture never touched
it", and a raw geometry count is not a defect.

## Procedure

### 1. Choose the server

The exam reads a deployed preview; nothing is built locally unless the fallback below is
needed. Every push deploys to the `stc-preview` Cloudflare project:

| tip under exam | base URL |
| --- | --- |
| `develop` | `https://stc-preview.pages.dev` |
| a pushed branch | `https://<branch-slug>.stc-preview.pages.dev` |

The slug is the branch lowercased, with every run of non-alphanumeric characters turned into
`-` and the result cut to 28 characters.

Prove the deployment is the commit you mean before capturing anything. Every build stamps its
own commit into the page:

```bash
curl -s https://stc-preview.pages.dev | rg -o 'name="stc-commit" content="[^"]+"'
git rev-parse --short=7 origin/develop
```

Compare the LEADING 7 characters of the meta content against the tip; a mismatch means CI has
not deployed that commit yet or the deploy failed, so wait for it or fall back. No tag in the
page at all means the served build predates the stamp: redeploy it, and do not examine it as
it stands.

Local fallback, for work that is not pushed:

```bash
bun run build
bun run preview --port 4174 --strictPort   # background it
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4174/   # poll until 200
```

Port 4174 on purpose: Playwright's `webServer` owns 4173 for the e2e suite, so step 4 can run
without disturbing the exam server. A local build of a worktree with untracked or modified
files stamps a `-dirty` suffix; report that separately in the final report as "exam of
uncommitted work" instead of pinning the findings to a commit nobody else can check out.

Step 4's geometry audit never touches this server: Playwright builds and serves the checkout
itself.

### 2. Choose the corpus

The fixed core is captured every time: `default`, `battery5-xiranite`, `multi6`, `gas-web`.
Rotating plans are chosen fresh each exam to reach recipes the core never runs.

Start by comparing the pack fingerprint. The first line of `.artifacts/exam/hashes.tsv` is
`# pack <sourceCommit> <gameVersion>`; if the last exam's ledger names a different pack, the
recipes moved underneath the corpus and its ids are not comparable with this run's.

```bash
bun run tools/exam/coverage.ts                    # the fixed core, report only
bun run tools/exam/coverage.ts --fill --max 4     # plus up to 4 rotating plans
```

Both runs rewrite `.artifacts/exam/hashes.tsv` with the fingerprint line and one
`<id>\t<hash>` row per plan; `--fill` appends the rotating rows after the core ones and writes
the picked scenarios to `.artifacts/exam/rotating.json`, which step 4 feeds back to the audit.

The report has three parts worth reading: per-plan and union coverage, the uncovered recipes,
and (after `--fill`) the residue grouped by the reason each recipe stayed out. A large residue
is expected and is not a corpus defect - most of it is alternate producers of an item the LP
never prefers, so no single-target plan can make the solver run them. The only part a bigger
`--max` would move is the count carried by the `reachable by an unpicked candidate; raise
--max` note. Candidates whose solve threw are listed separately and were skipped, never fatal.

The exam captures the core plus the rotating set, which is exactly what the ledger now holds.

### 3. Capture every plan in the ledger

One capture per ledger row, each launching its own Chromium, under the memory cap this 3.2 GiB
box needs:

```bash
while IFS=$'\t' read -r id hash; do
  case "$id" in \#*) continue ;; esac
  systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=512M -- \
    bun --smol run tools/exam/capture.ts \
      --base-url https://stc-preview.pages.dev \
      --hash "$hash" --plan-id "$id" --locale en --out .artifacts/exam
done < .artifacts/exam/hashes.tsv
```

The `#` fingerprint line is skipped; every other row is a plan. Other flags: `--target-zoom`
(default 0.75), `--locale` (default `en`; a `zh` exam is its own run, never a mix),
`--max-tiles` (default 64), `--seam-margin` (default 64). Outputs land in
`.artifacts/exam/<id>/` as `scene.json` plus an `images/` subdirectory holding `00-fit.png`,
`10-tile-r<row>c<col>.png` and `20-corrective-<nnn>-<slug>.png` (the index is zero-padded to
three digits). The split is structural: an evaluator is handed `images/` and judges the pixels
cold, so the ledger it must not read is not in the directory it can list. There is no smoke
test, because capture fails fast by itself:

| exit | what happened | what you do |
| --- | --- | --- |
| 0 | captured, `status` is `complete` or a labelled `partial` | keep it; a partial is a real capture, carry its blind spots forward |
| 1 | harness failure | fix the invocation and rerun |
| 2 | the base URL is not serving | back to step 1 |
| 3 | the page never became examinable | drop that plan and report it |
| 4 | the served build cannot name itself | redeploy or fix the build; do NOT drop the plan |

Exits 3 and 4 pull opposite ways on purpose. A plan that never became examinable is a fact
about that plan. A build with no provenance says nothing about any plan - every plan in the run
would fail the same way.

### 4. Run the geometry ratchets. These are the machine findings.

```bash
EXAM_EXTRA_SCENARIOS=.artifacts/exam/rotating.json bun run test:e2e geometry-audit
```

`EXAM_EXTRA_SCENARIOS` admits the rotating plans to the same hard assertions the fixed corpus
gets; a relative path resolves against the repo root, whatever directory the run started in.

A finding here is a failure of `test/e2e/geometry-audit.spec.ts`, and nothing else: either a
baseline EXCEEDANCE, or one of its hard zero-tolerance assertions (off-centre handles,
mult-chip/rate-block overlaps, chip-vs-chip overlaps, chips clipped outside the pane,
flow-chip-over-junction z-order, tier 1 segments entering a foreign raw card, the tundra
ore-feed presence check). That spec already encodes every ruling this repo has made about
acceptable geometry; the exam must not compute defects from its own numbers.

Read a SKIPPED rotating plan as "hard checks passed", not as "not examined". Twelve baseline
tables pin the fixed corpus and a rotating id sits in none of them, so the test runs every
zero-tolerance assertion first and only then ends as skipped, naming the id and the tables it
could not read. A fixed-corpus id missing a baseline row throws instead, because that is a
table that lost a row.

Attribute every failure to a commit before calling it a finding. The stable failset on the
current tip is: geometry-audit segment placement audit > multi6 (RAW pierce). For anything
else, rerun only that spec at the branch point in a throwaway worktree:

```bash
git worktree add .claude/worktrees/exam-base "$(git merge-base HEAD origin/develop)"
(cd .claude/worktrees/exam-base && bun install && \
  bun run test:e2e geometry-audit --grep "segment placement audit > multi6")
git worktree remove .claude/worktrees/exam-base
```

From the workspace root the first line is `git -C STC worktree add .claude/worktrees/exam-base
<merge-base sha>`. A test that fails identically on the base commit is not something this exam
found.

### 5. Build the workflow args from the ledgers

One jq over every `scene.json` emits the whole args object, so nothing is retyped and no field
is invented. Run it from the repo root:

```bash
jq -s --arg examDir "$PWD/.artifacts/exam" --arg repoRoot "$PWD" \
     --rawfile conv docs/render-conventions.md '{
  examDir: $examDir,
  repoRoot: $repoRoot,
  conventions: $conv,
  plans: [.[] | . as $s | {
    id: .planId,
    dir: "\($examDir)/\(.planId)/\(.imagesDir)",
    url: .url,
    locale: .locale,
    coverage: .coverage,
    images: [.tiles[] | {file, what: (
      if .kind == "fit" then "whole-graph fit overview, at the app fit zoom"
      elif .kind == "tile" then "grid tile row \(.row) col \(.col), at zoom \($s.targetZoom)"
      else "corrective shot, at zoom \($s.targetZoom)" end)}],
    tiles: [.tiles[] | {file, kind, viewportTransform, safeRegion}]
  }],
  measurements: ([.[] | {key: .planId, value: (.measurements | map({kind, footprint, detail}))}] | from_entries)
}' .artifacts/exam/*/scene.json
```

What each part is for, because passing the wrong thing here fails silently rather than loudly:

- `repoRoot` is `$PWD` only because the jq is run from the repo root. A refuter's Bash starts
  wherever its own agent did, so the probe command it is handed names the CLI absolutely
  instead of telling it where to stand.
- `conventions` is the text of `docs/render-conventions.md`, and it is the one thing an
  evaluator is told about the design it is judging; without it, deliberate behaviour comes back
  as a defect. A PR that changes a rendering rule must update `docs/render-conventions.md` in
  the same PR.
- `locale` is what the capture booted. Anything but `en` also sends the evaluator to the
  conventions doc's locale section, and a refuter boots the plan itself, so a missing locale
  probes a differently rendered app than the one under exam.
- `dir` is `<examDir>/<planId>/<imagesDir>`, the IMAGES directory. An evaluator is handed it and
  judges the pixels cold; the plan directory one level up holds `scene.json`, and handing that
  out instead would let a cold evaluator read the measurements its findings are about to be
  checked against. The workflow rejects a `dir` that is not strictly below the plan directory,
  so a wrong value stops the run.
- `tiles` is what the corroboration join needs: `file` is the bare name an evaluator can cite,
  `kind` says which camera shot it (only `tile` and `corrective` can carry a measurement), and
  `viewportTransform`/`safeRegion` place a world-unit footprint inside that image. Omit it and
  every join misses, which reads as "nothing was corroborated".
- `measurements` is keyed by plan id and trimmed to `kind`, `footprint` and `detail`. `[]` is a
  real answer: the measurement pass runs on every capture, so an empty array means measured and
  clean. `elementIds` is left out deliberately - nothing downstream reads it, and it stays in
  the ledger a refuter can open.
- `url` must be `scene.json`'s verbatim, `<baseUrl>/?exam=1#<hash>`: refuters' probe commands
  are built by splitting it.

Surface these four now, and again in the final report:

```bash
jq -r 'select(.status == "partial") | "\(.planId): \(.coverage.uncovered | length) uncovered, capHit=\(.coverage.capHit)"' .artifacts/exam/*/scene.json
jq -r 'select(.consoleErrors | length > 0) | "\(.planId): \(.consoleErrors | join(" | "))"' .artifacts/exam/*/scene.json
jq -r '"\(.planId): \([.elements[] | select(.kind == "band")] | length) band(s), \([.elements[] | select(.kind == "junction")] | length) junction(s)"' .artifacts/exam/*/scene.json
ledgerPack=$(awk 'NR == 1 {print $3}' .artifacts/exam/hashes.tsv)
jq -sr --arg ledgerPack "$ledgerPack" '
  (map(.commit) | unique) as $commits
  | (.[] | "\(.planId): pack \(.pack.sourceCommit) commit \(.commit)"
      + (if .pack.sourceCommit != $ledgerPack then "  <- captures were of a different pack" else "" end)),
    (if ($commits | length) > 1 then "commit disagreement across plans: \($commits | join(", "))" else "one build: \($commits[0])" end)
' .artifacts/exam/*/scene.json
```

The third line is the layout-feature census: bus bands and junction dots are the only features
the ledger records by their own kind. Icon-only chips are not in it (the chip record carries no
icon-only flag) and neither are fan-out columns (nothing records them), so read the census as
two counts, not as an inventory of what the layout did.

### 6. Run the workflow

From the MAIN session (the Workflow tool is not available inside subagents).

`Workflow({name: "render-quality-exam", args: <the object step 5 printed>})` - that is,
`{examDir, repoRoot, conventions, plans: [{id, dir, url, locale, images, tiles, coverage}],
measurements}`.

Write the return to `.artifacts/exam/<date>-run.json` with the Write tool the moment it comes
back, before reading a single verdict: step 7's crops are cut from that file, and a return that
exists only in the transcript is one compaction away from gone. Resuming with `resumeFromRunId`
re-runs agents that boot the app, so the preview server - remote or local - has to be reachable
again first.

Three phases:

- **Evaluate**: one agent per plan, given the images, the coverage ledger and the conventions
  doc, and nothing else. It returns typed findings, each with a pixel rect per evidence entry, a
  `claimType`, and a `falsifier` naming the probe op that would disprove it.
- **Triage** (code, no agent): validates every finding, joins it to the measurements by
  footprint, and routes it. A geometric finding with an independent measurement at the
  place it marked is CORROBORATED and skips refutation; a stated mechanism, an absence
  claim or an interaction claim always goes to its own refuter; a subjective claim goes to
  you; anything malformed is reported, never routed. The routing histogram is logged.
- **Refute**: one agent per individually routed finding, one per plan for the batched
  minors. Each must DISPROVE its finding through `tools/exam/probe.ts` and return the
  command it ran and what it printed.

It returns `{evaluations, findings, triage, verdicts, humanRuling, invalid}`. A verdict
judges the observation and the mechanism SEPARATELY, so "symptom real, cause wrong" comes
back as `observationVerdict: CONFIRMED` with `mechanismVerdict: REFUTED`, and its
`disposition` says what to do with it:

| disposition | what it means | what you do |
| --- | --- | --- |
| `FILE` | observation confirmed, mechanism (if any) confirmed | file it |
| `FILE_SYMPTOM_ONLY` | symptom real, stated cause disproved | file the symptom; the struck-out cause is in `mechanismStripped` |
| `HUMAN_REVIEW` | UNCERTAIN on some claim | you rule on it; never file it as-is |
| `DROP` | observation disproved at runtime | do not file |

Every verdict carries the same keys whatever produced it, so one filter reads them all:

| field | what it holds |
| --- | --- |
| `findingId`, `planId` | which finding this answers; the id is namespaced `<planId>:<slug>` |
| `observationVerdict` | `CONFIRMED` / `REFUTED` / `UNCERTAIN` on the symptom |
| `mechanismVerdict` | the same on the stated cause; `null` when the finding stated none |
| `mechanismStripped` | the cause struck out; `null` unless `FILE_SYMPTOM_ONLY` |
| `disposition` | the table above, derived from the two verdicts and nothing else |
| `corroboratedBy` | the measurement ids (`<planId>#<index>:<kind>`) that carried the finding past refutation; `[]` for anything a refuter answered |
| `probeCommand`, `probeOutput` | what was run and what it printed; `null` for a corroborated finding, which never reached an agent, and for a refuter that ran nothing |
| `reasoning` | how that settles the claim; `null` when none was given |
| `correctedObservation` | what is actually true, when the symptom is real but stated wrongly; `null` otherwise |
| `coercions` | why a claim was forced to `UNCERTAIN`; `[]` when nothing was forced |

So `probeCommand: null` does not mean unsupported: check `corroboratedBy` before reading it
that way.

`UNCERTAIN` is a legitimate answer and is preferred over a guess. A verdict that cites no
`probeCommand` and `probeOutput`, a refuter that returns nothing at all, and a refuter whose
answers carry finding ids nobody asked about are all coerced to `UNCERTAIN` by the workflow,
with the reason in `coercions`: nothing is ever auto-confirmed or auto-dropped.
`humanRuling` carries the subjective findings, `invalid` the malformed ones with their
violations.

Refuters answer through `tools/exam/probe.ts`, which boots one plan, optionally commands a
camera (`--zoom` and `--center` together), and runs one named op:

```bash
bun run tools/exam/probe.ts --base-url https://stc-preview.pages.dev --hash <planHash> \
  --locale en --op hover-edge --arg id='<edgeId>'
```

Ops: `hover-edge`, `hover-node`, `contrast`, `delta-e`, `chip-binding`, `rect`,
`computed-style`, `text-overflow`; `--eval <file.js>` is the escape hatch and `--shot
<out.png>` writes evidence. `--locale` must be the locale the plan was captured in. A `--shot`
after a hover op deliberately photographs the pointer where the op left it, so the image shows
the dimmed state the finding was about.

### 7. Verify, group, and file

File `FILE` and `FILE_SYMPTOM_ONLY`, rule on `HUMAN_REVIEW` and on `humanRuling` yourself, and
file nothing that came back `DROP`. An entry in `invalid` is a defect of the REPORT, not of the
app: it was never routed and no verdict exists for it, so read its `violations`, and either
restate the finding yourself against the evidence image (then treat it as your own claim,
disproving it before filing) or drop it. Do not file one as it stands. Read the evidence image
for every major finding yourself and drop or downgrade what the pixels do not show; the
workflow's "nothing is auto-dropped" rule binds the machine, not you, and this pass is where a
finding the pixels do not support dies.

Check what is already open before writing anything new:

```bash
gh issue list --state open --limit 100
```

Match each surviving finding to an open issue by defect FAMILY - same mechanism, not same plan.
A finding that belongs to an open family is a reconfirmation comment on that issue, naming the
plan and the evidence, not a second issue. Only a family nothing covers earns a new issue.

Cut the evidence crops from the saved return:

```bash
bun run tools/exam/crop.ts --verdicts .artifacts/exam/<date>-run.json
```

That crops every evidence entry of every `FILE` and `FILE_SYMPTOM_ONLY` verdict with a 24 px
margin into `.artifacts/exam/crops/`, named `<findingId>-<n>.png` with the id's colon
flattened to `-`. A `HUMAN_REVIEW` or `humanRuling` finding you decide to file is not in that
pass and there is no margin flag, so cut those by hand:

```bash
bun run tools/exam/crop.ts --image .artifacts/exam/<plan>/images/<tile>.png \
  --rect <x>,<y>,<w>,<h> --out .artifacts/exam/crops/<name>.png
```

Write each new issue body to `.artifacts/exam/issues/<slug>.md` and hand the user the
`gh issue create --title "..." --body-file .artifacts/exam/issues/<slug>.md` commands rather
than running them: creation was classifier-blocked in auto mode on 2026-08-15. Push the PNGs to
an orphan assets branch via git plumbing (no checkout switch): `git hash-object -w` each PNG,
`git mktree`, `git commit-tree`, `git branch exam-assets-<date>`, push, then embed
`https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<file>` in the bodies. Include
per-plan share hashes in a `<details>` block for reproduction.

## What the final report says

In this order:

- the pack fingerprint from `hashes.tsv`, and any plan whose `scene.json` names a different one
  ("captures were of a different pack")
- the served commit against the tip under exam, with "exam of uncommitted work" when the stamp
  carried `-dirty`
- the fixed core: `default`, `battery5-xiranite`, `multi6`, `gas-web`
- each rotating plan and the recipes it brought in
- the uncovered residue by reason class, with how much of it a larger `--max` would have reached
- the band and junction census, per plan
- every partial plan with the ids in its `coverage.uncovered`
- every console error
- every capture that failed, with its exit code
- the geometry-audit failset, and which of it fails identically at the base commit

## What `scene.json` is

A ledger of what was captured and measured, with no verdicts in it.

- `pack`, `commit` and `locale` are the provenance: the recipe pack the app shipped, the build
  the page named itself as, and the language the capture booted. They are what makes a capture
  comparable with another one, or provably not.
- `imagesDir` is the image subdirectory, relative to `scene.json` itself; `tiles[].file` is a
  bare file name, so an image resolves as `<plan dir>/<imagesDir>/<file>`. Keep it bare when
  citing one: the corroboration join matches an evaluator's cited name against `tiles[].file`.
- `elements` is a map from element id to `{kind, worldRect}` over the whole plan;
  `tiles[].elements` places those elements in CSS pixels within one image, but only those
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
| Capture exit 4 looks like a broken plan | It is a broken BUILD: the page could not name its commit. Redeploy or rebuild and capture again; dropping the plan hides a fault that affects all of them |
| A rotating plan reported SKIPPED by the geometry audit | Read it as "hard checks passed". The zero-tolerance assertions all ran; the skip only says the ratchet tables pin no baseline for that id |
| A `-dirty` commit stamp | The server is serving uncommitted work. Say so in the report; findings from it cannot be pinned to a commit anyone else can check out |
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
