# Testing conventions

## Where a test lives

A module has one test home, and it sits beside the module. The test for
`src/<path>/<mod>.ts` is `src/<path>/<mod>.test.ts`.

The `test/` tree is not a second home for a module. It holds suites that cross
module boundaries (integration, pipeline, regression, e2e), shared fixtures
(`test/canvas/busRouting.testkit.ts`, `test/canvas/pathAssertions.ts`,
`test/canvas/edgeSpans.ts`), and nothing else. A file under `test/` named after
exactly one `src/` module is in the wrong place.

Three consequences:

1. A new test goes beside its module.
2. An existing pair is not split further. New behaviour goes into whichever
   half already covers that area.
3. A `src/` test never imports from `test/`. A fixture both trees need lives in
   a `.testkit.ts` beside the module, which is what `src/canvas/node.testkit.ts`
   and `src/canvas/cssContract.testkit.ts` already are.

## Acknowledged backlog

Ten modules carry a test file in both trees today. Each is debt against the rule
above, to be settled when that module is being worked on anyway, not as a
campaign of its own:

| module                           | homes                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `src/components/InputsPanel.tsx` | `src/components/InputsPanel.test.tsx`, `test/components/InputsPanel.test.tsx` |
| `src/canvas/ProductNode.tsx`     | `src/canvas/ProductNode.test.tsx`, `test/canvas/ProductNode.test.tsx`         |
| `src/canvas/RecipeNode.tsx`      | `src/canvas/RecipeNode.test.tsx`, `test/canvas/RecipeNode.test.tsx`           |
| `src/canvas/edgePath.ts`         | `src/canvas/edgePath.test.ts`, `test/canvas/edgePath.test.ts`                 |
| `src/data/plan.ts`               | `src/data/plan.test.ts`, `test/plan.test.ts`                                  |
| `src/data/recipe-category.ts`    | `src/data/recipe-category.test.ts`, `test/data/recipe-category.test.ts`       |
| `src/solver/assemble.ts`         | `src/solver/assemble.test.ts`, `test/solver/assemble.test.ts`                 |
| `src/solver/graph.ts`            | `src/solver/graph.test.ts`, `test/solver/graph.test.ts`                       |
| `src/solver/replicate.ts`        | `src/solver/replicate.test.ts`, `test/solver/replicate.test.ts`               |
| `src/solver/tear.ts`             | `src/solver/tear.test.ts`, `test/solver/tear.test.ts`                         |

Two more collisions are not instances of the rule: `invariants.test.ts` names
two different `src/` modules (`src/solver` and `src/pipeline/render`), and
`types.test.ts` / `index.test.ts` name two different modules inside `test/`.

The single-module suites borrowed under `test/canvas/` are the same debt without
a basename collision: `busRouting.*.test.ts`, `chipSeating.*.test.ts` and the
other canvas suites each test one `src/canvas` module from the `test/` tree.
They are large and heavily pinned; leave them where they are until their module
is being worked on.
