export const meta = {
  name: 'render-quality-exam',
  description: 'Capture and evaluate rendering quality of solved plans (screenshot sweep + visual critique)',
  whenToUse: 'Invoked by the render-exam skill after a preview server is running and plan URLs are smoke-tested',
  phases: [
    { title: 'Capture', detail: 'Opus + Playwright screenshot sweeps per plan', model: 'opus' },
    { title: 'Evaluate', detail: 'Read screenshots and critique correctness/comprehension/UX' },
  ],
}

// args: { plans: [{id, url}], repoDir, examDir }
//   plans: solved-plan share URLs (smoke-tested to reach STATUS READY)
//   repoDir: absolute path of the STC checkout the preview server serves
//   examDir: absolute scratch dir for captures (gitignored, e.g. <repoDir>/.artifacts/exam)
const input = typeof args === 'string' ? JSON.parse(args) : args
const plans = input.plans
const REPO = input.repoDir
const EXAM_DIR = input.examDir

const CAPTURE_SCHEMA = {
  type: 'object',
  properties: {
    planId: { type: 'string' },
    dir: { type: 'string', description: 'absolute directory holding the captures' },
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'file name relative to dir' },
          what: { type: 'string', description: 'what this image shows (fit / tile position / hover state), incl. approx zoom' },
        },
        required: ['file', 'what'],
      },
    },
    notes: { type: 'string', description: 'coverage caveats, console errors seen, anything odd during capture' },
  },
  required: ['planId', 'dir', 'images', 'notes'],
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    planId: { type: 'string' },
    overall: { type: 'string', description: '2-4 sentence overall quality verdict for this plan' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'short defect statement' },
          severity: { type: 'string', enum: ['major', 'minor', 'nit'] },
          aspect: { type: 'string', enum: ['correctness', 'comprehension', 'ux'] },
          description: { type: 'string', description: 'what is wrong, why it hurts the reader, grounded in the pixels' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                image: { type: 'string', description: 'file name of the screenshot showing it' },
                where: { type: 'string', description: 'where in the image (quadrant / nearby labels)' },
              },
              required: ['image', 'where'],
            },
          },
        },
        required: ['title', 'severity', 'aspect', 'description', 'evidence'],
      },
    },
  },
  required: ['planId', 'overall', 'findings'],
}

const capturePrompt = (p) => `You are a screenshot-capture agent for the STC blueprint canvas (a React Flow production-chain planner). A production preview server is ALREADY RUNNING. Do not start/stop servers, do not modify any repo source file. Work from ${REPO} (stay inside it).

Plan under exam: "${p.id}"
URL: ${p.url}

Your job: produce a set of PNG screenshots under ${EXAM_DIR}/${p.id}/ that together capture EVERYTHING this plan renders -- every node card, edge, rate chip, bus lane band (they sit above/below the node block), junction dot, and any chip that sits outside the node block. Then return a manifest.

Method -- write a Playwright script (TypeScript, import { chromium } from "playwright") into ${EXAM_DIR}/${p.id}/capture.ts and run it with: cd ${REPO} && bun ${EXAM_DIR}/${p.id}/capture.ts
(playwright is a devDependency; chromium is installed.)

Script requirements:
1. Fresh browser page, viewport 1920x1080, deviceScaleFactor 2. Before navigation: page.addInitScript(() => window.localStorage.setItem("aef.locale", "en")).
2. page.goto(url, { waitUntil: "load" }); wait for a node (".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product") to be visible (30s timeout); wait for the status annotation ".canvas-annot.bottom-right" to contain "READY"; await document.fonts.ready via page.evaluate; then wait ~800ms for the fit-view camera to settle. Collect console errors (page.on("console")) into your notes.
3. FIT SHOT: screenshot of the element ".react-flow" saved as 00-fit.png. This is the overview truth.
4. TILED ZOOM SWEEP covering the full content:
   - Read the current pan/zoom from the ".react-flow__viewport" element's CSS transform (translate(tx, ty) scale(z)). At fit, compute the world-rect the canvas shows.
   - Pick a target tile zoom of roughly 0.85-1.0 (chip text must be crisply legible; per-member chips appear only at zoom >= 0.35, so tiles MUST be above that).
   - Compute a grid of tile centers IN SCREEN COORDINATES AT FIT VIEW such that, after zooming in around each center up to the target zoom, the union of tile world-rects covers the entire fit-view content rect with >= 15% overlap between neighbours. (Wheel-zoom in React Flow keeps the world point under the mouse fixed, so a tile's world center stays at the chosen screen point.)
   - For each tile: click the fit-view control button (".react-flow__controls-fitview") and wait ~400ms; move the mouse to the tile center; issue mouse.wheel(0, -N) steps in a loop, re-reading the viewport transform each step, until zoom >= target (cap the loop; note d3-zoom applies smoothing so wait ~50ms between steps and ~300ms after the last); THEN MOVE THE MOUSE TO (3, 3) (off the pane, over the frame) and wait 400ms so no hover-dim state is captured; screenshot ".react-flow" as 10-tile-r<row>c<col>.png.
   - NEVER pan by dragging the pane: a drag that starts on a node card MOVES the node and corrupts the layout under exam.
   - Record each tile's achieved zoom in the manifest entries.
5. HOVER BONUS (2 shots): at fit view, hover an edge and screenshot as 20-hover-edge.png; hover a recipe node card and screenshot as 21-hover-node.png. Note in the manifest what was hovered. (These show the hover-dim/ego-network behaviour.) If flaky, skip and say so in notes.
   - NEVER hover an edge by element (Playwright element hover targets the bbox center, which for L/Z-shaped orthogonal edges usually lies OFF the razor-thin stroke and produces a false "hover does nothing" result - this caused a spurious defect filing). Instead compute an on-stroke screen coordinate: take the edge's interaction path, getPointAtLength(totalLength/2) (or another point verifiably on the stroke), map it through getScreenCTM, mouse.move there, and CONFIRM hover-active/dim state is present in the DOM before screenshotting; if not, try another point or edge and note it.
6. Print the manifest JSON to stdout at the end.

Validate before returning: list the PNG files you produced (ls) and sanity-check at least one tile with the Read tool (it renders the image) -- confirm chip text is legible and the shot is not a dimmed hover state. If coverage failed (blank tiles, zoom never reached target), fix the script and re-run; you have the time budget for 2-3 iterations.

Return (this is consumed by an orchestrator, not a human): the structured manifest -- planId "${p.id}", dir "${EXAM_DIR}/${p.id}", every image with a one-line description of what it shows, and notes (console errors, coverage caveats, what you hovered).`

const evalPrompt = (p, cap) => {
  const list = cap.images.map((im) => `- ${cap.dir}/${im.file} :: ${im.what}`).join('\n')
  return `You are a rendering-quality examiner for the STC blueprint canvas (Arknights: Endfield factory planner; React Flow). You are given screenshots of ONE fully solved production plan, "${p.id}". Judge what a reader sees. Read EVERY image below with the Read tool (they render visually). Capture notes from the screenshot agent: ${JSON.stringify(cap.notes)}

Images:
${list}

Domain, so you can judge correctness:
- Recipe cards: header with recipe name + machine multiplier (xN), then input rows (left ports) and output rows (right ports); port handles carry small glyphs. Product chips (cyan) are boundary inputs/outputs. Group slabs/loop boxes contain member cards.
- Edges: orthogonal chamfered polylines, colored by item; they leave a source's RIGHT side and enter a target's LEFT side (arrowheads must point right, into the target). Each item edge carries one rate chip (icon + N/min) that should sit ON its own line.
- Bus lanes: long edges route through shared horizontal lanes in faint tinted bands (labeled BUS) above/below the node block. A trunk shows ONE aggregate chip (Σ-prefixed total when several members) at its drop, plus one per-member rise chip spread along the lane.
- Fan-out trunks: same-source edges one layer over share a junction column marked with a dot; the owner shows a Σ aggregate chip on the shared trunk segment.
- Intentional behaviours -- do NOT report these as defects: per-member/rate chips are hidden below zoom 0.35 (fit shots show mostly aggregate chips; card details fade at low zoom by design); a fan-out branch chip may be deliberately hidden when its short leg cannot host it (the rate remains on the target card's input row); hover screenshots intentionally dim everything outside the hovered ego-network.

Evaluate, in order of importance:
1. CORRECTNESS of the presented information: chips attached to the wrong line or floating in empty space; a chip overlapping/hiding another chip or card text; edges slicing through node cards; arrowheads pointing the wrong way; junction dots off their trunk; Σ aggregate totals that contradict the visible member rates or target rows (cross-check numbers where legible); the same item rendered in confusingly different colors, or two different items in near-identical colors on crossing lines.
2. COMPREHENSION: can a reader trace where a flow comes from and goes? Ambiguous overlapping parallel lines; labels that could bind to either of two nearby lines; illegible text at the zoom it is meant to be read; crowded braids where the eye loses the line.
3. UI/UX clarity: visual hierarchy, clutter, band shading, wasted space, LOD behaviour, anything that would make a factory-game player squint. You are free to critique beyond these aspects.

Discipline: every finding must be grounded in specific pixels you saw -- name the image and where. Severity: major = misleads the reader or hides information; minor = friction; nit = polish. Do not pad; if a plan renders cleanly say so. Deduplicate within your own findings (one finding per defect FAMILY with all its occurrences as evidence entries).

Return the structured result for plan "${p.id}".`
}

// Chunk pairs: each capture agent runs one headless chromium (~400MB); this box
// OOMs if all plans capture at once.
const results = []
for (let i = 0; i < plans.length; i += 2) {
  const chunk = plans.slice(i, i + 2)
  const out = await pipeline(
    chunk,
    (p) => agent(capturePrompt(p), { label: `capture:${p.id}`, phase: 'Capture', model: 'opus', schema: CAPTURE_SCHEMA }),
    (cap, p) =>
      cap === null
        ? null
        : agent(evalPrompt(p, cap), { label: `evaluate:${p.id}`, phase: 'Evaluate', schema: FINDINGS_SCHEMA }).then((f) => ({ capture: cap, evaluation: f })),
  )
  results.push(...out.filter(Boolean))
  log(`${results.length}/${plans.length} plans captured+evaluated`)
}
return results
