# First-Year Optimizer Validation Bugfix Design

## Overview

The first-year cache expansion is present in `web/data/`, and the existing selector/manifest path can load ECE/Computer, Mechanical, Industrial, Chemical, Materials, Civil, Mineral, and Track One for Fall and Winter. The remaining defect is in the browser-side optimizer: `web/index.html` currently constructs feasible per-course combinations, then `solveBest` repeatedly randomizes course and combination order for at most 900 samples or nine seconds. It can therefore render a feasible plan that is not the best plan under the enabled preferences. The locked-section placement loop also checks each course's locked sections against previously placed courses, but does not reject two active locked sections from the same course when their meeting intervals overlap.

The fix will keep the current data loading, cache, controls, attendance, rendering, and no-solution contracts, while moving the pure scheduling engine into a browser/Node-shared module. The engine will validate active locks before searching, enumerate the finite feasible search space deterministically, and use conflict pruning plus only admissible lower bounds. It will never use elapsed time or a random fallback to decide which result to display. A returned result will be marked complete/optimal only after every non-pruned feasible branch has been considered; an unsatisfiable lock set will return the existing no-solution path.

This phase creates only this design document. It does not modify `web/index.html`, data files, Python implementation files, or tests. The existing `.config.kiro` for this feature is retained with `workflowType` `requirements-first` and `specType` `bugfix`.

## Glossary

- **Bug_Condition (C)**: An input to the optimizer for which the current randomized implementation can miss a better feasible preference score, or for which active locked sections from the same course overlap and are nevertheless accepted.
- **Property (P)**: The required behavior of the fixed optimizer: return a clash-free feasible plan with the minimum configured objective, or return the existing no-solution result when the active locks make the problem unsatisfiable.
- **Preservation**: Keeping all behavior outside the bug condition unchanged, including cache selection, UI controls, attendance exclusions, locked meeting selection, rendering, and existing second-year ECE behavior.
- **F**: The current/unfixed browser behavior in `web/index.html`, especially `selectedPlan`, `solve`, `scorePlan`, and `solveBest`.
- **F'**: The fixed browser behavior after the exact search, lock validation, and scoring changes described here.
- **Feasible plan**: One complete choice for every course's active components that has no overlapping meeting intervals anywhere in the week and includes every active locked meeting.
- **Active lock**: A user-selected PRA/TUT section and its selected meetings after the existing `not worth attending` filters are applied. A lock on an excluded component is not an attendance requirement and must not create a new conflict.
- **Candidate**: One internally clash-free choice for a course's remaining component types, including the lecture meeting combination produced by `buildLecOptions` and the selected option for each active PRA/TUT component.
- **Objective evaluation**: The canonical measurements of a plan: active-day count, inter-class gaps, lunch deficit, sum of class end times, and sum of class start times. `scorePlan` and the exact-search comparator must consume the same evaluation.
- **`selectedPlan`**: The DOM-facing function that reads the current locks, exclusions, and tutorial attendance selections and builds per-course plan inputs.
- **`scorePlan`**: The current user-preference scoring function. Its campus, lunch, end-early, and start-late measurements are retained and made pure/testable.
- **Track One/ECE equivalence**: For a given semester, `trackone-1-{semester}.json` and `computer-1-{semester}.json` must have equivalent optimizer inputs and produce equivalent feasibility, clash, objective, and deterministic tie behavior; `computer` remains the ECE cache ID.

## Bug Details

### Bug Condition

The defect has two related forms. First, a feasible input may have a returned plan whose enabled-preference objective is worse than another feasible plan because the search stops after a random, time-bounded sample. Second, two active locks belonging to one course may overlap because the current lock loop checks them against earlier courses but not against the other locks in the same course.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input containing courses, active locks, attendance exclusions, and options
  OUTPUT: boolean

  lockedClash := EXISTS course c and distinct active locks l1, l2 in c
                 WHERE EXISTS meeting a in l1 and meeting b in l2
                 SUCH THAT overlaps(a, b)

  feasible := EXISTS plan p satisfying all active attendance requirements
              AND no meeting pair in p overlaps

  objectiveMiss := feasible
                  AND input.returnedPlan is not null
                  AND objectiveKey(input.returnedPlan, input.options)
                      is worse than
                      objectiveKey(p, input.options) for some feasible p

  RETURN lockedClash OR objectiveMiss
END FUNCTION
```

The objective comparison is the configured comparison, not a random sample comparison. For campus-only input it is the minimum campus penalty. For early-only and late-only input it is respectively the minimum end-time total and maximum start-time total. For combined input it uses the documented combined penalty, with lunch satisfaction handled as the explicit lunch tier described below.

### Examples

- **Confirmed ECE/Computer Fall reproduction**: Load `computer-1-fall.json`, lock `APS100H1 TUT0106` and `APS111H1 TUT0106`, mark all `APS110H1` tutorials not worth attending, leave other user-selectable sections unlocked, and enable only “Minimize free time on campus.” The current implementation can label a plan optimized even though an alternative feasible plan has fewer inter-class gaps or fewer active days. F' must prove that its returned campus objective is no greater than every feasible alternative.
- **Lunch objective**: Two otherwise equivalent alternatives can leave one free hour in the 11:00–13:00 window versus occupying the whole window. With lunch enabled, the full-hour alternative must win whenever it is feasible; if no alternative has a full hour, the smallest lunch deficit must be selected before the remaining enabled preferences are compared.
- **End-early objective**: If one feasible alternative has class end-time total 10:00 + 12:00 and another has 10:00 + 14:00, enabling “End early” must select the first alternative when the other enabled objective terms tie.
- **Start-late objective**: If one feasible alternative starts at 08:00 and another at 10:00 with the same other terms, enabling “Start late” must select the 10:00 alternative. The implementation compares the sum of all class starts, matching the existing scoring definition rather than only the single latest class.
- **Campus-gap objective**: A day containing 09:00–10:00 and 14:00–15:00 has a four-hour intervening gap, while 09:00–10:00 and 10:00–11:00 has no gap. With campus minimization enabled and other terms tied, the compact alternative must win.
- **Intra-course locked clash**: In the Fall MAT188H1 data, `PRA0106` and `TUT0115` both occupy Monday 10:00–11:00. If both are selected as active locks, F' must reject the input, clear any displayed result, and use the existing no-solution guidance. It must not render both sections and call the timetable clash-free. The pairwise check must treat touching intervals such as 10:00–11:00 and 11:00–12:00 as non-overlapping, consistent with `overlaps`.
- **Dataset coverage gap**: The current Python tests prove that the 16 first-year files exist and have valid shapes, but they do not execute the browser plan construction, lock validation, scoring, or search. A program-specific optimizer failure can therefore pass the current test suite.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- The selector continues to load `data/${program}-${year}-${session}.json`, uses the manifest only for availability, and keeps the existing in-memory/localStorage cache keys and fallback behavior.
- `computer` remains the ECE/Computer cache ID, `trackone` remains a first-year shared ECE/Computer curriculum, and the existing `electrical` option and distinct second-year ECE Electrical cache remain available.
- A selected lecture/PRA/TUT lock remains fixed. A selected subset of meetings for a multi-meeting tutorial remains the exact subset attended until the user changes it.
- `not worth attending` continues to omit only the corresponding lecture, practical, or tutorial component according to the current controls. The exact solver must not silently replace an active component with an excluded component.
- A valid timetable continues to include every non-excluded required component, show the same section choices in the existing renderer, and retain the current status/timetable rendering path.
- An unsatisfiable cross-course or intra-course lock set, or a set of remaining components with no feasible completion, continues to clear the result and show the existing no-solution guidance rather than dropping required sections or rendering a conflict.
- With no preference enabled, the optimizer continues to return any valid clash-free timetable without an unintended preference penalty. The deterministic tie choice may replace random section selection, but it must retain all attendance and lock invariants.
- Repeated Optimize presses with unchanged loaded data, locks, exclusions, tutorial attendance, and options never regress to a worse objective. The cumulative `bestSoFar` behavior may remain, but it must be keyed to all inputs that affect the plan and may only retain an equal-or-better completed result.

**Scope:**

Inputs outside the bug condition must be unaffected in observable behavior. This includes:

- Mouse and checkbox interactions, program/year/semester dropdown behavior, Load behavior, manifest availability messaging, localStorage/in-memory cache behavior, and timetable rendering.
- Second-year ECE Computer (`computer-2-*`) and Electrical (`electrical-2-*`) course/section selection and optimizer attendance semantics.
- Non-number/UI inputs are not relevant to this bug; no new keyboard or unrelated interaction behavior is introduced.

The correct behavior for a buggy input is defined by the following predicate. It is kept as a pure specification so the browser engine and the test oracle can assert the same contract without depending on DOM text:

```
FUNCTION expectedBehavior(input, result)
  INPUT: input and a fixed-search result
  OUTPUT: boolean

  IF hasActiveIntraCourseLockedClash(input) THEN
    RETURN result.plan == null
           AND result.status == "NO_SOLUTION"
           AND result.complete == true
  END IF

  IF NOT hasFeasiblePlan(input) THEN
    RETURN result.plan == null
           AND result.status == "NO_SOLUTION"
           AND result.complete == true
  END IF

  RETURN result.plan != null
         AND result.complete == true
         AND isClashFree(result.plan)
         AND containsAllActiveLockedMeetings(result.plan, input)
         AND containsAllNonExcludedComponents(result.plan, input)
         AND objectiveKey(result.plan, input.options)
             == minimumObjectiveKeyOverAllFeasiblePlans(input)
END FUNCTION
```

### Objective and Tie Contract

The existing score measurements remain the source of truth:

- **Campus**: one unit for each active day plus the positive gaps between consecutive classes on that day.
- **Lunch**: for each active day, measure free time in 11:00–13:00; the deficit is zero when at least one hour is free and otherwise is the missing amount below one hour.
- **Early**: the sum of every selected class end time in hours; lower is better.
- **Late**: the negative sum of every selected class start time in hours; lower is better, which means later starts are preferred.

`scorePlan` must calculate these values once in a pure evaluation object. To avoid floating-point ordering differences, comparisons should use a common integer time unit (milliseconds or minutes) while preserving the current relative weights. The user-facing penalty may continue to display the normalized hours-equivalent value.

When lunch is enabled, `objectiveKey` compares the total lunch deficit first. This makes the explicit requirement “provide at least one free hour whenever one exists” true even when campus/early/late terms would otherwise trade against it. Among plans with the same lunch tier/deficit, the existing enabled campus, early, and late terms are combined with their current unit weights. When lunch is disabled, only the enabled non-lunch terms participate. Exact ties are allowed; deterministic candidate ordering supplies a stable tie result but no correctness requirement depends on which tied plan is chosen.

## Hypothesized Root Cause

1. **Random sampling is not an optimizer**: `solveBest` calls `solve(plans, 1)` repeatedly with `shuffle` applied to course order and candidate order. It stops after a fixed number of samples or a nine-second deadline, so it has no proof that an unvisited feasible branch cannot improve the displayed score.

2. **The search has no deterministic tie/order contract**: `Math.random()` affects both which courses are placed first and which per-course combinations are tried first. Two identical Optimize presses can inspect different regions of the finite space, and the current cumulative result only prevents regression after a sample has been found; it cannot recover a missed optimum.

3. **The score and the search are not separated**: `scorePlan` calculates campus, lunch, early, and late values inside the page, but no exact comparator or admissible lower bound uses those same terms. As a result, the current timeout can miss lunch, end-early, or start-late candidates even when the arithmetic for an examined candidate is correct.

4. **Locked sections are validated at the wrong scope**: In `solve`, each locked section is checked against `chosen`, which contains earlier courses, and the remaining candidate is checked against `lockedMs`. The locked sections of the current course are not compared with each other before being appended, so two active locks such as MAT188H1 `PRA0106` and `TUT0115` can pass through together.

5. **The inline implementation is difficult to execute as a unit under test**: The pure plan construction/search/scoring functions are embedded in a DOM-heavy `index.html`, while current tests are Python static/data checks. This prevents the test suite from invoking the exact browser algorithm over all first-year files.

## Correctness Properties

Property 1: Bug Condition - Exact Preference Optimum and Locked-Conflict Rejection

_For any_ input where the bug condition holds (the current result is worse than a feasible alternative or active locks from one course overlap), F' SHALL either return a complete, clash-free plan whose `objectiveKey` is minimal over every feasible plan with the same data, locks, exclusions, attendance, and options, or return a complete no-solution result with no rendered plan when the active locks are unsatisfiable.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6**

Property 2: Preservation - Existing Loading, Attendance, and UI Semantics

_For any_ input where the bug condition does NOT hold (and for every non-target interaction in the supported domain), F' SHALL preserve the observable F behavior: the same program/year/semester cache is loaded, active locked and attended meetings remain fixed, excluded components remain omitted, valid plans remain clash-free, no-solution inputs use the existing failure path, and repeated unchanged Optimize presses do not worsen the result.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

Property 3: Deterministic Completion and Track One/ECE Equivalence

_For any_ identical loaded course data, attendance/lock state, and option set, the exact engine SHALL return the same completion status, feasibility result, objective evaluation, and stable tie signature on every run. For equivalent `computer` and `trackone` first-year inputs in the same semester, it SHALL return equivalent feasibility, clash validation, objective evaluation, and tie behavior, independent of the cache label.

**Validates: Requirements 2.7, 2.8**

## Fix Implementation

### Changes Required

Assuming the root-cause analysis is correct, make the following implementation changes after this design phase. Do not change curriculum extraction, scraper behavior, generated JSON, or cache naming.

**File**: `web/optimizer.js` (new pure browser/Node-shared module)

**Functions**: `groupCourses`, `buildLecOptions`, `buildCoursePlans`, `validateLockedSections`, `evaluatePlan`, `scorePlan`, `comparePlans`, `findBestPlan`, `isClashFree`, and stable signature helpers.

1. **Extract the pure engine without changing its data contract**:
   - Move the current `meetings`, `overlaps`, lecture-option construction, per-course pool/combo construction, and score arithmetic into a UMD-style module that exposes `window.TimetableOptimizer` in the static browser and `module.exports` for Node's built-in test runner.
   - Keep section fields (`name`, `teachMethod`/`type`, `meetingTimes`) and the existing `{code, name, locked, poolTypes, combos}` plan shape compatible with the current renderer. `LEC*` options must continue to carry their per-position section names for display.
   - Preserve the current component rules: lectures are selected from the existing lecture meeting-position combinations, PRA/TUT sections are selected as before, selected tutorial attendance filters only the selected section's meetings, and the three `useless*` controls omit only their existing component.
   - Ensure candidate and course ordering is explicit and stable: course code, component type, section name, meeting day/start/end, then stable candidate signature. Do not call `Math.random()` or an in-place random `shuffle` anywhere in the exact path.

2. **Reject intra-course active locked clashes before search**:
   - After `selectedPlan` applies `uselessPra`/`uselessTut` and tutorial meeting attendance, flatten each course's `locked` meetings and compare every pair with `overlaps`.
   - If any pair overlaps, mark the plan set unsatisfiable and return a complete `{plan: null, status: "NO_SOLUTION", complete: true}` search result. The DOM `optimize` function must take the same existing no-solution branch and must not call `renderPlan`.
   - Keep the existing cross-course check and candidate-vs-lock check. The solver should also retain a final whole-plan clash assertion before returning, so a future caller cannot render a conflicting plan by bypassing the precheck.
   - Check active locks after exclusions: marking a component not worth attending continues to remove that attendance requirement, while two still-active locks from the same course remain invalid.

3. **Replace randomized `solveBest` with a complete deterministic search**:
   - Build a finite candidate list for every course, where each candidate consists of that course's active locked sections plus one internally clash-free `combo` for every remaining active component type. Eliminate duplicate event/signature candidates deterministically.
   - Search one candidate per course with a deterministic most-constrained ordering (fewest viable candidates first, then highest conflict degree, then course code). Maintain a weekly occupancy index/bit mask for conflict checks; never admit a candidate whose event overlaps an occupied event or the course's own locks.
   - Visit candidate lists in stable signature order. At every complete assignment evaluate the plan through `evaluatePlan` and retain a plan only when `comparePlans` says it is better. If equal plans are not replaced, the first stable traversal result is deterministic and ties remain valid.
   - Use branch-and-bound only with admissible bounds. For a partial assignment, active days are a lower bound for the campus term (ignore future gaps), current lunch deficit is a lower bound because adding non-overlapping meetings can only occupy more lunch time, and per-remaining-course minimum end sums / maximum start sums provide valid early/late bounds. Ignoring future conflicts when calculating these bounds is conservative. A branch may be pruned only when its bound cannot beat the incumbent under the exact objective comparator.
   - Memoize only equivalent partial states (same next-course index, occupancy signature, and all objective-relevant accumulated metrics) or deduplicate identical candidate signatures. Do not use an unsafe “best score for occupancy only” cache when start/end sums or lunch state differ.
   - Remove the nine-second `Date.now()` cutoff and the random fallback. If cooperative yielding is later needed for the browser UI, it may split the same exhaustive generator across event-loop turns, but it must continue until `complete: true` before rendering and must never display a merely sampled result as optimized.
   - Return proof metadata such as `complete`, `optimal`, `nodesVisited`, and the objective evaluation. `optimize` renders only a complete result; a null complete result uses the existing failure message.

4. **Make scoring a single deterministic contract**:
   - Implement `evaluatePlan` once and have both the optimizer comparator and the displayed `scorePlan` value use it. Sort days and blocks explicitly and use integer time units for comparison to eliminate object-order and floating-point tie differences.
   - Preserve the current campus formula (active-day units plus positive internal gaps), early formula (sum of all end times), and late formula (negative sum of all start times). Preserve the current lunch window and one-hour threshold, while comparing lunch deficit as the primary tier when the lunch option is enabled so a feasible full-hour lunch is never lost to a different enabled preference.
   - Keep the existing checkboxes and option object (`campus`, `lunch`, `early`, `late`) and do not change the no-preference result contract. Format any normalized objective information in `#optInfo` without changing the controls or timetable layout.

5. **Integrate the module while preserving page state and cache behavior**:
   - Add `<script src="optimizer.js"></script>` before the existing inline page script and bind the page's `selectedPlan`, `load`, `renderPlan`, and `optimize` functions to the shared pure helpers. The DOM event listeners, `COURSES`, `uselessTut`, `uselessPra`, `uselessLec`, `tutAttend`, `bestSoFar`, `_memCache`, localStorage key prefix, manifest loading, and renderer remain in the page with their existing responsibilities.
   - `optimize` must use the exact result and compare/reuse `bestSoFar` only when a key containing all loaded course data, active locks, excluded components, tutorial attendance, and options matches. Reset behavior on Load, lock changes, exclusion changes, and tutorial attendance changes remains as it is today.
   - Do not change `cacheKey`, `comboKey`, manifest availability, second-year option values, or `renderPlan`'s event construction. The only visible behavior change is that the selected timetable is proven best under the enabled objective or the existing no-solution message is shown.

**File**: `web/index.html`

**Specific integration changes**:

- Load the shared optimizer module before the UI script.
- Remove the inline randomized search/scoring implementation or replace its calls with the module's `buildCoursePlans`, `validateLockedSections`, `evaluatePlan`, `comparePlans`, and `findBestPlan` functions.
- Keep `selectedPlan`'s DOM parsing and attendance filtering behavior intact; pass its resulting state into the pure engine rather than reinterpreting the controls.
- Keep `renderPlan`, cache loading, manifest availability, status text path, and input event listeners unchanged except for consuming the complete result and reporting no-solution for an intra-course lock conflict.

**Files**: `tests/test_frontend_optimizer.js` (new), `tests/test_frontend_catalog.py`, and `tests/test_data_contract.py` (only if additional assertions are needed)

**Test-facing changes**:

- Use Node 22's built-in `node:test` and `assert` modules; do not add a runtime dependency just to execute the pure engine.
- Require the same `web/optimizer.js` module used by the browser. Tests must not copy a second implementation of `scorePlan` or the search algorithm.
- Keep the existing Python catalog/data tests and add only assertions that the page loads the shared module and that the existing cache/program/second-year contracts remain present.

## Testing Strategy

### Validation Approach

Validation follows the bug-condition workflow: first capture counterexamples against F, then verify F' against an independent small-domain oracle and all cached first-year datasets. The exact engine must expose completion metadata so tests can distinguish a proven optimum from a time-budgeted sample.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples on the current inline implementation before replacing it, confirm the root cause, and preserve concrete evidence for the fix tests.

**Test Plan**: Use a small Node/browser harness with deterministic replacement for `Math.random` and the current `selectedPlan`/`solveBest` inputs. For the full data reproduction, run the current page logic with the specified locks and exclusions, record the returned plan's `scorePlan`, and independently enumerate a reduced synthetic candidate space or the relevant feasible alternatives. Repeat with several fixed random sequences so the failure is reproducible rather than relying on one incidental sample.

**Test Cases**:

1. **ECE Fall campus reproduction**: Use `computer-1-fall.json`, lock APS100H1/TUT0106 and APS111H1/TUT0106, exclude APS110H1 tutorials, and enable campus only. Capture a seed where F returns a higher campus penalty than the exhaustive reference.
2. **Lunch counterexample**: Construct two compatible candidates, one with 11:00–12:00 occupied and one with 11:00–13:00 occupied, and run the current sampled path with lunch enabled. Capture the result when the full-hour lunch candidate is missed.
3. **Early/late counterexamples**: Construct alternatives with different end-time and start-time totals, run F under each single preference, and record a seed where the better candidate is not sampled before the deadline.
4. **Intra-course lock reproduction**: Select MAT188H1 PRA0106 and TUT0115 simultaneously. Confirm that F can append both locks and return a plan containing their overlapping Monday meetings.
5. **Dataset coverage gap**: Run the current Python suite and show that it checks file shape/catalog membership but never invokes browser plan construction or `scorePlan` over the 16 first-year files.

**Expected Counterexamples**:

- A returned plan whose measured objective is higher than the independent feasible-plan minimum.
- A returned plan that includes two active same-course locked events with overlapping intervals.
- No optimizer execution evidence for one or more first-year program/semester combinations in the current suite.

### Fix Checking

**Goal**: Verify that every buggy input is handled by the complete engine and that the result is either the exact optimum or a complete no-solution result.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  result := findBestPlan_fixed(input.plans, input.options)
  ASSERT result.complete == true
  ASSERT expectedBehavior(input, result)
  IF result.plan != null THEN
    ASSERT objectiveKey(result.plan, input.options)
           == minimumObjectiveKeyOverAllFeasiblePlans(input)
    ASSERT isClashFree(result.plan)
  END IF
END FOR
```

The small-domain oracle must enumerate the Cartesian product independently, reject every conflicting assignment (including same-course locks), calculate the reference objective from raw meetings, and compare the fixed engine's objective and feasibility. For the real cache matrix, `complete: true` plus the final clash/attendance assertions proves that the browser engine did not use the old timeout fallback.

### Preservation Checking

**Goal**: Verify that for inputs outside C, F' keeps the current observable loading, attendance, failure, and UI/cache behavior.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  original := observableContract_original(input)
  fixed := observableContract_fixed(input)
  ASSERT fixed.cacheKey == original.cacheKey
  ASSERT fixed.activeLocks == original.activeLocks
  ASSERT fixed.attendedMeetings == original.attendedMeetings
  ASSERT fixed.excludedComponents == original.excludedComponents
  ASSERT fixed.failureOrPlanInvariant == original.failureOrPlanInvariant
  ASSERT objective(fixed) <= objective(previousFixedResult)
         when the input is unchanged and Optimize is pressed again
END FOR
```

**Testing Approach**: Compare invariant-level behavior rather than random section identity for F versus F'. The original algorithm is intentionally randomized, so a different tied valid section is not a regression. Use static page/cache assertions for loading and UI semantics, pure-engine tests for locks/exclusions/attendance, and deterministic repeated-run assertions for F'.

**Test Cases**:

1. **Attendance preservation**: For synthetic and real course inputs, lock a PRA and TUT, select a subset of meetings for a multi-meeting TUT, and mark lecture/PRA/TUT components not worth attending in turn. Assert the fixed plan contains exactly the active locks and selected meeting subset and omits only the requested component.
2. **No-preference preservation**: Run with all four options disabled and assert a complete clash-free plan, zero configured penalty, all active components present, and the existing renderer/no-solution contract.
3. **Cache/UI preservation**: Retain the existing Python catalog tests for all first-year options, manifest entries, cache path interpolation, legacy `electrical` availability, and `computer`/`electrical` second-year distinction. Add a static assertion that `index.html` loads `optimizer.js` without removing the existing cache path.
4. **Second-year ECE regression**: Run the same pure plan construction/search over `computer-2-fall.json`, `computer-2-winter.json`, `electrical-2-fall.json`, and `electrical-2-winter.json`. Assert the existing track-specific course codes remain distinct and each valid result honors attendance/lock semantics.
5. **Repeated Optimize preservation**: For unchanged inputs, run F' twice and assert `complete` remains true, the objective never increases, and the stable result signature is identical.

### Unit Tests

- `meetings` de-duplicates exact repeated meeting records and `overlaps` rejects only positive-duration intersections; touching intervals remain valid.
- Same-course locked-section validation catches every pairwise overlap, including a lock with multiple selected tutorial meetings, while allowing non-overlapping locks and ignoring a component explicitly marked not worth attending.
- Candidate construction preserves lecture-position options, PRA/TUT attendance filtering, locked sections, and all active required component types.
- `evaluatePlan`/`scorePlan` verify active-day and internal-gap campus values, lunch deficit threshold/window, sum-of-end-times early values, sum-of-start-times late values, and combined option behavior using hand-built plans.
- The exact comparator returns the lower campus/early/combined penalty, later start preference, lunch-tier priority, and deterministic tie handling.
- The search returns `complete: true` and null for an intra-course lock conflict or any unsatisfiable input, and returns a clash-free plan for a feasible input.

### Property-Based Tests

Use a deterministic seeded generator implemented in the Node test file (no third-party dependency required) to generate hundreds of small course-plan inputs with 1–4 courses, one to three candidates per course, one to three meetings per candidate, optional active locks, and each combination of objective flags.

- Compare F' against an independently written exhaustive reference enumerator for every generated feasible input. The fixed result's objective must equal the reference minimum and its plan must be clash-free.
- Generate overlapping same-course lock pairs and assert every one returns complete no-solution without rendering a plan; generate touching/non-overlapping pairs and assert they remain eligible.
- Generate attendance/exclusion variants and assert component/lock invariants are preserved across all objective settings.
- Generate the same input repeatedly with different random seeds in the test harness and assert F' returns the same objective/completion/stable signature, proving that browser randomness cannot affect the answer.
- Run the property suite against the old harness first to retain a counterexample for the exploratory bug condition, then against the shared fixed module.

### Integration Tests

Add a Node integration suite that loads the JSON files from `web/data/` and invokes the same pure helpers that `index.html` invokes.

- **All first-year programs and semesters**: Iterate over `computer` (ECE), `mechanical`, `industrial`, `chemical`, `materials`, `civil`, `mineral`, and `trackone`, and over `fall` and `winter`. For all 16 inputs, build default active attendance plans and run no-preference, campus-only, lunch-enabled, early-only, late-only, and all-enabled searches. Assert `complete`, feasibility/no-solution consistency, no overlaps, all non-excluded components, valid score evaluation, and no random/deadline fallback metadata.
- **Confirmed reproduction**: Run the APS100/APS111 lock plus APS110 tutorial exclusion on Computer/ECE Fall with campus enabled. Assert the exact engine's result matches an independently computed minimum and retains both locked tutorial meetings.
- **Track One/ECE equivalence**: For both semesters and each objective configuration, run equivalent `computer` and `trackone` inputs. Compare canonical course/section signatures, feasible/no-solution status, whole-plan clash result, objective evaluation, and deterministic tie signature. Do not treat equal course-code sets alone as sufficient.
- **Locked-clash integration**: Exercise the MAT188H1 PRA0106/TUT0115 conflict through the same plan-building path used by the page and assert the existing no-solution status and empty render input.
- **Second-year preservation**: Execute the optimizer on both second-year ECE cache families without changing loader/cache selection; assert `computer` retains ECE297H1 behavior, `electrical` retains ECE295H1 behavior, and neither track is silently substituted.
- **Browser wiring/static checks**: Keep the Python catalog tests, assert `optimizer.js` is loaded before the inline UI script, and verify the existing manifest/cache/localStorage strings and selector options remain intact.

Run the complete validation with the existing Python command plus the new one-shot Node command:

```
python -m unittest discover -s tests -v
node --test tests/test_frontend_optimizer.js
```

Neither command is a watcher or server. The implementation phase must not accept a passing data-shape-only suite as sufficient: the Node suite must execute the exact browser optimizer/search/scoring module over all 16 first-year datasets and the specified second-year/equivalence regressions.
