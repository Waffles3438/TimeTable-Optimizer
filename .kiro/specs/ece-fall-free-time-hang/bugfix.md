# Bugfix Requirements Document

## Introduction

This bugfix addresses the ECE/Computer first-year Fall optimizer failure reported for a specific locked and filtered schedule. The user loads the `computer-1-fall.json` cache, locks `APS100H1` tutorial `TUT0106` and `APS111H1` tutorial `TUT0106`, marks all `APS110H1` tutorials as not worth attending, leaves every other user-selectable section unlocked, and enables only “Minimize free time on campus.” In this state the website can crash or become unresponsive instead of completing the optimization interaction.

The scope is the browser optimizer’s execution and result contract for this input, together with regression protection for the established first-year optimizer behavior. The fix must not trade completeness for responsiveness by displaying a sampled, timed-out, partial, or random result. It must preserve the existing cache and UI flow, attendance and lock semantics, Track One/ECE first-year equivalence, and distinct second-year ECE behavior. Curriculum extraction, scraping, generated cache data, and unrelated UI behavior are outside the requested change.

For an optimizer input `X`, let `C(X)` identify the reported failure and let `P(result)` describe the required result:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X containing the selected cache, active locks, exclusions,
         tutorial attendance, and objective flags
  OUTPUT: boolean

  target := X.program = "computer"
            AND X.year = "1"
            AND X.session = "fall"
            AND activeLock(X, "APS100H1", "TUT0106")
            AND activeLock(X, "APS111H1", "TUT0106")
            AND tutorialsExcluded(X, "APS110H1")
            AND noOtherUserSelectedLocks(X)
            AND X.options = { campus: true, lunch: false,
                              early: false, late: false }

  failure := optimizerCrashes(X)
            OR optimizerDoesNotReturnControlWithACompleteResult(X)
            OR returnedResultIsNotCompleteClashFreeAndOptimal(X)

  RETURN target AND failure
END FUNCTION

FUNCTION expectedBehavior(X, result)
  INPUT: X and the result made available to the page
  OUTPUT: boolean

  IF noFeasiblePlan(X) THEN
    RETURN result.plan = null
           AND result.status = "NO_SOLUTION"
           AND result.complete = true
  END IF

  RETURN result.plan != null
         AND result.status = "OPTIMAL"
         AND result.complete = true
         AND result.optimal = true
         AND isClashFree(result.plan)
         AND containsActiveLocks(result.plan, X)
         AND containsAllNonExcludedComponents(result.plan, X)
         AND objectiveKey(result.plan, X.options)
             = minimumObjectiveKeyOverAllFeasiblePlans(X)
END FUNCTION
```

Acceptance criteria are satisfied only when the reported reproduction returns control without a crash or an unresponsive page, displays only a complete deterministic result, proves the campus-minimizing feasible objective (or the complete no-solution result), preserves both locked tutorials and the APS110 tutorial exclusion, and retains every behavior described in clauses 3.1–3.8. Equivalent tied plans are acceptable when their objective, clash, attendance, and lock invariants are identical.

## Bug Analysis

### Current Behavior (Defect)

The existing behavior is defective in the following ways:

1.1 WHEN `computer-1-fall.json` is loaded with `APS100H1 TUT0106` and `APS111H1 TUT0106` locked, all `APS110H1` tutorials excluded, no other user-selectable sections locked, and only “Minimize free time on campus” enabled THEN the website can crash or become unresponsive instead of completing the Optimize interaction.

1.2 WHEN the reported input has at least one feasible clash-free timetable and two feasible timetables have different campus free-time penalties THEN the optimizer can fail to return a result or can return a result without establishing that its campus penalty is no worse than every feasible alternative.

1.3 WHEN the reported optimization operation does not finish normally THEN the page does not reliably reach either a trustworthy optimized timetable or the existing explicit no-solution outcome, leaving the user without a valid result contract.

1.4 WHEN the user repeats Optimize with the same reported input after an attempted search THEN the observable outcome is not guaranteed to be a stable completed result, so a prior crash, hang, or incomplete search can prevent deterministic repeated behavior.

### Expected Behavior (Correct)

The corrected behavior for the reported condition SHALL be:

2.1 WHEN the reported ECE/Computer first-year Fall input is optimized THEN the system SHALL return control without throwing an optimizer error or leaving the page unusable, and SHALL display a result only after the optimization has completed.

2.2 WHEN the reported input has at least one feasible clash-free timetable THEN the system SHALL return a complete, deterministic, clash-free timetable whose campus objective is the minimum over every feasible timetable for the same cache data, active locks, tutorial exclusion, attendance state, and objective flags. Equivalent objective ties SHALL be resolved consistently without requiring a particular tied section identity.

2.3 WHEN the reported input has no feasible clash-free timetable, including when active required sections cannot be completed without a clash THEN the system SHALL return `plan = null`, `status = "NO_SOLUTION"`, and `complete = true`, SHALL clear the displayed timetable, and SHALL show the existing no-solution guidance instead of rendering a partial or conflicting plan.

2.4 WHEN the corrected optimizer returns a successful timetable for the reported input THEN it SHALL retain the complete selected meeting set for both active tutorial locks, SHALL omit every APS110H1 tutorial because that component is excluded, and SHALL include every other required non-excluded component without silently replacing, dropping, or inventing a user selection.

2.5 WHEN the optimizer is working on the reported input THEN the page SHALL remain usable while the complete search is performed, and SHALL not use a random sample, arbitrary elapsed-time cutoff, incomplete fallback, or unproven intermediate result as the displayed optimized timetable.

2.6 WHEN the reported input is optimized repeatedly without changing cache data, locks, exclusions, tutorial attendance, or objective flags THEN the system SHALL return the same completion and feasibility status, the same campus objective value, and the same stable tie choice, and SHALL not regress to a worse result.

### Unchanged Behavior (Regression Prevention)

The fix SHALL preserve the following behavior outside the reported defect and for all unaffected inputs:

3.1 WHEN a program, year, and semester is selected and its data is available THEN the system SHALL CONTINUE TO use the existing manifest-backed availability check, `data/${program}-${year}-${semester}.json` cache path, in-memory cache, and `ttb:` localStorage cache semantics.

3.2 WHEN a lecture, practical, or tutorial is actively locked, or when a selected multi-meeting tutorial has an attendance subset THEN the system SHALL CONTINUE TO retain the exact locked section and selected meetings until the user changes that input; deterministic tie selection SHALL NOT silently replace an active lock or attended meeting.

3.3 WHEN a lecture, practical, or tutorial component is marked not worth attending THEN the system SHALL CONTINUE TO omit only that component according to the existing controls, while retaining all other required non-excluded components and applying the optimizer to the remaining choices.

3.4 WHEN any returned timetable is feasible THEN the system SHALL CONTINUE TO require clash freedom within a course and across courses, treating only positive-duration intersections as clashes so intervals that touch at an endpoint remain eligible.

3.5 WHEN any supported objective combination is enabled, including campus, lunch, end-early, start-late, or their combinations THEN the system SHALL CONTINUE TO use the established objective measurements: campus active-day and positive internal-gap costs, the 11:00–13:00 lunch window with its one-hour threshold, the sum of selected class end times for end-early, and the negative sum of selected class start times for start-late. The optimizer SHALL continue to complete deterministically over feasible choices rather than weakening those semantics to avoid the reported hang.

3.6 WHEN no objective option is enabled, or when a supported input is unsatisfiable THEN the system SHALL CONTINUE TO return a valid clash-free arrangement without an unintended penalty, or the complete existing no-solution result, and SHALL render only a complete successful result.

3.7 WHEN the user presses Optimize repeatedly without changing any plan-affecting input, or changes a lock, exclusion, attendance subset, loaded data set, or objective option THEN the system SHALL CONTINUE TO maintain the existing `bestSoFar` reset and cumulative-result semantics: an unchanged input cannot regress, and a result from a different input cannot be reused.

3.8 WHEN first-year or second-year data is loaded and validated THEN the system SHALL CONTINUE TO preserve all eight first-year program IDs for both Fall and Winter, equivalent optimizer behavior for same-semester Computer/ECE and Track One first-year data, the existing `electrical` option, and the distinct second-year Computer and Electrical ECE course behavior. The fix SHALL NOT modify curriculum definitions, scraper behavior, or generated timetable data.
