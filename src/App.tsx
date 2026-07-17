import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import Canvas, { type CanvasStatus } from "./canvas/Canvas";
import { TargetsPanel } from "./components/TargetsPanel";
import { InputsPanel } from "./components/InputsPanel";
import { layoutRenderPlan } from "./canvas/layout";
import { buildRealizedRateByItem } from "./canvas/productNodeMetadata";
import {
  describePlanLoadError,
  encodePlan,
  loadPlan,
  validatePlan,
} from "./data/plan";
import type { ItemOverride, Plan } from "./data/plan";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "./data/transport-config";
import type { Target } from "./data/targets";
import { pack } from "./data/load";
import type { LogicalGraph } from "./canvas/layout";
import {
  LpInfeasibleError,
  solvePlanWithIntermediates,
  type SolvePlanFull,
} from "./solver";
import { planToSolverArgs } from "./solver/planToSolverArgs";
import { renderPlanFromSolve } from "./pipeline/driver";
import { LocaleProvider, useI18n } from "./data/i18n-context";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { ItemPackProvider } from "./canvas/itemPackContext";
import StatsStrip from "./canvas/StatsStrip";
import { displayedInputCount } from "./components/InputsPanel";
import { iconSheetUrl } from "./canvas/iconSprite";

// Run the render pipeline over a SolvePlanFull and turn it into React Flow nodes
// and edges via layoutRenderPlan.
async function renderFromFull(
  full: SolvePlanFull,
  itemOverrides: ReadonlyArray<import("./data/plan").ItemOverride>,
  targets: ReadonlyArray<import("./solver/planToSolverArgs").SolverTarget>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const { plan } = renderPlanFromSolve(full, pack, targets, itemOverrides);
  const laid = await layoutRenderPlan({
    plan,
    recipeById: full.recipeById,
    itemById,
  });
  return { nodes: laid.nodes as Node[], edges: laid.edges };
}

// Loading and error surfaces render inside the themed .ak-app-shell so there is
// no unstyled white page. These lay out a centered card; the shell class
// supplies the dark background and text color.
const splashStyle: CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  boxSizing: "border-box",
};

const splashCardStyle: CSSProperties = {
  maxWidth: 420,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 20,
  textAlign: "center",
};

const splashTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 700,
};

const splashDetailStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  opacity: 0.7,
  wordBreak: "break-word",
};

// A dismissible banner error. "load" wraps a hash-decode / validation failure
// (the pasted link, not the solver); "solver" wraps an exception thrown while
// solving a valid plan, which the render layer maps to localized copy (naming
// the implicated items for an LpInfeasibleError).
type BannerError =
  | { kind: "load"; message: string }
  | { kind: "solver"; error: unknown };

type SideSection = "targets" | "inputs";

// Document order of the side-rail sections. Ties in visibility resolve toward
// the earlier section, so a fully-visible later section never steals the
// highlight from an equally-visible earlier one.
const SIDE_SECTION_ORDER: SideSection[] = ["targets", "inputs"];

function toSideSection(elementId: string): SideSection | null {
  if (elementId === "side-inputs") return "inputs";
  if (elementId === "side-targets") return "targets";
  return null;
}

// Pick the section to highlight from a batch of IntersectionObserver readings.
// Highest intersection ratio wins; equal ratios resolve by document order.
// Returns null when nothing is intersecting so the caller keeps the last pick.
export function pickActiveSection(
  entries: ReadonlyArray<{ id: string; ratio: number }>,
): SideSection | null {
  let best: SideSection | null = null;
  let bestRatio = 0;
  for (const section of SIDE_SECTION_ORDER) {
    const entry = entries.find((e) => toSideSection(e.id) === section);
    if (entry && entry.ratio > bestRatio) {
      bestRatio = entry.ratio;
      best = section;
    }
  }
  return best;
}

export default function App() {
  return (
    <LocaleProvider>
      <AppInner />
    </LocaleProvider>
  );
}

function AppInner() {
  const [plan, setPlan] = useState<Plan | null>(null);
  // Authoritative copy of the plan, kept in lockstep with the `plan` state.
  // Mutation handlers read and write it synchronously so a commit never builds
  // on a stale snapshot while a solve is still in flight.
  const planRef = useRef<Plan | null>(null);
  const [logical, setLogical] = useState<LogicalGraph | null>(null);
  // Which section anchor is in view inside the side rail. Drives the skewed-tab
  // highlight so it reads as a "you-are-here" pill, not a toggle. Computed by an
  // IntersectionObserver watching the two section anchors.
  const [activeSection, setActiveSection] = useState<SideSection>("targets");
  useEffect(() => {
    // jsdom (the vitest environment) lacks IntersectionObserver. Bail quietly:
    // the highlight is decorative, so the rest of the side rail still renders.
    if (typeof IntersectionObserver === "undefined") return;
    const targetsEl = document.getElementById("side-targets");
    const inputsEl = document.getElementById("side-inputs");
    if (!targetsEl || !inputsEl) return;
    const io = new IntersectionObserver(
      (entries) => {
        // Pick whichever section overlaps the rail viewport more. Ignoring
        // non-intersecting entries keeps the highlight steady when one section
        // has scrolled fully out of view; ties resolve by document order.
        const pick = pickActiveSection(
          entries.map((e) => ({
            id: e.target.id,
            ratio: e.intersectionRatio,
          })),
        );
        if (pick) setActiveSection(pick);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(targetsEl);
    io.observe(inputsEl);
    return () => io.disconnect();
  }, [plan]);
  // Cached full solver output for the current Plan. Survives mutation paths that
  // re-run the render pipeline but not the solver.
  const fullRef = useRef<SolvePlanFull | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // `pending` is true while a solve + layout generation is in flight. It drives
  // the header status chip and the canvas status annotation (SOLVING), so both
  // load and mutation paths must set and clear it.
  const [pending, setPending] = useState(false);
  // Monotonic counter bumped whenever a fresh layout is applied to the canvas
  // (both the load and the mutation solve paths). Canvas re-fits the viewport on
  // each bump so plan edits and hash navigation frame the new graph.
  const [layoutGeneration, setLayoutGeneration] = useState(0);
  // Bumped only when the whole plan is replaced by a load (mount or hash
  // navigation), never by a mutation commit. The panels reset their uncommitted
  // local edits when it changes, so a freshly loaded plan never shows leftover
  // text from the previous one.
  const [planEpoch, setPlanEpoch] = useState(0);
  const [initialError, setInitialError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<BannerError | null>(null);
  // True while the rendered canvas is stale relative to the latest committed
  // intent: a mutation or navigation solve failed and the old graph is still on
  // screen. It stays true after the banner is dismissed, so the ERROR status
  // (header chip + canvas annotation) and the disabled Copy-share button remain
  // as the persistent "this is not what you asked for" cue until the next
  // successful solve clears it.
  const [stale, setStale] = useState(false);
  const solveGen = useRef(0);
  // The hash the app last handled: written by itself (history.replaceState on
  // solve success) or already picked up by loadFromHash. The hashchange
  // handler compares against it so app-initiated writes and spurious events
  // for the current hash never re-trigger a load. replaceState fires no
  // hashchange event, so for self-writes this is belt-and-braces; it becomes
  // load-bearing if a hash write ever switches to a location.hash assignment.
  const lastHandledHashRef = useRef<string | null>(null);
  const tConfigRef = useRef(loadTransportConfig(defaultTransportConfig, pack));
  // Accepted transient: this recomputes from the synchronously committed plan,
  // so ProductNode override chips on the still-stale canvas nodes update
  // against the new overrides during the solve window. Sub-second cosmetic
  // mismatch that self-heals when the new render lands.
  const itemPackValue = useMemo(
    () => ({
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      overrides: plan?.itemOverrides ?? [],
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
    }),
    [plan],
  );

  // Load a plan from a URL hash, solve it, and swap the whole app state to it.
  // Serves both the mount-time load and hashchange navigation (pasting another
  // plan's #v1.* URL into the address bar). It joins the solveGen last-write-
  // wins flow: a navigation invalidates any in-flight commit solve and vice
  // versa, so the newest intent always owns the rendered state. Load errors go
  // to initialError on mount (nothing is rendered yet) and to the dismissible
  // mutationError banner on navigation (the old plan stays up).
  const loadFromHash = useCallback(
    async (hash: string, source: "mount" | "navigation"): Promise<void> => {
      const myGen = ++solveGen.current;
      setPending(true);
      // Mark the hash as handled up front: even if the load fails, re-running
      // it for the same hash would only fail again.
      lastHandledHashRef.current = hash;
      // A load/validation failure is the pasted link's fault; a solve exception
      // is a valid plan the solver could not satisfy. They route to different
      // banner wrappers. On mount there is no canvas yet, so both land on the
      // full-screen initial-error surface instead of the dismissible banner.
      const failLoad = (message: string) => {
        if (myGen !== solveGen.current) return;
        if (source === "mount") setInitialError(new Error(message));
        else {
          setMutationError({ kind: "load", message });
          setStale(true);
        }
      };
      const failSolve = (e: unknown) => {
        if (myGen !== solveGen.current) return;
        if (source === "mount") {
          setInitialError(e instanceof Error ? e : new Error(String(e)));
        } else {
          setMutationError({ kind: "solver", error: e });
          setStale(true);
        }
      };
      try {
        const outcome = await loadPlan(hash, pack);
        if (outcome.kind === "error") {
          failLoad(describePlanLoadError(outcome.error));
          return;
        }
        const nextPlan = outcome.plan;
        const { targets, itemOverrides, recipeCosts } =
          planToSolverArgs(nextPlan, pack);
        const full = solvePlanWithIntermediates(
          targets,
          pack,
          tConfigRef.current,
          itemOverrides,
          recipeCosts,
        );
        const laid = await renderFromFull(full, itemOverrides, targets);
        if (outcome.kind === "seeded") {
          const newHash = "#" + (await encodePlan(nextPlan));
          if (myGen !== solveGen.current) return;
          lastHandledHashRef.current = newHash;
          history.replaceState(null, "", newHash);
        }
        if (myGen !== solveGen.current) return;
        fullRef.current = full;
        planRef.current = nextPlan;
        setPlan(nextPlan);
        setLogical(full.logical);
        setNodes(laid.nodes);
        setEdges(laid.edges);
        setLayoutGeneration((g) => g + 1);
        setPlanEpoch((e) => e + 1);
        // A fresh render is authoritative: the canvas now matches the plan.
        setStale(false);
        if (source === "navigation") {
          setMutationError(null);
          // A bad mount hash leaves the initial error screen up; a later
          // successful navigation must clear it so the loaded plan renders.
          setInitialError(null);
        }
      } catch (e) {
        failSolve(e);
      } finally {
        if (myGen === solveGen.current) setPending(false);
      }
    },
    [setNodes, setEdges],
  );

  // Recover from a damaged share link: drop the hash and load the default plan
  // so the user is not stranded on the error screen having to hand-edit the URL.
  const handleReset = useCallback(() => {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    void loadFromHash("", "navigation");
  }, [loadFromHash]);

  useEffect(() => {
    void (async () => {
      await loadFromHash(window.location.hash, "mount");
    })();
    const onHashChange = () => {
      if (window.location.hash === lastHandledHashRef.current) return;
      void loadFromHash(window.location.hash, "navigation");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadFromHash]);

  // Commit the plan (user intent) synchronously, then kick off the async
  // solve + layout for the derived state. On a solver failure the committed
  // plan stays put and the error banner is the signal; the canvas keeps the
  // last good render. The URL hash updates on solve success only.
  function commitPlan(nextPlan: Plan): void {
    const error = validatePlan(nextPlan, pack);
    if (error) {
      // A rejected edit is a plan-validity problem (the load wrapper), and the
      // canvas keeps the last good render, so mark it stale.
      setMutationError({ kind: "load", message: describePlanLoadError(error) });
      setStale(true);
      return;
    }
    planRef.current = nextPlan;
    setPlan(nextPlan);
    void scheduleSolve(nextPlan);
  }

  // Async derived-state refresh for an already-committed plan. solveGen is
  // last-write-wins: every solve corresponds to a committed plan, so the
  // newest generation's render is always the right one to keep.
  async function scheduleSolve(nextPlan: Plan): Promise<void> {
    const myGen = ++solveGen.current;
    setPending(true);
    try {
      const { targets, itemOverrides, recipeCosts } =
        planToSolverArgs(nextPlan, pack);
      const full = solvePlanWithIntermediates(
        targets,
        pack,
        tConfigRef.current,
        itemOverrides,
        recipeCosts,
      );
      const laid = await renderFromFull(full, itemOverrides, targets);
      if (myGen !== solveGen.current) return;
      fullRef.current = full;
      setLogical(full.logical);
      setNodes(laid.nodes);
      setEdges(laid.edges);
      setLayoutGeneration((g) => g + 1);
      setMutationError(null);
      setStale(false);
      const newHash = "#" + (await encodePlan(nextPlan));
      if (myGen !== solveGen.current) return;
      lastHandledHashRef.current = newHash;
      history.replaceState(null, "", newHash);
    } catch (e) {
      if (myGen !== solveGen.current) return;
      setMutationError({ kind: "solver", error: e });
      setStale(true);
    } finally {
      if (myGen === solveGen.current) setPending(false);
    }
  }

  function handleTargetsChange(update: (current: Target[]) => Target[]): void {
    const current = planRef.current;
    if (!current) return;
    const nextTargets = update(current.targets);
    // Same reference back means the updater had nothing to do (for example a
    // blur commit whose row was removed); skip the no-op solve.
    if (nextTargets === current.targets) return;
    commitPlan({ ...current, targets: nextTargets });
  }

  function handleItemOverridesChange(
    update: (current: ItemOverride[]) => ItemOverride[],
  ): void {
    const current = planRef.current;
    if (!current) return;
    const curOverrides = current.itemOverrides ?? [];
    const nextOverrides = update(curOverrides);
    if (nextOverrides === curOverrides) return;
    commitPlan({ ...current, itemOverrides: nextOverrides });
  }

  const i18n = useI18n();

  // Memoise the set of target output items so InputsPanel's dual-listing badge
  // does not recompute on every keystroke. Rebuilt from recipeById plus
  // plan.targets whenever the plan changes.
  const targetItemIds = useMemo<ReadonlySet<string>>(() => {
    if (!plan) return new Set<string>();
    const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
    const ids = new Set<string>();
    for (const t of plan.targets) {
      const r = recipeById.get(t.recipeId);
      const outId = r?.out[0]?.item;
      if (outId) ids.add(outId);
    }
    return ids;
  }, [plan]);

  // Realized demand per input item from the latest render pass, read off the
  // input ProductNode data the layout layer wrote. InputsPanel mirrors this so
  // the side row shows the same number as the canvas. Recomputes when the React
  // Flow nodes change.
  const realizedRateByItem = useMemo<
    ReadonlyMap<string, import("./pipeline/types").RationalString>
  >(() => buildRealizedRateByItem(nodes), [nodes]);

  // Raw items the current plan pulls across the boundary as assumed-infinite
  // supply. InputsPanel surfaces these as auto-rows when the user has declared
  // no explicit overrides, so the "raw is unlimited by default" assumption is
  // visible. Sorted by id for stable row order across re-renders.
  const assumedRawItemIds = useMemo<ReadonlyArray<string>>(() => {
    const ids: string[] = [];
    for (const item of pack.items) {
      if (!item.raw) continue;
      if (!realizedRateByItem.has(item.id)) continue;
      ids.push(item.id);
    }
    ids.sort();
    return ids;
    // `pack` is a module-stable import, so it stays out of the dependency list
    // (same as inSccRecipes above).
  }, [realizedRateByItem]);

  if (initialError) {
    return (
      <div className="ak-app-shell" style={splashStyle}>
        <div role="alert" style={splashCardStyle}>
          <p style={splashTitleStyle}>{i18n.t("app.error.corrupt")}</p>
          <p style={splashDetailStyle}>{initialError.message}</p>
          <button type="button" onClick={handleReset}>
            {i18n.t("app.error.reset")}
          </button>
        </div>
      </div>
    );
  }
  if (!plan || !logical) {
    return (
      <div className="ak-app-shell" style={splashStyle}>
        <div>{i18n.t("app.loading")}</div>
      </div>
    );
  }

  // An in-flight generation reads as SOLVING even if the previous one errored
  // (a retry is under way); a stale canvas reads as ERROR and stays ERROR after
  // the banner is dismissed until the next successful solve; otherwise READY.
  const status: CanvasStatus = pending ? "SOLVING" : stale ? "ERROR" : "READY";

  // Localized banner copy. Load/validation failures use the load wrapper; a
  // solver exception maps to a body that names the implicated items when it is
  // an infeasibility, falling back to the raw solver message otherwise.
  const bannerText = (err: BannerError): string => {
    if (err.kind === "load") return i18n.t("app.error.load", { message: err.message });
    const e = err.error;
    if (e instanceof LpInfeasibleError) {
      const ids =
        e.cappedItemIds.length > 0 ? e.cappedItemIds : e.targetItemIds;
      if (ids.length > 0) {
        const items = ids.map((id) => i18n.displayName(id)).join(", ");
        return i18n.t("app.error.infeasible", { items });
      }
      return i18n.t("app.error.infeasible.generic");
    }
    return i18n.t("app.error.solver", {
      message: e instanceof Error ? e.message : String(e),
    });
  };

  const targetCount = plan.targets.length;
  // Distinct recipes in the plan. logical.nodes mixes kind:"group" containers
  // with per-replica kind:"recipe" stamps, so neither the raw length nor the
  // recipe-stamp count matches what a RECIPES chip claims to show.
  const recipeCount = new Set(
    logical.nodes.flatMap((n) => (n.kind === "recipe" ? [n.recipe.id] : [])),
  ).size;

  return (
    <div
      className="ak-app-shell"
      style={{
        width: "100vw",
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        ["--icons-url" as string]: `url(${iconSheetUrl})`,
      }}
    >
      <div data-testid="header-strip">
        <div className="topbar">
          <div className="wordmark">
            <svg className="tri-mark" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 2 L14 13 L2 13 Z" fill="currentColor" />
            </svg>
            <span className="zh">明日方舟</span>
            <span className="sep" />
            <span className="latin">Endfield Planner</span>
          </div>
          <div className="breadcrumb">
            <span>SECTOR-01</span>
            <span className="sep">/</span>
            <span>FACTORY</span>
            <span className="sep">·</span>
            <span>BLUEPRINT TREE</span>
          </div>
          <div className="actions">
            <span className="stat-chip">
              TARGETS <span className="v">{targetCount}</span>
            </span>
            <span className="stat-chip">
              RECIPES <span className="v">{recipeCount}</span>
            </span>
            <span
              className={
                status === "ERROR"
                  ? "stat-chip err"
                  : status === "SOLVING"
                    ? "stat-chip warn"
                    : "stat-chip"
              }
            >
              {status}
            </span>
            <LocaleSwitcher />
          </div>
        </div>
        {mutationError ? (
          <div role="alert" className="app-error-banner">
            <span className="app-error-banner-body">
              {bannerText(mutationError)}
            </span>
            <button
              type="button"
              className="app-error-banner-dismiss"
              onClick={() => setMutationError(null)}
            >
              {i18n.t("app.error.dismiss")}
            </button>
          </div>
        ) : null}
      </div>
      <ItemPackProvider value={itemPackValue}>
        <StatsStrip plan={plan} assumedRawItemIds={assumedRawItemIds} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "row",
          }}
        >
          <div
            data-testid="side-panel"
            style={{
              // A fixed 360px column gives the pickers enough room that
              // "Cuprium Bottle" no longer truncates to "Cuprium B..." on a
              // 1440 viewport.
              width: 360,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div className="side-panel-scroll">
              {/* Section-jump nav, not a tablist. Targets and Inputs are both
                    always rendered in the scroll body, so these controls are
                    anchor links into the rail, with aria-current pinned to the
                    section in view (set by the IntersectionObserver above).
                    role=tab/tablist would mislead assistive-tech users, since
                    the controls toggle nothing's visibility. */}
              <nav
                className="side-panel-tabs"
                aria-label={i18n.t("side.nav.label")}
              >
                <a
                  data-testid="side-panel-tab-targets"
                  href="#side-targets"
                  aria-current={
                    activeSection === "targets" ? "location" : undefined
                  }
                  className={
                    "side-panel-tab" +
                    (activeSection === "targets" ? " active" : "")
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById("side-targets")?.scrollIntoView({
                      block: "start",
                      behavior: "smooth",
                    });
                  }}
                >
                  <span>{i18n.t("targets.title")}</span>
                  <span className="count">{plan.targets.length}</span>
                </a>
                <a
                  data-testid="side-panel-tab-inputs"
                  href="#side-inputs"
                  aria-current={
                    activeSection === "inputs" ? "location" : undefined
                  }
                  className={
                    "side-panel-tab" +
                    (activeSection === "inputs" ? " active" : "")
                  }
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById("side-inputs")?.scrollIntoView({
                      block: "start",
                      behavior: "smooth",
                    });
                  }}
                >
                  <span>{i18n.t("inputs.title")}</span>
                  <span className="count">
                    {displayedInputCount(
                      plan.itemOverrides ?? [],
                      assumedRawItemIds,
                    )}
                  </span>
                </a>
              </nav>
              <div id="side-targets">
                <TargetsPanel
                  key={planEpoch}
                  targets={plan.targets}
                  pack={pack}
                  onChange={handleTargetsChange}
                />
              </div>
              <div id="side-inputs">
                <InputsPanel
                  key={planEpoch}
                  itemOverrides={plan.itemOverrides ?? []}
                  onChange={handleItemOverridesChange}
                  pack={pack}
                  targetItemIds={targetItemIds}
                  realizedRateByItem={realizedRateByItem}
                  assumedRawItemIds={assumedRawItemIds}
                />
              </div>
              <div className="side-rail-footer" aria-hidden="true">
                <div>
                  <span className="key">PACK · </span>
                  <span className="val">{pack.source.name}</span>
                </div>
                <div>
                  <span className="key">REV · </span>
                  <span className="val">
                    {pack.source.sourceCommit?.slice(0, 7) ?? "—"}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
            <Canvas
              nodes={nodes}
              edges={edges}
              status={status}
              layoutGeneration={layoutGeneration}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
            />
          </div>
        </div>
      </ItemPackProvider>
    </div>
  );
}
