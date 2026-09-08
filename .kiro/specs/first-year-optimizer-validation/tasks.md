# Implementation Plan

## Scope, dependencies, and targets

This plan implements the bugfix specified by `bugfix.md` and `design.md` using the bug-condition workflow. The current phase creates this task document only; it does not modify implementation files, generated datasets, or tests.

**Dependencies**

- Node.js 22 or newer, using only the built-in `node:test`, `assert`, `fs`, `path`, and `vm` modules. No runtime or test dependency is required.
- Python with the repository's existing test environment for the catalog, scraper, curriculum, and data-contract checks.
- The existing static files under `web/data/`; do not regenerate or rename them as part of this bugfix.
- The existing browser contracts in `web/index.html`: manifest availability, `data/${program}-${year}-${session}.json` loading, `_memCache`, localStorage `ttb:` keys, selector values, attendance controls, `bestSoFar`, no-solution status, and `renderPlan`.

**Concrete file targets**

- `web/optimizer.js` — new pure browser/Node-shared optimizer module.
- `web/index.html` — wire the module into the current page while leaving DOM, cache, attendance, and renderer responsibilities intact.
- `tests/test_frontend_optimizer.js` — new Node unit, property-based, exploratory, and integration suite for the same module used by the browser.
- `tests/test_frontend_catalog.py` — add only static wiring assertions needed to prove the shared script and existing cache path remain present.
- `tests/test_data_contract.py` — preserve the existing data/Track One/second-year assertions; extend only if a narrowly scoped contract assertion is needed.
- `web/data/*.json`, `curriculum.py`, and `scrape.py` — read-only inputs for this fix; do not change them.

**One-shot validation commands**

```powershell
python -m unittest discover -s tests -v
node --test tests/test_frontend_optimizer.js
```

For the static HTTP smoke check, start the server manually in a separate terminal (it is intentionally long-running and is not an automated agent command):

```powershell
python -m http.server 8765 --directory web
```

Then, from a second terminal at the repository root, verify the page, shared module, manifest, and representative cache are served as static assets:

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/index.html).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/optimizer.js).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/data/manifest.json).StatusCode
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/data/computer-1-fall.json).StatusCode
```

Each request must return `200`; the browser smoke check must show the page can load `optimizer.js` before its inline UI script and can load a manifest-backed dataset without a console error.

## Ordered implementation tasks

- [x] 1. Write the bug-condition exploration test before implementing the fix
  - **Property 1: Bug Condition** - Exact preference optimum and intra-course lock rejection
  - **STANDALONE TASK — MUST PRECEDE ALL IMPLEMENTATION WORK.** Create the exploratory portion of `tests/test_frontend_optimizer.js` and a small test-only adapter that invokes the current inline optimizer from `web/index.html`; do not change production code to make this test pass.
  - **Bug condition specification:** for input `X`, `isBugCondition(X)` is true when either (a) a feasible plan exists and the current returned plan has an objective key worse than another feasible plan, or (b) two distinct active locks in one course contain meeting pair `a,b` with `overlaps(a,b) == true`. The objective comparison must use the enabled preference, not a random sample order.
  - Exercise the confirmed Computer/ECE Fall reproduction using `web/data/computer-1-fall.json`: lock `APS100H1 TUT0106` and `APS111H1 TUT0106`, exclude all `APS110H1` tutorials, leave other selectable sections unlocked, and enable only campus minimization. Run the current sampled implementation with deterministic replacement random sequences and independently enumerate the small relevant feasible alternatives.
  - Add focused seeded counterexamples for lunch, end-early, and start-late, plus the MAT188H1 Fall case with active `PRA0106` and `TUT0115` locks whose Monday meetings overlap. The exploration must record the returned objective, the independent minimum, the overlapping lock pair, and the legacy status/plan shape.
  - Also record the current coverage gap: the existing Python suite checks cache presence/shape but does not call browser plan construction, lock validation, scoring, or search over the first-year matrix.
  - Run on **unfixed** code with `node --test tests/test_frontend_optimizer.js`; the bug-condition assertions are expected to fail. Preserve the smallest deterministic counterexamples in test failure output or comments instead of weakening the assertions.
  - **Acceptance criteria:** at least one reproducible worse-than-optimal sampled plan is captured; at least one reproducible same-course locked clash is accepted by the old path; the test names the input and expected behavior from `expectedBehavior`; no production file is modified; failure is documented as evidence of the defect.
  - **Dependencies:** none beyond the repository and Node.js 22.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 2. Write preservation property tests before implementing the fix
  - **Property 2: Preservation** - Existing loading, attendance, and UI semantics
  - **STANDALONE TASK — MUST PRECEDE IMPLEMENTATION.** Extend `tests/test_frontend_optimizer.js` with observation-first preservation checks and run them against the unfixed page/harness before changing `web/index.html`.
  - Observe and record the legacy behavior for non-buggy inputs (`NOT C(X)`), then assert the observed invariants rather than assuming a particular random tied section: selected cache path and manifest availability, active lecture/PRA/TUT locks, selected subset of meetings for a multi-meeting tutorial, omission of only `uselessLec`/`uselessPra`/`uselessTut`, clash-free valid plans, the existing no-solution result, zero configured penalty when all options are disabled, and repeated Optimize presses not worsening the remembered result.
  - Use a deterministic seeded generator with 1–4 courses, one to three candidate choices, one to three meetings per choice, optional locks, attendance subsets, exclusions, and all combinations of `campus`, `lunch`, `early`, and `late`. The baseline properties must pass on unfixed behavior for non-buggy inputs and must not require random section identity.
  - Keep static preservation assertions in the existing Python catalog/data tests for the eight first-year program IDs, both semesters, manifest-backed cache interpolation, the legacy `electrical` option, the distinct second-year ECE tracks, and Track One's shared Computer/ECE identity. Do not replace these with data-shape-only optimizer coverage.
  - Run the baseline suite with `python -m unittest discover -s tests -v` and the preservation portion with `node --test tests/test_frontend_optimizer.js`; preservation tests are expected to pass on unfixed code. Capture observed examples for both no-preference and no-solution paths.
  - **Acceptance criteria:** preservation tests pass before the fix; every generated assertion is tied to a non-bug condition; attendance and exclusion observations distinguish an omitted component from a silently replaced component; the tests establish the cache/UI/second-year baseline that later integration must retain.
  - **Dependencies:** Task 1's test harness and counterexample format.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. Implement exact optimizer behavior and browser integration
  - **Parent task dependencies:** Tasks 1 and 2 must be complete; do not delete or replace their exploration/preservation assertions. The implementation must satisfy `isBugCondition`, `expectedBehavior`, and all preservation requirements from the design.
  - **Implementation annotation:**
    - _Bug_Condition: `isBugCondition(input)` is a feasible objective miss or an overlapping pair of active locks from the same course._
    - _Expected_Behavior: `expectedBehavior(input, result)` returns a complete optimal clash-free plan containing all active locks/non-excluded components, or `{plan: null, status: "NO_SOLUTION", complete: true}` for unsatisfiable inputs._
    - _Preservation: preserve cache selection, manifest and localStorage/in-memory behavior, controls, attendance filtering, lock selection, renderer/status path, no-preference behavior, cumulative best-result behavior, first-year catalog, Track One identity, and second-year ECE tracks._
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 3.1 Extract the pure browser/Node-shared optimizer module
    - **Target:** new `web/optimizer.js`; update only its tests as needed, not the data or Python implementation.
    - Implement a UMD-style wrapper that exports `window.TimetableOptimizer` in the static browser and `module.exports` in Node. Expose the pure helpers required by the design: `meetings`, `overlaps`, `groupCourses`, `buildLecOptions`, `buildCoursePlans`, `validateLockedSections`, `evaluatePlan`, `scorePlan`, `comparePlans`, `findBestPlan`, `isClashFree`, and stable signature helpers.
    - Preserve the current section data contract (`name`, `teachMethod`/`type`, `meetingTimes`) and the renderer-compatible plan shape `{code, name, locked, poolTypes, combos}`. Lecture options must retain per-position section names in `secs`; PRA/TUT choices and selected meeting arrays must remain renderable without DOM access.
    - Normalize and de-duplicate exact meeting records without changing positive-duration semantics. `overlaps` must reject only positive intersections; intervals that touch at an endpoint remain non-overlapping. Make all candidate/course/signature ordering explicit and stable: course code, component type, section name, meeting day/start/end, then candidate signature.
    - Keep the module free of DOM, `Math.random()`, elapsed-time checks, localStorage, fetch, or rendering. The browser page will supply normalized inputs and consume returned results.
    - **Acceptance criteria:** `require("./web/optimizer.js")` succeeds in Node; loading the same script in a browser exposes the same API; repeated calls with identical inputs return equal stable signatures; helper unit tests can run without a DOM or third-party package.
    - **Dependencies:** Tasks 1 and 2 for the preserved data/attendance observations.
    - _Requirements: 2.7, 3.2, 3.3, 3.4, 3.8_

  - [x] 3.2 Build candidates and reject intra-course active-lock clashes before search
    - **Target:** `web/optimizer.js`; exercise via `tests/test_frontend_optimizer.js`.
    - Implement `validateLockedSections` after the page's `uselessLec`/`uselessPra`/`uselessTut` filters and selected TUT attendance subsets have been applied. Compare every pair of active locks within each course and retain the existing cross-course and candidate-vs-lock checks. Ignore a lock on a component explicitly excluded by the existing controls; do not ignore two still-active locks from the same course.
    - Implement `buildCoursePlans`/candidate construction so each candidate contains all active locked sections plus one internally clash-free option for every remaining active component type. Preserve lecture-position construction, PRA/TUT selection, selected tutorial meeting subsets, and required non-excluded component types. Remove duplicate event/signature candidates deterministically.
    - Touching intervals such as 10:00–11:00 and 11:00–12:00 must remain eligible. A pairwise overlap, including one lock with multiple selected tutorial meetings, must cause a complete unsatisfiable result rather than a rendered conflict.
    - **Acceptance criteria:** MAT188H1 `PRA0106` + `TUT0115` returns the no-solution contract before enumeration; non-overlapping locks remain eligible; excluded components do not create false lock conflicts; every candidate is internally clash-free and contains all active lock/attendance invariants.
    - **Dependencies:** 3.1.
    - _Requirements: 2.6, 2.7, 3.3, 3.4, 3.5_

  - [x] 3.3 Make scoring and comparison one canonical deterministic contract
    - **Target:** `web/optimizer.js`; update the pure assertions in `tests/test_frontend_optimizer.js`.
    - Implement `evaluatePlan` once and have both `scorePlan` and the search comparator consume it. Sort days and blocks explicitly and use integer minutes or milliseconds for comparison; normalize only at the display boundary.
    - Preserve the measurements: campus is one unit per active day plus positive internal gaps; lunch uses the 11:00–13:00 window and a one-hour free threshold; early is the sum of every selected class end time with lower better; late is the negative sum of every selected class start time with lower better.
    - When lunch is enabled, compare total lunch deficit/tier first so a feasible one-hour lunch wins whenever one exists. Among equal lunch results, combine the enabled campus/early/late terms with their existing relative weights. When no option is enabled, retain a valid plan with zero configured penalty and use only stable tie ordering.
    - Implement `comparePlans` as a complete order for objective values plus a stable signature tie-break. It must allow equal-score ties while returning the same tie choice for equal inputs.
    - **Acceptance criteria:** hand-built plans prove campus gaps/day count, lunch deficit/window, end sums, start sums, lunch priority, combined objectives, touching intervals, and no-preference behavior; `scorePlan` and comparator cannot disagree about the preferred plan; repeated evaluation has no floating/object-order drift.
    - **Dependencies:** 3.1 and 3.2.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.6, 3.7_

  - [x] 3.4 Replace randomized/time-limited `solveBest` with a complete deterministic search
    - **Target:** `web/optimizer.js`; keep any compatibility shim in `web/index.html` delegated to `findBestPlan`, never a second algorithm.
    - Implement `findBestPlan` over the finite candidate Cartesian product. Validate locks first, order courses deterministically by fewest viable candidates, then conflict degree, then course code, visit candidates by stable signature, and maintain a weekly occupancy index/bit mask for clash checks.
    - Evaluate every complete non-pruned assignment with the canonical evaluation/comparator and retain only the better plan. Use only admissible branch-and-bound lower bounds: current active-day campus contribution, current lunch deficit, minimum remaining end sums, and maximum remaining start sums while conservatively ignoring future conflicts. Memoize only equivalent partial states containing the next-course index, occupancy signature, and every objective-relevant accumulated metric; do not cache by occupancy alone.
    - Remove the nine-second `Date.now()` cutoff, iteration/sample limit, random shuffle, and random clash-free fallback. Return proof metadata including `complete`, `optimal`, `status`, `nodesVisited`, objective evaluation, and a stable plan signature. A null result for any unsatisfiable input must still be complete and must never be rendered.
    - Add a final whole-plan `isClashFree` and attendance/lock assertion before accepting a result, so callers cannot obtain a conflicting or incomplete plan through a future code path.
    - **Acceptance criteria:** the exact engine returns the independent exhaustive minimum for synthetic inputs, always reports `complete: true` before a result is displayed, produces the same objective/signature across repeated runs and random seeds, and returns complete no-solution for intra-course or cross-course unsatisfiable inputs. There is no `Math.random`, deadline, or sampled fallback in the exact path.
    - **Dependencies:** 3.2 and 3.3.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.5, 3.6, 3.7_

  - [x] 3.5 Complete Node unit, property-based, and integration coverage against the shared module
    - **Target:** `tests/test_frontend_optimizer.js`; use the exact `require`d `web/optimizer.js` that the browser loads. Do not copy a second scoring or search implementation into the test oracle.
    - Keep unit tests for meeting de-duplication, positive-duration overlap, touching intervals, same-course lock validation, candidate construction, lecture-position options, attendance filtering, `evaluatePlan`/`scorePlan`, comparator/tie behavior, complete no-solution, and clash-free feasible results.
    - Add the seeded property suite (hundreds of generated cases) for 1–4 courses, one to three candidates per course, one to three meetings per candidate, optional active locks, attendance/exclusion variants, and every objective flag combination. Compare the fixed result with an independently written exhaustive reference enumerator over the generated small domain; assert objective minimum, lock/component invariants, clash freedom, complete metadata, and deterministic signatures. Generate both overlapping and touching same-course lock pairs.
    - Add integration coverage for every first-year file: `computer`, `mechanical`, `industrial`, `chemical`, `materials`, `civil`, `mineral`, and `trackone`, each with `fall` and `winter` (all 16 datasets). For each, build default active attendance plans and run no-preference, campus-only, lunch-enabled, early-only, late-only, and all-enabled searches. Assert complete feasibility/no-solution consistency, no overlaps, all non-excluded components, valid objective evaluation, and absence of deadline/random-fallback metadata.
    - Include the confirmed Computer/ECE Fall APS100/APS111 lock plus APS110 tutorial exclusion and compare with an independent minimum; include MAT188H1 `PRA0106`/`TUT0115` no-solution integration through the same plan-building path.
    - For both semesters and every objective configuration, compare `computer-1-{semester}.json` with `trackone-1-{semester}.json` using canonical optimizer-input/course-section signatures, feasibility/no-solution status, clash validation, objective evaluation, and deterministic tie signature. Equal course-code sets alone are insufficient.
    - Run the same pure engine over `computer-2-fall.json`, `computer-2-winter.json`, `electrical-2-fall.json`, and `electrical-2-winter.json`; assert attendance/lock invariants and preserve `ECE297H1` only for the Computer family and `ECE295H1` only for the Electrical family.
    - **Property 3: Deterministic Completion and Track One/ECE Equivalence** - For identical normalized input and options, and for equivalent Computer/Track One first-year inputs, fixed results have identical completion, feasibility, objective evaluation, and stable tie signatures regardless of harness seed or run order.
    - **Acceptance criteria:** `node --test tests/test_frontend_optimizer.js` executes the real shared module, the independent oracle agrees for all generated cases, all 16 first-year datasets and four second-year ECE datasets are exercised, Track One/ECE equivalence is checked at optimizer behavior level, and no test relies only on static file shape.
    - **Dependencies:** 3.1–3.4; retain the counterexamples and baseline observations from Tasks 1 and 2.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 3.6 Wire `optimizer.js` into `index.html` without changing page semantics
    - **Target:** `web/index.html`, with static assertions in `tests/test_frontend_catalog.py` and any narrowly scoped data assertions in `tests/test_data_contract.py`.
    - Add `<script src="optimizer.js"></script>` before the existing inline UI script. Remove or delegate the inline `meetings`, `overlaps`, lecture/combo construction, scoring, and randomized `solveBest` logic so there is one implementation; keep the DOM-facing `selectedPlan` responsible for reading controls and passing normalized state to the pure helpers.
    - Preserve `COURSES`, `uselessTut`, `uselessPra`, `uselessLec`, `tutAttend`, event listeners, program/year/semester selectors, manifest availability messages, `cacheKey`, `comboKey`, `_memCache`, localStorage `ttb:` keys, Load behavior, and `renderPlan` event construction/layout. Preserve selected locks and selected multi-meeting tutorial subsets exactly until the user changes them.
    - Have `optimize` render only a complete successful result. For `{plan: null, status: "NO_SOLUTION", complete: true}`, clear `#timetable` and use the existing no-solution guidance; never render an incomplete or sampled plan. Keep the existing controls and `#optInfo`/status path, changing only the result to the proven exact objective.
    - Add static checks that the shared script appears before the inline UI script, the existing manifest/cache URL strings remain, all requested selector options remain, and legacy `electrical`/second-year strings are not removed.
    - **Acceptance criteria:** a static HTTP page loads the module before UI initialization; existing cache/UI/attendance/rendering tests remain green; the page uses the shared exact result and never calls a random/time-limited fallback; the no-solution DOM path remains empty/result-free.
    - **Dependencies:** 3.1, 3.4, and 3.5.
    - _Requirements: 2.6, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.8_

  - [x] 3.7 Integrate `bestSoFar` safely with complete results only
    - **Target:** `web/index.html`; cover behavior in `tests/test_frontend_optimizer.js`.
    - Replace the current lock-only/options-only cumulative key with a canonical input signature containing all loaded course/section data, active locks and their selected meetings, excluded lecture/PRA/TUT components, tutorial attendance subsets, and all four options. The signature must change when any plan-affecting input changes and remain stable for unchanged input.
    - On each Optimize press, call the exact engine and retain/re-render `bestSoFar` only when the new result is complete and `comparePlans` says it is equal or better for the same signature. Never reuse a plan across different data/attendance/exclusion/options, never let an incomplete result replace a complete one, and clear the displayed plan on complete no-solution as the existing path requires.
    - Preserve resets on Load, lock changes, exclusions, and tutorial attendance changes. For unchanged input, repeated presses must keep the same or better objective and deterministic tie signature; no random result may regress the displayed timetable.
    - **Acceptance criteria:** repeated Optimize integration assertions pass; changing each independent input dimension invalidates the prior key; a complete no-solution cannot leave stale `bestSoFar` content rendered; a complete result is the only value passed to `renderPlan`.
    - **Dependencies:** 3.5 and 3.6.
    - _Requirements: 3.3, 3.4, 3.5, 3.7_

  - [x] 3.8 Verify the original exploration test now passes as expected behavior
    - **Property 1: Expected Behavior** - Exact preference optimum and locked-conflict rejection
    - **Do not write a replacement test.** Re-run the same Property 1 test from Task 1 against the fixed shared engine and page wiring.
    - For every captured objective-miss case, assert `complete === true`, a clash-free plan, all active locks and non-excluded components, and an objective key equal to the independent minimum. For every captured active same-course lock clash, assert exactly `{plan: null, status: "NO_SOLUTION", complete: true}` at the engine boundary and the existing cleared/no-solution DOM behavior at the page boundary.
    - Re-run the Computer/ECE Fall reproduction with campus-only, plus lunch, early, and late counterexamples. Confirm no deadline/sample metadata or random fallback is involved.
    - **Acceptance criteria:** all original counterexamples are fixed rather than masked; the exact result is proven complete/optimal; no overlapping required sections are rendered; the test passes with `node --test tests/test_frontend_optimizer.js`.
    - **Dependencies:** 3.1–3.7.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 3.9 Verify preservation tests still pass after the fix
    - **Property 2: Preservation** - Existing loading, attendance, and UI semantics
    - **Do not write a replacement test.** Re-run the same Property 2 tests from Task 2 against the fixed module/page.
    - Confirm the same cache path and manifest behavior, exact active locks and attended meeting subsets, component exclusions, valid/no-solution contracts, no-preference behavior, cumulative no-regression behavior, first-year catalog/semester entries, Track One identity, and distinct second-year Computer/Electrical behavior.
    - Compare invariant-level outcomes rather than requiring the old random section identity; stable deterministic tie selection is acceptable when attendance, clash, score, and rendering contracts are preserved.
    - **Acceptance criteria:** all preservation assertions pass after extraction and wiring; no cache/UI/attendance/rendering regression is introduced; the existing Python suite and Node suite both pass.
    - **Dependencies:** 3.5–3.8.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 4. Checkpoint — run complete validation and confirm acceptance criteria
  - **Dependencies:** Tasks 1–3.9.
  - Run the complete offline validation:
    - `python -m unittest discover -s tests -v`
    - `node --test tests/test_frontend_optimizer.js`
  - Run the manual static HTTP smoke check from the commands at the top of this document. Confirm HTTP 200 for `index.html`, `optimizer.js`, `data/manifest.json`, and `data/computer-1-fall.json`; load the page and verify the browser console has no module or initialization errors.
  - Confirm no implementation task changed `web/data/*.json`, `curriculum.py`, or `scrape.py`; the first-year catalog remains eight programs × two semesters, Track One remains equivalent to Computer/ECE for first year, and `electrical` remains a distinct second-year ECE cache.
  - **Final acceptance criteria:**
    - Every buggy feasible input returns a complete, clash-free minimum-objective result, including campus, lunch, early, and late preferences; ties are deterministic and valid.
    - Every active same-course locked overlap returns complete no-solution and is never rendered.
    - The exact search is finite, deterministic, fully completed, and contains no random/time-limited fallback.
    - `optimizer.js` is shared by browser and Node; the Node suite covers unit behavior, seeded properties, all 16 first-year datasets, Track One/ECE equivalence, the confirmed reproduction, MAT188 lock rejection, and all four second-year ECE datasets.
    - Cache loading, manifest/UI controls, attendance selections, exclusions, `bestSoFar`, no-solution guidance, and timetable rendering preserve the documented semantics.
    - Python, Node, and static HTTP validation all pass.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_
