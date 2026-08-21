# Status taxonomy: STC LP solver <-> FactorioLab GLPK

Prototype branch `prototype/001-glpk-oracle-eval`, PLAN-001 T3/T4. This is the
mapping `compare.ts` uses to reduce each solver's raw outcome to one of three
comparable verdicts. Validated on the Phase-0 gate battery's cyclic-target and
no-producer members (the infeasible-as-stated cases); the `unbounded` row is
UNVERIFIED (not constructible in this model, see bottom).

## Verdict reduction

Both solvers are collapsed to one of:

- `satisfiable` - feasible AND every target met with no shortfall.
- `unsatisfiable` - the problem AS STATED has no target-meeting solution.
- `infeasible-hard` - structurally infeasible or unbounded, reported as a hard
  failure by the solver itself.

The split between `unsatisfiable` and `infeasible-hard` exists because STC and
GLPK report a target-with-no-solution differently (STC keeps a "feasible"
status and parks the shortfall in a deficit variable; GLPK has no deficit
variable and the solve fails). Folding both onto `unsatisfiable` is what lets
the two solvers AGREE on the verdict for an unsatisfiable target.

## STC side (`LpResult.status` x `softFeasible`)

| STC `status` | `softFeasible` | deficit present | Verdict          |
| ------------ | -------------- | --------------- | ---------------- |
| `feasible`   | true           | no              | `satisfiable`    |
| `empty`      | true           | no              | `satisfiable`    |
| `feasible`   | false          | yes (>1e-12)    | `unsatisfiable`  |
| `empty`      | false          | yes             | `unsatisfiable`  |
| `infeasible` | (any)          | (any)           | `infeasible-hard`|
| `unbounded`  | (any)          | (any)           | `infeasible-hard`|

`softFeasible` is `deficit.size === 0`; a surviving deficit entry means some
item demand could not be met, so the target as stated is not satisfiable even
though the LP "status" stays `feasible`. (This silent-feasible-with-deficit is
the behaviour the oracle is built to surface.)

## GLPK side (`MatrixResult.resultType` + `simplexStatus` + `returnCode`)

| `resultType` | `simplexStatus` (GLPK)             | Verdict          |
| ------------ | ---------------------------------- | ---------------- |
| `solved`     | `optimal`                          | `satisfiable`    |
| `failed`     | `unbounded`                        | `infeasible-hard`|
| `failed`     | `infeasible` / `no_feasible` / etc | `unsatisfiable`  |
| `skipped`    | (no objectives)                    | n/a (not used)   |
| `paused`     | (paused flag)                      | n/a (not used)   |

`SimplexService.getSolution` returns `resultType = solved` only when GLPK's
`returnCode === 'ok'` AND model `status === 'optimal'`; any other pair becomes
`resultType = failed` with the raw `returnCode` and `status` preserved on the
result. The GLPK `Status` enum is
`optimal | feasible | infeasible | no_feasible | unbounded | undefined`
(`glpk-ts/dist/status.d.ts`). The simplex `ReturnCode` values that block a
solve are `no_primal_feasible` / `no_dual_feasible` etc.; the adapter never
trips the MIP path (no `transfer_*` ids, no `MachineLimit` objective), so the
MIP return codes are out of scope.

## Cross-solver agreement (the comparison contract)

| Closed-form truth         | STC                                   | GLPK                          | Verdict (both) |
| ------------------------- | ------------------------------------- | ----------------------------- | -------------- |
| target satisfiable        | `feasible`/`empty`, softFeasible=true | `solved`/`optimal`            | `satisfiable`  |
| target unsatisfiable      | `feasible`, softFeasible=false, deficit | `failed`/`infeasible`       | `unsatisfiable`|
| structurally unbounded    | `unbounded` (UNREACHABLE)             | `failed`/`unbounded` (UNREACHABLE) | `infeasible-hard` |

Validated members:
- cyclic-target (axis 5): STC `feasible` + `softFeasible=false` + deficit on F;
  GLPK `failed` (not `solved`). Both -> `unsatisfiable`. AGREE, and STC matches
  the closed-form truth (a pure 2-cycle cannot net-produce its target).
- no-producer (axis 6): STC `feasible` + `softFeasible=false` + deficit on X;
  GLPK `solved` (it supplies the no-producer item X from a free `unproduceable`
  variable). STC -> `unsatisfiable` (matches truth); GLPK -> `satisfiable`
  (diverges). This is the one taxonomy DISAGREEMENT in the battery and the
  reason axis 6 is excluded from the whitelist (adapter-artifact).

## `unbounded` row: UNVERIFIED (not constructible)

An unbounded LP cannot be built in this model:
- STC minimizes a sum of variables with non-negative cost (recipe costs >= 0;
  surplus/deficit weights > 0), so the objective is bounded below by 0 for any
  feasible problem. `src/solver/lp.ts` documents unbounded as unreachable for a
  valid model.
- The adapter feeds GLPK a `min` model whose only negative-cost variable is
  `maximize` (cost -1e6), present ONLY when a Maximize objective is supplied.
  The adapter never emits a Maximize objective (STC has no maximize concept), so
  there is no negative-cost variable and every recipe var is bounded below at 0;
  GLPK is therefore bounded too.

Conclusion: the `unbounded` -> `infeasible-hard` mapping is plausible but cannot
be exercised against a constructed fixture here. Its confidence is UNVERIFIED.
A corpus run (T5) that ever produces an unbounded result would be the trip-wire.
