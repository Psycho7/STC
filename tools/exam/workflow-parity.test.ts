// Parity between triage.ts and the copy of it inlined in the workflow script.
//
// A workflow script is evaluated by the Workflow runtime with its globals
// already bound, and it cannot import. So the rules that decide whether a
// finding SKIPS REFUTATION exist twice: once in ./triage.ts, which
// ./triage.test.ts covers, and once inlined in
// .claude/workflows/render-quality-exam.js, which nothing covered. Two copies of
// a procedure whose expensive failure is silent - a false corroboration files an
// unverified claim - is one copy too many, and this test is what holds them
// together: it evaluates the workflow file itself over a table of findings and
// diffs what it produced against what the module answers for the same input.
//
// It runs the workflow END TO END rather than extracting its functions: they are
// declarations inside the evaluated body and nothing outside can reach them, and
// the routing is observable in the result anyway. Running it whole also pins the
// rule that only the workflow states - that validation GATES routing, so a
// malformed finding is reported rather than routed on a footprint it should
// never have been joined to.
//
// The table carries both sides of every constant the module's own tests pin
// (join slack, the two proportionality limits), plus the exclusions that decide
// a join without touching a number (fit camera, safe region, claim-type
// compatibility) and the JSON an agent can emit that a plain object would
// resolve through its prototype. A constant edited in one copy and not the other
// changes a route in here.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  CLAIM_TYPES,
  corroborationsFor,
  routeFinding,
  validateFinding,
  type Finding,
  type Route,
  type TileFrame,
} from "./triage";
import {
  CARD,
  CHIP,
  SEG,
  TILES,
  TILE_A,
  TILE_B,
  TILE_FIT,
  XING,
  finding,
  without,
  withoutFalsifier,
} from "./triage-fixtures";
import type { Measurement } from "./scene";

// From the repo root, which is Vitest's own root here; `import.meta.url` is not
// a file URL under the jsdom environment this suite runs in.
const WORKFLOW_PATH = resolve(process.cwd(), ".claude/workflows/render-quality-exam.js");

// ---------------------------------------------------------------------------
// The table. One plan per case, so a case's tiles and measurements are exactly
// what the workflow sees for it and nothing leaks between them.
// ---------------------------------------------------------------------------

type Case = {
  name: string;
  finding: Finding;
  measurements: Measurement[];
  tiles: TileFrame[];
};

function kase(
  name: string,
  f: Finding,
  over: { measurements?: Measurement[]; tiles?: TileFrame[] } = {},
): Case {
  return {
    name,
    finding: f,
    measurements: over.measurements ?? [CHIP],
    tiles: over.tiles ?? TILES,
  };
}

// A zero-extent footprint: a point in world units, which projects to a point and
// has no extent for the proportionality limit to scale, so only the floor
// applies. Nothing in the join may divide by it or refuse it for being flat.
const POINT: Measurement = {
  kind: "chip-vs-segment",
  elementIds: ["chip:9", "e:0:A->B:iron"],
  footprint: { x: 100, y: 100, width: 0, height: 0 },
  detail: "chip:9 anchor coincides with a segment of e:0:A->B:iron",
};

// A measurement as the orchestrator hands it over: `{kind, footprint, detail}`
// and nothing else. `elementIds` stays in scene.json and in the Measurement type
// - a refuter resolves ids from the ledger - but neither the join nor the
// verdict builder reads it, so the args drop it. A copy that started requiring
// it would reject the real args while every fixture carrying it stayed green.
const TRIMMED = {
  kind: CHIP.kind,
  footprint: CHIP.footprint,
  detail: CHIP.detail,
} as unknown as Measurement;

const CASES: Case[] = [
  kase("rect over the projected footprint", finding()),

  kase("measurement passed without elementIds, as the args trim it", finding(), {
    measurements: [TRIMMED],
  }),

  kase(
    "rect 500 px away on the same element",
    finding({
      evidence: [
        { image: TILE_A.file, rect: [790, 240, 60, 40], where: "on edge e:0:A->B:iron" },
      ],
    }),
  ),

  kase(
    "cites tile B at the place the footprint occupies in tile A",
    finding({
      evidence: [{ image: TILE_B.file, rect: [290, 240, 60, 40], where: "left of centre" }],
    }),
  ),

  kase(
    "cites tile B where the footprint is in tile B",
    finding({
      evidence: [{ image: TILE_B.file, rect: [1090, 240, 60, 40], where: "right of centre" }],
    }),
  ),

  kase(
    "cites an image no tile record names",
    finding({
      evidence: [{ image: "99-nope.png", rect: [290, 240, 60, 40], where: "middle" }],
    }),
  ),

  // TILE_FIT carries TILE_A's transform, so the projection lands exactly where
  // the passing case does and only `kind` can refuse it.
  kase(
    "cites the fit overview, whose transform would otherwise join",
    finding({
      evidence: [{ image: TILE_FIT.file, rect: [290, 240, 60, 40], where: "the dense band" }],
    }),
    { tiles: [...TILES, TILE_FIT] },
  ),

  kase("interaction claim over a perfect overlap", finding({ claimType: "interaction" })),
  kase("absence claim over a perfect overlap", finding({ claimType: "absence" })),
  kase(
    "subjective claim over a perfect overlap",
    withoutFalsifier(finding({ claimType: "subjective" })),
  ),

  // The geometric family is split by tier, so a co-located measurement of
  // another tier must refuse the join in both copies.
  kase("placement claim over a co-located segment measurement", finding({ claimType: "geometric-placement" }), {
    measurements: [SEG],
  }),
  // The placement row's second kind, which no other case reaches: without it
  // either copy could drop `chip-vs-card` from that row and stay green.
  kase("placement claim over its own tier's card-overlap measurement", finding({ claimType: "geometric-placement" }), {
    measurements: [CARD],
  }),
  kase("routing claim over a co-located chip measurement", finding({ claimType: "geometric-routing" })),
  kase("routing claim over its own tier's segment measurement", finding({ claimType: "geometric-routing" }), {
    measurements: [SEG],
  }),
  kase("collision claim over its own tier's crossing", finding({ claimType: "geometric-collision" }), {
    measurements: [XING],
  }),
  kase(
    "retired geometric claim type is rejected",
    finding({ claimType: "geometric" as Finding["claimType"] }),
  ),

  kase(
    "claimType outside the enumeration",
    finding({ claimType: "vibes" as Finding["claimType"] }),
  ),

  // "constructor" and "toString" are legal strings for an agent to emit and
  // resolve through the prototype chain of any plain object, so a table lookup
  // for them returns a function - one whose `length` is not zero and which has
  // no `includes`. Both copies must test membership against the key list.
  ...(["constructor", "toString", "hasOwnProperty"] as const).map((name) =>
    kase(
      `claimType "${name}", an inherited property name`,
      finding({ claimType: name as unknown as Finding["claimType"] }),
    ),
  ),

  // An element reaching the pane only under the minimap or the zoom controls is
  // in the image and outside the region the evaluator was given to read.
  kase(
    "footprint projects below the tile's safe region",
    finding({
      evidence: [{ image: TILE_A.file, rect: [290, 240, 60, 40], where: "bottom-left" }],
    }),
    { tiles: [{ ...TILE_A, safeRegion: { x: 0, y: 0, width: 1920, height: 200 } }] },
  ),

  // An orthogonal run has zero thickness in one axis; a strict area test would
  // refuse every segment-tier measurement.
  kase(
    "zero-thickness segment footprint under a rect round the stroke",
    finding({
      claimType: "geometric-routing",
      evidence: [{ image: TILE_A.file, rect: [310, 244, 20, 12], where: "over card B" }],
    }),
    {
      measurements: [
        {
          kind: "segment-vs-card",
          elementIds: ["e:0:A->B:iron", "B"],
          footprint: { x: 100, y: 100, width: 40, height: 0 },
          detail: "edge e:0:A->B:iron segment enters the padding of card B",
        },
      ],
    },
  ),

  kase(
    "zero-extent footprint under a small mark on it",
    finding({
      claimType: "geometric-collision",
      evidence: [{ image: TILE_A.file, rect: [298, 248, 10, 10], where: "the anchor" }],
    }),
    { measurements: [POINT] },
  ),

  kase(
    "zero-extent footprint with the mark elsewhere",
    finding({
      claimType: "geometric-collision",
      evidence: [{ image: TILE_A.file, rect: [400, 248, 10, 10], where: "further right" }],
    }),
    { measurements: [POINT] },
  ),

  // The tolerance boundary. CHIP projects to image x 300..340 through TILE_A, so
  // a rect starting at 341, 342 and 343 sits 1, 2 and 3 px clear of it: the
  // slack is 2 px and the intersection is inclusive, so 2 px clear still joins
  // and 3 px clear does not.
  ...[341, 342, 343].map((x) =>
    kase(
      `rect ${x - 340} px clear of the projected footprint`,
      finding({
        evidence: [{ image: TILE_A.file, rect: [x, 250, 60, 20], where: "right of it" }],
      }),
    ),
  ),

  // CHIP projects to 40x20, below the 48 px floor, so its limit is the floor
  // times the ratio: 144 is commensurate with it, 145 is a region containing it.
  ...[144, 145].map((width) =>
    kase(
      `${width} px wide mark on a 40x20 footprint`,
      finding({
        evidence: [{ image: TILE_A.file, rect: [290, 240, width, 40], where: "here" }],
      }),
    ),
  ),

  // A footprint of real size takes the ratio instead, which pins it at 3
  // independently of the floor: 200x200 projected admits 600 and refuses 601.
  ...[600, 601].map((width) =>
    kase(
      `${width} px wide mark on a 200x200 footprint`,
      finding({
        claimType: "geometric-routing",
        evidence: [{ image: TILE_A.file, rect: [300, 250, width, 600], where: "here" }],
      }),
      {
        measurements: [
          {
            ...CHIP,
            kind: "own-card-pierce",
            footprint: { x: 100, y: 100, width: 100, height: 100 },
          },
        ],
      },
    ),
  ),

  kase(
    "a card-sized mark round a thin graze",
    finding({
      claimType: "geometric-routing",
      evidence: [{ image: TILE_A.file, rect: [250, 200, 300, 200], where: "this card" }],
    }),
    {
      measurements: [
        {
          kind: "segment-vs-card",
          elementIds: ["e:0:A->B:iron", "B"],
          footprint: { x: 100, y: 100, width: 5, height: 0 },
          detail: "edge e:0:A->B:iron segment enters the padding of card B",
        },
      ],
    },
  ),

  kase(
    "second evidence entry reaches where the first does not",
    finding({
      evidence: [
        { image: TILE_A.file, rect: [790, 240, 60, 40], where: "500 px away" },
        { image: TILE_A.file, rect: [290, 240, 60, 40], where: "on the chip" },
      ],
    }),
  ),

  kase("keeps only the measurements that co-locate", finding(), {
    measurements: [
      { ...CHIP, kind: "chip-vs-card", footprint: { x: 800, y: 800, width: 20, height: 10 } },
      CHIP,
    ],
  }),

  kase(
    "malformed evidence rect",
    finding({
      evidence: [{ image: TILE_A.file, rect: [NaN, 240, 60, 40], where: "somewhere" }],
    }),
  ),

  kase(
    "evidence entries that are not objects",
    finding({ evidence: [null, "over there"] as unknown as Finding["evidence"] }),
  ),

  kase(
    "evidence rect that is not a four-number tuple",
    finding({
      evidence: [
        {
          image: TILE_A.file,
          rect: { x: 290, y: 240 } as unknown as [number, number, number, number],
          where: "somewhere",
        },
      ],
    }),
  ),

  // Routing past the join: severity sorts what nothing corroborated, a stated
  // mechanism outranks corroboration, and an unwitnessable claim always gets its
  // own refuter.
  kase(
    "uncorroborated minor",
    finding({
      severity: "minor",
      evidence: [{ image: TILE_A.file, rect: [790, 240, 60, 40], where: "away" }],
    }),
  ),
  kase(
    "uncorroborated nit",
    finding({
      severity: "nit",
      evidence: [{ image: TILE_A.file, rect: [790, 240, 60, 40], where: "away" }],
    }),
  ),
  kase(
    "corroborated finding that also states a mechanism",
    finding({
      severity: "nit",
      mechanismHypothesis: "the chip anchor is stamped before the route is chamfered",
    }),
  ),
  kase(
    "absence claim at nit severity",
    finding({ claimType: "absence", severity: "nit" }),
  ),
  kase(
    "interaction claim at nit severity",
    finding({ claimType: "interaction", severity: "nit" }),
  ),

  // The validator, whose violations gate all of the above.
  kase("geometric claim with no falsifier", withoutFalsifier(finding())),
  kase("subjective claim carrying a falsifier", finding({ claimType: "subjective" })),
  kase(
    "subjective claim with a mechanism and no falsifier",
    withoutFalsifier(
      finding({
        claimType: "subjective",
        mechanismHypothesis: "the anchor is stamped too early",
      }),
    ),
  ),
  kase("blank observation", finding({ observation: "   " })),
  kase("no observation at all", without(finding(), "observation")),
  kase("empty evidence", finding({ evidence: [] })),
  kase("no evidence at all", without(finding(), "evidence")),
  kase(
    "values outside every enumeration at once",
    finding({
      claimType: "vibes" as Finding["claimType"],
      severity: "blocker" as Finding["severity"],
      aspect: "taste" as Finding["aspect"],
    }),
  ),
];

const planIdOf = (index: number): string => `c${index}`;

// ---------------------------------------------------------------------------
// What the module says, computed the way the workflow composes it: validation
// first, and only a finding with no violations is routed at all.
// ---------------------------------------------------------------------------

type Row = {
  case: string;
  route: Route | null;
  violations: string[];
  corroboratedBy: string[];
};

function expectedRow(c: Case, index: number): Row {
  const violations = validateFinding(c.finding);
  if (violations.length > 0) {
    return { case: c.name, route: null, violations, corroboratedBy: [] };
  }
  const corroborations = corroborationsFor(c.finding, c.measurements, c.tiles);
  const route = routeFinding(c.finding, corroborations);
  return {
    case: c.name,
    route,
    violations: [],
    // Only a CORROBORATED finding gets a verdict without an agent, so that is
    // the only route where the join's output is observable by id.
    corroboratedBy:
      route === "CORROBORATED"
        ? corroborations.map(
            (m) => `${planIdOf(index)}#${c.measurements.indexOf(m)}:${m.kind}`,
          )
        : [],
  };
}

// ---------------------------------------------------------------------------
// Evaluating the workflow file
// ---------------------------------------------------------------------------

type TriageRow = {
  id: string;
  planId: string;
  route: Route | null;
  violations: string[];
};
type Verdict = {
  findingId: string;
  planId: string;
  observationVerdict: string;
  mechanismVerdict: string | null;
  mechanismStripped: string | null;
  disposition: string;
  corroboratedBy: string[];
  probeCommand: string | null;
  probeOutput: string | null;
  reasoning: string | null;
  correctedObservation: string | null;
  coercions: string[];
};
type WorkflowResult = {
  findings: Finding[];
  triage: TriageRow[];
  verdicts: Verdict[];
  humanRuling: Finding[];
  invalid: Array<{ id: string; planId: string; violations: string[] }>;
};

type AgentOptions = { label: string; phase: string; schema: unknown };
type AgentStub = (prompt: string, options: AgentOptions) => Promise<unknown>;

// `new Function` builds a SYNCHRONOUS function, and the workflow awaits its own
// phases at the top level, so the async analogue of the same constructor is what
// can evaluate it. Same construction otherwise: a body with the runtime's
// globals as named parameters, which is what the Workflow runtime hands it.
const AsyncFunction = Object.getPrototypeOf(async function () {
  /* type carrier only */
}).constructor as FunctionConstructor;

// A pipeline stage, as the runtime hands it its arguments: the previous stage's
// result (the item itself for the first stage), the item, and its index.
type Stage = (previous: unknown, item: unknown, index: number) => unknown;

type WorkflowRunner = (
  args: unknown,
  agent: AgentStub,
  parallel: (tasks: Array<() => Promise<unknown>>) => Promise<unknown[]>,
  pipeline: (items: unknown[], ...stages: Stage[]) => Promise<unknown[]>,
  phase: unknown,
  log: (message: string) => void,
  budget: unknown,
  workflow: unknown,
) => Promise<WorkflowResult>;

// The two fan-out globals, as the runtime documents them. `parallel` is a
// BARRIER over thunks; `pipeline` runs each item through every stage on its own,
// with no barrier between stages, so one item can be in stage 2 while another is
// still in stage 1 - which is the whole reason the workflow uses it. An item
// whose stage throws drops to null and skips the rest of its own chain only.
const parallelStub = (tasks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
  Promise.all(tasks.map((task) => task()));

const pipelineStub = (items: unknown[], ...stages: Stage[]): Promise<unknown[]> =>
  Promise.all(
    items.map(async (item, index) => {
      let value: unknown = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch {
          return null;
        }
      }
      return value;
    }),
  );

function compileWorkflow(): WorkflowRunner {
  const raw = readFileSync(WORKFLOW_PATH, "utf8");
  // The file declares its metadata as a module export, which a function body
  // cannot hold. Nothing else in it may be module syntax - a workflow script
  // cannot import, and that is the whole reason the rules are copied into it.
  const source = raw.replace("export const meta", "const meta");
  if (source === raw) {
    throw new Error(`${WORKFLOW_PATH} no longer declares \`export const meta\``);
  }
  for (const keyword of ["export ", "import "]) {
    if (source.includes(keyword)) {
      throw new Error(`${WORKFLOW_PATH} contains module syntax "${keyword.trim()}"`);
    }
  }
  return new AsyncFunction(
    "args",
    "agent",
    "parallel",
    "pipeline",
    "phase",
    "log",
    "budget",
    "workflow",
    source,
  ) as unknown as WorkflowRunner;
}

// One plan as this harness feeds it in: the tiles and measurements the join
// sees, and the findings an evaluator is stubbed to have returned for it.
type PlanSpec = {
  id: string;
  findings: Finding[];
  measurements: Measurement[];
  tiles: TileFrame[];
};

// Stands in for docs/render-conventions.md, which the orchestrator reads off
// disk and passes through. A distinctive body, so the assertion that the prompt
// carries it verbatim cannot pass on some other paragraph.
const CONVENTIONS = [
  "## Cards",
  "Stub conventions for the parity harness: cards, edges and chips.",
  "",
  "## Locale notes",
  "Stub locale paragraph.",
].join("\n");

// The args the orchestrator builds, in one place, so a test can take it apart
// to check what the workflow refuses.
// Where the orchestrator says the checkout is. Distinctive, so an assertion that
// the probe path is absolute cannot pass on a relative one that happens to
// contain the same suffix.
const REPO_ROOT = "/srv/checkouts/stc";

function workflowArgs(specs: PlanSpec[], locale = "en"): Record<string, unknown> {
  return {
    examDir: "/exam",
    repoRoot: REPO_ROOT,
    conventions: CONVENTIONS,
    plans: specs.map((spec) => ({
      id: spec.id,
      dir: `/exam/${spec.id}/images`,
      url: "http://localhost:4174/?exam=1#v1.parity",
      images: spec.tiles.map((t) => ({ file: t.file, what: "a tile of this plan" })),
      tiles: spec.tiles,
      coverage: {
        targetZoom: 0.75,
        coveredCount: 1,
        uncovered: [],
        correctiveTiles: 0,
        correctiveReserve: 0,
        capHit: false,
      },
      locale,
    })),
    measurements: Object.fromEntries(specs.map((spec) => [spec.id, spec.measurements])),
  };
}

// The workflow over args a test has taken apart, with every global stubbed to
// answer nothing: what is under test here is which args it refuses, so nothing
// past the validation prologue has to produce anything.
const runArgs = (args: unknown): Promise<WorkflowResult> =>
  compileWorkflow()(
    args,
    () => Promise.resolve(null),
    parallelStub,
    pipelineStub,
    undefined,
    () => {},
    undefined,
    undefined,
  );

async function runWorkflow(
  specs: PlanSpec[],
  // What a refuter answers, by the agent label the workflow gave it. The default
  // answers nothing, which is what the routing table wants: it is about where a
  // finding is SENT, and a stubbed verdict would only exercise the coercion.
  refute: (label: string) => unknown = () => null,
  locale?: string,
): Promise<{ result: WorkflowResult; logs: string[]; prompts: Map<string, string> }> {
  const args = workflowArgs(specs, locale);

  const evaluations = new Map(
    specs.map((spec) => [
      spec.id,
      {
        planId: spec.id,
        overall: "stubbed evaluation",
        blindSpotsAcknowledged: [],
        findings: spec.findings,
      },
    ]),
  );

  const logs: string[] = [];
  const prompts = new Map<string, string>();
  const agent: AgentStub = (prompt, options) => {
    prompts.set(options.label, prompt);
    if (!options.label.startsWith("evaluate:")) {
      return Promise.resolve(refute(options.label));
    }
    return Promise.resolve(evaluations.get(options.label.slice("evaluate:".length)) ?? null);
  };

  const result = await compileWorkflow()(
    args,
    agent,
    parallelStub,
    pipelineStub,
    undefined,
    (message: string) => logs.push(message),
    undefined,
    undefined,
  );
  return { result, logs, prompts };
}

// Started once at import and awaited by each test: the workflow evaluates the
// whole table in one pass, and re-running it per assertion would only be slower.
const RAN = runWorkflow(
  CASES.map((c, i) => ({
    id: planIdOf(i),
    findings: [c.finding],
    measurements: c.measurements,
    tiles: c.tiles,
  })),
);

describe("the workflow's inlined triage matches tools/exam/triage.ts", () => {
  test("routes and reports every case identically", async () => {
    const { result } = await RAN;
    const byPlan = new Map(result.triage.map((row) => [row.planId, row]));

    const actual: Row[] = CASES.map((c, i) => {
      const row = byPlan.get(planIdOf(i));
      if (row === undefined) throw new Error(`case "${c.name}" produced no triage row`);
      const verdict = result.verdicts.find((v) => v.findingId === row.id);
      return {
        case: c.name,
        route: row.route,
        violations: row.violations,
        corroboratedBy: verdict?.corroboratedBy ?? [],
      };
    });

    expect(actual).toEqual(CASES.map(expectedRow));
  });

  // A table that stopped covering a route would still pass the diff above, and
  // would stop testing the thing it exists for.
  test("the table exercises every route and the invalid path", async () => {
    const { result } = await RAN;
    const routes = new Set(result.triage.map((row) => row.route));
    expect([...routes].sort()).toEqual([
      "CORROBORATED",
      "HUMAN_RULING",
      "REFUTE_BATCH",
      "REFUTE_INDIVIDUAL",
      null,
    ]);
    expect(result.invalid.length).toBeGreaterThan(0);
    expect(result.humanRuling.length).toBeGreaterThan(0);
  });

  // The ids the routing is keyed by. A finding is namespaced by plan before
  // either output exists, and a verdict that joined to nothing would be a silent
  // fork of that id space rather than a failure.
  test("stamps one plan-namespaced id per finding, shared by every output", async () => {
    const { result } = await RAN;
    expect(result.findings.map((f) => f.id)).toEqual(
      CASES.map((c, i) => `${planIdOf(i)}:${c.finding.id}`),
    );
    expect(result.triage.map((row) => row.id)).toEqual(result.findings.map((f) => f.id));
    const known = new Set(result.findings.map((f) => f.id));
    expect(result.verdicts.filter((v) => !known.has(v.findingId))).toEqual([]);
  });

  test("a corroborated finding is filed without a probe, and says what carried it", async () => {
    const { result } = await RAN;
    const corroborated = result.triage
      .filter((row) => row.route === "CORROBORATED")
      .map((row) => result.verdicts.find((v) => v.findingId === row.id));

    expect(corroborated.length).toBeGreaterThan(0);
    for (const verdict of corroborated) {
      expect(verdict?.disposition).toBe("FILE");
      expect(verdict?.probeCommand).toBeNull();
      expect(verdict?.corroboratedBy.length).toBeGreaterThan(0);
      expect(verdict?.coercions).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The evaluator's output schema
//
// The table above hands findings to the workflow directly, so it never touches
// the JSON schema the workflow gives its evaluator - and the claimType enum in
// that schema is the one value whose staleness costs everything: an evaluator
// held to a retired claim type emits it on every finding, and validateFinding
// then rejects every one of them. The schema is a literal the runner never
// evaluates into anything reachable from here, so read it out of the source.
// ---------------------------------------------------------------------------

// The single `claimType: { type: 'string', enum: [...] }` line of the schema.
const CLAIM_TYPE_ENUM = /claimType:\s*\{\s*type:\s*'string',\s*enum:\s*\[([^\]]*)\]/;

function schemaClaimTypes(): string[] {
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  const match = CLAIM_TYPE_ENUM.exec(source);
  const list = match?.[1];
  if (list === undefined) {
    throw new Error(`${WORKFLOW_PATH} declares no claimType enum`);
  }
  return list.split(",").map((entry) => entry.trim().replace(/^'|'$/g, ""));
}

describe("the workflow's evaluator schema offers the module's claim types", () => {
  test("its claimType enum is exactly CLAIM_TYPES", () => {
    expect([...schemaClaimTypes()].sort()).toEqual([...CLAIM_TYPES].sort());
  });
});

// ---------------------------------------------------------------------------
// The conventions doc
//
// What the canvas is trying to draw used to be two paragraphs hardcoded in the
// prompt, and they drifted from the renderer without anything noticing. They now
// live in docs/render-conventions.md, which the orchestrator reads and passes as
// `args.conventions`. Two ways that goes wrong silently: the doc reaches the
// prompt truncated or not at all, and the old paragraphs survive alongside it
// and contradict it.
// ---------------------------------------------------------------------------

describe("the evaluator prompt is briefed from the conventions doc", () => {
  test("carries args.conventions verbatim and none of the old hardcoded domain text", async () => {
    const { prompts } = await RAN;
    const evaluatorPrompts = [...prompts.entries()]
      .filter(([label]) => label.startsWith("evaluate:"))
      .map(([, prompt]) => prompt);

    expect(evaluatorPrompts.length).toBeGreaterThan(0);
    for (const prompt of evaluatorPrompts) {
      expect(prompt).toContain(CONVENTIONS);
      expect(prompt).not.toContain("Domain, so you can judge correctness");
    }
  });

  // A non-en capture is judged against the same doc plus its locale section; an
  // en one must not be sent chasing CJK typography it cannot see. The refuter
  // end of the same fact: it boots the plan itself, and booting it in another
  // language would probe a different rendering than the one under exam.
  test("points a non-en plan at the locale section, and an en plan at nothing extra", async () => {
    const spec: PlanSpec = {
      id: "loc",
      findings: [finding({ id: "chip-adrift", evidence: AWAY })],
      measurements: [CHIP],
      tiles: TILES,
    };
    const zh = await runWorkflow([spec], () => null, "zh");
    const en = await runWorkflow([spec], () => null, "en");

    // Matched on the brief the workflow adds, not on the section name: the doc
    // it splices in names that section itself, in every locale.
    expect(zh.prompts.get("evaluate:loc")).toContain('captured in locale "zh"');
    expect(zh.prompts.get("evaluate:loc")).toContain('"Locale notes" section');
    expect(en.prompts.get("evaluate:loc")).not.toContain("captured in locale");

    expect(zh.prompts.get("refute:loc:chip-adrift")).toContain("--locale zh");
    expect(en.prompts.get("refute:loc:chip-adrift")).toContain("--locale en");
  });

  test("refuses a plan carrying no locale", async () => {
    const spec: PlanSpec = {
      id: "bare",
      findings: [],
      measurements: [CHIP],
      tiles: TILES,
    };
    const bare = workflowArgs([spec]);
    for (const plan of bare.plans as Array<Record<string, unknown>>) delete plan.locale;
    await expect(runArgs(bare)).rejects.toThrow(/render-quality-exam: plan bare .*locale/);
  });

  test("refuses args carrying no conventions", async () => {
    const spec: PlanSpec = {
      id: "bare",
      findings: [],
      measurements: [CHIP],
      tiles: TILES,
    };
    const bare = workflowArgs([spec]);
    delete bare.conventions;
    await expect(runArgs(bare)).rejects.toThrow(/render-quality-exam: .*conventions/);
  });
});

// ---------------------------------------------------------------------------
// One plan does not wait for another
//
// Evaluate, triage and refute used to be separated by barriers, so the fastest
// plan's findings sat idle until the slowest evaluator returned - on a corpus
// where one plan is much larger than the rest, that is most of the run. The
// chain is per plan now, and nothing else in this file would notice a barrier
// coming back: every other test either runs one plan or resolves every stub
// immediately.
// ---------------------------------------------------------------------------

describe("a plan runs through the exam without waiting for the others", () => {
  test("refutes one plan's finding while another plan's evaluator is still out", async () => {
    const specs: PlanSpec[] = ["fast", "slow"].map((id) => ({
      id,
      findings: [finding({ id: "chip-adrift", evidence: AWAY })],
      measurements: [CHIP],
      tiles: TILES,
    }));
    const evaluationOf = (spec: PlanSpec) => ({
      planId: spec.id,
      overall: "stubbed evaluation",
      blindSpotsAcknowledged: [],
      findings: spec.findings,
    });

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    const agent: AgentStub = (_prompt, options) => {
      prompts.push(options.label);
      if (options.label === "evaluate:slow") return held.then(() => evaluationOf(specs[1]!));
      if (options.label === "evaluate:fast") return Promise.resolve(evaluationOf(specs[0]!));
      return Promise.resolve(null);
    };

    const run = compileWorkflow()(
      workflowArgs(specs),
      agent,
      parallelStub,
      pipelineStub,
      undefined,
      () => {},
      undefined,
      undefined,
    );

    // Let every pending microtask and timer settle: "fast" has nothing left to
    // await, and "slow" is still holding its evaluator open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompts).toContain("refute:fast:chip-adrift");
    expect(prompts).not.toContain("refute:slow:chip-adrift");

    release();
    const result = await run;
    expect(result.verdicts.map((v) => v.findingId)).toEqual([
      "fast:chip-adrift",
      "slow:chip-adrift",
    ]);
    expect(result.findings.map((f) => f.id)).toEqual(["fast:chip-adrift", "slow:chip-adrift"]);
  });
});

// ---------------------------------------------------------------------------
// The probe command a refuter is handed
//
// A refuter runs Bash wherever its own agent starts, which is not necessarily
// the checkout: a relative `tools/exam/probe.ts` then resolves to nothing, and
// the harness failure that follows settles no claim in either direction. So the
// path is built from `args.repoRoot` and the briefing says so.
// ---------------------------------------------------------------------------

describe("the refuter's probe command is absolute", () => {
  test("names the probe under args.repoRoot and drops the repo-root instruction", async () => {
    const { prompts } = await runWorkflow([solo({})]);
    const prompt = prompts.get("refute:solo:chip-adrift");

    expect(prompt).toContain(`bun run ${REPO_ROOT}/tools/exam/probe.ts`);
    expect(prompt).not.toContain("from the repo root");
  });

  test("refuses args carrying no repoRoot, and a relative one", async () => {
    const spec: PlanSpec = { id: "bare", findings: [], measurements: [CHIP], tiles: TILES };

    const missing = workflowArgs([spec]);
    delete missing.repoRoot;
    await expect(runArgs(missing)).rejects.toThrow(/render-quality-exam: .*repoRoot/);

    await expect(runArgs({ ...workflowArgs([spec]), repoRoot: "STC" })).rejects.toThrow(
      /render-quality-exam: .*repoRoot/,
    );
  });
});

// ---------------------------------------------------------------------------
// Reading a refuter's answer
//
// A verdict is keyed by finding id, so an answer under another id has not
// answered the finding it is joined to - and the expensive way to get that wrong
// is to stamp the asked-for id onto it and file a CONFIRMED about something
// else. These run the same workflow with a refuter stubbed to misbehave.
// ---------------------------------------------------------------------------

// Uncorroborated wherever the measurement is: the finding has to reach a
// refuter for any of this to happen.
const AWAY: Finding["evidence"] = [
  { image: TILE_A.file, rect: [790, 240, 60, 40], where: "500 px away" },
];
const CITED = {
  probeCommand: "bun run tools/exam/probe.ts --op chip-binding --arg id=chip:7",
  probeOutput: '{"chip":"chip:7","ownDistance":84.0,"nearestOther":210.4}',
  reasoning: "the chip sits 84 world units off the polyline it belongs to",
};
const solo = (over: Partial<Finding>): PlanSpec => ({
  id: "solo",
  findings: [finding({ id: "chip-adrift", evidence: AWAY, ...over })],
  measurements: [CHIP],
  tiles: TILES,
});

describe("a refuter's answer is matched to the finding it answers", () => {
  test("an individual answer carrying another id settles nothing", async () => {
    const { result } = await runWorkflow([solo({})], () => ({
      findingId: "a-different-finding",
      observationVerdict: "CONFIRMED",
      ...CITED,
    }));

    expect(result.verdicts).toHaveLength(1);
    const [verdict] = result.verdicts;
    expect(verdict?.findingId).toBe("solo:chip-adrift");
    expect(verdict?.observationVerdict).toBe("UNCERTAIN");
    expect(verdict?.disposition).toBe("HUMAN_REVIEW");
    // The probe output belonged to another question, so none of it is kept.
    expect(verdict?.probeCommand).toBeNull();
    expect(verdict?.coercions).toEqual([
      `no answer carried this finding's id; the refuter answered about "a-different-finding"`,
    ]);
  });

  test("an agent that returned nothing says so, in those words", async () => {
    const { result } = await runWorkflow([solo({})]);
    expect(result.verdicts[0]?.coercions).toEqual(["the refuter returned nothing"]);
  });

  // The batch's failure mode: N answers, none of them matching, because the
  // "<planId>:" namespace was stripped. Diagnosed as an id-space mismatch rather
  // than as an agent that said nothing, and the ids it did use are logged.
  test("a batch answering under stripped ids is diagnosed as a mismatch", async () => {
    const spec: PlanSpec = {
      id: "pair",
      findings: [
        finding({ id: "chip-a", severity: "minor", evidence: AWAY }),
        finding({ id: "chip-b", severity: "nit", evidence: AWAY }),
      ],
      measurements: [CHIP],
      tiles: TILES,
    };
    const { result, logs } = await runWorkflow([spec], (label) =>
      label.startsWith("refute-batch:")
        ? {
            verdicts: [
              { findingId: "chip-a", observationVerdict: "REFUTED", ...CITED },
              { findingId: "chip-b", observationVerdict: "CONFIRMED", ...CITED },
            ],
          }
        : null,
    );

    expect(result.verdicts.map((v) => v.findingId)).toEqual(["pair:chip-a", "pair:chip-b"]);
    for (const verdict of result.verdicts) {
      expect(verdict.observationVerdict).toBe("UNCERTAIN");
      expect(verdict.disposition).toBe("HUMAN_REVIEW");
      expect(verdict.coercions).toEqual([
        `no answer carried this finding's id; the refuter answered about "chip-a", "chip-b"`,
      ]);
    }
    expect(logs).toContain(
      'refute-batch:pair answered about 2 id(s) not in this batch, ignored: "chip-a", "chip-b"',
    );
  });

  // The whole shape at once, on the outcome that has every field populated:
  // symptom real, stated cause disproved. Nothing here is optional, so a
  // consumer can read one key without checking whether it exists.
  test("an answered finding comes back with every field of the verdict shape", async () => {
    const { result } = await runWorkflow(
      [solo({ mechanismHypothesis: "the anchor is stamped before the route is chamfered" })],
      () => ({
        findingId: "solo:chip-adrift",
        observationVerdict: "CONFIRMED",
        mechanismVerdict: "REFUTED",
        ...CITED,
        correctedObservation: "the chip is 84 units off its line, but the anchor is stamped last",
      }),
    );

    expect(result.verdicts[0]).toEqual({
      findingId: "solo:chip-adrift",
      planId: "solo",
      observationVerdict: "CONFIRMED",
      mechanismVerdict: "REFUTED",
      mechanismStripped: "the anchor is stamped before the route is chamfered",
      disposition: "FILE_SYMPTOM_ONLY",
      corroboratedBy: [],
      probeCommand: CITED.probeCommand,
      probeOutput: CITED.probeOutput,
      reasoning: CITED.reasoning,
      correctedObservation: "the chip is 84 units off its line, but the anchor is stamped last",
      coercions: [],
    });
  });
});

// ---------------------------------------------------------------------------
// A plan that fell out of the run
//
// A chain comes back null only when one of its stages THREW, and that plan
// loses the findings, triage rows and verdicts it had already produced. An
// evaluator that returned nothing is a different failure - nothing was ever
// produced - and the two used to be reported under one line, so a thrown stage
// read as a silent agent and its lost rows went unmentioned.
// ---------------------------------------------------------------------------

// `pipeline` as the runtime resolves it, with stage two made to throw for ONE
// named plan; every other item runs untouched.
const throwingStageTwo =
  (planId: string) =>
  (items: unknown[], ...stages: Stage[]): Promise<unknown[]> =>
    pipelineStub(
      items,
      ...stages.map(
        (stage, stageIndex): Stage =>
          (previous, item, index) => {
            if (stageIndex === 1 && (item as { id: string }).id === planId) {
              throw new Error(`stage two threw for ${planId}`);
            }
            return stage(previous, item, index);
          },
      ),
    );

// `parallel` as the runtime resolves it: a thunk that throws does not fail the
// whole barrier, it resolves to null in that slot.
const forgivingParallel = (tasks: Array<() => Promise<unknown>>): Promise<unknown[]> =>
  Promise.all(tasks.map((task) => Promise.resolve().then(task).catch(() => null)));

describe("a plan that produced nothing is named for the reason it produced nothing", () => {
  test("separates a thrown stage from an evaluator that returned nothing, and keeps the rest", async () => {
    const specs: PlanSpec[] = ["boom", "silent", "ok"].map((id) => ({
      id,
      findings: [finding({ id: "chip-adrift", evidence: AWAY })],
      measurements: [CHIP],
      tiles: TILES,
    }));
    const agent: AgentStub = (_prompt, options) => {
      if (options.label === "evaluate:silent") return Promise.resolve(null);
      if (options.label.startsWith("evaluate:")) {
        const id = options.label.slice("evaluate:".length);
        return Promise.resolve({
          planId: id,
          overall: "stubbed evaluation",
          blindSpotsAcknowledged: [],
          findings: specs.find((s) => s.id === id)?.findings ?? [],
        });
      }
      return Promise.resolve(null);
    };

    const logs: string[] = [];
    const result = await compileWorkflow()(
      workflowArgs(specs),
      agent,
      parallelStub,
      throwingStageTwo("boom"),
      undefined,
      (message: string) => logs.push(message),
      undefined,
      undefined,
    );

    expect(logs).toContain("Not evaluated (agent returned nothing): silent");
    expect(logs).toContain("Dropped (a stage threw): boom");

    // The surviving plan keeps everything it produced.
    expect(result.findings.map((f) => f.id)).toEqual(["ok:chip-adrift"]);
    expect(result.triage.map((row) => row.id)).toEqual(["ok:chip-adrift"]);
    expect(result.verdicts.map((v) => v.findingId)).toEqual(["ok:chip-adrift"]);
  });

  test("a refuter task that threw costs its findings a verdict, and says so", async () => {
    const specs = [solo({})];
    const agent: AgentStub = (_prompt, options) => {
      if (options.label.startsWith("evaluate:")) {
        return Promise.resolve({
          planId: "solo",
          overall: "stubbed evaluation",
          blindSpotsAcknowledged: [],
          findings: specs[0]!.findings,
        });
      }
      throw new Error("the refuter blew up");
    };

    const logs: string[] = [];
    // Before the fix the null slot survived `.flat()` and the disposition
    // summary read `.disposition` off it, so this run threw a TypeError.
    const result = await compileWorkflow()(
      workflowArgs(specs),
      agent,
      forgivingParallel,
      pipelineStub,
      undefined,
      (message: string) => logs.push(message),
      undefined,
      undefined,
    );

    expect(result.verdicts).toEqual([]);
    expect(result.findings.map((f) => f.id)).toEqual(["solo:chip-adrift"]);
    expect(logs).toContain("solo: 1 refuter task(s) threw, so their findings carry no verdict");
  });
});
