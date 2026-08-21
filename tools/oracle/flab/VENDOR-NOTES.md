# Vendored FactorioLab solver slice - patch log

Throwaway prototype 001 (GLPK oracle eval). Relaxed quality bar.

## Source

- Repo: github.com/endfield-calc/factoriolab (MIT)
- Commit: 4fc462948fe9f652db20258953dd8dc09b3dfc97
- Path alias preserved: `~/* -> flab/src/app/*`; `src/environments -> flab/src/environments`.

## What was copied

The fork's `src/app/{services,models,helpers}` and `src/environments` subtrees were
copied wholesale, then `*.spec.ts`, `src/app/store`, and `src/app/d3-sankey` were
removed, and `src/app/services` was reduced to `simplex.service.ts` + `rate.service.ts`.
Only the closure reached from `smoke.test.ts` is type-checked (tsconfig `include` is the
smoke test); the remaining copied files (e.g. `app-data.ts`, `stored-signal.ts`,
`options.ts`, most `enum/*` and `settings/*`) are unimported leftovers and are NOT
checked. They still contain Angular/primeng/rxjs imports and would break if pulled in.

## Patches (per file)

- `services/simplex.service.ts`
  - Removed `@Injectable({ providedIn: 'root' })` decorator and the `inject`/`Injectable`
    import; replaced `rateSvc = inject(RateService)` with `rateSvc = new RateService()`
    (de-Angular).
  - Changed `import { StatusSimplex } from 'node_modules/glpk-ts/dist/status'` to a
    type-only `import type { StatusSimplex } from 'glpk-ts/dist/status'`. The deep path is
    not in glpk-ts's package `exports` map, so it is aliased in tsconfig to the `.d.ts`;
    `import type` makes it erase at runtime so vitest/Node never resolve it.
- `services/rate.service.ts`
  - Reduced to ONLY the `adjustPowerPollution` method (the single method the solver
    calls). Dropped `@Injectable`, the `d3-sankey` imports + `sortBySankey`, the
    `~/store/{items,recipes}.service` (`ItemsSettings`/`RecipesSettings`) imports, and all
    other methods (`normalizeSteps`, `objectiveNormalizedRate`, etc.). This severs the
    d3 and Angular-store dependency graphs.
- `models/matrix-result.ts`
  - Same `node_modules/glpk-ts/dist/status` -> type-only `glpk-ts/dist/status` fix.
- `models/settings/settings.ts`
  - SEVERED `Settings extends Omit<SettingsState, ...>` (from `~/store/settings.service`,
    a 1035-LOC Angular store that drags the whole store graph through tsc). Replaced with
    the minimal resolved field shape the simplex solver actually reads:
    `{ excludedItemIds, maximizeType, requireMachinesOutput, costs }`.
- `models/settings/recipe-settings.ts`
  - Dropped `primeng/api` (`SelectItem`) and `beacon-settings`/`module-settings` imports;
    typed the option / module / beacon fields as `unknown[]` placeholders (never read by
    the solver) to preserve the `Step`/`Objective` shape without dragging those deps.
- `models/settings/beacon-settings.ts`
  - Dropped `areBeaconSettingsEqual` (used the trimmed-out `areArraysEqual` helper and is
    never called by the solver); kept the `BeaconSettings` type only.
- `helpers/index.ts`
  - Trimmed to `coalesce`, `contains`, `spread`, `toEntities`, plus `cloneEntities` and
    `toRationalEntities` (needed by `data/recipe.ts`). Dropped the `primeng/api`, `rxjs`,
    `~/models/constants` (APP), and `~/models/enum/item-id` imports and every UI/Observable
    helper that depended on them.
- `models/enum/maximize-type.ts`, `objective-type.ts`, `objective-unit.ts`, `game.ts`,
  `quality.ts`
  - Dropped the `primeng/api` (`SelectItem`) import and the associated `*Options` UI
    constants; `objective-unit.ts` also dropped its `display-rate`/`flags` imports. Kept
    only the runtime enums (and `quality.ts`'s helper functions) the solver/closure uses.

## Closure surprises (for future tasks)

- `glpk-ts@0.0.11` exposes only `.` and `./package.json` in its package `exports`, so
  `glpk-ts/dist/status` (used by the upstream code) cannot be imported at runtime. It is
  type-only here. The status enum/types future adapters need (`StatusSimplex` =
  `'optimal' | 'feasible' | 'infeasible' | 'no_feasible' | 'unbounded' | 'undefined'`)
  live in `glpk-ts/dist/status.d.ts`.
- `SimplexService.solve()` contains a HARDCODED fork hack: it always pushes a
  `domain_key_tundra` `Limit` objective (value 0) unless a `DomainTransfer` objective
  disables it. Any solve input must therefore include `domain_key_tundra` in
  `itemIds`, `itemEntities`, `itemRecipeIds`, `itemAvailableRecipeIds`, and
  `itemAvailableIoRecipeIds` (as a boundary item with no producing recipe), or
  `recipeMatches` throws on the missing map entry. There is a second hardcoded hack
  (`transfer_*` integer vars, `xiranite_oven_1` blackRecipe) the adapter must be aware of.
- `wasm path`: `node_modules/glpk-wasm/dist/glpk.all.wasm` (verified present), loaded via
  `loadModule(...)` once before any `Model` is constructed.
- vitest needs its own alias config (`tools/oracle/vitest.config.ts`) for `~/*` and
  `src/environments`; the repo root `vite.config.ts` does not define `~`.
