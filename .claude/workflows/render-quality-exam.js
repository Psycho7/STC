export const meta = {
  name: 'render-quality-exam',
  description: 'Evaluate the rendering quality of already-captured solved plans (cold visual critique of a deterministic capture)',
  whenToUse: 'Invoked by the render-exam skill AFTER tools/exam/capture.ts has written images and scene.json for every plan under exam',
  phases: [
    { title: 'Evaluate', detail: 'One agent per plan: judge the captured images cold, bounded by the coverage ledger' },
  ],
}

// args: {
//   plans: [{ id, dir, url, images: [{file, what}], coverage }],
//   measurements: { [planId]: Measurement[] },
//   examDir,
// }
//   plans[].dir     absolute directory the capture wrote images and scene.json into
//   plans[].images  every image the capture produced, with a one-line description
//   plans[].coverage  scene.json `coverage`: what the capture proved it framed
//   plans[].url     the plan's share URL. NOT given to an evaluator: it judges the
//                   pixels, and a live app would let it answer questions the images
//                   cannot. It is here for the refutation step, which drives the app.
//   measurements    geometry occurrences with world footprints, also deliberately
//                   withheld from evaluators (see COLD below) and consumed by the
//                   footprint join that triages findings.
//
// COLD. An evaluator receives images and the coverage ledger, and nothing else: no
// measurements, no earlier findings, no open-issue list. That independence is what
// makes a later corroboration worth having - an evaluator shown the geometry first
// would only be agreeing with it. Do not "help" the prompt by passing measurements
// in.
//
// Capture is NOT part of this workflow. It is deterministic code run before the
// workflow starts; an agent shooting its own screenshots into the same directory
// would overwrite the captures with wheel-zoom and hover artifacts, which is how an
// earlier exam filed a defect that only existed in its own screenshot.
const input = typeof args === 'string' ? JSON.parse(args) : args
const plans = input && input.plans

if (!Array.isArray(plans) || plans.length === 0) {
  throw new Error('render-quality-exam requires args {plans: [{id, dir, url, images, coverage}], measurements, examDir}')
}
for (const p of plans) {
  if (!p || typeof p.id !== 'string' || typeof p.dir !== 'string') {
    throw new Error(`render-quality-exam: every plan needs a string id and dir, got ${JSON.stringify(p)}`)
  }
  if (!Array.isArray(p.images) || p.images.length === 0) {
    throw new Error(`render-quality-exam: plan ${p.id} has no images; run tools/exam/capture.ts first`)
  }
  if (!p.coverage) {
    throw new Error(`render-quality-exam: plan ${p.id} has no coverage ledger; pass scene.json's coverage through`)
  }
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
      description: 'element ids from coverage.uncovered that you could not judge; empty array when the capture covered everything',
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
            description: 'what a reader sees and why it hurts them, stated as a symptom and grounded in the pixels',
          },
          claimType: { type: 'string', enum: ['geometric', 'interaction', 'absence', 'subjective'] },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                image: { type: 'string', description: 'file name of the image, exactly as listed' },
                rect: {
                  type: 'array',
                  items: { type: 'number' },
                  minItems: 4,
                  maxItems: 4,
                  description: '[x, y, width, height] in the CSS pixels of THAT image, marking the defect itself and nothing more',
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

What it binds you to. \`uncovered\` lists elements the capture never framed at readable zoom. An element that was never covered is a blind spot of the capture, not a fact about the app, so you may NOT claim anything is missing, absent, unlabelled or unrendered where the thing in question is an uncovered id, and you may not read a low \`coveredCount\` as the app rendering too little. List in \`blindSpotsAcknowledged\` every uncovered id you would otherwise have had something to say about (empty array when \`uncovered\` is empty). \`capHit: true\` means the capture ran out of tiles, so anything you did not see may simply not have been shot.

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

const evaluations = (
  await parallel(
    plans.map((p) => () =>
      agent(evalPrompt(p), { label: `evaluate:${p.id}`, phase: 'Evaluate', schema: FINDINGS_SCHEMA }).then((r) =>
        r === null ? null : { ...r, planId: p.id },
      ),
    ),
  )
).filter(Boolean)

const skipped = plans.filter((p) => !evaluations.some((e) => e.planId === p.id))
if (skipped.length > 0) log(`Not evaluated (agent returned nothing): ${skipped.map((p) => p.id).join(', ')}`)

// Flattened for the steps that work finding by finding. The id is namespaced by
// plan because an evaluator only promises uniqueness within its own plan, and a
// verdict is later keyed by finding id across all of them.
const findings = evaluations.flatMap((e) =>
  (e.findings || []).map((f, i) => ({ ...f, planId: e.planId, id: `${e.planId}:${f.id || i}` })),
)

log(`${evaluations.length}/${plans.length} plans evaluated, ${findings.length} findings`)

return { evaluations, findings }
