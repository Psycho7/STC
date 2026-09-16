import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import Canvas, { type CanvasHandle, type CanvasStatus } from "./canvas/Canvas";
import { downloadBlob, exportFilename } from "./canvas/exportPng";
import { TargetsPanel } from "./components/TargetsPanel";
import { InputsPanel } from "./components/InputsPanel";
import { rerouteEdges, type RFAnyNode } from "./canvas/layout";
import { layoutSolved } from "./canvas/layoutSolved";
import type { GapRecord } from "./canvas/layerModel";
import { buildRealizedRateByItem } from "./canvas/realizedRateByItem";
import {
  describePlanLoadError,
  encodeItemOverrideKey,
  encodePlan,
  loadPlan,
  validatePlan,
} from "./data/plan";
import type { ItemOverride, Plan, PlanLoadError } from "./data/plan";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "./data/transport-config";
import type { Target } from "./data/targets";
import { pack } from "./data/load";
import {
  readStoredEventOverrides,
  unavailableEventItems,
  unavailableRecipeIds,
  writeStoredEventOverrides,
  packCohortOf,
  type EventCohortOverrides,
} from "./data/event-cohorts";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";
import { SettingsPanel } from "./components/SettingsPanel";
import type { LogicalGraph } from "./canvas/layout";
import { LpInfeasibleError } from "./solver";
import type { CatalystAccount } from "./solver/catalyst";
import { solveFromPlan } from "./pipeline/solveForRender";
import { LocaleProvider, useI18n } from "./data/i18n-context";
import type { I18nIndex } from "./data/i18n";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { ItemPackProvider } from "./canvas/itemPackContext";
import StatsStrip from "./canvas/StatsStrip";
import { displayedInputCount } from "./components/InputsPanel";
import { iconSheetUrl } from "./canvas/iconSprite";

// Distinct recipes in the plan. logical.nodes mixes kind:"group" containers
// with per-replica kind:"recipe" stamps, so neither the raw length nor the
// recipe-stamp count matches what a RECIPES chip claims to show.
function countDistinctRecipes(logical: LogicalGraph): number {
  return new Set(
    logical.nodes.flatMap((n) => (n.kind === "recipe" ? [n.recipe.id] : [])),
  ).size;
}

// Loading and error surfaces render inside the themed .ak-app-shell so there is
// no unstyled white page. These lay out a centered card; the shell class
// supplies the dark background and text color. The positioning context also
// anchors the error splash's settings gear slot (top-right, out of the card).
const splashStyle: CSSProperties = {
  width: "100vw",
  height: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  boxSizing: "border-box",
  position: "relative",
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

// Warning strip under the header for a plan that solved but does not deliver
// what it declares. Styled inline rather than in canvas.css because it is an
// app-shell surface, not canvas chrome; the amber reads as "look at this",
// distinct from the red error banner directly above it.
const shortfallStripStyle: CSSProperties = {
  padding: "6px 10px",
  background: "rgba(232, 155, 26, 0.14)",
  borderTop: "1px solid var(--ak-accent-amber)",
  color: "var(--ak-accent-amber-bright)",
  fontFamily: "var(--font-ui)",
  fontSize: 13,
};

// Validated once at import: loadTransportConfig is a pure check over the two
// module constants and hands back its first argument, so the outcome (including
// an UnknownCarrierError throw on a pack the config cannot carry) is the same on
// every run. The returned config is not threaded anywhere - solveForRender
// supplies it to the solver itself - so this call IS the check.
loadTransportConfig(defaultTransportConfig, pack);

// A dismissible banner error. "load" wraps a hash-decode / validation failure
// (the pasted link, not the solver); "edit" wraps an in-app edit (or a
// mid-session availability change) that validatePlan rejected; "solver" wraps
// an exception thrown while solving a valid plan, which the render layer maps
// to localized copy (naming the implicated items for an LpInfeasibleError);
// "busy" reports an edit refused because a hash navigation was still landing.
// The load/edit kinds carry the structured PlanLoadError so the render phase,
// which holds the i18n index, can localize the user-facing kinds - see
// describeLoadError.
type BannerError =
  | { kind: "load"; error: PlanLoadError }
  | { kind: "edit"; error: PlanLoadError }
  | { kind: "busy" }
  | { kind: "solver"; error: unknown };

// Boot-time failure before any plan renders, owning the whole viewport: the
// structured load error when validation failed (so the splash can localize
// the user-facing kinds), or a solve exception's message.
type InitialError =
  | { kind: "load"; error: PlanLoadError }
  | { kind: "solve"; message: string };

// Localized text for a plan-load error on a user-facing surface. The
// producer-unavailable kind is the one failure aimed at the player rather
// than the link (#144): it names the target item and the switched-off event
// cohort, in the UI language. Every other kind describes a damaged share
// link - developer-facing detail - and keeps describePlanLoadError's text.
function describeLoadError(error: PlanLoadError, i18n: I18nIndex): string {
  if (error.kind === "producer-unavailable" && error.cause.kind === "event") {
    return i18n.t("app.error.producer-unavailable.event", {
      itemId: error.itemId,
      cohort: error.cause.cohort,
    });
  }
  return describePlanLoadError(error);
}

type SideSection = "targets" | "inputs";

// Document order of the side-rail sections. Ties in visibility resolve toward
// the earlier section, so a fully-visible later section never steals the
// highlight from an equally-visible earlier one.
const SIDE_SECTION_ORDER: SideSection[] = ["targets", "inputs"];

const EMPTY_CATALYST_ACCOUNT: CatalystAccount = new Map();

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

// Recovery screen for a render-phase throw. Sits inside LocaleProvider so it
// can be localized, and reuses the corrupt-link splash so a crash and a damaged
// share link look like the same class of problem. Reset drops the hash and
// reloads: once React has torn the tree down there is no state left to repair
// in place, and the default plan is the one input known to render.
function CrashSplash() {
  const i18n = useI18n();
  const onReset = () => {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    window.location.reload();
  };
  return (
    <div className="ak-app-shell" style={splashStyle}>
      <div role="alert" style={splashCardStyle}>
        <p style={splashTitleStyle}>{i18n.t("app.error.crash")}</p>
        <button type="button" onClick={onReset}>
          {i18n.t("app.error.reset")}
        </button>
      </div>
    </div>
  );
}

// Without a boundary, a throw anywhere in the render phase unmounts the whole
// tree and leaves a blank page. No reachable throw exists on validated input
// today, so this is hardening: it turns a future one into a recoverable screen.
// createRoot's onUncaughtError hook cannot do this job - it fires after the
// unmount, with nothing left to render into.
class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) return <CrashSplash />;
    return this.props.children;
  }
}

export default function App() {
  return (
    <LocaleProvider>
      <AppErrorBoundary>
        <AppInner />
      </AppErrorBoundary>
    </LocaleProvider>
  );
}

function AppInner() {
  const [plan, setPlan] = useState<Plan | null>(null);
  // Authoritative copy of the plan, kept in lockstep with the `plan` state.
  // Mutation handlers read and write it synchronously so a commit never builds
  // on a stale snapshot while a solve is still in flight.
  const planRef = useRef<Plan | null>(null);
  const [recipeCount, setRecipeCount] = useState<number | null>(null);
  // Per-item catalyst account from the latest solve, items per second. It is
  // the one piece of solver output the panel needs that no render node
  // carries: the solver expands no producer for a catalyst. Empty until the
  // first solve lands, and written only behind the same generation guard as
  // the nodes it is folded with, so a superseded solve can never leave its
  // numbers on screen.
  const [catalystAccount, setCatalystAccount] = useState<CatalystAccount>(
    EMPTY_CATALYST_ACCOUNT,
  );
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
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // The layout's inter-layer gap reserves. The canvas reads them for the exam
  // hook, and the drag-stop replay below routes against them as the RoutingCtx
  // (widenLayerGaps is not re-run at drag-stop, so a drag that changes a node's
  // layer membership routes against slightly stale gap records; accepted).
  const [gaps, setGaps] = useState<ReadonlyArray<GapRecord>>([]);
  // The post-ELK, pre-pass edges the current render was routed from. A drop
  // replays the routing passes from this pristine array rather than the routed
  // one, so the replay cannot drift from a fresh layout and no hint key has to
  // be un-stamped.
  const [baseEdges, setBaseEdges] = useState<Edge[]>([]);
  // A drop re-runs the routing passes over the live node positions (ruling R1:
  // replay at drag-stop, no per-frame re-route). The last pass
  // (deconflictChipAnchors) re-seats chips, junction dots and crossing cues on
  // the fresh route in the same call.
  const handleNodeDragStop = useCallback(
    (liveNodes: Node[]) => {
      setEdges(rerouteEdges(liveNodes as RFAnyNode[], baseEdges, { gaps }));
    },
    [setEdges, baseEdges, gaps],
  );
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
  const [initialError, setInitialError] = useState<InitialError | null>(null);
  const [mutationError, setMutationError] = useState<BannerError | null>(null);
  // Target items the last successful render delivers below their declared rate.
  // Kept apart from mutationError on purpose: this describes the plan on screen
  // rather than a failed action, so it is not dismissible and it survives until
  // a later solve replaces it. Every successful solve overwrites it, so an
  // empty array is the "the canvas matches the declaration" state.
  const [underDelivered, setUnderDelivered] = useState<ReadonlyArray<string>>(
    [],
  );
  // True while the rendered canvas is stale relative to the latest committed
  // intent: a mutation or navigation solve failed and the old graph is still on
  // screen. It stays true after the banner is dismissed, so the ERROR status
  // (header chip + canvas annotation) remains as the persistent "this is not
  // what you asked for" cue until the next successful solve clears it.
  const [stale, setStale] = useState(false);
  const solveGen = useRef(0);
  // True while a hash navigation is landing. A commit started in that window
  // would win the last-write-wins race and silently
  // rewrite the URL back to the plan the user just navigated away from, so
  // both refuse and say so instead. The flag cannot stick: only the newest
  // generation clears it - the navigation itself when it lands, and
  // scheduleSolve when an availability re-solve (which does not go through
  // the refusal) supersedes one mid-flight.
  const navigationInFlightRef = useRef(false);
  // The hash the app last handled: written by itself (history.replaceState on
  // solve success) or already picked up by loadFromHash. The hashchange
  // handler compares against it so app-initiated writes and spurious events
  // for the current hash never re-trigger a load. replaceState fires no
  // hashchange event, so for self-writes this is belt-and-braces; it becomes
  // load-bearing if a hash write ever switches to a location.hash assignment.
  const lastHandledHashRef = useRef<string | null>(null);
  // Event-cohort overrides (#144): cohort -> forced on/off beyond the default
  // rule (on iff the cohort matches the pack's own version). Read once at
  // boot; every later change goes through handleEventOverridesChange, which
  // persists it, so state and storage never disagree.
  const [eventOverrides, setEventOverrides] = useState<EventCohortOverrides>(
    readStoredEventOverrides,
  );
  // The pack's own cohort, handed to the settings panel so its Events rows
  // can tell current from past. `pack` is a module-stable import, so it stays
  // out of the dependency list.
  const packCohort = useMemo(() => packCohortOf(pack), []);
  // Whether the settings modal (#123's shell, holding #144's Events section)
  // is mounted. Conditional mount rather than an open prop, matching how the
  // panels own the picker popup.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Imperative seam to the canvas for the PNG export: Canvas owns the React
  // Flow provider and the element the rasterizer walks.
  const canvasRef = useRef<CanvasHandle>(null);
  // True from the click until the blob is handed to the download, so a second
  // click cannot start a capture on top of the first.
  const [exportingPng, setExportingPng] = useState(false);
  // A capture failure (unreachable webfont, a canvas the browser refuses) is
  // not a plan error, so it stays off the banner - which only carries plan
  // outcomes - and the button always comes back enabled.
  const handleExportPng = useCallback(async (): Promise<void> => {
    const handle = canvasRef.current;
    if (handle === null) return;
    setExportingPng(true);
    try {
      const blob = await handle.exportPng();
      const targetItemIds = (planRef.current?.targets ?? []).map(
        (t) => t.itemId,
      );
      downloadBlob(blob, exportFilename(targetItemIds, new Date()));
    } catch (e) {
      console.error("PNG export failed", e);
    } finally {
      setExportingPng(false);
    }
  }, []);
  // The recipes switched off under those overrides - the availability set the
  // load, mutation, and re-solve paths below all thread into the seam from
  // T3. `pack` is a module-stable import, so it stays out of the dependency
  // list; only an override flip re-derives the set.
  const unavailable = useMemo(
    () => unavailableRecipeIds(pack, eventOverrides),
    [eventOverrides],
  );
  // The event items behind that set, each with its cohort (#144's T6): the
  // pickers dim exactly these tiles and their hint names the cohort(s) the
  // validation error above also interpolates. Derived beside `unavailable`
  // from the same overrides, so the tiles, the hint, and the banner can never
  // disagree about which cohort is off.
  const eventOffItems = useMemo(
    () => unavailableEventItems(pack, eventOverrides),
    [eventOverrides],
  );
  // loadFromHash is a long-lived callback: the mount/hashchange wiring below
  // must not re-run when a flip recreates it, or every flip would reload the
  // plan and reset the panels. It reads the set through this ref instead of
  // closing over it; the re-solve effect owns flip-time work. The initializer
  // covers boot, and the effect below (declared before anything that calls
  // loadFromHash) keeps the ref current on later renders.
  const unavailableRef = useRef(unavailable);
  useEffect(() => {
    unavailableRef.current = unavailable;
  }, [unavailable]);
  // Mirrors initialError for the availability effect below, the same trick as
  // unavailableRef: that effect must fire on cohort flips alone, so it cannot
  // also key on the error object - every failed load stores a fresh one, and
  // keying on it would re-run the pending load after each failure (each retry
  // failing again) into a loop. It reads the current value through this ref.
  const initialErrorRef = useRef(initialError);
  useEffect(() => {
    initialErrorRef.current = initialError;
  }, [initialError]);
  // The one writer for override state: apply in memory and persist, so every
  // path that changes cohorts - T5's settings panel per switch and section
  // reset, the cross-tab storage listener below - lands identically. Kept as a
  // stable callback so effects can depend on it.
  const handleEventOverridesChange = useCallback(
    (next: EventCohortOverrides): void => {
      setEventOverrides(next);
      writeStoredEventOverrides(next);
    },
    [],
  );
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
  // to initialError while no plan is committed (nothing is rendered yet) and to
  // the dismissible mutationError banner once one is (the old plan stays up).
  const loadFromHash = useCallback(
    async (hash: string, source: "mount" | "navigation"): Promise<void> => {
      const myGen = ++solveGen.current;
      navigationInFlightRef.current = true;
      setPending(true);
      // Mark the hash as handled up front: even if the load fails, re-running
      // it for the same hash would only fail again.
      lastHandledHashRef.current = hash;
      // A load/validation failure is the pasted link's fault; a solve exception
      // is a valid plan the solver could not satisfy. They route to different
      // banner wrappers. With no plan rendered there is no canvas to keep, so
      // both land on the full-screen initial-error surface instead of the
      // dismissible banner. That test is the committed plan, not the source of
      // the load: a second bad hash pasted while the splash is up must refresh
      // the splash, and a failed reset from the splash must not write a banner
      // nothing displays.
      const failLoad = (error: PlanLoadError) => {
        if (myGen !== solveGen.current) return;
        if (planRef.current === null) setInitialError({ kind: "load", error });
        else {
          setMutationError({ kind: "load", error });
          setStale(true);
        }
      };
      const failSolve = (e: unknown) => {
        if (myGen !== solveGen.current) return;
        if (planRef.current === null) {
          setInitialError({
            kind: "solve",
            message: e instanceof Error ? e.message : String(e),
          });
        } else {
          setMutationError({ kind: "solver", error: e });
          setStale(true);
        }
      };
      try {
        const outcome = await loadPlan(hash, pack, unavailableRef.current);
        if (outcome.kind === "error") {
          failLoad(outcome.error);
          return;
        }
        const nextPlan = outcome.plan;
        const solved = solveFromPlan(
          nextPlan,
          undefined,
          unavailableRef.current,
        );
        const laid = await layoutSolved(solved);
        if (outcome.kind === "seeded") {
          const newHash = "#" + (await encodePlan(nextPlan));
          if (myGen !== solveGen.current) return;
          lastHandledHashRef.current = newHash;
          history.replaceState(null, "", newHash);
        }
        if (myGen !== solveGen.current) return;
        planRef.current = nextPlan;
        setPlan(nextPlan);
        setRecipeCount(countDistinctRecipes(solved.full.logical));
        setCatalystAccount(solved.full.catalystAccount);
        setNodes(laid.nodes as Node[]);
        setEdges(laid.edges);
        setGaps(laid.gaps);
        setBaseEdges(laid.baseEdges);
        setUnderDelivered(solved.underDelivered);
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
        if (myGen === solveGen.current) {
          navigationInFlightRef.current = false;
          setPending(false);
        }
      }
    },
    [setNodes, setEdges, setGaps, setBaseEdges],
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

  // Async derived-state refresh for an already-committed plan. solveGen is
  // last-write-wins: every solve corresponds to a committed plan, so the
  // newest generation's render is always the right one to keep. A stable
  // callback (the setters are stable and `unavailable` changes only on an
  // override flip) so the availability re-solve effect below can key on it.
  // Declared before commitPlan, which forwards into it.
  const scheduleSolve = useCallback(
    async (nextPlan: Plan): Promise<void> => {
      const myGen = ++solveGen.current;
      // This generation now supersedes anything in flight, including a hash
      // navigation the re-solve effect can preempt mid-load (commitPlan cannot:
      // it refuses while the flag is set). The navigation's finally clears the
      // flag only when it is the newest generation, which it no longer is, so
      // clear it here to keep the "the flag cannot stick" invariant.
      navigationInFlightRef.current = false;
      setPending(true);
      try {
        const solved = solveFromPlan(nextPlan, undefined, unavailable);
        const laid = await layoutSolved(solved);
        if (myGen !== solveGen.current) return;
        setRecipeCount(countDistinctRecipes(solved.full.logical));
        setCatalystAccount(solved.full.catalystAccount);
        setNodes(laid.nodes as Node[]);
        setEdges(laid.edges);
        setGaps(laid.gaps);
        setBaseEdges(laid.baseEdges);
        setUnderDelivered(solved.underDelivered);
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
    },
    [setNodes, setEdges, setGaps, setBaseEdges, unavailable],
  );

  // Commit the plan (user intent) synchronously, then kick off the async
  // solve + layout for the derived state. On a solver failure the committed
  // plan stays put and the error banner is the signal; the canvas keeps the
  // last good render. The URL hash updates on solve success only.
  function commitPlan(nextPlan: Plan): void {
    if (navigationInFlightRef.current) {
      setMutationError({ kind: "busy" });
      return;
    }
    const error = validatePlan(nextPlan, pack, unavailable);
    if (error) {
      // The edit itself is what validatePlan rejected, and the canvas keeps the
      // last good render, so mark it stale.
      setMutationError({ kind: "edit", error });
      setStale(true);
      return;
    }
    planRef.current = nextPlan;
    setPlan(nextPlan);
    void scheduleSolve(nextPlan);
  }

  // A mid-session availability change (#144) re-checks the committed plan
  // against the new set. A cohort switched off can invalidate a target only
  // its recipes produce: keep the last render up (banner + stale, never
  // cleared here - the plan itself is untouched) so flipping the cohort back
  // re-solves from the same plan; a still-valid plan just re-solves. With no
  // plan committed (the boot load failed onto the splash) there is no render
  // to re-check, so a flip re-runs the pending load instead: the stored
  // overrides are plausibly what rejected the hash's event target, and
  // flipping the cohort on must recover into the linked plan. The reload
  // joins the same solveGen last-write-wins flow as any navigation, and a
  // link still invalid under the new set simply fails again onto a fresh,
  // correctly-localized splash - one idempotent retry, not a loop, because
  // this effect fires on cohort flips and not on the error those flips may
  // rewrite. Boot-time runs with no splash up no-op because planRef.current
  // is null and so is initialErrorRef.current, and loads and mutations never
  // change the derived set, so only a flip re-triggers this effect.
  useEffect(() => {
    const current = planRef.current;
    if (!current) {
      if (initialErrorRef.current !== null) {
        void loadFromHash(window.location.hash, "navigation");
      }
      return;
    }
    const error = validatePlan(current, pack, unavailable);
    if (error) {
      setMutationError({ kind: "edit", error });
      setStale(true);
      return;
    }
    void scheduleSolve(current);
  }, [unavailable, scheduleSolve, loadFromHash]);

  // Cross-tab sync for the overrides: a `storage` event fires in every OTHER
  // window sharing this origin's localStorage when the key changes, which is
  // how a cohort flipped in one tab reaches a second open tab. Route it through
  // the same writer the settings panel (T5) will use, so both tabs converge on
  // the same normalized map. Same-document writes fire no `storage` event, so
  // the panel path never double-applies.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== EVENT_COHORT_OVERRIDES_STORAGE_KEY) return;
      handleEventOverridesChange(readStoredEventOverrides());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [handleEventOverridesChange]);

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
  // does not recompute on every keystroke. Plan targets are item-keyed, so this
  // is just their item ids; rebuilt whenever the plan changes.
  const targetItemIds = useMemo<ReadonlySet<string>>(() => {
    if (!plan) return new Set<string>();
    return new Set(plan.targets.map((t) => t.itemId));
  }, [plan]);

  // Boundary supply per ROW KEY: the realized demand of the latest render
  // pass, read off the input ProductNode data the layout layer wrote.
  //
  // A catalyst is external supply the same way a raw draw is, and the render
  // pipeline draws the cycled charge from a catalyst node of its own. The two
  // nodes go in under different row keys rather than being summed: the panel
  // shows one row per pool, and the general row's number is its ordinary draw
  // alone. What the general pool was billed of the charge comes from
  // catalystAccount, not from the catalyst node, so adding the node's rate
  // here would count that share twice.
  const supplyRateByItem = useMemo<
    ReadonlyMap<string, import("./pipeline/types").RationalString>
  >(() => {
    const map = new Map<string, import("./pipeline/types").RationalString>();
    for (const [itemId, rates] of buildRealizedRateByItem(nodes)) {
      if (rates.ordinary !== undefined) {
        map.set(encodeItemOverrideKey({ itemId }), rates.ordinary);
      }
      if (rates.catalyst !== undefined) {
        map.set(
          encodeItemOverrideKey({ itemId, role: "catalyst" }),
          rates.catalyst,
        );
      }
    }
    return map;
  }, [nodes]);

  // Items the current plan pulls across the boundary as assumed-infinite
  // supply: raw items with a realized draw, plus every item whose cycled
  // charge the general pool is holding. A catalyst item earns its row from the
  // draw, not from the raw flag, so the non-raw liquid_xiranite gets one too,
  // and it keeps it when the charge is its only general number. InputsPanel
  // surfaces these as auto-rows when the user has declared no explicit general
  // override, so the "unlimited by default" assumption is visible. General
  // side only, item ids: the catalyst pool has no auto-row. Sorted by id for
  // stable row order across re-renders.
  const assumedRawItemIds = useMemo<ReadonlyArray<string>>(() => {
    const ids: string[] = [];
    for (const item of pack.items) {
      const account = catalystAccount.get(item.id);
      if (account === undefined && !item.raw) continue;
      const hasOrdinary = supplyRateByItem.has(
        encodeItemOverrideKey({ itemId: item.id }),
      );
      const holdsCharge =
        account !== undefined && account.fromGeneral.valueOf() !== 0;
      if (!hasOrdinary && !holdsCharge) continue;
      ids.push(item.id);
    }
    ids.sort();
    return ids;
    // `pack` is a module-stable import, so it stays out of the dependency list.
  }, [supplyRateByItem, catalystAccount]);

  // One gear button and one panel mount serve every surface a boot can end
  // on (#144): the normal shell's topbar AND the error splash. A shared link
  // whose event target the stored overrides reject lands on the splash, and
  // the settings panel is the one way out that keeps the link - so it must be
  // reachable exactly there, not only from a plan that already rendered.
  const settingsGear = (
    <button
      type="button"
      className="settings-open"
      data-testid="settings-open"
      aria-label={i18n.t("settings.open.label")}
      title={i18n.t("settings.open.label")}
      onClick={() => setSettingsOpen(true)}
    >
      {/* Sliders, not a literal gear: three rails with two offset
          knobs read cleanly at the topbar's 16px. */}
      <svg
        className="settings-open-glyph"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <line x1="1.5" y1="4" x2="14.5" y2="4" />
        <circle cx="10" cy="4" r="2" />
        <line x1="1.5" y1="12" x2="14.5" y2="12" />
        <circle cx="6" cy="12" r="2" />
      </svg>
    </button>
  );
  // Portals to <body>; the opener button (topbar or splash gear) is the focus
  // the panel hands back on close.
  const settingsMount = settingsOpen ? (
    <SettingsPanel
      pack={pack}
      packCohort={packCohort}
      overrides={eventOverrides}
      onOverridesChange={handleEventOverridesChange}
      onClose={() => setSettingsOpen(false)}
    />
  ) : null;

  if (initialError) {
    return (
      <div className="ak-app-shell" style={splashStyle}>
        <div role="alert" style={splashCardStyle}>
          <p style={splashTitleStyle}>{i18n.t("app.error.corrupt")}</p>
          <p style={splashDetailStyle}>
            {initialError.kind === "load"
              ? describeLoadError(initialError.error, i18n)
              : initialError.message}
          </p>
          <button type="button" onClick={handleReset}>
            {i18n.t("app.error.reset")}
          </button>
        </div>
        {/* The same gear the topbar hosts, pinned top-right so the panel is
            reachable from the splash - flipping the rejecting cohort on is
            what re-runs the pending load below. */}
        <div className="splash-settings-slot">{settingsGear}</div>
        {settingsMount}
      </div>
    );
  }
  if (!plan || recipeCount === null) {
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

  // Localized banner copy. A bad link uses the load wrapper and a rejected edit
  // its own wrapper; a solver exception maps to a body that names the
  // implicated items when it is an infeasibility, falling back to the raw
  // solver message otherwise.
  const bannerText = (err: BannerError): string => {
    if (err.kind === "load")
      return i18n.t("app.error.load", {
        message: describeLoadError(err.error, i18n),
      });
    if (err.kind === "edit")
      return i18n.t("app.error.edit", {
        message: describeLoadError(err.error, i18n),
      });
    if (err.kind === "busy") return i18n.t("app.error.busy");
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
            <button
              type="button"
              className="export-png"
              data-testid="export-png"
              aria-label={i18n.t("export.png.label")}
              title={i18n.t("export.png.label")}
              disabled={
                status !== "READY" || nodes.length === 0 || exportingPng
              }
              onClick={() => void handleExportPng()}
            >
              {/* Download glyph: an arrow dropping into a tray. */}
              <svg
                className="export-png-glyph"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path d="M8 2 L8 10" />
                <path d="M4.5 7 L8 10.5 L11.5 7" />
                <path d="M2.5 13 L13.5 13" />
              </svg>
            </button>
            {settingsGear}
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
        {underDelivered.length > 0 ? (
          <div
            role="status"
            data-testid="shortfall-strip"
            style={shortfallStripStyle}
          >
            {i18n.t("app.error.infeasible", {
              items: underDelivered
                .map((id) => i18n.displayName(id))
                .join(", "),
            })}
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
                  eventOffItems={eventOffItems}
                />
              </div>
              <div id="side-inputs">
                <InputsPanel
                  key={planEpoch}
                  itemOverrides={plan.itemOverrides ?? []}
                  onChange={handleItemOverridesChange}
                  pack={pack}
                  eventOffItems={eventOffItems}
                  targetItemIds={targetItemIds}
                  supplyRateByItem={supplyRateByItem}
                  catalystAccount={catalystAccount}
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
              ref={canvasRef}
              nodes={nodes}
              edges={edges}
              gaps={gaps}
              status={status}
              layoutGeneration={layoutGeneration}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={handleNodeDragStop}
            />
          </div>
        </div>
      </ItemPackProvider>
      {settingsMount}
    </div>
  );
}
