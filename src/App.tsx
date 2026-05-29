import { useEffect, useMemo, useRef, useState } from "react";
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
import { buildRenderPlan } from "./pipeline/driver";
import { LocaleProvider, useI18n } from "./data/i18n-context";
import { LocaleSwitcher } from "./components/LocaleSwitcher";
import { ItemPackProvider } from "./canvas/itemPackContext";
import StatsStrip from "./canvas/StatsStrip";
import { iconSheetUrl } from "./canvas/iconSprite";

// Run the full render pipeline over a SolvePlanFull and turn it into React Flow
// nodes and edges via layoutRenderPlan.
async function renderFromFull(
  full: SolvePlanFull,
  itemOverrides: ReadonlyArray<import("./data/plan").ItemOverride>,
  targets: ReadonlyArray<Target>,
): Promise<{ nodes: Node[]; edges: Edge[] }> {
  const itemById = new Map(pack.items.map((i) => [i.id, i]));
  const machineById = new Map(pack.machines.map((m) => [m.id, m]));
  const { plan } = buildRenderPlan({
    logical: full.logical,
    replicas: full.replicas,
    multipliers: full.multipliers,
    idealCount: full.idealCount,
    classByReplicaId: full.classByReplicaId,
    classToQuotient: full.classToQuotient,
    condensation: full.condensation,
    torn: full.torn,
    recipeById: full.recipeById,
    rates: full.rates,
    itemById,
    machineById,
    itemOverrides,
    targets,
    pack,
  });
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
  const [logical, setLogical] = useState<LogicalGraph | null>(null);
  // Which section anchor is currently in view inside the side rail. This drives
  // the skewed-tab highlight so it reads as a "you-are-here" pill rather than a
  // toggle, and it's computed by an IntersectionObserver watching the two
  // section anchors.
  const [activeSection, setActiveSection] = useState<"targets" | "inputs">(
    "targets",
  );
  useEffect(() => {
    // jsdom (the vitest environment) doesn't implement IntersectionObserver.
    // Bailing out quietly is fine: the highlight is purely decorative, so the
    // rest of the side rail still renders without it.
    if (typeof IntersectionObserver === "undefined") return;
    const targetsEl = document.getElementById("side-targets");
    const inputsEl = document.getElementById("side-inputs");
    if (!targetsEl || !inputsEl) return;
    const io = new IntersectionObserver(
      (entries) => {
        // Pick whichever section overlaps the rail viewport more. Ignoring
        // entries with no intersection keeps the highlight steady when one
        // section has scrolled completely out of view.
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
  // Cached full solver output for the current Plan. It survives mutation paths
  // that re-run the render pipeline but not the solver.
  const fullRef = useRef<SolvePlanFull | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  // `pending` is written by every async mutation handler below. Its one reader
  // (the disabled state on the canvas toolbar's fixture buttons) is gone now,
  // but the writers stay so a future status indicator can hook into it.
  const [, setPending] = useState(false);
  const [initialError, setInitialError] = useState<Error | null>(null);
  const [mutationError, setMutationError] = useState<Error | null>(null);
  const solveGen = useRef(0);
  const tConfigRef = useRef(loadTransportConfig(defaultTransportConfig, pack));
  const inSccRecipes = useMemo(() => computeInSccRecipes(pack), []);
  const itemPackValue = useMemo(
    () => ({
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      overrides: plan?.itemOverrides ?? [],
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
    }),
    [plan],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await loadPlan(window.location.hash, pack);
        if (outcome.kind === "error") {
          if (cancelled) return;
          setInitialError(new Error(describePlanLoadError(outcome.error)));
          return;
        }
        const nextPlan = outcome.plan;
        const full = solvePlanWithIntermediates(
          nextPlan.targets,
          pack,
          tConfigRef.current,
          nextPlan.itemOverrides ?? [],
        );
        const laid = await renderFromFull(
          full,
          nextPlan.itemOverrides ?? [],
          nextPlan.targets,
        );
        if (outcome.kind === "seeded") {
          history.replaceState(null, "", "#" + (await encodePlan(nextPlan)));
        }
        if (cancelled) return;
        fullRef.current = full;
        setPlan(nextPlan);
        setLogical(full.logical);
        setNodes(laid.nodes);
        setEdges(laid.edges);
      } catch (e) {
        if (cancelled) return;
        setInitialError(e as Error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setNodes, setEdges]);

  async function applyPlan(nextPlan: Plan): Promise<void> {
    const myGen = ++solveGen.current;
    setPending(true);
    try {
      const error = validatePlan(nextPlan, pack);
      if (error) throw new Error(describePlanLoadError(error));
      const overrides = nextPlan.itemOverrides ?? [];
      const full = solvePlanWithIntermediates(
        nextPlan.targets,
        pack,
        tConfigRef.current,
        overrides,
      );
      const laid = await renderFromFull(full, overrides, nextPlan.targets);
      if (myGen !== solveGen.current) return;
      fullRef.current = full;
      setPlan(nextPlan);
      setLogical(full.logical);
      setNodes(laid.nodes);
      setEdges(laid.edges);
      setMutationError(null);
      const newHash = await encodePlan(nextPlan);
      if (myGen !== solveGen.current) return;
      history.replaceState(null, "", "#" + newHash);
    } catch (e) {
      if (myGen !== solveGen.current) return;
      setMutationError(e as Error);
    } finally {
      if (myGen === solveGen.current) setPending(false);
    }
  }

  async function handleTargetsChange(nextTargets: Target[]) {
    if (!plan) return;
    await applyPlan({ ...plan, targets: nextTargets });
  }

  async function handleItemOverridesChange(next: ItemOverride[]) {
    if (!plan) return;
    await applyPlan({ ...plan, itemOverrides: next });
  }

  const i18n = useI18n();

  // Memoise the set of target output items so InputsPanel's dual-listing badge
  // doesn't recompute on every keystroke. recipeById is rebuilt whenever the
  // plan changes, and targetItemIds is derived from it plus plan.targets.
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

  // Realized demand per input item from the most recent render pass. We read it
  // off the input ProductNode data the layout layer wrote, and InputsPanel
  // mirrors this so the side row shows the same number the canvas does. It
  // recomputes whenever the React Flow nodes change.
  const realizedRateByItem = useMemo<
    ReadonlyMap<string, import("./pipeline/types").RationalString>
  >(() => {
    const map = new Map<string, import("./pipeline/types").RationalString>();
    for (const n of nodes) {
      if (n.type !== "product") continue;
      const data = n.data as {
        kind?: string;
        itemId?: string;
        rate?: import("./pipeline/types").RationalString;
      };
      if (data.kind !== "inputProduct") continue;
      if (data.itemId === undefined || data.rate === undefined) continue;
      map.set(data.itemId, data.rate);
    }
    return map;
  }, [nodes]);

  // Raw items the current plan actually pulls across the boundary as
  // assumed-infinite supply. InputsPanel uses this to surface those items as
  // auto-rows when the user hasn't declared any explicit overrides, so the
  // "raw is unlimited by default" assumption is visible rather than hidden.
  // Sorted lexicographically by id for stable row order across re-renders.
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
    // (same reasoning as inSccRecipes above).
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
              // A fixed 360px column gives the recipe and item pickers enough
              // room that "Cuprium Bottle" no longer truncates to
              // "Cuprium B..." on a 1440 viewport.
              width: 360,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div className="side-panel-scroll">
              {/* This is a section-jump nav, not a tablist. Both Targets and
                    Inputs are always rendered in the scroll body, so these
                    controls are just anchor links into the rail, with
                    aria-current pinned to whichever section is in view (see the
                    IntersectionObserver that sets activeSection). Using
                    role=tab/tablist would mislead assistive-tech users, since
                    the controls don't toggle anything's visibility. */}
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
                    {pack.source.submoduleSha?.slice(0, 7) ?? "—"}
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
