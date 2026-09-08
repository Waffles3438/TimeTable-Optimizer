# Implementation Plan

## Scope and implementation anchors

This plan is limited to the reported ECE/Computer first-year Fall optimizer bug. Do not modify `curriculum.py`, `scrape.py`, generated files under `web/data/`, manifest contents, or unrelated UI behavior. Preserve the existing cache/data flow and the shared renderer-compatible optimizer boundary.

The current repository anchors the work as follows:

- `web/optimizer.js` is the browser/Node shared module and exports `groupCourses`, `buildCoursePlans`, `isClashFree`, `evaluatePlan`, `scorePlan`, `objectiveKey`, `comparePlans`, and `findBestPlan(plans, options)`. Its current candidate/mask/exact-search code must be audited rather than replaced blindly.
- `web/index.html` owns `selectedPlan()`, locks/exclusions/tutorial attendance, cache loading, `bestSoFar`, result rendering, and `optimize()`. At present `optimize()` calls `OPTIMIZER.findBestPlan(plans, opts)` synchronously, so the exact search can still block the browser even when the solver result is correct.
- `web/optimizer-worker.js` does not currently exist. Add it only if the worker path is the appropriate repository-compatible responsiveness solution; otherwise implement the specified cooperative exact fallback in the page while sharing the same solver state machine.
- `tests/test_frontend_optimizer.js` already contains the reproduction harness, independent reference-search helpers, preservation fixtures, result-shape checks, dataset integration checks, and cumulative-state checks. Extend those tests instead of creating a second incompatible optimizer or oracle.

## Ordered tasks

- [x] 1. Reproduce the reported failure and write the bug-condition exploration test
  - **Property 1: Bug Condition** - Complete deterministic optimization for the locked Computer/ECE first-year Fall input
  - **STANDALONE TASK; MUST BE COMPLETED BEFORE ANY FIX.** Use the unfixed repository behavior as the baseline and do not weaken the test when it fails.
  - Reproduce the exact input from `web/data/computer-1-fall.json`: use program/cache `computer`, year `1`, Fall; lock exactly `APS100H1` tutorial `TUT0106` and `APS111H1` tutorial `TUT0106`; exclude all `APS110H1` tutorials; leave every other user-selectable component unlocked; enable only campus optimization (`campus: 1`, `lunch: 0`, `early: 0`, `late: 0`). Confirm the constructed plans retain both locks and have no `APS110H1` tutorial pool.
  - Use the existing `tests/test_frontend_optimizer.js` harness and independent finite reference search. Exercise the actual page/control path, not only a direct solver call, and record whether `optimize()` blocks control, throws, fails to complete, returns an unproven/sample result, or renders a partial/conflicting result. Because the current page invokes the shared search synchronously, include a deterministic event-loop/control-return assertion or equivalent browser-harness instrumentation so the current defect is observable without relying on a flaky wall-clock threshold.
  - Assert the expected contract that the fixed path will later satisfy: control returns; a feasible case is `status: "OPTIMAL"`, `complete: true`, `optimal: true`, clash-free, exact-lock preserving, complete for every required non-excluded component, and equal to the independent minimum campus objective; an unsatisfiable case is `plan: null`, `status: "NO_SOLUTION"`, `complete: true`, `optimal: true` with no rendered timetable. The exploration run on the unfixed path is expected to fail; this failure is the captured proof of the defect, not a test defect.
  - Capture concrete counterexamples in the test failure message or test notes, including whether the synchronous path blocks, whether an incumbent lacks completion/optimality proof, and the objective/signature returned by the baseline versus the reference minimum. Also retain focused baseline fixtures for a worse sampled campus alternative and overlapping same-course locks if they are needed to localize the actual root cause.
  - Do not add random seeds, elapsed-time cutoffs, partial-result fallbacks, or a second solver to make this exploration pass.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

- [x] 2. Observe and write preservation property tests before implementation
  - **Property 2: Preservation** - Existing optimizer, page, cache, lock, attendance, exclusion, clash, objective, and curriculum behavior
  - **STANDALONE TASK; MUST BE COMPLETED BEFORE IMPLEMENTATION.** Follow observation-first methodology: run the unfixed code with inputs where the reported bug condition is false, record the actual outputs/state transitions, then encode those observations as properties. These tests must pass on the unfixed baseline.
  - Cover the established `selectedPlan()` and `buildCoursePlans()` observations for active lecture/PRA/TUT locks, selected subsets of multi-meeting tutorial attendance, component-specific exclusions, required non-excluded component retention, duplicate/equivalent section handling, positive-duration clashes, and endpoint-touching intervals.
  - Cover every supported objective measurement and combination: no preference, campus active-day plus positive internal gaps, lunch in the 11:00–13:00 window with the one-hour threshold, end-early sum of selected end times, start-late negative sum of selected start times, and deterministic tie behavior. Record the expected no-solution result for unsatisfiable active locks or unfillable active component types.
  - Cover manifest-backed availability, `data/${program}-${year}-${semester}.json` paths, `_memCache`, `ttb:` localStorage entries, reset-on-load behavior, the existing Electrical selector, and the distinction between displayed dropdown changes and an actual Load action. Do not assume a new worker contract yet; observe the existing page behavior separately from the future responsiveness assertion.
  - Cover repeated Optimize behavior and state changes: unchanged inputs do not worsen the remembered result; changing a lock, exclusion, tutorial attendance subset, loaded data set, or objective option cannot reuse a result from another input. Record the exact current `bestSoFar`/rendering invariants that must remain.
  - Include all eight first-year program IDs for Fall and Winter, raw/built Computer–Track One first-year equivalence, and distinct second-year Computer versus Electrical ECE course sets as regression observations. Keep data fixtures read-only.
  - Use `_Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_`.

- [ ] 3. Implement the fix as one shared exact, proof-carrying search and a responsive page boundary
  - **Dependency:** Tasks 1 and 2 must be written and their baseline observations/counterexamples documented before changing production behavior.
  - Keep the public API and renderer shape stable. The implementation must be limited to the likely files `web/optimizer.js`, `web/index.html`, a new `web/optimizer-worker.js` if selected, and focused tests in `tests/test_frontend_optimizer.js`.

  - [x] 3.1 Audit and complete candidate construction while preserving the shared API
    - Start from the current implementation rather than assuming the design’s old sampler still exists. Confirm the actual defect(s) in the current branch, especially the synchronous page call and any remaining randomized/deadline path; remove production dependence on `Math.random`, `Date.now` deadlines, `solve`, `solveBest`, fixed samples, timeout metadata, or random fallback wherever it remains in the search path.
    - Preserve the signatures and established input shapes of `groupCourses`, `buildCoursePlans`, `isClashFree`, `evaluatePlan`, `scorePlan`, `objectiveKey`, `comparePlans`, and `findBestPlan(plans, options)`. Continue to return renderer-compatible course plans with `pick` entries; do not introduce a page-only candidate format.
    - Normalize and stably sort meetings, sections, component types, courses, options, and candidates. De-duplicate equivalent event schedules while retaining the lexicographically stable section identity. Apply exclusions before requiring active component types, apply tutorial attendance exactly once, preserve exact active-lock meeting arrays, and return no candidates when an active required type cannot be filled.
    - Validate all active lock pairs before search, including locks within the same course and across courses. Retain the positive-overlap predicate `left.start < right.end && right.start < left.end`, so endpoint-touching meetings remain eligible. Never silently drop or replace a conflicting lock.
    - _Bug_Condition: `isBugCondition(input)` from the design, including the exact `computer-1-fall` lock/exclusion/objective state and any failure to preserve active locks, exclusions, or required components._
    - _Expected_Behavior: `expectedBehavior(input, result)` receives only a complete exact result and preserves both locked tutorials, omits all excluded APS110 tutorials, and retains all other required non-excluded components._
    - _Preservation: Requirements 3.2, 3.3, 3.4, and 3.8; existing normalization and renderer-compatible API behavior._
    - _Requirements: 2.2, 2.3, 2.4, 3.2, 3.3, 3.4, 3.8_

  - [x] 3.2 Make search exhaustive, deterministic, objective-correct, and proof-carrying in `web/optimizer.js`
    - Enumerate every finite feasible course-candidate combination exactly. Use the existing exact occupancy approach or an equivalent exact interval index/mask representation over all meeting endpoints; compatibility must remain equivalent to the positive-overlap rule without assuming whole-hour meetings.
    - Use deterministic most-constrained-first ordering (compatible-candidate count, conflict degree, then course code) and stable candidate signatures. Branch-and-bound may seed an incumbent and prune only with admissible lower bounds; it must not prune away an equal-cost stable tie that the comparator would select and must never expose an incumbent before all branches are exhausted.
    - Revalidate every leaf for one candidate per course, every active required component, all locks and selected attendance meetings, and global clash freedom. A missing candidate, unsatisfiable lock, or exhausted search must be a proven no-solution result, never a partial plan or a sampled failure.
    - Centralize canonical integer-millisecond evaluation: active days and positive internal campus gaps, the 11:00–13:00 lunch deficit/one-hour threshold, selected end-time sum, negative selected start-time sum, and stable signature tie-break. Keep `scorePlan` as the established display score and use `objectiveKey`/`comparePlans` for exact ordering. Validate objective combinations without weakening semantics.
    - Return the exact result contract for both outcomes: feasible `{ plan, status: "OPTIMAL", complete: true, optimal: true, evaluation, objective, score, signature, ... }`; exhaustive failure `{ plan: null, status: "NO_SOLUTION", complete: true, optimal: true, evaluation: null, objective: null, ... }`. Do not emit `deadline`, `timedOut`, `sampled`, `random`, `fallback`, or incomplete-progress metadata as a final result.
    - _Bug_Condition: `optimizerCrashes(input)`, `pageDoesNotReturnControl(input)`, an incomplete/unproven result, or a result whose objective is not the minimum over all feasible plans for the reported input._
    - _Expected_Behavior: after complete traversal, return the global minimum objective/tie result or a complete `NO_SOLUTION`; repeated calls with unchanged normalized plans/options return identical status, evaluation, objective, signature, and event set._
    - _Preservation: Requirements 3.4, 3.5, 3.6, 3.7, and the existing shared optimizer API._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 3.4, 3.5, 3.6, 3.7_

  - [ ] 3.3 Move browser execution off the main thread without changing the solver
    - Prefer a plain-browser-compatible `web/optimizer-worker.js` that imports the shared `optimizer.js`, accepts a monotonically identified request containing renderer-compatible plans and normalized options, invokes the same synchronous `findBestPlan`, and posts only a completed result or an explicit worker error. Do not duplicate candidate construction, objective code, or result validation in the worker.
    - Update `web/index.html` so `optimize()` builds plans and the canonical input key, marks a request generation as active, and submits work to the worker. Terminate/cancel or supersede old work when loaded data, locks, exclusions, tutorial attendance, or objective options change. Reject late responses by request generation and canonical key; cancellation is not `NO_SOLUTION` and must not render a partial or stale plan.
    - If repository/browser constraints make a worker unavailable, implement a cooperative exact fallback that shares the exact search state machine and yields between bounded node batches. It must have no elapsed-time cutoff, random sample, incomplete fallback, or unproven intermediate render. Keep the synchronous exported `findBestPlan` for Node and worker callers.
    - Keep status/control updates responsive while searching and ensure worker errors clear stale output and expose an error/retry state rather than inventing a result. Add focused harness coverage for request IDs, superseded responses, cancellation, worker errors, and the fallback path as applicable.
    - _Bug_Condition: synchronous exact/random search on the browser main thread blocks the reported Optimize interaction or allows stale/incomplete results to reach the page._
    - _Expected_Behavior: the page remains usable while complete search runs and renders only a validated complete `OPTIMAL` or complete `NO_SOLUTION` result._
    - _Preservation: Requirements 3.1, 3.6, 3.7 and the existing selected-plan/cache/UI flow._
    - _Requirements: 2.1, 2.3, 2.5, 2.6, 3.1, 3.6, 3.7_

  - [ ] 3.4 Enforce page result guards and input-safe cumulative state in `web/index.html`
    - Keep `selectedPlan()` and the existing `pick` shape as the page/solver boundary. Validate before rendering: `complete`, `optimal`, status, plan length/course coverage, clash freedom, exact active locks/attendance, required non-excluded components, plan signature, canonical evaluation, objective key, and score.
    - For complete `NO_SOLUTION`, clear `bestSoFar`, `bestSoFarResult`, `bestSoFarKey`, and the rendered timetable, then show the existing no-solution guidance. Never render a partial, conflicting, sampled, or stale plan.
    - Compute `bestSoFarKey` from canonical loaded course/section data, built active plans, all locks and selected meetings, all exclusions, tutorial attendance subsets, and all objective flags. Invalidate cumulative state on every plan-affecting control change and on new data load; do not reuse a result for a different key. Only a complete exact `OPTIMAL` result for the current key may initialize or improve the cumulative result, using the stable comparator for ties.
    - Preserve the established cache semantics (`manifest`, `data/${program}-${year}-${session}.json`, `_memCache`, `ttb:` localStorage), default tutorial attendance, selected subset behavior, exclusion behavior, dropdown/load flow, and existing rendering/status semantics outside the search-in-progress state.
    - _Bug_Condition: a prior crash/hang/incomplete search or an input change can leave no trustworthy result or allow an old `bestSoFar`/timetable to leak into the current input._
    - _Expected_Behavior: only a complete exact result for the current canonical input is rendered; unchanged repeats cannot regress, changed inputs cannot reuse old state, and complete no-solution clears the display._
    - _Preservation: Requirements 3.1, 3.2, 3.3, 3.6, and 3.7._
    - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.6, 3.7_

  - [x] 3.5 Extend focused browser/Node tests and static scope checks
    - In `tests/test_frontend_optimizer.js`, retain the exact reproduction and independent reference oracle; add/adjust assertions for minimum campus objective, exact locked meetings, omitted APS110 tutorials, all required components, result metadata, deterministic repeated signatures, and no legacy timeout/sample fields.
    - Add small generated domains for no options, each objective, and supported combinations; compare the shared result to an independent exhaustive oracle. Include same-course/cross-course lock conflicts, endpoint-touching intervals, duplicate schedules, active-type-with-no-candidate, tutorial attendance subsets, exclusions, no-solution clearing, and worker/direct-adapter result guards.
    - Exercise the page boundary for repeated Optimize, input changes while a request is pending, late worker responses, worker errors, stale-result rejection, bestSoFar invalidation, and render suppression. Test the cooperative fallback if it is implemented.
    - Exercise all 16 first-year datasets (eight program IDs × Fall/Winter), raw and built Computer/Track One equivalence, the `electrical` option, and distinct second-year Computer/Electrical ECE datasets through the shared optimizer. Use generated/cache data only as read-only fixtures; do not alter it.
    - Add a source-level regression assertion over the production search path that disallows random sampling, `Date.now` deadline termination, `solveBest`, sampled/partial fallback, or legacy timeout metadata. Keep this check focused so unrelated UI date/time code is not rejected.
    - _Bug_Condition: the reported reproduction or generated buggy-domain input can block, return an incomplete/unproven result, lose a required selection, or choose a worse feasible campus objective._
    - _Expected_Behavior: the independent oracle and page result predicate agree on a complete deterministic optimum or complete no-solution outcome._
    - _Preservation: Requirements 3.1–3.8 and the existing frontend test contract._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 3.6 Verify the bug-condition property after the fix
    - **Property 1: Expected Behavior** - Re-run the SAME exploration test from Task 1; do not write a replacement test.
    - Run the exact reported `computer-1-fall` lock/exclusion/campus input through the real page boundary and shared optimizer. The test must now return control, prove a complete result, match the independent exhaustive objective, retain both `TUT0106` locks and their selected meetings, omit every `APS110H1` tutorial, and contain every other required non-excluded component.
    - Run the unsatisfiable lock/active-type variants from the same test and require `plan: null`, `status: "NO_SOLUTION"`, `complete: true`, `optimal: true`, cleared timetable, and existing guidance. Repeat the unchanged feasible input and compare status, evaluation, objective, signature, and rendered events exactly.
    - **EXPECTED OUTCOME:** Property 1 passes after implementation and no result contains partial/sample/timeout metadata.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 3.7 Verify the preservation property after the fix
    - **Property 2: Preservation** - Re-run the SAME preservation tests from Task 2; do not write replacement tests that omit baseline cases.
    - Confirm cache/manifest paths and localStorage behavior, locks and tutorial attendance, component exclusions, endpoint-touching and positive-overlap clash semantics, all objective measurements/combinations, no-preference/no-solution behavior, repeated Optimize non-regression, bestSoFar invalidation, first-year coverage, Computer/Track One equivalence, Electrical selection, and distinct second-year ECE behavior.
    - **EXPECTED OUTCOME:** all preservation properties still pass, and no curriculum, scraper, manifest, or generated-data file was changed.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 4. Checkpoint - Run complete validation and review scope
  - **Dependency:** Tasks 3.1–3.7 must be complete; do not mark this checkpoint complete with only a direct `findBestPlan` unit test because the defect includes browser responsiveness and stale-result control flow.
  - Run the focused frontend suite: `node --test tests/test_frontend_optimizer.js`.
  - Run the full regression suite: `python -m unittest discover -s tests -v`.
  - Run syntax/static checks for changed JavaScript: `node --check web/optimizer.js` and, when present, `node --check web/optimizer-worker.js`; inspect the source regression check for forbidden random/deadline/sample paths. Use `git diff --check` for whitespace/errors.
  - Perform a manual browser smoke test through a developer-provided static server for `web/` (do not add or leave a long-running development server as part of automated execution): load `computer-1-fall.json` through the UI, apply the exact locks/exclusion/options, press Optimize, change an input while a search is pending, press Optimize repeatedly, and verify responsive controls, no stale rendering, deterministic completion, exact lock/exclusion display, and complete no-solution guidance.
  - Confirm the final diff is limited to the intended optimizer/control-flow/worker/test/spec-task artifacts. Curriculum extraction, scraping logic, cache JSON, generated data, and unrelated UI must remain untouched.
  - **Completion criteria:** the reported reproduction returns control and only a complete proof-carrying `OPTIMAL` or `NO_SOLUTION` result; campus optimality agrees with the independent exhaustive oracle; locks, exclusions, clashes, attendance, and required components are correct; repeated results are stable; worker/fallback cancellation rejects stale results; `bestSoFar` is input-safe; all preservation and full validation commands pass; and no forbidden scope files change.
  - _Requirements: 2.1–2.6, 3.1–3.8_
