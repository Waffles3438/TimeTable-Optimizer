# ece-fall-free-time-hang Bugfix Design

## Overview

The ECE/Computer first-year Fall optimizer currently uses a synchronous randomized sampler. For the reported `computer-1-fall` state—`APS100H1:TUT0106` locked, `APS111H1:TUT0106` locked, every `APS110H1` tutorial excluded, no other user locks, and only campus free-time minimization enabled—the sampler can spend long periods on the browser main thread and can still return only a sampled, non-proven plan. The page therefore has no reliable distinction between an optimal timetable, a failed sample, and a genuinely unsatisfiable input.

The fix will replace the legacy `solve`/`solveBest` path with one deterministic complete search in the shared browser/Node optimizer. Candidate construction will preserve every active lock, attendance subset, required non-excluded component, and clash rule. Branch-and-bound will be used only with admissible bounds; it will never terminate the search early or display an incumbent as a final result. The browser will execute that complete search off the main UI thread (with an exact cooperative fallback where workers are unavailable), and will render only a proof-carrying `OPTIMAL` result or a proof-carrying `NO_SOLUTION` result.

The pure `findBestPlan(plans, options)` API and renderer-compatible plan shape remain the stable seam for Node tests and the worker. Cache loading, curriculum data, scraping, generated JSON, and unrelated rendering remain outside the fix.

## Glossary

- **Bug_Condition (C)**: The reported Computer/ECE first-year Fall input reaches the old randomized optimizer and it crashes, blocks the page, fails to return a complete result, or returns a result that is not globally optimal.
- **Property (P)**: For every input satisfying `C`, a completed search returns a clash-free, complete, deterministic `OPTIMAL` plan with the minimum objective, or a complete `NO_SOLUTION` result when no feasible plan exists.
- **Preservation**: For every input outside `C`, existing cache, UI, lock, attendance, exclusion, clash, objective, curriculum, and cumulative-result behavior remains unchanged.
- **Plan**: One renderer-compatible candidate per loaded course, with `pick` containing its locked sections and one option for every active required component type.
- **Candidate**: One course-level choice consisting of the active locks plus one internally clash-free component combination.
- **Active lock**: A user-selected lecture, practical, or tutorial section and its selected meetings. A multi-meeting tutorial lock may contain only the meetings selected by `tutAttend`.
- **Exclusion**: A `uselessLec`, `uselessPra`, or `uselessTut` state that removes only the requested component from a course.
- **Objective key**: The comparison representation produced from the canonical integer evaluation. When lunch is enabled, lunch deficit is the first comparison tier; campus, end-early, and start-late terms retain their established measurements, followed by a stable signature tie-break.
- **Complete result**: A result with `complete: true` and `optimal: true`. A successful result has `status: "OPTIMAL"`; an exhaustive failure has `status: "NO_SOLUTION"` and `plan: null`.
- **`bestSoFar`**: The page’s cumulative result. It may contain only a complete, optimal, clash-free result associated with the exact canonical input key that produced it.

## Bug Details

### Bug Condition

The reproduction selects the `computer` cache ID (the existing ECE first-year cache), year `1`, and Fall, locks exactly `APS100H1` tutorial `TUT0106` and `APS111H1` tutorial `TUT0106`, marks the `APS110H1` tutorial component not worth attending, leaves all other section controls unlocked, and enables only the campus objective. The old page handler calls a synchronous randomized search on the UI thread. A search that does not find a plan or does not find a good sample is not distinguishable from a valid global result.

**Formal Specification:**

```text
FUNCTION isBugCondition(input)
  INPUT: input containing cache selection, active locks, exclusions,
         tutorial attendance, and objective flags
  OUTPUT: boolean

  target := input.program = "computer"
            AND input.year = "1"
            AND input.session = "fall"
            AND activeLock(input, "APS100H1", "TUT0106")
            AND activeLock(input, "APS111H1", "TUT0106")
            AND tutorialsExcluded(input, "APS110H1")
            AND noOtherUserSelectedLocks(input)
            AND input.options = { campus: true, lunch: false,
                                  early: false, late: false }

  failure := optimizerThrows(input)
            OR pageDoesNotReturnControl(input)
            OR resultIsMissingOrIncomplete(input)
            OR resultIsNotClashFreeOptimalOrCompleteNoSolution(input)

  RETURN target AND failure
END FUNCTION
```

### Expected Result Predicate

The page-facing result must be checked after the worker or direct API returns, not while an incumbent is still being searched.

```text
FUNCTION expectedBehavior(input, result)
  INPUT: input and the result made available to the page
  OUTPUT: boolean

  IF result.complete != true OR result.optimal != true THEN
    RETURN false
  END IF

  IF noFeasiblePlan(input) THEN
    RETURN result.plan = null
           AND result.status = "NO_SOLUTION"
           AND result.evaluation = null
           AND result.objective = null
  END IF

  RETURN result.status = "OPTIMAL"
         AND result.plan != null
         AND isClashFree(result.plan)
         AND containsExactActiveLocks(result.plan, input)
         AND containsEveryRequiredNonExcludedComponent(result.plan, input)
         AND objectiveKey(result.plan, input.options)
             = minimumObjectiveKeyOverAllFeasiblePlans(input)
END FUNCTION
```

### Examples

1. **Reported reproduction:** The old handler repeatedly shuffles the three-course slice and the remaining full first-year course choices on the main thread. It can consume the nominal search window without yielding to the browser, or return a feasible sample without proving that no lower-campus alternative exists. The fixed path must return control through the worker, retain both locked tutorials, omit all `APS110H1` tutorials, and return a complete minimum-campus result.
2. **Concrete objective miss:** The reduced `APS100H1`/`APS110H1`/`APS111H1` fixture has multiple feasible alternatives. A fixed random seed in the legacy two-choice shuffle selects the worse alternative, while an independent exhaustive reference selects the lower campus penalty. The fixed search must visit or safely prove every feasible candidate and choose the same objective minimum on repeated runs.
3. **Locked conflict:** If two active sections from one course, such as `MAT188H1` practical `PRA0106` and tutorial `TUT0115`, overlap, the old per-course placement loop can add both because it checks each lock against previously chosen courses but not against the other locks in the same course. The fixed builder must reject the input before search and return complete `NO_SOLUTION`; endpoint-touching locks remain valid.
4. **Unsatisfiable active type:** If an active non-excluded component has no viable section or every candidate clashes with a lock, the builder must not silently drop that component. The complete search must return `plan: null`, `status: "NO_SOLUTION"`, and `complete: true`, never a partial timetable.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Program/year/semester availability continues to come from the manifest, while data continues to load from `data/${program}-${year}-${session}.json`, use `_memCache`, and use the `ttb:` localStorage cache key. Loading a new cache still clears the prior optimizer state and rendered timetable.
- A selected lecture, practical, or tutorial lock remains the exact selected section. A selected multi-meeting tutorial retains exactly the selected meeting subset until the user changes attendance. The deterministic search may not replace an active lock with a tied alternative.
- Marking a lecture, practical, or tutorial not worth attending removes only that component according to the current controls. In the reproduction, excluding `APS110H1` tutorials must not remove its lecture or affect the two locked tutorial components.
- Clash detection continues to reject positive-duration intersections within a course and across courses. Intervals that meet at an endpoint remain eligible. Lock diagnostics must cover both intra-course and cross-course pairs.
- Campus, lunch, end-early, and start-late objectives retain their existing measurements: active-day cost plus positive internal gaps; the 11:00–13:00 lunch window with its one-hour free-time threshold; the sum of selected class end times; and the negative sum of selected class start times. Combined options must not be weakened to make the search finish.
- With no objective enabled, the result remains a valid clash-free arrangement with zero configured penalty. A supported unsatisfiable input continues to show the existing no-solution guidance and no timetable.
- Repeated Optimize actions on unchanged inputs cannot regress the stored objective or stable tie choice. Changing locks, exclusions, tutorial attendance, loaded data, or any objective option invalidates the old cumulative result; a result for one input may never be reused for another.
- All eight first-year program IDs remain available for Fall and Winter. Computer/ECE and Track One first-year data continue to have equivalent optimizer behavior, while the `electrical` option and second-year Computer/Electrical ECE course sets remain distinct. Curriculum extraction, scraping, generated cache data, and unrelated UI behavior are not changed.
- The existing shared optimizer API—normalization, grouping, course-plan construction, clash validation, evaluation, scoring, comparison, and `findBestPlan(plans, options)`—continues to accept the established input shapes and produce renderer-compatible plans. The browser worker calls this same API rather than maintaining a second solver.

**Scope:**

All inputs that do not satisfy the reported bug condition must remain unaffected. In particular, a mouse/control interaction, a different program/year/semester, a different lock or attendance state, a different exclusion, another supported objective combination, and a no-preference search must not be changed merely to avoid the reported search cost. A worker cancellation caused by a user changing the input is not a search result and must never be interpreted as `NO_SOLUTION` or rendered as a partial plan.

## Hypothesized Root Cause

The most likely failure is in the old browser search/control flow, not in the manifest or `computer-1-fall.json` cache:

1. **Randomized one-pass search cannot prove an optimum.** The baseline defines `shuffle(a)` as `a.sort(() => Math.random() - 0.5)`, then randomizes course order and component combinations in `solve`. `solveBest(plans, 900, opts)` repeats independent one-pass attempts and keeps the lowest sampled score. The non-transitive sort comparator also mutates the arrays it receives, so traversal is neither reproducible nor a reliable enumeration of the finite search space.
2. **The deadline is a blocking loop, not responsiveness control.** `solveBest` checks `Date.now()` only in its outer sampling loop. Each iteration can execute up to 500 complete `solve(plans, 1)` attempts, and each attempt can scan a large set of lecture combinations. The click handler performs this work synchronously on the browser main thread; the nine-second deadline does not yield to painting or input events and can be exceeded substantially by the inner loop. This explains the unresponsive-page symptom even when no JavaScript exception is visible.
3. **Failure to sample is not proof of no solution.** Returning `null` after random attempts, or returning the best sampled plan after the deadline, conflates “not found within the sample” with “no feasible plan” and “globally optimal.” The old result shape carries no completion or optimality proof, so the UI can render an unproven result.
4. **Lock validation is incomplete.** The old placement loop checks a course’s locks against meetings already placed for other courses but does not compare all locks within the same course before adding them. This allows an overlapping same-course lock pair to reach rendering and is a separate path to an invalid or apparently broken timetable.
5. **Cumulative identity is incomplete.** The old `bestSoFar` identity is based on a subset of lock and option values. Loaded section data, component exclusions, and tutorial attendance can change the feasible domain without invalidating the remembered plan. A sampled result can therefore survive an input change or be compared with a result from a different search domain.
6. **Objective calculation and search selection are not proof-carrying.** The sampler scores whatever plan it happens to find, rather than sharing a canonical evaluation/objective key with an exhaustive comparator. That makes it impossible to establish the minimum for campus free time or to guarantee the established lunch and combined-preference semantics.

## Correctness Properties

Property 1: Bug Condition - Complete deterministic optimization for the locked Fall reproduction

_For any_ input where the bug condition holds (`isBugCondition(input)` returns true), the fixed optimizer and browser control flow SHALL return control without throwing or blocking the page, and SHALL make available only a complete deterministic result: either a clash-free `OPTIMAL` plan containing both exact active tutorial locks, all required non-excluded components, and the minimum objective over every feasible plan, or a complete `NO_SOLUTION` result with `plan: null` when no feasible plan exists. Repeating the same unchanged input SHALL preserve the completion/feasibility status, objective key, and stable tie choice.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

Property 2: Preservation - Existing optimizer, UI, cache, and curriculum behavior

_For any_ input where the bug condition does NOT hold (`isBugCondition(input)` returns false), the fixed code SHALL produce the same established behavior as the original code, preserving cache and manifest loading, lock and tutorial-attendance semantics, component exclusions, endpoint-touching clash rules, all supported objective measurements, complete no-solution handling, `bestSoFar` invalidation and non-regression, first-year program coverage, Computer/Track One equivalence, distinct second-year ECE tracks, and the existing shared optimizer API.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## Fix Implementation

### Changes Required

Assuming the root-cause analysis is correct, implement the following changes without changing curriculum, scraper, or generated cache files.

1. **Replace the legacy sampler with a shared exact engine — `web/optimizer.js`.**
   - Keep `groupCourses`, `buildCoursePlans`, `isClashFree`, `evaluatePlan`, `scorePlan`, `objectiveKey`, `comparePlans`, and `findBestPlan` as the browser/Node API. Remove the production dependency on `shuffle`, `solve`, `solveBest`, `Math.random`, `Date.now`, fixed iteration counts, elapsed-time cutoffs, and random fallbacks.
   - Normalize and sort meetings, sections, component types, options, courses, and candidates by stable signatures. De-duplicate equivalent sections and equivalent event schedules without losing the lexicographically stable section identity.
   - Build one finite candidate set per course from active locks plus exactly one option for each active required component type. Apply exclusions before requiring a type; apply tutorial attendance exactly once; preserve explicit lock meeting arrays; return zero candidates when an active required type cannot be filled.
   - Validate every active-lock pair before enumeration, including same-course pairs and cross-course pairs. Use the positive-overlap predicate `left.start < right.end && right.start < left.end`, so endpoint-touching sections remain feasible.

2. **Search every feasible combination exactly.**
   - Convert all finite meeting endpoints into per-day elementary segments and represent candidate occupancy with exact masks (or an equivalent exact interval index). This makes candidate compatibility equivalent to the existing clash predicate without assuming whole-hour meetings.
   - Use deterministic most-constrained-first ordering: current compatible-candidate count, conflict degree, then course code. Visit candidate options in stable signature order. A deterministic greedy incumbent may seed a bound, but it is never returned as proof and the full backtracking traversal still runs.
   - Use only admissible branch-and-bound bounds. Lower bounds may account for the minimum possible active days, optimistically fillable campus gaps, current lunch deficit, minimum remaining end-time sum, and maximum remaining start-time sum. A branch may be pruned only when it cannot beat the incumbent under the complete objective key; the stable tie rule must not be lost by an unsafe equal-cost prune.
   - At each leaf, revalidate one candidate per course, all required component types, all active locks and selected meetings, and global clash freedom. After all branches are exhausted, return the best objective/tie result or a proven no-solution result. Do not expose an incumbent, partial branch, sample count, or timeout as the final plan.

3. **Centralize objective semantics and result contracts — `web/optimizer.js`.**
   - Evaluate a plan once using integer millisecond quantities: union occupied blocks for daily gaps and lunch, active-day count, positive internal gaps, the 11:00–13:00 lunch deficit, and raw start/end sums. Endpoint-touching blocks do not add a gap.
   - Keep `scorePlan` as the existing normalized display score. Use `objectiveKey`/`comparePlans` for exact search ordering with the established lunch priority, campus/early/late terms, and stable plan-signature tie-break. The result must include `evaluation`, `objective`, `score`, and `signature` consistent with the exported helpers.
   - Return `{plan, status, complete, optimal, ...}` for both outcomes. Feasible output is `status: "OPTIMAL"`, `complete: true`, `optimal: true`; exhaustive failure is `plan: null`, `status: "NO_SOLUTION"`, `complete: true`, `optimal: true`. Do not emit legacy `deadline`, `timedOut`, `sampled`, `random`, `fallback`, or `iterations` metadata.

4. **Move browser search off the UI thread — add `web/optimizer-worker.js` and update `web/index.html`.**
   - The worker imports the shared optimizer and accepts a request ID, the already-built renderer-compatible plans, and normalized options. It invokes the same synchronous `findBestPlan` API and posts only a completed result or an explicit worker error; it never posts a partial plan. Internal exact-search state, including masks, remains in the worker.
   - `optimize()` builds the current plans and canonical input key, marks the search as in progress, and submits a worker request. A monotonically increasing request generation and the canonical key reject late responses from a canceled or superseded input. Changing the loaded dataset, lock, exclusion, tutorial attendance, or objective invalidates/terminates the old request; cancellation is not converted into `NO_SOLUTION`.
   - Render only after validating `complete`, `optimal`, `status`, plan length, clash freedom, signature, evaluation, objective, and score. A complete `NO_SOLUTION` clears both `bestSoFar` and the timetable and shows the existing guidance. Worker errors clear stale output and show an error/retry state rather than inventing a result.
   - Keep the controls, cache flow, and status updates responsive while the worker searches. If a worker is unavailable, use a cooperative exact driver that yields between bounded node batches; it must share the same exhaustive state machine and has no elapsed-time cutoff or sampled fallback. The synchronous exported `findBestPlan` remains available for Node and worker callers.

5. **Make cumulative state proof- and input-safe — `web/index.html`.**
   - Keep `bestSoFar`, `bestSoFarResult`, and `bestSoFarKey`, but compute the key from canonical loaded course/section data, built active plans, locks and selected meetings, all exclusions, tutorial attendance subsets, and all objective flags.
   - Clear cumulative state on load and every plan-affecting control change. Only a complete exact `OPTIMAL` result for the current key may initialize or improve `bestSoFar`; compare equal objective results with the stable tie comparator. A complete `NO_SOLUTION` result always clears the displayed timetable, including a previous result for the same key.
   - Preserve the existing `selectedPlan()` boundary and renderer-compatible `pick` shape so the page does not need a second candidate or scoring implementation.

6. **Extend browser/Node tests without changing production data.**
   - Retain the independent reference enumerator as the oracle for small domains. Add the reported locked/excluded fixture, worker/result-guard coverage, and API contract assertions to the existing frontend test suite. Keep Python catalog/data tests as regression checks rather than using them as a substitute for browser execution.

## Testing Strategy

### Validation Approach

The testing strategy has three stages: capture counterexamples on the unfixed baseline, verify the exact fix against independent oracles and the page result contract, and run preservation tests across UI state, objective combinations, generated inputs, and every supported cache family. Tests must prove completion; a test that merely observes a plan is insufficient.

### Exploratory Bug Condition Checking

**Goal:** Demonstrate the old failure and confirm the root cause before implementation.

**Test Plan:** Run the baseline inline solver with a fixed random sequence and the exact reproduction slice, then compare it with an independent finite reference. Instrument the click-handler path to record whether control returns before the page can process another event. Do not interpret the baseline failure as a test defect.

**Test Cases:**

1. **Computer/ECE Fall campus reproduction:** Load `computer-1-fall.json`, apply the two `TUT0106` locks and `APS110H1` tutorial exclusion, and compare the sampled result with the exhaustive minimum. The captured seed should either select a worse campus plan or fail to produce a result.
2. **Main-thread blocking check:** Run the same search with the full first-year course set and verify that repeated synchronous attempts prevent a scheduled UI/input callback from running during the search window or continue past the nominal deadline through the inner retry loop.
3. **Objective sampling misses:** Use two-choice fixtures for lunch, end-early, and start-late. Place the better choice second under the legacy shuffle and verify that the sampled solver returns the worse choice.
4. **Lock conflict counterexample:** Apply overlapping same-course practical/tutorial locks and verify that the old solver can pass them to rendering instead of returning an explicit no-solution result.

**Expected Counterexamples:**

- A feasible lower-campus alternative is not selected reliably.
- The page remains blocked while the synchronous sampler repeats full searches.
- A random result has no `complete`/`optimal` proof and a failed sample has no trustworthy `NO_SOLUTION` proof.
- An overlapping same-course lock pair can reach the renderer.

### Fix Checking

**Goal:** Verify Property 1 for every buggy input represented by the reproduction and generated small domains.

**Pseudocode:**

```text
FOR ALL input WHERE isBugCondition(input) DO
  start a search without blocking the UI
  result := await completedSearch(input)
  ASSERT expectedBehavior(input, result)
  repeat with the unchanged input
  ASSERT sameStatus(result, repeatedResult)
  ASSERT sameObjectiveKey(result, repeatedResult)
  ASSERT sameStableTie(result, repeatedResult)
END FOR
```

**Concrete checks:**

- On the reported cache/lock/exclusion state, assert `complete === true`, `optimal === true`, `status === "OPTIMAL"` when feasible, clash freedom, exact locked meetings, no `APS110H1` tutorial, and equality with an independent exhaustive objective oracle.
- For an unsatisfiable lock state, assert `plan === null`, `status === "NO_SOLUTION"`, `complete === true`, `optimal === true`, empty rendered timetable, and the existing no-solution guidance.
- Assert the result contains no timeout, sample, random, or partial-result metadata and that the page never renders a worker progress/incumbent message as a timetable.
- Invoke `findBestPlan` twice with the same normalized plans and options and compare status, evaluation, objective, signature, and rendered event set bit-for-bit.

### Preservation Checking

**Goal:** Verify Property 2 for all non-buggy inputs and ensure the worker boundary does not alter the established API or page behavior.

**Pseudocode:**

```text
FOR ALL input WHERE NOT isBugCondition(input) DO
  originalObservation := observeEstablishedBehavior(input)
  fixedObservation := observeFixedBehavior(input)
  ASSERT preservedCacheAndUiContract(originalObservation, fixedObservation)
  ASSERT preservedLocksAttendanceAndExclusions(originalObservation, fixedObservation)
  ASSERT preservedObjectiveAndClashSemantics(originalObservation, fixedObservation)
  ASSERT preservedProgramAndCumulativeState(originalObservation, fixedObservation)
END FOR
```

**Test Plan:** Use the existing deterministic fixtures and generated preservation domains, then exercise the real page boundary for cache loading, result rendering, repeated Optimize presses, changed-input invalidation, and complete no-solution handling. Compare invariants rather than requiring a particular tied section identity unless the stable signature contract is under test.

**Preservation Cases:**

1. Manifest-backed cache path, in-memory/localStorage cache, all eight first-year program IDs, both semesters, and the existing Electrical selector remain intact.
2. Active lecture/PRA/TUT locks and selected multi-meeting tutorial attendance remain exact; excluded components are omitted without dropping other required types.
3. Valid endpoint-touching schedules remain feasible; positive overlaps remain rejected, including intra-course and cross-course locked conflicts.
4. No-preference, campus, lunch, end-early, start-late, and combined objective cases retain their established measurements and deterministic ties.
5. Repeated Optimize cannot regress; changed data, locks, exclusions, attendance, or options cannot reuse a stale `bestSoFar` or timetable.
6. Computer and Track One first-year results remain equivalent, while second-year Computer and Electrical ECE retain distinct course sets.

### Unit Tests

- Test meeting normalization, de-duplication, stable signatures, endpoint-touching overlap, and renderer-compatible plan normalization.
- Test course candidate construction for every component type, active locks, selected tutorial meeting subsets, exclusions, duplicate sections, and active-type-with-no-candidate behavior.
- Test lock diagnostics for same-course and cross-course conflicts and verify conflicts are rejected before search.
- Test canonical evaluation, lunch union and one-hour threshold, campus gaps, end/start sums, objective comparison, stable ties, and zero configured penalty.
- Test `findBestPlan` result shapes for `OPTIMAL` and `NO_SOLUTION`, final invariants, no legacy sampler/deadline metadata, and the unchanged exported API.
- Test worker request/response generation guards, error handling, cancellation on changed input, and the rule that only completed results reach `renderPlan`.

### Property-Based Tests

- Generate finite course/section domains and compare `findBestPlan` with an independent exhaustive oracle for no options, each individual objective, and supported combinations. Assert optimality, clash freedom, required components, exact locks, complete status, and deterministic repeated signatures.
- Generate random same-course lock pairs with both positive overlap and endpoint touching; assert the former is complete `NO_SOLUTION` and the latter remains feasible.
- Generate random exclusions and tutorial attendance subsets; assert only the requested component/meetings change and all other required components remain.
- Generate mutations of loaded data, locks, exclusions, attendance, and objective flags; assert each mutation changes the canonical `bestSoFar` key and an unchanged input does not.
- Run static/source checks that the production search path contains no `Math.random`, `Date.now` deadline, `solveBest`, sampled fallback, or timeout result metadata.

### Integration Tests

- Run the exact reported `computer-1-fall` flow through course grouping, `selectedPlan()`, the worker/direct search adapter, `bestSoFar`, and `renderPlan`; verify the complete minimum result and both locked tutorials.
- Run a complete no-solution flow through the page and verify the prior timetable is cleared and existing guidance is shown.
- Exercise repeated Optimize clicks and input changes while a worker request is pending; late responses must not overwrite the current input or render a stale plan.
- Validate manifest/cache behavior and all 16 first-year datasets (eight programs × Fall/Winter), including Computer/Track One raw and built equivalence.
- Validate second-year Computer and Electrical Fall/Winter datasets retain their distinct ECE course behavior and still complete through the shared optimizer.
- Run the established validation commands after implementation: `node --test tests/test_frontend_optimizer.js` and `python -m unittest discover -s tests -v`.
