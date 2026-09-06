# Bugfix Requirements Document

## Introduction

The first-year program expansion added Fall and Winter cache datasets for ECE/Computer, Mechanical, Industrial, Chemical, Materials Science and Engineering, Civil, Mineral, and Track One. Loading those datasets successfully does not establish that the browser optimizer selects a best schedule. This bugfix validates the optimizer against feasible alternatives, preference controls, locked-section clashes, and every supported first-year program while preserving the existing second-year ECE behavior.

The reported reproduction is a supported first-year Fall dataset with APS100H1 TUT0106 and APS111H1 TUT0106 selected, APS110H1 tutorials marked not worth attending, all other user-selectable sections left unlocked, and only “Minimize free time on campus” enabled. The resulting timetable contains apparently random breaks even though the optimizer reports an optimized result.

For an input schedule problem X, the bug condition C(X) is that the input has at least one feasible attendance plan and the displayed result either has a worse enabled-preference penalty than another feasible plan or contains overlapping required sections. The fix property P(result) is that the result is clash-free and minimizes the configured objective over the feasible plans for X, with ties allowed. For inputs that do not satisfy C(X), the fixed behavior SHALL preserve the original attendance, loading, and failure semantics.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN a supported first-year Fall dataset containing APS100H1, APS110H1, and APS111H1 is configured with APS100H1 TUT0106 and APS111H1 TUT0106 locked, APS110H1 tutorials excluded, all other user-selectable sections unlocked, and only “Minimize free time on campus” enabled THEN the system can display a feasible timetable with avoidable gaps while labeling it optimized.

1.2 WHEN “Minimize free time on campus” is enabled and multiple feasible schedules have different intervening free-time gaps or different numbers of active days THEN the randomized, time-bounded search can return a schedule with a higher campus penalty than another feasible schedule.

1.3 WHEN “Provide time for lunch” is enabled and a feasible schedule can preserve at least one free hour in the 11:00–13:00 lunch window THEN the randomized search can return a schedule with less lunch time, or can miss the best lunch trade-off under the other enabled preferences.

1.4 WHEN “End early” is enabled and feasible schedules have different class end-time totals THEN the randomized search can return a schedule whose classes end later than those of another feasible schedule.

1.5 WHEN “Start late” is enabled and feasible schedules have different class start-time totals THEN the randomized search can return a schedule whose classes start earlier than those of another feasible schedule.

1.6 WHEN a user locks two sections from the same course whose meeting times overlap, such as an overlapping MAT188H1 practical and tutorial, THEN the solver can accept and render both locked sections because it checks each lock against previously placed courses but does not check the locked sections against one another.

1.7 WHEN any of the eight supported first-year program caches is loaded for Fall or Winter THEN the existing automated validation verifies cache presence and data shape but does not execute the browser optimizer to prove preference handling and clash freedom for that program; a program-specific optimizer regression can therefore pass the current test suite undetected.

### Expected Behavior (Correct)

2.1 WHEN the reproduction in 1.1 is run THEN the system SHALL display a clash-free timetable whose campus penalty is no greater than that of every other feasible timetable for the same locks, exclusions, course data, and preference settings, so avoidable breaks are not presented as optimized.

2.2 WHEN “Minimize free time on campus” is enabled THEN the system SHALL evaluate the configured campus objective consistently (inter-class free-time gaps together with the active-day penalty) and SHALL select a feasible schedule with the minimum value of that objective, allowing equivalent-score ties.

2.3 WHEN “Provide time for lunch” is enabled THEN the system SHALL prefer a feasible schedule with at least one free hour inside the 11:00–13:00 window whenever one exists; when no such schedule exists, it SHALL minimize the missing lunch time under the combined enabled preferences.

2.4 WHEN “End early” is enabled THEN the system SHALL select a feasible schedule with the minimum configured class-end objective, so enabling the control cannot produce a schedule with a worse end-time total than an available alternative.

2.5 WHEN “Start late” is enabled THEN the system SHALL select a feasible schedule with the maximum configured class-start objective, so enabling the control cannot produce a schedule with an earlier start-time total than an available alternative.

2.6 WHEN locked sections from the same course overlap THEN the system SHALL reject the locked combination as unsatisfiable, SHALL NOT display overlapping required sections as a clash-free timetable, and SHALL use the existing no-solution behavior; every returned timetable SHALL be clash-free across and within courses.

2.7 WHEN any supported first-year program (computer/ECE, mechanical, industrial, chemical, materials, civil, mineral, or trackone) and either Fall or Winter dataset is loaded THEN the system SHALL apply the same optimizer semantics to that dataset, retain all required attendance components that are not excluded, honor locked sections, and return a result satisfying the enabled preference objective or the documented no-solution behavior.

2.8 WHEN the Track One and computer/ECE first-year datasets for the same semester are loaded with equivalent inputs THEN the system SHALL produce equivalent feasible-plan, clash-checking, and preference-scoring behavior; validation SHALL cover this equivalence rather than checking only that the course-code sets match.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN an existing second-year ECE computer or electrical dataset is loaded THEN the system SHALL CONTINUE TO use the existing program/year/semester cache selection and optimizer attendance semantics without changing the established course and section behavior.

3.2 WHEN a supported first-year program and semester is selected and its cache is available THEN the system SHALL CONTINUE TO load the selected dataset through the existing manifest-backed cache path, and the optimizer SHALL remain independent of program labels and operate on the loaded sections.

3.3 WHEN a user locks a lecture/tutorial/practical section or selects individual meetings of a multi-meeting tutorial THEN the system SHALL CONTINUE TO keep those selected meetings fixed in the generated timetable unless the input is changed, rather than silently replacing or dropping them.

3.4 WHEN a course component is marked “not worth attending” THEN the system SHALL CONTINUE TO omit only the corresponding component according to the existing controls, while retaining other required components and applying optimization to the remaining choices.

3.5 WHEN no feasible clash-free timetable exists because required locks or remaining components conflict THEN the system SHALL CONTINUE TO clear the displayed result and show the existing no-solution guidance instead of silently dropping required sections or rendering a conflicting schedule.

3.6 WHEN no optimization preference is enabled THEN the system SHALL CONTINUE TO produce a valid clash-free timetable using the existing attendance and section-selection rules, without applying an unintended preference penalty.

3.7 WHEN the user presses Optimize repeatedly without changing locks, exclusions, course data, or preference controls THEN the displayed timetable SHALL CONTINUE NOT TO regress to a worse score than the best result already displayed for that unchanged input.

3.8 WHEN the first-year data is refreshed or validated THEN the fix SHALL CONTINUE TO preserve the existing first-year program catalog, Track One’s shared ECE/Computer curriculum identity, both Fall/Winter availability entries, and the distinct existing second-year electrical ECE track.
