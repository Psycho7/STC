import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import Canvas from "./canvas/Canvas";
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
import { computeInSccRecipes } from "./solver/packSccs";
import { solvePlanWithIntermediates, type SolvePlanFull } from "./solver";
import { planToSolverArgs } from "./solver/planToSolverArgs";
import { renderPlanFromSolve } from "./pipeline/driver";
import { LocaleProvider, useI18n } from "./data/i18n-context";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { ItemPackProvider } from "./canvas/itemPackContext";
import StatsStrip from "./canvas/StatsStrip";
import { iconSheetUrl } from "./canvas/iconSprite";

// Run the render pipeline over a SolvePlanFull and turn it into React Flow nodes
// and edges via layoutRenderPlan.
async function renderFromFull(
  full: SolvePlanFull,
  itemOverrides: ReadonlyArray<import("./data/plan").ItemOverride>,
  targets: ReadonlyArray<Target>,
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
  const [activeSection, setActiveSection] = useState<"targets" | "inputs">(
    "targets",
  );
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
        // has scrolled fully out of view.
        let bestId: "targets" | "inputs" | null = null;
        let bestRatio = 0;
        for (const e of entries) {
          if (e.intersectionRatio > bestRatio) {
            bestRatio = e.intersectionRatio;
            bestId = e.target.id === "side-inputs" ? "inputs" : "targets";
          }
        }
        if (bestId) setActiveSection(bestId);
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
  // `pending` is written by every async mutation handler below. Its one reader
  // (the canvas toolbar's fixture-button disabled state) is gone, but the
  // writers stay so a future status indicator can hook in.
  const [, setPending] = useState(false);
  const [initialError, setInitialError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const solveGen = useRef(0);
  // The hash the app last handled: written by itself (history.replaceState on
  // solve success) or already picked up by loadFromHash. The hashchange
  // handler compares against it so app-initiated writes and spurious events
  // for the current hash never re-trigger a load. replaceState fires no
  // hashchange event, so for self-writes this is belt-and-braces; it becomes
  // load-bearing if a hash write ever switches to a location.hash assignment.
  const lastHandledHashRef = useRef<string | null>(null);
  const tConfigRef = useRef(loadTransportConfig(defaultTransportConfig, pack));
  const inSccRecipes = useMemo(() => computeInSccRecipes(pack), []);
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
      // Mark the hash as handled up front: even if the load fails, re-running
      // it for the same hash would only fail again.
      lastHandledHashRef.current = hash;
      const fail = (e: Error) => {
        if (myGen !== solveGen.current) return;
        if (source === "mount") setInitialError(e);
        else setMutationError(e);
      };
      try {
        const outcome = await loadPlan(hash, pack);
        if (outcome.kind === "error") {
          fail(new Error(describePlanLoadError(outcome.error)));
          return;
        }
        const nextPlan = outcome.plan;
        const { targets, itemOverrides, recipeCosts } =
          planToSolverArgs(nextPlan);
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
        if (source === "navigation") setMutationError(null);
      } catch (e) {
        fail(e as Error);
      }
    },
    [setNodes, setEdges],
  );

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
      setMutationError(new Error(describePlanLoadError(error)));
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
        planToSolverArgs(nextPlan);
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
      setMutationError(null);
      const newHash = "#" + (await encodePlan(nextPlan));
      if (myGen !== solveGen.current) return;
      lastHandledHashRef.current = newHash;
      history.replaceState(null, "", newHash);
    } catch (e) {
      if (myGen !== solveGen.current) return;
      setMutationError(e as Error);
    } finally {
      if (myGen === solveGen.current) setPending(false);
    }
  }

  function handleTargetsChange(update: (current: Target[]) => Target[]): void {
    const current = planRef.current;
    if (!current) return;
    const nextTargets = update(current.targets);
    // Same reference back means the updater had nothing to do (for example a
    // debounced edit whose row was removed); skip the no-op solve.
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
      <div role="alert">
        {i18n.t("app.error.load", { message: initialError.message })}
      </div>
    );
  }
  if (!plan || !logical) return <div>{i18n.t("app.loading")}</div>;

  const targetCount = plan.targets.length;
  const recipeCount = logical.nodes.length;

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
            <span className="stat-chip warn">RDY</span>
            <LocaleSwitcher />
          </div>
        </div>
        {mutationError ? (
          <div
            role="alert"
            style={{
              padding: "6px 10px",
              background: "#fee",
              color: "#900",
              borderTop: "1px solid #f99",
              fontSize: 13,
            }}
          >
            {i18n.t("app.error.solver", { message: mutationError.message })}
            <button
              type="button"
              onClick={() => setMutationError(null)}
              style={{ marginLeft: 8 }}
            >
              {i18n.t("app.error.dismiss")}
            </button>
          </div>
        ) : null}
      </div>
      <ItemPackProvider value={itemPackValue}>
        <StatsStrip plan={plan} />
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
                    {(plan.itemOverrides ?? []).length}
                  </span>
                </a>
              </nav>
              <div id="side-targets">
                <TargetsPanel
                  targets={plan.targets}
                  pack={pack}
                  onChange={handleTargetsChange}
                  unsafeRecipes={inSccRecipes}
                />
              </div>
              <div id="side-inputs">
                <InputsPanel
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
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
            />
          </div>
        </div>
      </ItemPackProvider>
    </div>
  );
}
