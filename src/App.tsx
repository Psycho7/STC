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
  blockedTargets,
  describePlanLoadError,
  encodeItemOverrideKey,
  encodePlan,
  loadPlan,
  validatePlan,
} from "./data/plan";
import type {
  BlockedTarget,
  ItemOverride,
  Plan,
  PlanLoadError,
} from "./data/plan";
import { attributeShortfall, shortfallText } from "./data/shortfall";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "./data/transport-config";
import type { Target } from "./data/targets";
import { pack } from "./data/load";
import { packIndex } from "./data/pack-index";
import {
  availabilityKey,
  readStoredArea,
  readStoredEventOverrides,
  unavailableCauses,
  unavailableEventItems,
  unavailableItems,
  unavailableRecipeIds,
  writeStoredArea,
  writeStoredEventOverrides,
  packCohortOf,
  type AvailabilitySettings,
  type EventCohortOverrides,
} from "./data/availability";
import {
  AREA_STORAGE_KEY,
  EVENT_COHORT_OVERRIDES_STORAGE_KEY,
} from "./data/storage-keys";
import { SettingsPanel } from "./components/SettingsPanel";
import { SettingsIndicator } from "./components/SettingsIndicator";
import type { LogicalGraph } from "./canvas/layout";
import { LpInfeasibleError } from "./solver";
import type Fraction from "fraction.js";
import type { CatalystAccount } from "./solver/catalyst";
import { solveFromPlan } from "./pipeline/solveForRender";
import { deficitItemsBeyondTolerance } from "./pipeline/render/invariants";
import type { RationalString } from "./pipeline/types";
import { LocaleProvider, useI18n } from "./data/i18n-context";
import type { I18nIndex, UiKey } from "./data/i18n";
import { joinList, joinSentences } from "./data/i18n-join";
import { ItemPackProvider } from "./canvas/itemPackContext";
import StatsStrip from "./canvas/StatsStrip";
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
// module constants, so the outcome (including an UnknownCarrierError throw on a
// pack the config cannot carry) is the same on every run. Nothing downstream
// takes the config, so this call IS the check.
loadTransportConfig(defaultTransportConfig, pack);

// A dismissible banner error. "load" wraps a hash-decode / validation failure
// (the pasted link, not the solver); "edit" wraps an in-app edit that
// validatePlan rejected; "blocked" rides on an adopted plan that was not
// solved because the viewer's area/event settings leave some target without a
// producer; "solver" wraps an exception thrown while solving a valid plan,
// which the render layer maps to localized copy (naming the implicated items
// for an LpInfeasibleError);
// "busy" reports an edit refused because a hash navigation was still landing.
// The load/edit kinds carry the structured PlanLoadError, described at render.
type BannerError =
  | { kind: "load"; error: PlanLoadError }
  | { kind: "edit"; error: PlanLoadError }
  | { kind: "blocked"; targets: readonly BlockedTarget[] }
  | { kind: "busy" }
  | { kind: "solver"; error: unknown };

// One banner sentence for a target the viewer's settings leave without a
// producer. The event cause names the switched-off cohort (#144) and the area
// cause the selected settlement (#124), both in the UI language, and the item
// goes by its display name. The manual cause keeps its English text naming the
// raw ids until #125 ships the toggles that can produce it. Exported so a test
// can pin the manual wording, which no settings path reaches yet.
export function describeBlockedTarget(
  { itemId, cause }: BlockedTarget,
  i18n: I18nIndex,
): string {
  switch (cause.kind) {
    case "event":
      return i18n.t("app.error.producer-unavailable.event", {
        item: i18n.displayName(itemId),
        cohort: cause.cohort,
      });
    case "area":
      // The settlement is named the way the panel names it, not by its raw
      // pack id: the sentence has to point at the option the user would flip.
      return i18n.t("app.error.producer-unavailable.area", {
        item: i18n.displayName(itemId),
        area: i18n.displayName(cause.area),
      });
    case "manual":
      return `Item ${itemId} cannot be a target right now: every recipe producing it is unavailable (recipe ${cause.recipeId} is switched off in settings).`;
  }
}

// Banner copy for a plan adopted with blocked targets: one sentence per target
// naming the setting that blocks it, then the pointer to Settings.
function describeBlocked(
  targets: readonly BlockedTarget[],
  i18n: I18nIndex,
): string {
  const sentences = targets.map((target) =>
    describeBlockedTarget(target, i18n),
  );
  sentences.push(i18n.t("app.error.blocked.settings"));
  return joinSentences(i18n.locale, sentences);
}

// Localized text for a solver exception. An infeasibility names the implicated
// items instead of the raw LP message, and advises raising the supply caps
// only when the plan sets at least one; otherwise it names the targets.
function describeSolveError(e: unknown, i18n: I18nIndex): string {
  if (e instanceof LpInfeasibleError) {
    const items = (ids: readonly string[]): string =>
      joinList(
        i18n.locale,
        ids.map((id) => i18n.displayName(id)),
      );
    if (e.cappedItemIds.length > 0) {
      return i18n.t("app.error.infeasible", { items: items(e.cappedItemIds) });
    }
    if (e.targetItemIds.length > 0) {
      return i18n.t("app.error.infeasible.targets", {
        items: items(e.targetItemIds),
      });
    }
    return i18n.t("app.error.infeasible.generic");
  }
  return i18n.t("app.error.solver", {
    message: e instanceof Error ? e.message : String(e),
  });
}

const EMPTY_CATALYST_ACCOUNT: CatalystAccount = new Map();
const EMPTY_DEFICITS: ReadonlyMap<string, Fraction> = new Map();
const NO_ITEMS: ReadonlyArray<string> = [];

// Boundary supply per general ROW KEY, folded out of the input ProductNode
// data the layout layer wrote.
//
// Only the ordinary draw goes in. The render pipeline draws the cycled charge
// from a catalyst node of its own, but every reader keys this map by the
// general row: the general row's number is its ordinary draw alone, and what
// the general pool was billed of the charge comes from catalystAccount, not
// from the catalyst node, so adding the node's rate here would count that
// share twice. The catalyst row's number comes from catalystAccount too.
type SupplyRateByItem = ReadonlyMap<string, RationalString>;

const EMPTY_SUPPLY_RATES: SupplyRateByItem = new Map();

function buildSupplyRateByItem(nodes: readonly Node[]): SupplyRateByItem {
  const byRowKey = new Map<string, RationalString>();
  for (const [itemId, rates] of buildRealizedRateByItem(nodes)) {
    if (rates.ordinary !== undefined) {
      byRowKey.set(encodeItemOverrideKey({ itemId }), rates.ordinary);
    }
  }
  return byRowKey;
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

// The header chip's words. The enum stays English: the canvas annotation and
// the exam tooling read it.
const STATUS_LABEL: Record<CanvasStatus, UiKey> = {
  SOLVING: "app.status.solving",
  ERROR: "app.status.error",
  SHORTFALL: "app.status.shortfall",
  READY: "app.status.ready",
};

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
  // Realized boundary supply of the latest solve, per row key. Derived state of
  // the committed render pass, so it is written where the nodes it describes
  // are: a drag hands App a fresh node array every pointer frame without
  // touching any node's data, and the panels keep this map for the whole drag.
  const [supplyRateByItem, setSupplyRateByItem] =
    useState<SupplyRateByItem>(EMPTY_SUPPLY_RATES);
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
  // Boot-time failure before any plan renders, owning the whole viewport: the
  // load error of a link that failed to decode or validate. A link that
  // decodes is adopted even when its solve fails, so a solve failure never
  // reaches the splash.
  const [initialError, setInitialError] = useState<PlanLoadError | null>(null);
  const [mutationError, setMutationError] = useState<BannerError | null>(null);
  // Target items the last successful render delivers below their declared rate.
  // Kept apart from mutationError on purpose: this describes the plan on screen
  // rather than a failed action, so it is not dismissible and it survives until
  // a later solve replaces it. Every successful solve overwrites it, so an
  // empty array is the "the canvas matches the declaration" state.
  const [underDelivered, setUnderDelivered] = useState<ReadonlyArray<string>>(
    [],
  );
  // The same solve's item-keyed feasibility deficits (items per second left
  // unmet) and the explicitly capped items it drew to their limit. They sit
  // beside underDelivered because the strip's sentence is built from all three:
  // a deficit can land on an item that is not a target at all, and a cap may be
  // named only when the plan actually exhausted it.
  const [deficits, setDeficits] =
    useState<ReadonlyMap<string, Fraction>>(EMPTY_DEFICITS);
  const [cappedAtLimit, setCappedAtLimit] =
    useState<ReadonlyArray<string>>(NO_ITEMS);
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
  // every committed plan) or already picked up by loadFromHash. The hashchange
  // handler compares against it so app-initiated writes and spurious events
  // for the current hash never re-trigger a load. replaceState fires no
  // hashchange event, so for self-writes this is belt-and-braces; it becomes
  // load-bearing if a hash write ever switches to a location.hash assignment.
  const lastHandledHashRef = useRef<string | null>(null);
  // The hash of the plan in the panels: written with the URL on every commit
  // and by a hash load that decoded, solved or not. A failed hash load over a
  // drawn plan puts it back in the URL, so a reload or a share gets the plan
  // on screen rather than the broken link.
  const lastGoodHashRef = useRef<string | null>(null);
  // Event-cohort overrides (#144): cohort -> forced on/off beyond the default
  // rule (on iff the cohort matches the pack's own version). Read once at
  // boot; every later change goes through handleEventOverridesChange, which
  // persists it, so state and storage never disagree.
  const [eventOverrides, setEventOverrides] = useState<EventCohortOverrides>(
    readStoredEventOverrides,
  );
  // The settlement the plan is built in (#124). Same one-writer discipline as
  // the overrides above; `pack` is a module-stable import, so the boot read
  // needs no dependency.
  const [area, setArea] = useState<string>(() => readStoredArea(pack));
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
  // Everything the availability core reads. The cohort overrides and the area
  // each have their own key and their own writer; #125 adds the last field.
  const availabilitySettings = useMemo<AvailabilitySettings>(
    () => ({ eventOverrides, area }),
    [eventOverrides, area],
  );
  // What is switched off and why: the cause map plan validation reports from,
  // the id set the solver seam takes, and the digest that decides whether any
  // of it actually changed. `pack` is a module-stable import, so it stays out
  // of the dependency list; only a settings change re-derives. A change that
  // leaves the map saying the same thing keeps the previous object, so the
  // validate / solve / layout work keyed on it does not re-run - and unlike the
  // old set-identity check, a same-ids-different-reason change does re-run,
  // because the digest carries the cause kind and its detail.
  const derivedAvailability = useMemo(() => {
    const causes = unavailableCauses(pack, availabilitySettings);
    return {
      causes,
      ids: unavailableRecipeIds(causes),
      key: availabilityKey(causes),
    };
  }, [availabilitySettings]);
  const [availability, setAvailability] = useState(derivedAvailability);
  if (
    derivedAvailability !== availability &&
    derivedAvailability.key !== availability.key
  ) {
    setAvailability(derivedAvailability);
  }
  const unavailable = availability.ids;
  // The items behind that map, each with its cause: the pickers dim exactly
  // these tiles and their hint names the cause the blocked-target banner also
  // interpolates. Derived beside `availability` from the same settings, so the
  // tiles, the hint, and the banner can never disagree.
  const unavailableItemCauses = useMemo(
    () => unavailableItems(pack, availabilitySettings),
    [availabilitySettings],
  );
  // The inputs picker gets the narrower map: an input is imported, so having no
  // producer in the selected area - or none left after a hand toggle - is no
  // reason to refuse it. Only an off cohort, which takes the item out of the
  // game entirely, can dim a tile there.
  const unavailableInputCauses = useMemo(
    () => unavailableEventItems(pack, availabilitySettings),
    [availabilitySettings],
  );
  // loadFromHash is a long-lived callback: the mount/hashchange wiring below
  // must not re-run when a flip recreates it, or every flip would reload the
  // plan and reset the panels. It reads availability through this ref instead
  // of closing over it; the re-solve effect owns flip-time work. The
  // initializer covers boot, and the effect below (declared before anything
  // that calls loadFromHash) keeps the ref current on later renders.
  const availabilityRef = useRef(availability);
  useEffect(() => {
    availabilityRef.current = availability;
  }, [availability]);
  // Mirrors initialError for the availability effect below, the same trick as
  // availabilityRef: that effect must fire on availability changes alone, so it cannot
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
  // The same one writer for the area (#124): the panel's radio group and the
  // cross-tab storage listener below both land here, so memory and storage
  // never disagree about which settlement is selected.
  const handleAreaChange = useCallback((next: string): void => {
    setArea(next);
    writeStoredArea(next);
  }, []);
  // `pack` is a module-stable import, so its memoized index is one object for
  // the app's lifetime and the item-pack context value never changes identity.
  const itemPackValue = packIndex(pack);

  // Swap the derived render state to a finished solve + layout. Shared by the
  // hash load and the re-solve paths, which each wrap it in their own plan and
  // error bookkeeping.
  const applySolved = useCallback(
    (
      solved: ReturnType<typeof solveFromPlan>,
      laid: Awaited<ReturnType<typeof layoutSolved>>,
    ): void => {
      setRecipeCount(countDistinctRecipes(solved.full.logical));
      setCatalystAccount(solved.full.catalystAccount);
      setSupplyRateByItem(buildSupplyRateByItem(laid.nodes as Node[]));
      setNodes(laid.nodes as Node[]);
      setEdges(laid.edges);
      setGaps(laid.gaps);
      setBaseEdges(laid.baseEdges);
      setUnderDelivered(solved.underDelivered);
      setDeficits(solved.full.feasibility.deficits);
      setCappedAtLimit(solved.cappedAtLimit);
      setLayoutGeneration((g) => g + 1);
    },
    [setNodes, setEdges, setGaps, setBaseEdges],
  );

  // Put a hash in the URL in place, marked handled so the hashchange listener
  // never reloads it.
  const replaceHash = useCallback((hash: string): void => {
    lastHandledHashRef.current = hash;
    history.replaceState(null, "", hash);
  }, []);

  // Write the plan's hash into the URL, unless a newer generation superseded
  // this one while the plan encoded.
  const writeHash = useCallback(
    async (nextPlan: Plan, myGen: number): Promise<void> => {
      const newHash = "#" + (await encodePlan(nextPlan));
      if (myGen !== solveGen.current) return;
      lastGoodHashRef.current = newHash;
      replaceHash(newHash);
    },
    [replaceHash],
  );

  // Drop whatever solve or navigation is in flight without starting a new one.
  // Bumping the generation is what makes the running one give up: every one of
  // its resume points compares against solveGen, so it applies nothing and
  // writes no hash. The navigation flag and the pending state have three
  // clearers: the running generation's own `finally`, scheduleSolve when it
  // supersedes a navigation, and this callback. The first only clears for the
  // newest generation, which the bump just made it not, and no scheduleSolve
  // follows, so this one clears both.
  const invalidateInFlight = useCallback((): void => {
    solveGen.current++;
    navigationInFlightRef.current = false;
    setPending(false);
  }, []);

  // Hold the committed plan unsolved because the viewer's settings leave some
  // target without a producer. A solve still running for an earlier plan is
  // obsolete: landing it would clear this banner and write the URL of a plan
  // the panels no longer hold. The old drawing stays up, marked stale, so its
  // now-disabled recipes do not read as valid. The URL still gets the held
  // plan, under the generation the bump just claimed, so a later commit
  // supersedes this write like any other.
  const holdBlocked = useCallback(
    (plan: Plan, targets: readonly BlockedTarget[]): void => {
      invalidateInFlight();
      setMutationError({ kind: "blocked", targets });
      setStale(true);
      void writeHash(plan, solveGen.current);
    },
    [invalidateInFlight, writeHash],
  );

  // Load a plan from a URL hash, solve it, and swap the whole app state to it.
  // Serves both the mount-time load and hashchange navigation (pasting another
  // plan's #v1.* URL into the address bar). It joins the solveGen last-write-
  // wins flow: a navigation invalidates any in-flight commit solve and vice
  // versa, so the newest intent always owns the rendered state. Load errors go
  // to initialError while no plan is committed (nothing is rendered yet) and to
  // the dismissible mutationError banner once one is (the old plan stays up).
  // A plan that decodes but fails to solve is committed anyway, under the
  // solver banner; one the viewer's settings block is committed unsolved,
  // under the blocked banner.
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
      // a load failure lands on the full-screen initial-error surface instead
      // of the dismissible banner. That test is the committed plan, not the
      // source of the load: a second bad hash pasted while the splash is up
      // must refresh the splash, and a failed reset from the splash must not
      // write a banner nothing displays. The splash keeps the broken hash in
      // the URL so it can be reported; over a drawn plan the last good hash
      // goes back in place (replaceState: no history entry and no hashchange,
      // and the handled ref covers a spurious one).
      const failLoad = (error: PlanLoadError) => {
        if (myGen !== solveGen.current) return;
        if (planRef.current === null) {
          setInitialError(error);
          return;
        }
        setMutationError({ kind: "load", error });
        setStale(true);
        const good = lastGoodHashRef.current;
        if (good !== null) replaceHash(good);
      };
      // A plan that decoded is plan state even when it cannot be solved, or
      // cannot be built under the viewer's settings, and the URL already holds
      // its hash: adopt it into the panels the way an in-app edit to an
      // infeasible rate is, with the banner and the old drawing (or an empty
      // canvas on first load) marked stale.
      const adoptUnsolved = (
        nextPlan: Plan,
        goodHash: string | null,
        banner: BannerError,
      ) => {
        if (myGen !== solveGen.current) return;
        planRef.current = nextPlan;
        setPlan(nextPlan);
        setPlanEpoch((n) => n + 1);
        if (goodHash !== null) lastGoodHashRef.current = goodHash;
        setRecipeCount((c) => c ?? 0);
        setInitialError(null);
        setMutationError(banner);
        setStale(true);
      };
      try {
        // Decode and check the plan without the viewer's settings: a target
        // they switch off blocks the solve, not the link.
        const outcome = await loadPlan(hash, pack);
        if (outcome.kind === "error") {
          failLoad(outcome.error);
          return;
        }
        const nextPlan = outcome.plan;
        const goodHash = outcome.kind === "loaded" ? hash : null;
        const blocked = blockedTargets(
          nextPlan,
          pack,
          availabilityRef.current.causes,
        );
        if (blocked.length > 0) {
          adoptUnsolved(nextPlan, goodHash, {
            kind: "blocked",
            targets: blocked,
          });
          return;
        }
        try {
          const solved = solveFromPlan(
            nextPlan,
            undefined,
            availabilityRef.current.ids,
          );
          const laid = await layoutSolved(solved);
          if (outcome.kind === "seeded") await writeHash(nextPlan, myGen);
          if (myGen !== solveGen.current) return;
          if (goodHash !== null) lastGoodHashRef.current = goodHash;
          planRef.current = nextPlan;
          setPlan(nextPlan);
          applySolved(solved, laid);
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
          adoptUnsolved(nextPlan, goodHash, { kind: "solver", error: e });
        }
      } finally {
        if (myGen === solveGen.current) {
          navigationInFlightRef.current = false;
          setPending(false);
        }
      }
    },
    [applySolved, writeHash, replaceHash],
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
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      // An unmounted app must not write the URL: a commit whose plan is still
      // encoding would land its hash under whatever mounts next.
      invalidateInFlight();
    };
  }, [loadFromHash, invalidateInFlight]);

  // Async derived-state refresh for an already-committed plan. solveGen is
  // last-write-wins: every solve corresponds to a committed plan, so the
  // newest generation's render is always the right one to keep. A stable
  // callback (the setters are stable and `unavailable` changes only when the
  // availability object does) so the re-solve effect below can key on it.
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
        applySolved(solved, laid);
        setMutationError(null);
        setStale(false);
        await writeHash(nextPlan, myGen);
      } catch (e) {
        if (myGen !== solveGen.current) return;
        setMutationError({ kind: "solver", error: e });
        setStale(true);
        await writeHash(nextPlan, myGen);
      } finally {
        if (myGen === solveGen.current) setPending(false);
      }
    },
    [applySolved, writeHash, unavailable],
  );

  // Solve a committed plan, or hold it unsolved when the viewer's settings
  // leave a target without a producer. A hash navigation still landing is
  // headed for another plan, so a block is not its concern: re-run it so the
  // pasted link is checked under the current set rather than dropped along
  // with the blocked plan. Only the availability effect can meet that case;
  // commitPlan refuses while a navigation is in flight.
  const solveOrHold = useCallback(
    (plan: Plan): void => {
      const blocked = blockedTargets(plan, pack, availability.causes);
      if (blocked.length > 0) {
        if (navigationInFlightRef.current) {
          void loadFromHash(window.location.hash, "navigation");
          return;
        }
        holdBlocked(plan, blocked);
        return;
      }
      void scheduleSolve(plan);
    },
    [availability, holdBlocked, loadFromHash, scheduleSolve],
  );

  // Commit the plan (user intent) synchronously, then kick off the async
  // solve + layout for the derived state. On a solver failure the committed
  // plan stays put and the error banner is the signal; the canvas keeps the
  // last good render. The URL hash tracks the committed plan, solved or not.
  function commitPlan(nextPlan: Plan): void {
    if (navigationInFlightRef.current) {
      setMutationError({ kind: "busy" });
      return;
    }
    const error = validatePlan(nextPlan, pack);
    if (error) {
      // The edit itself is what validatePlan rejected, and the canvas keeps the
      // last good render, so mark it stale.
      setMutationError({ kind: "edit", error });
      setStale(true);
      return;
    }
    planRef.current = nextPlan;
    setPlan(nextPlan);
    // An edit to a plan the settings block is still plan state: it commits
    // unsolved under the blocked banner, like a flip that orphans a target.
    solveOrHold(nextPlan);
  }

  // A mid-session availability change (#144, #124) re-checks the committed
  // plan against the new set. A cohort switched off or an area switched away
  // can leave a target with no producer: the setting stays applied, the plan
  // stays in the panels unsolved, and the last render stays up (blocked banner
  // + stale, never cleared here - the plan itself is untouched) so flipping
  // back re-solves from the same plan; a plan nothing blocks just re-solves.
  // With no plan committed (the boot load failed onto the splash) there is no
  // render to re-check, so a flip re-runs the pending load instead. The reload
  // joins the same solveGen last-write-wins flow as any navigation, and a
  // link still invalid simply fails again onto a fresh splash - one idempotent
  // retry, not a loop, because this effect fires on settings flips and not on
  // the error those flips may rewrite. Boot-time runs with no splash up no-op
  // because planRef.current is null and so is initialErrorRef.current, and
  // loads and mutations never change the derived set, so only a flip
  // re-triggers this effect.
  useEffect(() => {
    const current = planRef.current;
    if (!current) {
      if (initialErrorRef.current !== null) {
        void loadFromHash(window.location.hash, "navigation");
      }
      return;
    }
    solveOrHold(current);
  }, [availability, solveOrHold, loadFromHash]);

  // Cross-tab sync for the settings keys: a `storage` event fires in every
  // OTHER window sharing this origin's localStorage when a key changes, which
  // is how a cohort or an area changed in one tab reaches a second open tab.
  // Each key routes through the same writer the settings panel uses, so both
  // tabs converge on the same normalized state. Same-document writes fire no
  // `storage` event, so the panel path never double-applies.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === EVENT_COHORT_OVERRIDES_STORAGE_KEY) {
        handleEventOverridesChange(readStoredEventOverrides());
        return;
      }
      if (e.key === AREA_STORAGE_KEY) {
        handleAreaChange(readStoredArea(pack));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [handleEventOverridesChange, handleAreaChange]);

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

  // Items the current plan pulls across the boundary as assumed-infinite
  // supply: raw items with a realized draw, plus every item whose cycled
  // charge the general pool is holding. A catalyst item earns its row from the
  // draw, not from the raw flag, so the non-raw liquid_xiranite gets one too,
  // and it keeps it when the charge is its only general number. InputsPanel
  // surfaces these as auto-rows when the user has declared no explicit general
  // override, so the "unlimited by default" assumption is visible. General
  // side only, item ids: the catalyst pool has no auto-row. Sorted by id so
  // the list is stable across re-renders; the panel orders its rows by the
  // localized name.
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
      area={area}
      onAreaChange={handleAreaChange}
      onClose={() => setSettingsOpen(false)}
    />
  ) : null;

  if (initialError) {
    return (
      <div className="ak-app-shell" style={splashStyle}>
        <div role="alert" style={splashCardStyle}>
          <p style={splashTitleStyle}>{i18n.t("app.error.corrupt")}</p>
          <p style={splashDetailStyle}>{describePlanLoadError(initialError)}</p>
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

  // What the strip may say about the plan on screen, and about what: the unmet
  // items of the latest solve plus every explanation its evidence supports. The
  // deficit ids go through the same tolerance the under-delivery read applies,
  // so a sub-tolerance residue names no cause the item does not have.
  const shortfall = attributeShortfall({
    underDelivered,
    deficitItemIds: deficitItemsBeyondTolerance(deficits, plan.targets),
    itemCauses: unavailableItemCauses,
    cappedAtLimit,
  });

  // Ruling R9: the status reports FULFILLMENT. An in-flight generation reads as
  // SOLVING even if the previous one errored (a retry is under way); a stale
  // canvas reads as ERROR and stays ERROR after the banner is dismissed until
  // the next successful solve; a drawn plan with unmet demand - a deliberate
  // cap included - reads as SHORTFALL; only a plan that meets every declared
  // rate is READY. The gate is the tolerant under-delivery list the strip's
  // attribution also reads, NOT the raw deficit map: the LP can leave a
  // sub-tolerance residue there (a rate that snapped against its demand), and
  // gating on the raw map would flip a met plan to SHORTFALL over that noise.
  const status: CanvasStatus = pending
    ? "SOLVING"
    : stale
      ? "ERROR"
      : underDelivered.length > 0
        ? "SHORTFALL"
        : "READY";

  // Localized banner copy. A bad link uses the load wrapper and a rejected edit
  // its own wrapper; a solver exception maps to a body that names the
  // implicated items when it is an infeasibility, falling back to the raw
  // solver message otherwise.
  const bannerText = (err: BannerError): string => {
    if (err.kind === "load")
      return i18n.t("app.error.load", {
        message: describePlanLoadError(err.error),
      });
    if (err.kind === "edit")
      return i18n.t("app.error.edit", {
        message: describePlanLoadError(err.error),
      });
    if (err.kind === "blocked") return describeBlocked(err.targets, i18n);
    if (err.kind === "busy") return i18n.t("app.error.busy");
    return describeSolveError(err.error, i18n);
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
            <SettingsIndicator
              pack={pack}
              area={area}
              packCohort={packCohort}
              overrides={eventOverrides}
            />
            <span
              data-testid="status-chip"
              className={
                status === "ERROR"
                  ? "stat-chip err"
                  : status === "SOLVING" || status === "SHORTFALL"
                    ? "stat-chip warn"
                    : "stat-chip"
              }
            >
              {i18n.t(STATUS_LABEL[status])}
            </span>
            <button
              type="button"
              className="export-png"
              data-testid="export-png"
              aria-label={i18n.t("export.png.label")}
              title={i18n.t("export.png.label")}
              // A SHORTFALL plan is a drawn plan, so it exports: only an
              // in-flight solve or a stale canvas has nothing worth a PNG.
              disabled={
                status === "SOLVING" ||
                status === "ERROR" ||
                nodes.length === 0 ||
                exportingPng
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
        {/* The strip's gate mirrors the status gate above (the tolerant
            under-delivery list, not the raw deficit map) so the two can never
            disagree: no "unmet demand" sentence under a READY header. */}
        {underDelivered.length > 0 ? (
          <div
            role="status"
            data-testid="shortfall-strip"
            style={shortfallStripStyle}
          >
            {shortfallText(shortfall, i18n)}
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
            {/* One scroll body, no nav: each panel contributes its section
                head and its rows as siblings here, so both sticky heads keep
                their counts on screen whatever the rail is scrolled to. */}
            <div className="side-panel-scroll">
              <TargetsPanel
                key={`targets:${planEpoch}`}
                targets={plan.targets}
                pack={pack}
                onChange={handleTargetsChange}
                unavailableItems={unavailableItemCauses}
              />
              <InputsPanel
                key={`inputs:${planEpoch}`}
                itemOverrides={plan.itemOverrides ?? []}
                onChange={handleItemOverridesChange}
                pack={pack}
                unavailableItems={unavailableInputCauses}
                targetItemIds={targetItemIds}
                supplyRateByItem={supplyRateByItem}
                catalystAccount={catalystAccount}
                assumedRawItemIds={assumedRawItemIds}
              />
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
            {/* A sibling of the canvas, not part of it: the PNG export
                captures only the React Flow viewport inside Canvas. */}
            {targetCount === 0 ? (
              <div
                className="canvas-empty-hint"
                data-testid="canvas-empty-hint"
              >
                {i18n.t("canvas.empty.hint", {
                  action: i18n.t("targets.add"),
                })}
              </div>
            ) : null}
          </div>
        </div>
      </ItemPackProvider>
      {settingsMount}
    </div>
  );
}
