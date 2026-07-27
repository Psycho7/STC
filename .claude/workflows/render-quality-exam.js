export const meta = {
  name: 'render-quality-exam',
  description: 'Evaluate the rendering quality of already-captured solved plans (cold visual critique of a deterministic capture)',
  whenToUse: 'Invoked by the render-exam skill AFTER tools/exam/capture.ts has written images and scene.json for every plan under exam',
  phases: [
    { title: 'Evaluate', detail: 'One agent per plan: judge the captured images cold, bounded by the coverage ledger' },
    { title: 'Triage', detail: 'No agent: validate every finding, join it to the measurements by footprint, and route it' },
    { title: 'Refute', detail: 'One agent per routed finding (or per plan for the batch): DISPROVE it against the running app through tools/exam/probe.ts' },
  ],
}

// args: {
//   plans: [{ id, dir, url, images: [{file, what}], tiles: [{file, kind, viewportTransform, safeRegion}], coverage }],
//   measurements: { [planId]: Measurement[] },
//   examDir,
// }
//   plans[].dir     absolute IMAGES directory the capture wrote, which is
//                   `<examDir>/<planId>/<imagesDir>` and holds nothing but images
//   plans[].images  every image the capture produced, with a one-line description
//   plans[].tiles   scene.json `tiles`, reduced to what the footprint join needs:
//                   the bare `file` an evaluator can cite, the `kind` that says
//                   which camera shot it, and the `viewportTransform`/`safeRegion`
//                   that place a world-unit footprint inside that image. Passing
//                   plans without it does not fail: it makes every join miss, and
//                   "nothing was corroborated" is exactly what a working triage
//                   over a clean plan looks like. Hence the checks below.
//   plans[].coverage  scene.json `coverage`: what the capture proved it framed
//   plans[].url     the plan's share URL, `<baseUrl>/?exam=1#<hash>` as the capture
//                   recorded it. NOT given to an evaluator: it judges the pixels,
//                   and a live app would let it answer questions the images cannot.
//                   Refuters get it, because the probe command is built from it.
//   measurements    geometry occurrences with world footprints, also deliberately
//                   withheld from evaluators (see COLD below) and consumed by the
//                   footprint join that triages findings. Required per plan, and an
//                   empty array is a real answer - the measurement pass runs on
//                   every capture, so `[]` means measured and clean.
//
// COLD. An evaluator receives images and the coverage ledger, and nothing else: no
// measurements, no earlier findings, no open-issue list. That independence is what
// makes a later corroboration worth having - an evaluator shown the geometry first
// would only be agreeing with it. Do not "help" the prompt by passing measurements
// in. The other way in is the filesystem, not the args, and that one is closed by
// the layout: the capture writes scene.json one level ABOVE plans[].dir, so listing
// the directory the images are handed out of reaches no measurement at all. The
// prompt still forbids reading anything but the listed images, as a second line of
// defence and not as the only one; passing a plans[].dir that contains the ledger
// would put the whole weight back on that sentence.
//
// Capture is NOT part of this workflow. It is deterministic code run before the
// workflow starts; an agent shooting its own screenshots into the same directory
// would overwrite the captures with wheel-zoom and hover artifacts, which is how an
// earlier exam filed a defect that only existed in its own screenshot.
const input = typeof args === 'string' ? JSON.parse(args) : args
const plans = input && input.plans

if (!Array.isArray(plans) || plans.length === 0) {
  throw new Error(
    'render-quality-exam requires args {plans: [{id, dir, url, images, tiles, coverage}], measurements, examDir}',
  )
}
const examDir = input && typeof input.examDir === 'string' ? input.examDir.replace(/\/+$/, '') : ''
if (examDir === '' || !examDir.startsWith('/')) {
  throw new Error(
    `render-quality-exam: examDir must be the absolute directory the capture wrote into, got ${JSON.stringify(input && input.examDir)}`,
  )
}
const measurementsByPlan = new Map()
const finite = (n) => typeof n === 'number' && Number.isFinite(n)
// What tools/exam/capture.ts records as the plan's url: base, then `/?exam=1`,
// then the plan fragment. Split rather than carried as two more args, so the
// probe command a refuter runs is built from the same string the capture booted.
const URL_RE = /^(https?:\/\/[^?#]+?)\/\?exam=1#(.+)$/
const TILE_KINDS = ['fit', 'tile', 'corrective']
for (const p of plans) {
  if (!p || typeof p.id !== 'string' || typeof p.dir !== 'string') {
    throw new Error(`render-quality-exam: every plan needs a string id and dir, got ${JSON.stringify(p)}`)
  }
  // `dir` is handed to a cold evaluator, so it decides what that evaluator can
  // reach by listing it. The capture writes the images one level BELOW the plan
  // directory precisely so the `scene.json` ledger is not in it, and nothing
  // else in this workflow can tell that layout from the flat one: a `dir`
  // pointing at the plan directory would put the whole no-peeking rule back on
  // one sentence of prompt. So it must be a directory strictly under the plan
  // directory, checked by property rather than by the name "images", which is
  // scene.json's `imagesDir` and not this file's to assume.
  const planRoot = `${examDir}/${p.id}`
  const dir = p.dir.replace(/\/+$/, '')
  const rest = dir.startsWith(`${planRoot}/`) ? dir.slice(planRoot.length + 1) : ''
  if (rest === '' || rest.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(
      `render-quality-exam: plan ${p.id} dir must be the images subdirectory ${planRoot}/<imagesDir> ` +
        `(scene.json's imagesDir), not ${JSON.stringify(p.dir)}; the plan directory itself holds scene.json, ` +
        'which an evaluator must not be able to list',
    )
  }
  if (typeof p.url !== 'string' || !URL_RE.test(p.url)) {
    throw new Error(
      `render-quality-exam: plan ${p.id} needs scene.json's url verbatim (<baseUrl>/?exam=1#<hash>), got ${JSON.stringify(p.url)}`,
    )
  }
  if (!Array.isArray(p.images) || p.images.length === 0) {
    throw new Error(`render-quality-exam: plan ${p.id} has no images; run tools/exam/capture.ts first`)
  }
  // Every entry is spliced into the prompt verbatim. A missing `file` renders a
  // path that resolves to nothing, and `what` is orchestrator-authored free text
  // reaching a cold evaluator, so it is a second channel for measurement language
  // and has to be a deliberate string rather than whatever fell out of a jq.
  p.images.forEach((im, i) => {
    const named = (v) => typeof v === 'string' && v.trim() !== ''
    if (!im || !named(im.file) || !named(im.what)) {
      throw new Error(
        `render-quality-exam: plan ${p.id} images[${i}] needs a non-empty string file and what, got ${JSON.stringify(im)}`,
      )
    }
  })
  if (!p.coverage) {
    throw new Error(`render-quality-exam: plan ${p.id} has no coverage ledger; pass scene.json's coverage through`)
  }

  // The join data. Every check here exists because its absence is SILENT: a
  // missing tile, an unparseable transform or a rect in the wrong frame all
  // produce zero corroborations, which is indistinguishable from a plan whose
  // findings genuinely have no geometric support.
  if (!Array.isArray(p.tiles) || p.tiles.length === 0) {
    throw new Error(
      `render-quality-exam: plan ${p.id} has no tiles; pass scene.json's tiles as {file, kind, viewportTransform, safeRegion}. ` +
        'Without them every footprint join misses and every finding reads as uncorroborated',
    )
  }
  p.tiles.forEach((t, i) => {
    // A bare file name, because that is what an evaluator can cite: it is given
    // the images directory, so a path would never match what it wrote down.
    if (!t || typeof t.file !== 'string' || t.file.trim() === '' || t.file.includes('/')) {
      throw new Error(
        `render-quality-exam: plan ${p.id} tiles[${i}] needs the bare image file name, got ${JSON.stringify(t && t.file)}`,
      )
    }
    if (!TILE_KINDS.includes(t.kind)) {
      throw new Error(
        `render-quality-exam: plan ${p.id} tiles[${i}] (${t.file}) kind must be one of ${TILE_KINDS.join(', ')}, got ${JSON.stringify(t.kind)}`,
      )
    }
    const v = t.viewportTransform
    if (!v || !finite(v.x) || !finite(v.y) || !finite(v.zoom) || v.zoom <= 0) {
      throw new Error(
        `render-quality-exam: plan ${p.id} tiles[${i}] (${t.file}) needs viewportTransform {x, y, zoom} with a positive zoom, got ${JSON.stringify(v)}`,
      )
    }
    const s = t.safeRegion
    if (!s || !finite(s.x) || !finite(s.y) || !finite(s.width) || !finite(s.height) || s.width < 0 || s.height < 0) {
      throw new Error(
        `render-quality-exam: plan ${p.id} tiles[${i}] (${t.file}) needs safeRegion {x, y, width, height}, got ${JSON.stringify(s)}`,
      )
    }
  })
  // Every image an evaluator may cite has to be placeable, and tiles from the
  // WRONG plan are the way this goes wrong without a symptom: the transforms
  // parse, the join runs, and it matches nothing.
  const tileFiles = new Set(p.tiles.map((t) => t.file))
  const orphans = p.images.map((im) => im.file).filter((f) => !tileFiles.has(f))
  if (orphans.length > 0) {
    throw new Error(
      `render-quality-exam: plan ${p.id} lists images with no tile record: ${orphans.join(', ')}; ` +
        'images and tiles must both come from this plan\'s scene.json',
    )
  }
  if (!p.tiles.some(joinableTile)) {
    // Not fatal: it costs corroboration, never grants it, so every geometric
    // finding just goes to a refuter. Loud because a capture that shot only the
    // fit overview is a broken capture, not a clean plan.
    log(`WARNING: plan ${p.id} has no tile or corrective image; nothing can corroborate a geometric finding here`)
  }

  const ms = input.measurements && input.measurements[p.id]
  if (!Array.isArray(ms)) {
    throw new Error(
      `render-quality-exam: measurements["${p.id}"] must be scene.json's measurements array (\`[]\` when the plan measured clean), got ${JSON.stringify(ms)}`,
    )
  }
  measurementsByPlan.set(p.id, ms)
}

// Exactly the Finding type the triage join reads, so a finding this schema admits
// is one that join can validate rather than reject on shape. Two fields are
// optional here and load-bearing downstream: `falsifier` is what a refuter runs,
// and `mechanismHypothesis` is a claim about the code that no image can support,
// so stating one sends the finding to an individual refuter.
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    planId: { type: 'string' },
    overall: { type: 'string', description: '2-4 sentence overall quality verdict for this plan' },
    blindSpotsAcknowledged: {
      type: 'array',
      items: { type: 'string' },
      description:
        'the `id` field of each coverage.uncovered entry you could not judge, as a bare string; empty array when the capture covered everything',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'short kebab-case slug, unique within this plan' },
          planId: { type: 'string' },
          title: { type: 'string', description: 'short defect statement' },
          observation: {
            type: 'string',
            minLength: 1,
            description: 'what a reader sees and why it hurts them, stated as a symptom and grounded in the pixels',
          },
          claimType: { type: 'string', enum: ['geometric', 'interaction', 'absence', 'subjective'] },
          evidence: {
            type: 'array',
            // At least one entry, because the triage join rejects an empty
            // `evidence` outright: a finding emitted without one is dropped there
            // with no trace, so a whole-plan complaint has to be pinned to a place.
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                image: { type: 'string', description: 'file name of the image, exactly as listed' },
                rect: {
                  type: 'array',
                  items: { type: 'number' },
                  minItems: 4,
                  maxItems: 4,
                  description:
                    '[x, y, width, height] in the CSS pixels of THAT image, marking the defect itself and nothing more. x and y may be 0, but width and height must be positive: a negative or non-finite extent is not a place, and the check rejects the evidence entry',
                },
                where: { type: 'string', description: 'where in the image, in words: nearby labels, which card, which line' },
              },
              required: ['image', 'rect', 'where'],
            },
          },
          severity: { type: 'string', enum: ['major', 'minor', 'nit'] },
          aspect: { type: 'string', enum: ['correctness', 'comprehension', 'ux'] },
          falsifier: {
            type: 'object',
            description: 'the probe run that would DISPROVE this finding; required except for subjective claims',
            properties: {
              op: {
                type: 'string',
                enum: ['hover-edge', 'hover-node', 'contrast', 'delta-e', 'chip-binding', 'rect', 'computed-style', 'text-overflow'],
              },
              args: {
                type: 'object',
                additionalProperties: { type: 'string' },
                description: 'probe arguments as k=v strings; describe the target in words where you cannot know its id',
              },
              expectedIfFalse: { type: 'string', description: 'the probe output that would mean this finding is wrong' },
            },
            required: ['op', 'args', 'expectedIfFalse'],
          },
          mechanismHypothesis: {
            type: 'string',
            description: 'OPTIONAL cause in the code. Omit unless you have a specific reason; a symptom alone is a complete finding',
          },
        },
        required: ['id', 'planId', 'title', 'observation', 'claimType', 'evidence', 'severity', 'aspect'],
      },
    },
  },
  required: ['planId', 'overall', 'blindSpotsAcknowledged', 'findings'],
}

const evalPrompt = (p) => {
  const list = p.images.map((im) => `- ${p.dir}/${im.file} :: ${im.what}`).join('\n')
  return `You are a rendering-quality examiner for the STC blueprint canvas (Arknights: Endfield factory planner; React Flow). You are given screenshots of ONE fully solved production plan, "${p.id}". Judge what a reader sees.

Read EVERY image below with the Read tool (they render visually). Do NOT open the app, do not start a browser, do not take screenshots of your own, do not write any file: these images are the exam, and a shot of your own would be of a different camera than the one everything downstream is measured against.

READ NOTHING ELSE. Read exactly the image files listed below and no other file: do not list any directory, and do not go looking for the capture's \`scene.json\` ledger. It holds the geometry measurements your findings are about to be checked against, and a finding written from them is agreement with the check rather than independent evidence for it, which destroys the only thing your verdict is worth.

Images (all screenshots of the canvas pane, at 1 image pixel per CSS pixel):
${list}

Prefer a zoom tile as evidence. The fit overview is a different, much lower camera; cite it only for a whole-graph claim that no tile can show.

Domain, so you can judge correctness:
- Recipe cards: header with recipe name + machine multiplier (xN), then input rows (left ports) and output rows (right ports); port handles carry small glyphs. Product chips (cyan) are boundary inputs/outputs. Group slabs/loop boxes contain member cards.
- Edges: orthogonal chamfered polylines, colored by item; they leave a source's RIGHT side and enter a target's LEFT side (arrowheads must point right, into the target). Each item edge carries one rate chip (icon + N/min) that should sit ON its own line.
- Bus lanes: long edges route through shared horizontal lanes in faint tinted bands (labeled BUS) above/below the node block. A trunk shows ONE aggregate chip (Sigma-prefixed total when several members) at its drop, plus one per-member rise chip spread along the lane.
- Fan-out trunks: same-source edges one layer over share a junction column marked with a dot; the owner shows a Sigma aggregate chip on the shared trunk segment.
- Intentional behaviours -- do NOT report these as defects: per-member/rate chips are hidden below zoom 0.35 (fit shots show mostly aggregate chips; card details fade at low zoom by design); a fan-out branch chip may be deliberately hidden when its short leg cannot host it (the rate remains on the target card's input row); a hover screenshot, if any, intentionally dims everything outside the hovered ego-network.

COVERAGE LEDGER for this plan, written by the capture itself:
${JSON.stringify(p.coverage, null, 2)}

What it binds you to. \`uncovered\` lists elements the capture never framed at readable zoom. An element that was never covered is a blind spot of the capture, not a fact about the app, so you may NOT claim anything is missing, absent, unlabelled or unrendered where the thing in question is an uncovered id, and you may not read a low \`coveredCount\` as the app rendering too little. Each \`uncovered\` entry is an object; list in \`blindSpotsAcknowledged\` the \`id\` field of each \`uncovered\` entry you would otherwise have had something to say about, as a bare string and not the whole object (empty array when \`uncovered\` is empty). \`capHit: true\` means the capture ran out of tiles, so anything you did not see may simply not have been shot.

Evaluate, in order of importance:
1. CORRECTNESS of the presented information: chips attached to the wrong line or floating in empty space; a chip overlapping/hiding another chip or card text; edges slicing through node cards; arrowheads pointing the wrong way; junction dots off their trunk; Sigma aggregate totals that contradict the visible member rates or target rows (cross-check numbers where legible); the same item rendered in confusingly different colors, or two different items in near-identical colors on crossing lines.
2. COMPREHENSION: can a reader trace where a flow comes from and goes? Ambiguous overlapping parallel lines; labels that could bind to either of two nearby lines; illegible text at the zoom it is meant to be read; crowded braids where the eye loses the line.
3. UI/UX clarity: visual hierarchy, clutter, band shading, wasted space, LOD behaviour, anything that would make a factory-game player squint. You are free to critique beyond these aspects.

EVERY finding needs a pixel rect per evidence entry: \`rect: [x, y, width, height]\` in the CSS pixels of the image you named in the same entry, origin at that image's top-left. Mark WHERE THE DEFECT IS, tightly. A box drawn round a whole node card is not evidence about one chip inside it, and a downstream check compares your rect against independently measured geometry at the place you marked: an over-broad rect is rejected there, so a sloppy box silently costs the finding its support. Mark the chip, the overlap, the segment - not the neighbourhood it lives in.

CLAIM TYPE, one per finding, because it decides how the finding gets checked:
- \`geometric\`: a claim about where things are in the rendered picture - a chip off its own line, two boxes overlapping, an edge crossing a card, a dot off its trunk, text clipped by a box. Anything settled by coordinates.
- \`interaction\`: a claim about how the canvas responds to input - hover dimming, tooltips, click targets. Note that these are STILL images of an untouched canvas: you have no interaction evidence, so an interaction claim is a hypothesis about behaviour and its falsifier is the only thing that can settle it.
- \`absence\`: a claim that something which should be rendered is not there - a missing rate, a missing arrowhead, an unlabelled trunk. Bounded by the coverage ledger above.
- \`subjective\`: a matter of perception or taste that no measurement settles - two colors being hard to tell apart, a layout feeling cluttered, a hierarchy reading weakly. These go to a human for a ruling.

FALSIFIER, the run that would prove you WRONG: \`{op, args, expectedIfFalse}\`. Required for \`geometric\`, \`interaction\` and \`absence\`, and required for ANY finding that states a mechanism. FORBIDDEN on \`subjective\`: there is no probe output that settles taste, and offering one sends a refuter to answer a question you did not ask. (So never combine \`subjective\` with a mechanism: that pair demands a falsifier and forbids one, and cannot be satisfied.) Ops a refuter can run, pick the one that would settle your claim:
- \`hover-edge\` (id=<edge>), \`hover-node\` (id=<node>): does hovering it engage and dim the rest?
- \`contrast\` (selector=<css>): contrast ratio of an element against what is behind it.
- \`delta-e\` (a=<css>, b=<css>): perceptual color distance between two elements.
- \`chip-binding\` (id=<chip testid or an edge id naming exactly one chip>): which line a rate chip actually belongs to.
- \`rect\` (id=<scene element id>): the measured box of one element.
- \`computed-style\` (selector=<css>, props=<comma list>), \`text-overflow\` (selector=<css>).
Argument values are plain strings. Where you cannot know a machine id from a picture, describe the target precisely enough for someone at the running app to resolve it ("the sewage line entering the water-treatment card from the left, upper tile"). \`expectedIfFalse\` states the output that would mean you were wrong, so a refuter can settle it without re-deciding what you meant.

MECHANISM IS OPTIONAL. \`mechanismHypothesis\` is a claim about the CODE, and no picture supports one; the worst findings of an earlier exam were real symptoms wrapped around invented causes, and they cost more to disprove than they were worth. A symptom with no cause is a COMPLETE and valuable finding. State a mechanism only when you have a specific reason to believe it, and expect it to be judged separately from the symptom - "symptom real, cause wrong" is a normal outcome.

Discipline: every finding is grounded in specific pixels you saw. Severity: major = misleads the reader or hides information; minor = friction; nit = polish. Do not pad; if a plan renders cleanly say so in \`overall\` and return no findings. Deduplicate within your own findings: one finding per defect FAMILY, with each occurrence as its own evidence entry.

Return the structured result for plan "${p.id}", with \`planId\` set to "${p.id}" on the result and on every finding.`
}

// ONE id per finding, stamped once, before either output exists.
//
// The id is namespaced by plan because an evaluator only promises uniqueness
// within its own plan, and a verdict is later keyed by finding id across all of
// them. Uniqueness inside the plan is enforced here rather than trusted: the
// schema can only ASK for a unique slug, and two findings that ignore it would
// otherwise share one namespaced id, so one verdict would answer both.
//
// TRAP, if you extend this workflow: `evaluations[i].findings[j]` and the flat
// `findings` list are the same objects carrying the same id, and they have to
// stay that way. Re-stamping ids on one of them forks the id space, and a verdict
// keyed off one list then joins to nothing in the other - silently, since both
// halves still look well formed.
const stampIds = (planId, result) => {
  const used = new Set()
  const findings = (result.findings || []).map((f, i) => {
    const slug = typeof f.id === 'string' && f.id.trim() !== '' ? f.id.trim() : String(i)
    const base = `${planId}:${slug}`
    const id = used.has(base) ? `${base}#${i}` : base
    used.add(id)
    return { ...f, planId, id }
  })
  return { ...result, planId, findings }
}

const evaluations = (
  await parallel(
    plans.map((p) => () =>
      agent(evalPrompt(p), { label: `evaluate:${p.id}`, phase: 'Evaluate', schema: FINDINGS_SCHEMA }).then((r) =>
        r === null ? null : stampIds(p.id, r),
      ),
    ),
  )
).filter(Boolean)

const skipped = plans.filter((p) => !evaluations.some((e) => e.planId === p.id))
if (skipped.length > 0) log(`Not evaluated (agent returned nothing): ${skipped.map((p) => p.id).join(', ')}`)

// Flattened for the steps that work finding by finding, same objects as above.
const findings = evaluations.flatMap((e) => e.findings)

log(`${evaluations.length}/${plans.length} plans evaluated, ${findings.length} findings`)

// ---------------------------------------------------------------------------
// TRIAGE - a copy of tools/exam/triage.ts, which is the tested original.
//
// A workflow script cannot import, so the rules live twice. This copy must stay
// behaviourally IDENTICAL to that module: its unit tests are the only thing
// standing between a finding and being filed unchecked, and a divergence here
// files findings those tests say must be refuted first. Change one, change both,
// and run the parity test that holds them together:
//
//     bun run test -- tools/exam/workflow-parity.test.ts
//
// It evaluates THIS file with stub globals, runs a table of findings through it,
// and diffs the route and the violations each one came out with against what the
// module answers for the same finding - boundaries included, on both sides of
// every constant below. An edit made in one copy only fails it.
//
// Everything below is verbatim in substance; the reasoning behind each rule is
// in the module and is not repeated here. What matters at this end:
//   - a footprint is in WORLD units and an evidence rect is in the CSS pixels of
//     the image it names, so the join projects one into the other. Comparing
//     them raw matches nothing, and matching nothing reads as "not corroborated"
//   - every rule fails closed. The expensive error is a FALSE corroboration,
//     because that is the one that skips refutation
// ---------------------------------------------------------------------------

const EPS = 1e-9
const JOIN_SLACK_PX = 2
const MAX_MARK_EXTENT_RATIO = 3
const MIN_MARK_EXTENT_PX = 48

const MEASUREMENT_KINDS = [
  'chip-off-own-path',
  'chip-vs-card',
  'segment-vs-card',
  'own-card-pierce',
  'chip-vs-segment',
]
// Only a geometric claim is the sort of thing these audits measure. Interaction,
// absence and subjective claims get the empty row and go to a refuter or a human.
const COMPATIBLE_KINDS = {
  geometric: MEASUREMENT_KINDS,
  interaction: [],
  absence: [],
  subjective: [],
}
const CLAIM_TYPES = ['geometric', 'interaction', 'absence', 'subjective']
const SEVERITIES = ['major', 'minor', 'nit']
const ASPECTS = ['correctness', 'comprehension', 'ux']

// Measurements are taken ONCE, at the camera the last tile shot left behind, so
// a footprint is only a place in an image shot at that camera. An allowlist, so
// an unrecognised kind is refused rather than admitted.
function joinableTile(tile) {
  return tile.kind === 'tile' || tile.kind === 'corrective'
}

function isFiniteRect(rect) {
  return (
    Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)
  )
}

function rectFromTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length !== 4) return null
  const [x, y, width, height] = tuple
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') {
    return null
  }
  const rect = { x, y, width, height }
  return isFiniteRect(rect) && width >= 0 && height >= 0 ? rect : null
}

// world -> the image's own CSS-pixel frame.
function project(rect, t) {
  const out = {
    x: rect.x * t.zoom + t.x,
    y: rect.y * t.zoom + t.y,
    width: rect.width * t.zoom,
    height: rect.height * t.zoom,
  }
  return isFiniteRect(out) && out.width >= 0 && out.height >= 0 ? out : null
}

function inflate(rect, by) {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by }
}

// Inclusive: an orthogonal footprint is flat in one axis, so demanding overlap
// AREA would refuse every segment-tier measurement.
function intersect(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right < x - EPS || bottom < y - EPS) return null
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

// Is the mark ABOUT the projected footprint, or merely a region containing it?
// Per axis, because an orthogonal footprint is flat in one of them.
function commensurate(projected, evidence) {
  const limit = (extent) => Math.max(extent, MIN_MARK_EXTENT_PX) * MAX_MARK_EXTENT_RATIO
  return evidence.width <= limit(projected.width) + EPS && evidence.height <= limit(projected.height) + EPS
}

function meets(footprint, tile, evidence) {
  const projected = project(footprint, tile.viewportTransform)
  if (projected === null) return false
  if (!commensurate(projected, evidence)) return false
  const marked = intersect(inflate(projected, JOIN_SLACK_PX), evidence)
  if (marked === null) return false
  return intersect(marked, tile.safeRegion) !== null
}

function evidenceEntries(finding) {
  const raw = finding.evidence
  if (!Array.isArray(raw)) return []
  return raw.filter((entry) => typeof entry === 'object' && entry !== null)
}

// The measurements that occur AT THE PLACE THIS FINDING MARKS: co-location,
// proportionality and kind compatibility, all three or nothing. A shared element
// id is deliberately not among them.
function corroborationsFor(finding, measurements, tiles) {
  const kinds = CLAIM_TYPES.includes(finding.claimType) ? COMPATIBLE_KINDS[finding.claimType] : []
  if (kinds.length === 0) return []

  const places = []
  for (const entry of evidenceEntries(finding)) {
    const tile = tiles.find((t) => joinableTile(t) && t.file === entry.image)
    const rect = rectFromTuple(entry.rect)
    if (tile === undefined || rect === null) continue
    places.push({ tile, rect })
  }
  if (places.length === 0) return []

  return measurements.filter(
    (m) => kinds.includes(m.kind) && places.some((place) => meets(m.footprint, place.tile, place.rect)),
  )
}

// Where a finding goes next. The ORDER is the substance: a stated mechanism is a
// claim about the code that no footprint can check, so it outranks corroboration
// entirely; absence and interaction claims are unwitnessable by construction.
function routeFinding(finding, corroborations) {
  if (finding.claimType === 'subjective') return 'HUMAN_RULING'
  if (
    finding.claimType === 'absence' ||
    finding.claimType === 'interaction' ||
    finding.mechanismHypothesis !== undefined
  ) {
    return 'REFUTE_INDIVIDUAL'
  }
  if (finding.claimType === 'geometric' && corroborations.length > 0) return 'CORROBORATED'
  return finding.severity === 'major' ? 'REFUTE_INDIVIDUAL' : 'REFUTE_BATCH'
}

// Schema violations, empty when the finding is well formed. Nothing here throws:
// a finding with a missing field is exactly the input this is for.
function validateFinding(finding) {
  const violations = []

  if (!CLAIM_TYPES.includes(finding.claimType)) violations.push(`claimType "${String(finding.claimType)}" is not a claim type`)
  if (!SEVERITIES.includes(finding.severity)) violations.push(`severity "${String(finding.severity)}" is not a severity`)
  if (!ASPECTS.includes(finding.aspect)) violations.push(`aspect "${String(finding.aspect)}" is not an aspect`)

  const observation = finding.observation
  if (typeof observation !== 'string') violations.push('observation is missing')
  else if (observation.trim() === '') violations.push('observation is empty')

  const evidence = finding.evidence
  if (!Array.isArray(evidence)) {
    violations.push('evidence is missing')
  } else if (evidence.length === 0) {
    violations.push('evidence is empty')
  } else {
    evidence.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null) {
        violations.push(`evidence[${i}] is not an object`)
        return
      }
      if (typeof raw.image !== 'string' || raw.image.trim() === '') violations.push(`evidence[${i}] names no image`)
      if (rectFromTuple(raw.rect) === null) violations.push(`evidence[${i}] rect is not a finite [x, y, width, height]`)
    })
  }

  const needsFalsifier =
    finding.claimType === 'geometric' ||
    finding.claimType === 'interaction' ||
    finding.claimType === 'absence' ||
    finding.mechanismHypothesis !== undefined
  if (needsFalsifier && finding.falsifier === undefined) {
    violations.push(
      finding.mechanismHypothesis !== undefined && finding.claimType === 'subjective'
        ? 'a mechanismHypothesis requires a falsifier'
        : `claimType "${finding.claimType}" requires a falsifier`,
    )
  }
  if (finding.claimType === 'subjective' && finding.falsifier !== undefined) {
    violations.push('claimType "subjective" must not carry a falsifier')
  }

  return violations
}

// ---------------------------------------------------------------------------
// Triage, run
//
// VALIDATION GATES ROUTING, and it has to: routeFinding answers for any object
// handed to it, so a geometric finding carrying no falsifier - one nobody can
// disprove - would otherwise reach CORROBORATED on a footprint and be filed. An
// invalid finding is REPORTED, not routed and not silently dropped: the
// evaluator saw something, and what is wrong with it is a defect of the report
// rather than of the app.
// ---------------------------------------------------------------------------

const planById = new Map(plans.map((p) => [p.id, p]))

const triaged = findings.map((f) => {
  const plan = planById.get(f.planId)
  const violations = plan === undefined ? [`planId "${String(f.planId)}" is not a plan under exam`] : validateFinding(f)
  if (violations.length > 0) return { finding: f, violations, route: null, corroborations: [] }
  const measurements = measurementsByPlan.get(f.planId)
  const corroborations = corroborationsFor(f, measurements, plan.tiles)
  return {
    finding: f,
    violations,
    corroborations,
    // Which measurements, by position in this plan's own measurement array, so a
    // reader of the verdict can go back to scene.json and look at the geometry
    // that carried the finding through without a refuter.
    corroboratedBy: corroborations.map((m) => `${f.planId}#${measurements.indexOf(m)}:${m.kind}`),
    route: routeFinding(f, corroborations),
  }
})

const invalid = triaged.filter((t) => t.route === null)
const routed = (route) => triaged.filter((t) => t.route === route)
const histogram = ['CORROBORATED', 'REFUTE_INDIVIDUAL', 'REFUTE_BATCH', 'HUMAN_RULING']
  .map((r) => `${r}=${routed(r).length}`)
  .join(' ')
log(`Triage: ${histogram} INVALID=${invalid.length}`)
for (const t of invalid) log(`  invalid ${t.finding.id}: ${t.violations.join('; ')}`)

// ---------------------------------------------------------------------------
// REFUTE
//
// A refuter's job is to DISPROVE, and the only thing that can do that is the
// running app. The previous exam filed nine issues; two rested on invalid
// premises and two named a wrong mechanism, and all four would have died to one
// runtime check. One of them claimed edge hover produced no response, off two
// screenshot runs - hovering an edge by ELEMENT aims at its bounding-box centre,
// which misses a thin orthogonal stroke most of the time. That is why a
// screenshot is not evidence for an absence claim, and why every verdict must
// carry the command it ran and what came back.
// ---------------------------------------------------------------------------

const VERDICT_ENUM = ['CONFIRMED', 'REFUTED', 'UNCERTAIN']

const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    findingId: { type: 'string' },
    observationVerdict: { type: 'string', enum: VERDICT_ENUM },
    mechanismVerdict: { type: 'string', enum: VERDICT_ENUM },
    probeCommand: { type: 'string', description: 'the probe command line you actually ran, verbatim' },
    probeOutput: { type: 'string', description: 'what it printed, verbatim; trim to the relevant fields but never paraphrase' },
    reasoning: { type: 'string', description: 'how that output settles (or fails to settle) the claim' },
    correctedObservation: {
      type: 'string',
      description: 'OPTIONAL: what is actually true, when the observation is real but stated wrongly',
    },
  },
  required: ['findingId', 'observationVerdict', 'probeCommand', 'probeOutput', 'reasoning'],
}

const REFUTE_BATCH_SCHEMA = {
  type: 'object',
  properties: { verdicts: { type: 'array', items: REFUTE_SCHEMA } },
  required: ['verdicts'],
}

// What the refuter is told about the app it is driving. Shared by both prompts so
// the individual and the batch refuter answer under the same rules.
const refuterBriefing = (plan) => {
  const [, baseUrl, hash] = URL_RE.exec(plan.url)
  return `You are a REFUTER on the STC render-quality exam (Arknights: Endfield factory planner; React Flow canvas). Findings below were written by an examiner who saw only screenshots. YOUR JOB IS TO DISPROVE THEM.

You are not a second opinion and not a reviewer. For each finding, look for the run that would show it is WRONG, and report what you actually got.

THE ONLY EVIDENCE THAT COUNTS is the output of the probe CLI against the running app:

    bun run tools/exam/probe.ts --base-url ${baseUrl} --hash '${hash}' --op <op> --arg k=v [--arg k=v]

Run it from the repo root with Bash. It boots the plan, runs at most one named op, and prints one JSON object to stdout. Ops and their arguments:
- \`hover-edge\` --arg id=<edgeId>, \`hover-node\` --arg id=<nodeId>: does hovering the thing engage, and what dims? It samples points ON the edge's own geometry, which is the whole reason it exists.
- \`contrast\` --arg selector=<css>: contrast ratio of an element against what is painted behind it.
- \`delta-e\` --arg a=<css> --arg b=<css>: perceptual colour distance between two elements.
- \`chip-binding\` --arg id=<chip data-testid, or an edge id that names exactly one chip>: how far a rate chip sits from its own polyline against the nearest other one.
- \`rect\` --arg id=<scene element id>: the measured box of one element.
- \`computed-style\` --arg selector=<css> --arg props=<comma list>, \`text-overflow\` --arg selector=<css>.
Optional: \`--zoom <z> --center <wx>,<wy>\` together to frame a camera first, \`--eval <file.js>\` to evaluate one expression in the page (write the file under /tmp, never into the exam directory), \`--shot <out.png>\` to save what the page looked like after the op.

Resolving a target the finding describes in words: \`--eval\` is the way in. A one-line expression over the DOM lists what you need, for example every edge id (\`Array.from(document.querySelectorAll('.react-flow__edge')).map(e => e.getAttribute('data-id'))\`) or every chip and its owner. Then probe the id you found. Do not guess an id: a probe against an element that does not exist reports an error, and AN ERROR SETTLES NOTHING IN EITHER DIRECTION. It is not a refutation, and it is not a confirmation either - least of all of a finding that claims something is missing. "The probe could not find it" does not separate "it is not in the app" from "that is not its id", which is the screenshot confusion one step further down the pipeline. Resolve the target again with \`--eval\` and re-run; only a run that came back clean answers anything.

Exit codes: 0 the run succeeded; 1 harness failure (bad flags, an id that resolved to nothing, a missing element); 2 the base URL is not serving; 3 the page never became examinable. ONLY exit 0 settles a claim. On 1, 2 or 3 nothing was measured, so the verdict is UNCERTAIN whichever way the finding reads - never REFUTED, and never CONFIRMED - and you paste what happened.

READ THIS BEFORE JUDGING A HOVER RESULT: \`hoverEngaged: false\` is usually a miss by the probe, not a dead app. Read \`engagedElsewhere\` and \`samples\`, then re-probe whatever id took the pointer, or reframe with \`--zoom\`/\`--center\`. Only \`decision.noResponse\` is a real "hover produced no response"; \`decision.differs\` is a set difference that the app produces by design (it lights whole bus-trunk groups) and is NOT a defect.

A SCREENSHOT IS NOT EVIDENCE, above all for a claim that something is missing. A picture cannot tell "the app does nothing" from "my capture never triggered it" - that exact confusion is what put an invalid hover finding into the last exam. \`--shot\` is for illustrating a probe result, never for replacing one.

TWO VERDICTS, JUDGED SEPARATELY:
- \`observationVerdict\`: is the SYMPTOM real, as a reader would meet it? CONFIRMED means your probe output shows it. REFUTED means your probe output shows it is not so.
- \`mechanismVerdict\`: is the stated CAUSE right? Only for a finding that carries a \`mechanismHypothesis\`; omit it otherwise. "Symptom real, cause wrong" is a common and expected outcome, and it is reported as CONFIRMED observation with a REFUTED mechanism, not as one muddled verdict.

UNCERTAIN IS A CORRECT ANSWER and is preferred over guessing. If the probe could not reach the target, could not resolve it, or came back inconclusive, say UNCERTAIN and paste what you got. A guess that happens to be wrong costs more than an honest UNCERTAIN, which just sends the finding to a human.

EVERY verdict needs \`probeCommand\` (the exact command line you ran) and \`probeOutput\` (what it printed, verbatim; trim to the relevant fields, never paraphrase and never invent). A verdict without both is discarded and forced to UNCERTAIN, so an unrun probe buys nothing.`
}

const findingBlock = (plan, f) => {
  const evidence = f.evidence
    .map((e) => `  - ${plan.dir}/${e.image} rect [${e.rect.join(', ')}] :: ${e.where}`)
    .join('\n')
  return `FINDING ${f.id} (plan ${f.planId}, ${f.severity}, ${f.aspect}, claimType ${f.claimType})
title: ${f.title}
observation: ${f.observation}
evidence (you may Read these images to locate the target; they are the examiner's, not evidence for your verdict):
${evidence}
falsifier the examiner nominated (the run that would prove the finding WRONG): ${
    f.falsifier === undefined ? '(none)' : JSON.stringify(f.falsifier)
  }
mechanismHypothesis: ${f.mechanismHypothesis === undefined ? '(none stated - judge the observation only, and omit mechanismVerdict)' : f.mechanismHypothesis}`
}

const refutePrompt = (plan, f) =>
  `${refuterBriefing(plan)}

${findingBlock(plan, f)}

Start from the nominated falsifier: it names the op whose output the examiner agreed would settle this. Run it (translating a described target into a real id first), and run another op if the first one cannot decide. Return the verdict for \`findingId\` "${f.id}".`

const refuteBatchPrompt = (plan, group) =>
  `${refuterBriefing(plan)}

${group.length} findings on plan "${plan.id}", all of them minor or nit and none carrying a mechanism. Judge each ONE AT A TIME and independently: a probe run for one says nothing about another.

${group.map((f) => findingBlock(plan, f)).join('\n\n')}

Return \`verdicts\` with exactly ${group.length} entries, one per finding, with \`findingId\` set to ${group.map((f) => `"${f.id}"`).join(', ')}. Each entry needs its OWN probeCommand and probeOutput; reusing one run for several findings means the others were never checked, and an unchecked verdict must be UNCERTAIN.`

// THE ONLY PLACE A VERDICT IS BUILT. Every path lands here: a refuter's answer,
// a refuter that answered nothing usable, and a corroborated finding that never
// reached an agent. Two things follow, and both are the point:
//   - `disposition` has ONE derivation. It is a function of the two verdicts and
//     nothing else, so no caller can hardcode a disposition that the rules below
//     would not have produced.
//   - every verdict carries the SAME keys, whatever produced it. A consumer
//     filtering on `probeCommand === null` would otherwise read a corroborated
//     FILE as unsupported; here it reads a non-empty `corroboratedBy` instead,
//     which is never absent, only empty.
//
// The full shape, all fields always present:
//   findingId, planId      which finding this answers, id namespaced by plan
//   observationVerdict     CONFIRMED | REFUTED | UNCERTAIN, on the symptom
//   mechanismVerdict       the same on the stated cause; null when none was stated
//   mechanismStripped      the cause struck out; null unless FILE_SYMPTOM_ONLY
//   disposition            FILE | FILE_SYMPTOM_ONLY | HUMAN_REVIEW | DROP
//   corroboratedBy         the measurement ids that carried it past refutation;
//                          [] for anything a refuter answered
//   probeCommand           the command line the refuter ran; null when none was
//   probeOutput            what it printed; null when nothing was run
//   reasoning              how that settles the claim; null when none was given
//   correctedObservation   what is actually true; null when none was offered
//   coercions              why a claim was forced to UNCERTAIN; [] when none was
const buildVerdict = (finding, parts) => {
  const observationVerdict = parts.observationVerdict
  const mechanismVerdict = parts.mechanismVerdict ?? null

  // What the orchestrator does with it. A real symptom under a disproved cause is
  // the shape the last exam got wrong twice: it is still a finding, filed with
  // the mechanism struck out rather than dropped along with it.
  let disposition
  if (observationVerdict === 'REFUTED') disposition = 'DROP'
  else if (observationVerdict === 'UNCERTAIN' || mechanismVerdict === 'UNCERTAIN') disposition = 'HUMAN_REVIEW'
  else if (mechanismVerdict === 'REFUTED') disposition = 'FILE_SYMPTOM_ONLY'
  else disposition = 'FILE'

  return {
    findingId: finding.id,
    planId: finding.planId,
    observationVerdict,
    mechanismVerdict,
    mechanismStripped:
      disposition === 'FILE_SYMPTOM_ONLY' && finding.mechanismHypothesis !== undefined
        ? finding.mechanismHypothesis
        : null,
    disposition,
    corroboratedBy: parts.corroboratedBy ?? [],
    probeCommand: parts.probeCommand ?? null,
    probeOutput: parts.probeOutput ?? null,
    reasoning: parts.reasoning ?? null,
    correctedObservation: parts.correctedObservation ?? null,
    coercions: parts.coercions ?? [],
  }
}

// Every answer out of the Refute phase is read here. NEVER auto-confirm and
// NEVER auto-drop: an agent that returned nothing, one that answered about a
// different finding, an unknown verdict word, or a verdict with no command and
// no output behind it all become UNCERTAIN, which downgrades the finding and
// puts it in front of a human instead of quietly deciding it either way.
// `missReason` says HOW the answer went missing, and is recorded verbatim,
// because "nothing came back" and "the answers were about other ids" send an
// operator after two completely different bugs.
const coerceVerdict = (finding, raw, missReason) => {
  const r = raw !== null && typeof raw === 'object' ? raw : null
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== ''
  const cited = r !== null && nonEmpty(r.probeCommand) && nonEmpty(r.probeOutput)
  const coercions = []
  if (r === null) coercions.push(missReason)
  else if (!cited) coercions.push('no probeCommand and probeOutput, so nothing was run')

  const claim = (value, name) => {
    if (!cited) return 'UNCERTAIN'
    if (!VERDICT_ENUM.includes(value)) {
      coercions.push(`${name} ${JSON.stringify(value)} is not a verdict`)
      return 'UNCERTAIN'
    }
    return value
  }
  const observationVerdict = claim(r === null ? undefined : r.observationVerdict, 'observationVerdict')
  // A mechanism verdict only exists where a mechanism was claimed. Where one was,
  // silence about it is not agreement.
  const hasMechanism = finding.mechanismHypothesis !== undefined
  const mechanismVerdict = hasMechanism ? claim(r === null ? undefined : r.mechanismVerdict, 'mechanismVerdict') : null

  return buildVerdict(finding, {
    observationVerdict,
    mechanismVerdict,
    probeCommand: r !== null && nonEmpty(r.probeCommand) ? r.probeCommand : null,
    probeOutput: r !== null && nonEmpty(r.probeOutput) ? r.probeOutput : null,
    reasoning: r !== null && nonEmpty(r.reasoning) ? r.reasoning : null,
    correctedObservation: r !== null && nonEmpty(r.correctedObservation) ? r.correctedObservation : null,
    coercions,
  })
}

// A corroborated finding never reaches an agent: an independent measurement
// already exists at the place it marked, and that is what the join is for. The
// measurement ids travel with the verdict so the support is inspectable. It goes
// through the same builder as everything else, so its disposition is DERIVED
// from CONFIRMED-with-no-mechanism rather than asserted here - the route already
// guarantees the no-mechanism half, since a stated mechanism never reaches it.
const corroboratedVerdict = (t) =>
  buildVerdict(t.finding, {
    observationVerdict: 'CONFIRMED',
    mechanismVerdict: null,
    corroboratedBy: t.corroboratedBy,
    reasoning: `corroborated by ${t.corroborations.length} independent measurement(s) at the marked place: ${t.corroborations
      .map((m) => m.detail)
      .join(' | ')}`,
  })

// Which of a refuter's answers is about THIS finding, and what to say when none
// of them is. A verdict is keyed by finding id, so an answer carrying another id
// has not answered this finding whatever it says: stamping this finding's id
// onto it would file someone else's CONFIRMED against it. The two ways that
// happens have to read differently, because they are different bugs - an agent
// that produced nothing at all, against an id-space mismatch (a batch that
// stripped the "<planId>:" namespace answers every finding and matches none).
const answerFor = (finding, answers) => {
  const hit = answers.find((v) => v.findingId === finding.id)
  if (hit !== undefined) return { raw: hit, missReason: null }
  if (answers.length === 0) return { raw: null, missReason: 'the refuter returned nothing' }
  return {
    raw: null,
    missReason: `no answer carried this finding's id; the refuter answered about ${answers
      .map((v) => JSON.stringify(v.findingId))
      .join(', ')}`,
  }
}

// The objects in a refuter's reply, junk entries dropped: something that is not
// an object cannot be matched to a finding id, so it counts as no answer at all.
const answerObjects = (list) => (Array.isArray(list) ? list.filter((v) => v !== null && typeof v === 'object') : [])

const batches = new Map()
for (const t of routed('REFUTE_BATCH')) {
  if (!batches.has(t.finding.planId)) batches.set(t.finding.planId, [])
  batches.get(t.finding.planId).push(t.finding)
}

const refuteTasks = [
  // One finding was asked about, so one answer is expected - and it is still
  // matched on `findingId` rather than assumed. An agent handed one finding can
  // answer about another, and a verdict is keyed by id, so taking its word for
  // it would relabel that probe output as this finding's and file it.
  ...routed('REFUTE_INDIVIDUAL').map((t) => () => {
    const plan = planById.get(t.finding.planId)
    return agent(refutePrompt(plan, t.finding), {
      label: `refute:${t.finding.id}`,
      phase: 'Refute',
      schema: REFUTE_SCHEMA,
    }).then((r) => {
      const { raw, missReason } = answerFor(t.finding, answerObjects([r]))
      return [coerceVerdict(t.finding, raw, missReason)]
    })
  }),
  ...[...batches.entries()].map(([planId, group]) => () => {
    const plan = planById.get(planId)
    return agent(refuteBatchPrompt(plan, group), {
      label: `refute-batch:${planId}`,
      phase: 'Refute',
      schema: REFUTE_BATCH_SCHEMA,
    }).then((r) => {
      const answers = answerObjects(r === null ? null : r.verdicts)
      const verdicts = group.map((f) => {
        const { raw, missReason } = answerFor(f, answers)
        return coerceVerdict(f, raw, missReason)
      })
      // Answers about ids nobody asked about are logged rather than dropped:
      // they are the evidence that the batch ran and its ids were renamed, and
      // without them the run looks exactly like an agent that said nothing.
      const asked = new Set(group.map((f) => f.id))
      const extra = answers.filter((v) => !asked.has(v.findingId))
      if (extra.length > 0) {
        log(
          `refute-batch:${planId} answered about ${extra.length} id(s) not in this batch, ignored: ${extra
            .map((v) => JSON.stringify(v.findingId))
            .join(', ')}`,
        )
      }
      return verdicts
    })
  }),
]

const verdicts = [
  ...routed('CORROBORATED').map(corroboratedVerdict),
  ...(refuteTasks.length === 0 ? [] : (await parallel(refuteTasks)).flat()),
]

const dispositions = ['FILE', 'FILE_SYMPTOM_ONLY', 'HUMAN_REVIEW', 'DROP']
  .map((d) => `${d}=${verdicts.filter((v) => v.disposition === d).length}`)
  .join(' ')
log(`Refute: ${verdicts.length} verdicts, ${dispositions}; ${routed('HUMAN_RULING').length} awaiting a human ruling`)

return {
  evaluations,
  findings,
  triage: triaged.map((t) => ({ id: t.finding.id, planId: t.finding.planId, route: t.route, violations: t.violations })),
  verdicts,
  // No verdict is synthesised for either of these. A subjective claim has no
  // probe that settles it, and an invalid one is a defect of the report; both
  // are handed back for a person to rule on rather than resolved here.
  humanRuling: routed('HUMAN_RULING').map((t) => t.finding),
  invalid: invalid.map((t) => ({ id: t.finding.id, planId: t.finding.planId, violations: t.violations })),
}
