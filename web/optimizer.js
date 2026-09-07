/*
 * Pure timetable optimizer primitives shared by the browser and Node tests.
 *
 * This file deliberately has no DOM, network, storage, clock, or randomness
 * dependencies.  The page integration and complete search are separate tasks;
 * findBestPlan below is the stable result/normalization seam that the exact
 * search implementation will fill in.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TimetableOptimizer = factory();
  }
}(
  (typeof self !== "undefined" && self) ||
  (typeof window !== "undefined" && window) ||
  (typeof globalThis !== "undefined" && globalThis) ||
  this,
  function () {
    "use strict";

    const HOUR = 60 * 60 * 1000;
    const LUNCH_START = 11 * HOUR;
    const LUNCH_END = 13 * HOUR;
    const COMPONENT_ORDER = {
      LEC: 0,
      PRA: 1,
      TUT: 2,
      SEM: 3,
      LAB: 4,
    };

    function compareStrings(left, right) {
      const a = String(left == null ? "" : left);
      const b = String(right == null ? "" : right);
      return a < b ? -1 : a > b ? 1 : 0;
    }

    function compareNumbers(left, right) {
      const a = Number(left);
      const b = Number(right);
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    }

    function finiteNumber(value, fallback) {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function normalizedNumber(value) {
      const number = finiteNumber(value, 0);
      return Object.is(number, -0) ? 0 : number;
    }

    function stableStringify(value, active) {
      if (value === null) return "null";
      if (value === undefined) return "undefined";

      const valueType = typeof value;
      if (valueType === "string") return JSON.stringify(value);
      if (valueType === "number") {
        return Number.isFinite(value) ? String(normalizedNumber(value)) : JSON.stringify(String(value));
      }
      if (valueType === "boolean") return value ? "true" : "false";
      if (valueType === "bigint") return `${String(value)}n`;
      if (valueType === "function" || valueType === "symbol") return JSON.stringify(String(value));

      const seen = active || [];
      if (seen.indexOf(value) !== -1) return JSON.stringify("[Circular]");
      seen.push(value);

      let result;
      if (Array.isArray(value)) {
        result = `[${value.map(item => stableStringify(item, seen)).join(",")}]`;
      } else if (typeof Set !== "undefined" && value instanceof Set) {
        const values = Array.from(value, item => stableStringify(item, seen)).sort(compareStrings);
        result = `[${values.join(",")}]`;
      } else if (typeof Map !== "undefined" && value instanceof Map) {
        const entries = Array.from(value, entry =>
          [stableStringify(entry[0], seen), stableStringify(entry[1], seen)])
          .sort((left, right) => compareStrings(left[0], right[0]));
        result = `{${entries.map(entry => `${entry[0]}:${entry[1]}`).join(",")}}`;
      } else {
        const keys = Object.keys(value).sort(compareStrings);
        result = `{${keys.map(key =>
          `${JSON.stringify(key)}:${stableStringify(value[key], seen)}`).join(",")}}`;
      }

      seen.pop();
      return result;
    }

    function timeValue(value) {
      if (value && typeof value === "object") {
        for (const key of ["millisofday", "millisOfDay", "millisecondsOfDay", "ms", "value"]) {
          if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
        }
      }
      return value;
    }

    function normalizeMeeting(value) {
      if (!value || typeof value !== "object") return null;

      const startObject = value.start && typeof value.start === "object" ? value.start : null;
      const endObject = value.end && typeof value.end === "object" ? value.end : null;
      const dayValue = value.day !== undefined
        ? value.day
        : (startObject && startObject.day !== undefined ? startObject.day :
          (endObject && endObject.day !== undefined ? endObject.day : undefined));
      const startValue = timeValue(value.start !== undefined ? value.start : value.startMs);
      const endValue = timeValue(value.end !== undefined ? value.end : value.endMs);
      if (dayValue === undefined || startValue === undefined || endValue === undefined) return null;

      const day = finiteNumber(dayValue, NaN);
      const start = finiteNumber(startValue, NaN);
      const end = finiteNumber(endValue, NaN);
      if (!Number.isFinite(day) || !Number.isFinite(start) || !Number.isFinite(end)) return null;
      return { day, start, end };
    }

    function meetingSignature(value) {
      const meeting = normalizeMeeting(value);
      if (!meeting) return "meeting:invalid";
      return `${normalizedNumber(meeting.day)}:${normalizedNumber(meeting.start)}:${normalizedNumber(meeting.end)}`;
    }

    function compareMeetings(left, right) {
      const a = normalizeMeeting(left) || { day: Infinity, start: Infinity, end: Infinity };
      const b = normalizeMeeting(right) || { day: Infinity, start: Infinity, end: Infinity };
      return compareNumbers(a.day, b.day) ||
        compareNumbers(a.start, b.start) ||
        compareNumbers(a.end, b.end);
    }

    /*
     * Normalize and de-duplicate section meeting records.  The returned shape
     * is intentionally the compact shape consumed by the current renderer and
     * solver: {day, start, end}, all in milliseconds/day-number units.
     */
    function normalizeMeetingList(source) {
      if (!Array.isArray(source)) source = [];

      const seen = new Set();
      const result = [];
      for (const rawMeeting of source) {
        const meeting = normalizeMeeting(rawMeeting);
        if (!meeting) continue;
        const key = meetingSignature(meeting);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(meeting);
      }
      result.sort(compareMeetings);
      return result;
    }

    function meetings(section) {
      let source = section;
      if (section && !Array.isArray(section)) {
        source = section.meetingTimes || section.meetings || [];
      }
      return normalizeMeetingList(source);
    }

    // Empty and non-positive-duration records are normalized for compatibility,
    // but they cannot represent a selectable class in a course candidate.
    function usableMeetings(value) {
      return meetings(value).filter(meeting => meeting.end > meeting.start);
    }

    /* Endpoint-touching intervals are not clashes; only positive intersections are. */
    function overlaps(left, right) {
      const a = normalizeMeeting(left);
      const b = normalizeMeeting(right);
      return !!a && !!b && a.day === b.day && a.start < b.end && b.start < a.end;
    }

    function componentType(value) {
      const raw = value && typeof value === "object"
        ? (value.teachMethod || value.type || value.tm || value.componentType)
        : value;
      const text = String(raw == null ? "" : raw).toUpperCase();
      if (text === "LECTURE" || text === "LECTURES") return "LEC";
      if (text === "TUTORIAL" || text === "TUTORIALS") return "TUT";
      if (text === "PRACTICAL" || text === "PRACTICALS") return "PRA";
      if (text === "LABORATORY" || text === "LABORATORIES") return "LAB";
      if (text === "SEMINAR" || text === "SEMINARS") return "SEM";
      return text || "LEC";
    }

    function sectionName(section) {
      if (!section || typeof section !== "object") return String(section == null ? "" : section);
      return String(section.name || section.sectionName || section.sectionCode || "");
    }

    function sectionSignature(section) {
      const sec = section && section.sec ? section.sec : section;
      return `${componentType(sec)}:${sectionName(sec)}:${meetings(sec).map(meetingSignature).join(",")}`;
    }

    function optionMeetings(option) {
      if (!option) return [];
      if (Array.isArray(option.ms)) return normalizeMeetingList(option.ms);
      if (Array.isArray(option.meetings)) return normalizeMeetingList(option.meetings);
      if (option.sec) return meetings(option.sec);
      if (option.section) return meetings(option.section);
      const meeting = normalizeMeeting(option);
      return meeting ? [meeting] : [];
    }

    function optionType(option) {
      if (!option) return "";
      if (option.lec) return "LEC";
      return componentType(option.tm || option.teachMethod || option.sec || option.section);
    }

    function optionSignature(option) {
      if (!option) return "option:empty";
      const type = optionType(option);
      const sec = option.sec || option.section;
      const names = Array.isArray(option.secs) ? option.secs.map(String).join(",") : "";
      return `${type}:${sec ? sectionName(sec) : ""}:${names}:${optionMeetings(option).map(meetingSignature).join(",")}`;
    }

    function candidateItems(candidate) {
      if (!candidate) return [];
      if (Array.isArray(candidate)) return candidate;
      if (Array.isArray(candidate.pick)) return candidate.pick;
      if (Array.isArray(candidate.items)) return candidate.items;
      if (Array.isArray(candidate.combo)) return candidate.combo;
      if (Array.isArray(candidate.options)) return candidate.options;
      if (Array.isArray(candidate.locked) && !candidate.ms) return candidate.locked;
      return [candidate];
    }

    function candidateSignature(candidate) {
      if (!candidate) return "candidate:empty";
      const code = candidate.code || candidate.courseCode || "";
      const items = candidateItems(candidate)
        .map(optionSignature)
        .sort(compareStrings);
      return `${String(code)}[${items.join(";")}]`;
    }

    function planItems(plan) {
      if (!plan) return [];
      if (Array.isArray(plan)) return plan;
      if (Array.isArray(plan.plan)) return plan.plan;
      if (Array.isArray(plan.courses)) return plan.courses;
      return [plan];
    }

    function planSignature(plan) {
      return planItems(plan).map(candidateSignature).sort(compareStrings).join("|");
    }

    function flattenEvents(value) {
      const events = [];
      for (const entry of planItems(value)) {
        const items = candidateItems(entry);
        for (const item of items) {
          const itemMeetings = optionMeetings(item);
          for (const meeting of itemMeetings) events.push(meeting);
        }
      }
      return events;
    }

    function isClashFree(value, chosen) {
      const left = flattenEvents(value);
      if (chosen !== undefined) {
        const right = flattenEvents(chosen);
        return !left.some(leftMeeting => right.some(rightMeeting => overlaps(leftMeeting, rightMeeting)));
      }
      for (let i = 0; i < left.length; i++) {
        for (let j = i + 1; j < left.length; j++) {
          if (overlaps(left[i], left[j])) return false;
        }
      }
      return true;
    }

    function compareSections(left, right) {
      const typeLeft = componentType(left);
      const typeRight = componentType(right);
      return compareNumbers(
        Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, typeLeft)
          ? COMPONENT_ORDER[typeLeft] : 100,
        Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, typeRight)
          ? COMPONENT_ORDER[typeRight] : 100,
      ) || compareStrings(sectionName(left), sectionName(right)) ||
        compareStrings(sectionSignature(left), sectionSignature(right));
    }

    function compareOptions(left, right) {
      return compareNumbers(
        Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, optionType(left))
          ? COMPONENT_ORDER[optionType(left)] : 100,
        Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, optionType(right))
          ? COMPONENT_ORDER[optionType(right)] : 100,
      ) || compareStrings(optionSignature(left), optionSignature(right));
    }

    function rawCourseCombos(sections) {
      const byType = {};
      for (const section of sections || []) {
        const type = componentType(section);
        if (!Object.prototype.hasOwnProperty.call(byType, type)) byType[type] = [];
        const ms = usableMeetings(section);
        if (ms.length) byType[type].push({ sec: section, ms });
      }
      const types = Object.keys(byType).sort((left, right) => {
        const leftRank = Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, left)
          ? COMPONENT_ORDER[left] : 100;
        const rightRank = Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, right)
          ? COMPONENT_ORDER[right] : 100;
        return compareNumbers(leftRank, rightRank) || compareStrings(left, right);
      });
      let combos = [[]];
      for (const type of types) {
        const options = byType[type].slice().sort(compareOptions);
        const next = [];
        for (const prefix of combos) {
          for (const option of options) next.push(prefix.concat([option]));
        }
        combos = next;
      }
      return combos.filter(combo => isClashFree(combo));
    }

    /*
     * Group raw cache records by course code.  includeCombos defaults to true
     * to mirror the page's existing grouping contract; callers that only need
     * sections can pass {includeCombos:false} to avoid eager Cartesian products.
     */
    function groupCourses(rawCourses, options) {
      if (!Array.isArray(rawCourses)) return [];
      const opts = options || {};
      const grouped = new Map();
      const includeCodes = opts.includeCodes == null
        ? null
        : new Set(Array.from(opts.includeCodes, String));

      for (const entry of rawCourses) {
        if (!entry || entry.code == null) continue;
        const code = String(entry.code);
        if (includeCodes && !includeCodes.has(code)) continue;
        if (!grouped.has(code)) grouped.set(code, { code, name: entry.name || code, sections: [] });
        const target = grouped.get(code);
        if (target.name === code && entry.name) target.name = entry.name;
        const sourceSections = Array.isArray(entry.sections)
          ? entry.sections
          : (entry.section ? [entry.section] : []);
        target.sections.push(...sourceSections.filter(Boolean));
      }

      const courses = Array.from(grouped.values()).map(course => {
        const unique = new Map();
        for (const section of course.sections) unique.set(sectionSignature(section), section);
        const sections = Array.from(unique.values()).sort(compareSections);
        const result = { code: course.code, name: course.name, sections };
        result.combos = opts.includeCombos === false ? [] : rawCourseCombos(sections);
        return result;
      });
      courses.sort((left, right) => compareStrings(left.code, right.code));
      return courses;
    }

    /*
     * Build the page's lecture-position choices.  Position p is the p-th
     * chronological meeting of a section; one section may be used for multiple
     * positions, but selected weekly positions must be on distinct days and may
     * not overlap.
     */
    function buildLecOptions(lectureSections) {
      const sections = (lectureSections || [])
        .filter(section => componentType(section) === "LEC")
        .slice();
      const unique = new Map();
      for (const section of sections) unique.set(sectionSignature(section), section);
      const all = Array.from(unique.values())
        .map(sec => ({ sec, ms: usableMeetings(sec) }))
        .filter(option => option.ms.length)
        .sort((left, right) => compareSections(left.sec, right.sec));
      if (!all.length) return [];

      const count = Math.max(...all.map(option => option.ms.length));
      const positions = [];
      for (let position = 0; position < count; position++) {
        positions[position] = all
          .filter(option => position < option.ms.length)
          .map(option => ({ sec: option.sec, m: option.ms[position] }))
          .sort((left, right) => compareStrings(sectionName(left.sec), sectionName(right.sec)) ||
            compareMeetings(left.m, right.m));
      }

      const choices = [];
      const chosen = [];
      function visit(position) {
        if (position === count) {
          choices.push(chosen.slice());
          return;
        }
        for (const candidate of positions[position]) {
          if (chosen.some(previous => previous.m.day === candidate.m.day)) continue;
          if (chosen.some(previous => overlaps(previous.m, candidate.m))) continue;
          chosen.push(candidate);
          visit(position + 1);
          chosen.pop();
        }
      }
      visit(0);

      const result = [];
      const seen = new Set();
      for (const choice of choices) {
        const option = {
          lec: true,
          sec: { name: "LEC*" },
          ms: choice.map(item => item.m),
          secs: choice.map(item => sectionName(item.sec)),
        };
        const signature = optionSignature(option);
        if (seen.has(signature)) continue;
        seen.add(signature);
        result.push(option);
      }
      result.sort(compareOptions);
      return result;
    }

    function asSet(value) {
      if (value instanceof Set) return value;
      if (Array.isArray(value)) return new Set(value);
      if (value instanceof Map) return new Set(value.keys());
      if (value && typeof value === "object") return new Set(Object.keys(value));
      return new Set();
    }

    function hasSetValue(collection, key) {
      if (collection instanceof Set || collection instanceof Map) return collection.has(key);
      if (Array.isArray(collection)) return collection.includes(key);
      if (collection && typeof collection === "object") return !!collection[key];
      return false;
    }

    function exclusionValue(state, shortName) {
      const key = `useless${shortName.charAt(0).toUpperCase()}${shortName.slice(1)}`;
      if (state && state[key] !== undefined) return state[key];
      if (state && state.exclusions && state.exclusions[shortName] !== undefined)
        return state.exclusions[shortName];
      return undefined;
    }

    function isExcluded(state, code, type, name) {
      if (type === "LEC") return hasSetValue(exclusionValue(state, "lec"), code);
      if (type === "TUT") return hasSetValue(exclusionValue(state, "tut"), code);
      if (type === "PRA") {
        const values = exclusionValue(state, "pra");
        return hasSetValue(values, `${code}|${name}`) || hasSetValue(values, code);
      }
      return false;
    }

    function attendanceValue(state, key) {
      const map = state && (state.tutAttend || state.attendance || state.tutorialAttendance);
      if (map instanceof Map) return map.get(key);
      if (map && typeof map === "object") return map[key];
      return undefined;
    }

    function selectedIndices(value) {
      if (value instanceof Set) return value;
      if (Array.isArray(value)) return new Set(value.map(Number));
      if (value && typeof value === "object") {
        return new Set(Object.keys(value).filter(key => value[key]).map(Number));
      }
      return null;
    }

    function stateLocksForCourse(course, state) {
      const code = String(course.code);
      const source = state && (state.locks !== undefined ? state.locks :
        (state.locked !== undefined ? state.locked : state.lockedByCode));
      if (Array.isArray(source)) {
        return source.filter(lock => String(lock && (lock.code || lock.courseCode || "")) === code);
      }
      if (source instanceof Map) {
        const value = source.get(code);
        return Array.isArray(value) ? value : (value ? [value] : []);
      }
      if (source && typeof source === "object") {
        const value = source[code];
        return Array.isArray(value) ? value : (value ? [value] : []);
      }
      return Array.isArray(course.locked) ? course.locked : [];
    }

    function resolveLockSection(course, lock) {
      if (!lock) return null;
      const reference = lock.sec || lock.section || lock.sectionName ||
        (lock.name && !lock.code ? lock.name : null);
      const sections = course.sections || [];
      if (reference && typeof reference === "object") {
        // A page lock normally carries the exact section object.  Resolve it
        // back to the loaded course record by stable identity so an arbitrary
        // foreign object cannot inject meetings into the candidate.
        const exactSignature = sectionSignature(reference);
        const exact = sections.find(section =>
          section === reference || sectionSignature(section) === exactSignature);
        if (exact) return exact;
        // A name-only object is a supported shorthand; an object carrying
        // meeting data that is not in this course must be rejected, not
        // replaced by a same-named section with different meetings.
        const hasMeetingData = Array.isArray(reference.meetingTimes) ||
          Array.isArray(reference.meetings);
        if (hasMeetingData) return null;
        const name = sectionName(reference);
        return name ? sections.find(section => sectionName(section) === name) || null : null;
      }
      const name = String(reference == null ? "" : reference);
      return sections.find(section => sectionName(section) === name) || null;
    }

    function invalidLock(reason, rawLock, sec, tm) {
      return {
        invalid: true,
        reason,
        tm: tm || null,
        sectionName: sectionName(sec || rawLock && (rawLock.sec || rawLock.section || rawLock.sectionName)),
      };
    }

    function normalizeLock(course, rawLock, state) {
      const requestedType = rawLock &&
        (rawLock.tm || rawLock.teachMethod || rawLock.type);
      const sec = resolveLockSection(course, rawLock);
      const requestedTm = requestedType === undefined
        ? (sec ? componentType(sec) : null)
        : componentType(requestedType);
      if (!sec) return invalidLock("LOCK_SECTION_NOT_FOUND", rawLock, null, requestedTm);

      const sectionTm = componentType(sec);
      if (requestedTm !== sectionTm)
        return invalidLock("LOCK_COMPONENT_MISMATCH", rawLock, sec, requestedTm);
      if (isExcluded(state, course.code, requestedTm, sectionName(sec))) return { excluded: true };

      const sectionMeetings = meetings(sec);
      if (!sectionMeetings.length || sectionMeetings.some(meeting => meeting.end <= meeting.start))
        return invalidLock("LOCK_NO_USABLE_MEETINGS", rawLock, sec, requestedTm);

      const explicitMeetings = rawLock.ms !== undefined
        ? rawLock.ms
        : (rawLock.meetings !== undefined ? rawLock.meetings : rawLock.selectedMeetings);
      let selected;
      if (explicitMeetings !== undefined) {
        if (!Array.isArray(explicitMeetings))
          return invalidLock("LOCK_MEETINGS_INVALID", rawLock, sec, requestedTm);
        const normalizedExplicit = explicitMeetings.map(normalizeMeeting);
        if (normalizedExplicit.some(meeting => !meeting))
          return invalidLock("LOCK_MEETINGS_INVALID", rawLock, sec, requestedTm);
        selected = normalizeMeetingList(normalizedExplicit);
        const sectionKeys = new Set(sectionMeetings.map(meetingSignature));
        if (!selected.length || selected.some(meeting => !sectionKeys.has(meetingSignature(meeting))))
          return invalidLock("LOCK_MEETINGS_NOT_IN_SECTION", rawLock, sec, requestedTm);
      } else {
        selected = sectionMeetings.slice();
        // Attendance subsets are only applied when the caller did not already
        // pass an explicit selected-meeting array. This preserves page-selected
        // subsets exactly rather than applying the indexes a second time.
        if (requestedTm === "TUT") {
          const indices = selectedIndices(attendanceValue(state, `${course.code}|${sectionName(sec)}`));
          if (indices) selected = selected.filter((_, index) => indices.has(index));
          // The page treats an empty attendance subset as an unlocked tutorial;
          // retain that established behavior for the compatibility API.
          if (!selected.length) return null;
        }
      }

      selected = normalizeMeetingList(selected);
      if (!selected.length || selected.some(meeting => meeting.end <= meeting.start))
        return invalidLock("LOCK_NO_USABLE_MEETINGS", rawLock, sec, requestedTm);
      return { sec, ms: selected, tm: requestedTm };
    }

    function normalizeBuildState(state, exclusions, tutAttend) {
      if (Array.isArray(state)) {
        return { locks: state, exclusions: exclusions || {}, tutAttend: tutAttend || new Map() };
      }
      if (!state || typeof state !== "object") {
        return { exclusions: exclusions || {}, tutAttend: tutAttend || new Map() };
      }
      const normalized = Object.assign({}, state);
      if (exclusions !== undefined && normalized.exclusions === undefined)
        normalized.exclusions = exclusions;
      if (tutAttend !== undefined && normalized.tutAttend === undefined)
        normalized.tutAttend = tutAttend;
      return normalized;
    }

    function compareComponentTypes(left, right) {
      const leftRank = Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, left)
        ? COMPONENT_ORDER[left] : 100;
      const rightRank = Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, right)
        ? COMPONENT_ORDER[right] : 100;
      return compareNumbers(leftRank, rightRank) || compareStrings(left, right);
    }

    function comboSignature(combo) {
      return (combo || []).map(optionSignature).join(";");
    }

    /*
     * Build the finite Cartesian product for one course.  `requiredTypes` is
     * deliberately kept separate from the option map: an active component with
     * no viable options must produce zero combos (and therefore a later
     * no-solution result), not silently disappear from the timetable.
     */
    function buildPoolCombos(pool, locked, requiredTypes) {
      const typeSet = new Set(Object.keys(pool || {}));
      for (const type of requiredTypes || []) typeSet.add(type);
      const types = Array.from(typeSet).sort(compareComponentTypes);
      let combos = [[]];
      for (const type of types) {
        const source = pool && Array.isArray(pool[type]) ? pool[type] : [];
        const unique = new Map();
        for (const option of source) unique.set(optionSignature(option), option);
        const options = Array.from(unique.values()).sort(compareOptions);
        // An active type with no candidate makes this course unsatisfiable.  Do
        // not omit the type: doing so would incorrectly drop a required class.
        if (!options.length) return { types, combos: [] };
        const next = [];
        for (const prefix of combos) {
          for (const option of options) next.push(prefix.concat([option]));
        }
        combos = next;
      }

      const lockedEvents = (locked || []).flatMap(lock => optionMeetings(lock));
      const result = [];
      const seen = new Set();
      for (const combo of combos) {
        // Both checks are required here.  The first catches clashes between
        // remaining component choices; the second catches a combo against this
        // course's active locks before a cross-course search begins.
        if (!isClashFree(combo)) continue;
        if (!isClashFree(combo, lockedEvents)) continue;
        const signature = comboSignature(combo);
        if (seen.has(signature)) continue;
        seen.add(signature);
        result.push(combo);
      }
      result.sort((left, right) => compareStrings(comboSignature(left), comboSignature(right)));
      return { types, combos: result };
    }

    /*
     * Build renderer-compatible per-course plan inputs.  The second argument may
     * be a state object ({locks, uselessTut/uselessPra/uselessLec, tutAttend}),
     * a lock array, or omitted.  The optional third/fourth positional arguments
     * retain a convenient compatibility form for callers with separate
     * exclusions and attendance maps.
     */
    function buildCoursePlans(inputCourses, state, exclusions, tutAttend) {
      const buildState = normalizeBuildState(state, exclusions, tutAttend);
      const hasDuplicateCodes = Array.isArray(inputCourses) &&
        new Set(inputCourses.map(course => String(course && course.code || ""))).size !== inputCourses.length;
      const courses = Array.isArray(inputCourses) && !hasDuplicateCodes &&
        inputCourses.every(course => course && Array.isArray(course.sections))
        ? inputCourses.slice()
        : groupCourses(inputCourses, { includeCombos: false });

      const result = [];
      for (const sourceCourse of courses.slice().sort((left, right) =>
        compareStrings(left.code, right.code))) {
        const uniqueSections = new Map();
        for (const section of sourceCourse.sections || []) {
          if (section) uniqueSections.set(sectionSignature(section), section);
        }
        const course = {
          code: String(sourceCourse.code),
          name: sourceCourse.name || String(sourceCourse.code),
          sections: Array.from(uniqueSections.values()).sort(compareSections),
        };
        const normalizedLocks = stateLocksForCourse(course, buildState)
          .map(lock => normalizeLock(course, lock, buildState))
          .filter(Boolean);
        const invalidLocks = normalizedLocks.filter(lock => lock.invalid)
          .sort((left, right) => compareStrings(
            `${left.reason}:${left.tm || ""}:${left.sectionName || ""}`,
            `${right.reason}:${right.tm || ""}:${right.sectionName || ""}`,
          ));
        const locks = normalizedLocks.filter(lock => !lock.invalid && !lock.excluded)
          .sort((left, right) => compareOptions(left, right));
        const lockedTypes = new Set(locks.map(lock => lock.tm));
        const requiredTypes = new Set();
        const pool = {};
        const requireType = (type) => {
          if (lockedTypes.has(type)) return;
          requiredTypes.add(type);
          if (!Object.prototype.hasOwnProperty.call(pool, type)) pool[type] = [];
        };
        const lectures = course.sections.filter(section => componentType(section) === "LEC");

        if (lectures.length && !isExcluded(buildState, course.code, "LEC", "") &&
          !lockedTypes.has("LEC")) {
          requireType("LEC");
          pool.LEC = buildLecOptions(lectures);
        }

        for (const section of course.sections) {
          const type = componentType(section);
          const name = sectionName(section);
          if (type === "LEC" || type === "TUT") continue;
          if (isExcluded(buildState, course.code, type, name)) continue;
          if (lockedTypes.has(type)) continue;
          if (locks.some(lock => lock.sec && sectionName(lock.sec) === name && lock.tm === type)) continue;
          requireType(type);
          const ms = usableMeetings(section);
          if (ms.length) pool[type].push({ sec: section, ms });
        }

        const tutorialSections = course.sections
          .filter(section => componentType(section) === "TUT");
        if (!isExcluded(buildState, course.code, "TUT", "") &&
          !lockedTypes.has("TUT") && tutorialSections.length) {
          // Require TUT before filtering individual sections so an all-invalid
          // tutorial pool remains an explicit no-candidate requirement.
          requireType("TUT");
          for (const section of tutorialSections) {
            const ms = usableMeetings(section);
            if (ms.length) pool.TUT.push({ sec: section, ms });
          }
        }

        for (const type of Object.keys(pool)) {
          const unique = new Map();
          for (const option of pool[type]) unique.set(optionSignature(option), option);
          pool[type] = Array.from(unique.values()).sort(compareOptions);
        }
        const built = buildPoolCombos(pool, locks, requiredTypes);
        result.push({
          code: course.code,
          name: course.name,
          locked: locks,
          invalidLocks,
          poolTypes: built.types,
          // An invalid active lock is a construction failure. Keep the
          // renderer-compatible locked/pool shape, but expose no candidates so
          // the shared search must return a proven NO_SOLUTION.
          combos: invalidLocks.length ? [] : built.combos,
        });
      }
      return result;
    }

    function lockedConflictEntries(plans) {
      const entries = [];
      (plans || []).forEach((course, courseIndex) => {
        const code = String(course && (course.code || course.courseCode || ""));
        (course && course.locked || []).forEach((lock, lockIndex) => {
          optionMeetings(lock).forEach((meeting, meetingIndex) => {
            entries.push({ code, courseIndex, lock, lockIndex, meeting, meetingIndex });
          });
        });
      });
      return entries;
    }

    function lockedConflicts(plans) {
      const entries = lockedConflictEntries(plans);
      const conflicts = [];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const left = entries[i];
          const right = entries[j];
          if (!overlaps(left.meeting, right.meeting)) continue;
          const sameCourse = left.code === right.code;
          const sameLock = sameCourse && left.lockIndex === right.lockIndex;
          conflicts.push({
            reason: sameLock ? "LOCK_INTERNAL_CLASH" :
              (sameCourse ? "INTRA_COURSE_LOCK_CLASH" : "CROSS_COURSE_LOCK_CLASH"),
            scope: sameCourse ? "course" : "cross-course",
            code: sameCourse ? left.code : null,
            courseCodes: [left.code, right.code],
            left: left.lock,
            right: right.lock,
            meetings: { left: left.meeting, right: right.meeting },
            leftMeeting: left.meeting,
            rightMeeting: right.meeting,
          });
        }
      }
      return conflicts;
    }

    function lockedConflict(plans) {
      return lockedConflicts(plans)[0] || null;
    }

    function invalidLockEntries(plans) {
      const entries = [];
      (plans || []).forEach((course, courseIndex) => {
        for (const lock of (course && course.invalidLocks) || []) {
          entries.push({
            courseIndex,
            code: String(course && (course.code || course.courseCode || "")),
            lock,
          });
        }
      });
      return entries.sort((left, right) =>
        compareStrings(`${left.code}:${left.lock.reason}:${left.lock.sectionName || ""}`,
          `${right.code}:${right.lock.reason}:${right.lock.sectionName || ""}`));
    }

    /*
     * Validate all active locks, including every pair within one course and all
     * cross-course pairs. Invalid active-lock references are construction
     * failures too; they must not disappear and allow a replacement choice.
     */
    function validateLockedSections(plans, options) {
      const invalidLocks = invalidLockEntries(plans || []);
      const conflicts = lockedConflicts(plans || []);
      const diagnostics = {
        valid: invalidLocks.length === 0 && conflicts.length === 0,
        conflict: conflicts[0] || null,
        conflicts,
        invalidLocks,
        status: invalidLocks.length || conflicts.length ? "NO_SOLUTION" : "VALID",
        reason: invalidLocks.length
          ? invalidLocks[0].lock.reason
          : (conflicts.length ? conflicts[0].reason : null),
      };
      if (options && options.details) return diagnostics;
      return diagnostics.valid;
    }

    function normalizeWeight(value, fallback) {
      if (value === undefined) return fallback;
      if (value === true) return 1;
      if (value === false || value === null) return 0;
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function normalizeOptions(options) {
      const source = options || {};
      return {
        campus: normalizeWeight(source.campus, 1),
        lunch: normalizeWeight(source.lunch, 0),
        early: normalizeWeight(source.early, 0),
        late: normalizeWeight(source.late, 0),
      };
    }

    function dayBlocks(plan) {
      const byDay = new Map();
      for (const event of flattenEvents(plan)) {
        if (!byDay.has(event.day)) byDay.set(event.day, []);
        byDay.get(event.day).push({ start: event.start, end: event.end });
      }
      for (const blocks of byDay.values()) {
        blocks.sort((left, right) => compareNumbers(left.start, right.start) ||
          compareNumbers(left.end, right.end));
      }
      return byDay;
    }

    /*
     * Return the occupied union for one day.  Merging touching intervals is
     * intentional: an endpoint between two classes is not free time, and a
     * touching pair must not introduce a campus or lunch gap.
     */
    function mergeBlocks(blocks) {
      const sorted = (blocks || [])
        .filter(block => block && Number.isFinite(block.start) &&
          Number.isFinite(block.end) && block.end > block.start)
        .map(block => ({ start: block.start, end: block.end }))
        .sort((left, right) => compareNumbers(left.start, right.start) ||
          compareNumbers(left.end, right.end));
      const merged = [];
      for (const block of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || block.start > previous.end) {
          merged.push(block);
        } else {
          previous.end = Math.max(previous.end, block.end);
        }
      }
      return merged;
    }

    function mergedOccupiedMs(blocks, start, end) {
      const intervals = [];
      for (const block of blocks || []) {
        const left = Math.max(start, block.start);
        const right = Math.min(end, block.end);
        if (right > left) intervals.push({ start: left, end: right });
      }
      return mergeBlocks(intervals).reduce((total, interval) =>
        total + interval.end - interval.start, 0);
    }

    /*
     * Evaluate all objective measurements once using the shared integer time
     * unit (milliseconds).  Raw blocks are retained for class start/end sums,
     * while their occupied union is used for campus gaps and lunch.  This keeps
     * overlapping input blocks from double-counting occupied lunch time and
     * keeps campus gaps correct even for a defensive evaluation of a plan that
     * has not yet passed clash validation.
     *
     * Hour-equivalent aliases are included for the existing #optInfo display
     * and for callers that used the old score arithmetic directly.
     */
    function evaluatePlan(plan) {
      const byDay = dayBlocks(plan || []);
      let gapsMs = 0;
      let sumStartMs = 0;
      let sumEndMs = 0;
      let lunchDeficitMs = 0;

      for (const blocks of byDay.values()) {
        const occupied = mergeBlocks(blocks);
        for (let index = 1; index < occupied.length; index++) {
          gapsMs += Math.max(0, occupied[index].start - occupied[index - 1].end);
        }
        for (const block of blocks) {
          sumStartMs += block.start;
          sumEndMs += block.end;
        }
        const lunchFreeMs = (LUNCH_END - LUNCH_START) -
          mergedOccupiedMs(blocks, LUNCH_START, LUNCH_END);
        if (lunchFreeMs < HOUR) lunchDeficitMs += HOUR - lunchFreeMs;
      }

      const activeDays = byDay.size;
      const campusMs = activeDays * HOUR + gapsMs;
      return {
        activeDays,
        activeDayCount: activeDays,
        gapsMs,
        gapMs: gapsMs,
        campusMs,
        lunchDeficitMs,
        sumStartMs,
        sumEndMs,
        startTimeMs: sumStartMs,
        endTimeMs: sumEndMs,
        campus: campusMs / HOUR,
        gaps: gapsMs / HOUR,
        lunchDeficit: lunchDeficitMs / HOUR,
        lunch: lunchDeficitMs / HOUR,
        sumStartHours: sumStartMs / HOUR,
        sumEndHours: sumEndMs / HOUR,
        early: sumEndMs / HOUR,
        late: -sumStartMs / HOUR,
        signature: planSignature(plan || []),
      };
    }

    /*
     * Keep the page-facing penalty as the legacy normalized additive score.
     * The exact search uses comparePlans/objectiveKey below for its ordering;
     * specifically, lunch is a lexicographic tier there rather than an
     * arbitrary weighted trade-off.  Both paths consume this same evaluation
     * object, so no objective term can drift between display and comparison.
     */
    function scoreEvaluation(evaluation, options) {
      return (options.campus * evaluation.campusMs +
        options.lunch * evaluation.lunchDeficitMs +
        options.early * evaluation.sumEndMs -
        options.late * evaluation.sumStartMs) / HOUR;
    }

    function scorePlan(plan, options) {
      return scoreEvaluation(evaluatePlan(plan || []), normalizeOptions(options));
    }

    function isEvaluation(value) {
      return !!(value && typeof value === "object" &&
        Number.isFinite(Number(value.campusMs)) &&
        Number.isFinite(Number(value.lunchDeficitMs)) &&
        Number.isFinite(Number(value.sumEndMs)) &&
        Number.isFinite(Number(value.sumStartMs)));
    }

    function asEvaluation(value) {
      if (isEvaluation(value)) return value;
      if (value && value.plan) return evaluatePlan(value.plan);
      return evaluatePlan(value || []);
    }

    function objectiveKey(value, options) {
      const opts = normalizeOptions(options);
      const evaluation = asEvaluation(value);
      const nonLunchMs = opts.campus * evaluation.campusMs +
        opts.early * evaluation.sumEndMs - opts.late * evaluation.sumStartMs;
      // Lunch is deliberately a lexicographic tier when enabled.  This keeps a
      // feasible one-hour lunch from being traded away for another preference.
      return {
        lunchDeficitMs: opts.lunch ? evaluation.lunchDeficitMs : 0,
        combinedMs: nonLunchMs,
        totalMs: nonLunchMs + (opts.lunch ? evaluation.lunchDeficitMs : 0),
      };
    }

    function compareEvaluations(leftEvaluation, rightEvaluation, options) {
      const opts = normalizeOptions(options);
      const leftKey = objectiveKey(leftEvaluation, opts);
      const rightKey = objectiveKey(rightEvaluation, opts);
      if (leftKey.lunchDeficitMs !== rightKey.lunchDeficitMs)
        return leftKey.lunchDeficitMs < rightKey.lunchDeficitMs ? -1 : 1;
      if (leftKey.combinedMs !== rightKey.combinedMs)
        return leftKey.combinedMs < rightKey.combinedMs ? -1 : 1;
      return compareStrings(
        leftEvaluation.signature || "",
        rightEvaluation.signature || "",
      );
    }

    function comparePlans(left, right, options) {
      return compareEvaluations(asEvaluation(left), asEvaluation(right), options);
    }

    function normalizePlanInput(plans) {
      if (!Array.isArray(plans)) return [];
      return plans.map(course => {
        const normalized = {
          code: String(course && (course.code || course.courseCode || "")),
          name: course && course.name ? course.name : String(course && course.code || ""),
          locked: [],
          invalidLocks: Array.isArray(course && course.invalidLocks)
            ? course.invalidLocks.map(lock => ({
              invalid: true,
              reason: String(lock && lock.reason || "INVALID_LOCK"),
              tm: lock && lock.tm ? String(lock.tm) : null,
              sectionName: lock && lock.sectionName ? String(lock.sectionName) : "",
            }))
            : [],
          poolTypes: Array.isArray(course && course.poolTypes) ? course.poolTypes.slice() : [],
          combos: [],
        };
        for (const lock of (course && course.locked) || []) {
          const ms = optionMeetings(lock);
          if (!ms.length || ms.some(meeting => meeting.end <= meeting.start)) {
            normalized.invalidLocks.push({
              invalid: true,
              reason: "LOCK_NO_USABLE_MEETINGS",
              tm: componentType(lock && (lock.tm || lock.teachMethod || lock.type || lock.sec)),
              sectionName: sectionName(lock && (lock.sec || lock.section || lock)),
            });
          }
          normalized.locked.push({
            sec: lock && (lock.sec || lock.section) || { name: sectionName(lock) },
            ms,
            tm: componentType(lock && (lock.tm || lock.teachMethod || lock.type || lock.sec)),
          });
        }
        normalized.locked.sort(compareOptions);
        // Canonicalize component types using the same order as candidate
        // construction.  Candidate option order is not part of feasibility,
        // so final validation matches required types as a set below; keeping
        // this order stable makes normalized inputs deterministic.
        normalized.poolTypes.sort(compareComponentTypes);
        normalized.combos = (Array.isArray(course && course.combos) ? course.combos : [])
          .map(combo => (Array.isArray(combo) ? combo : []).map(option => ({
            ...option,
            ms: optionMeetings(option),
          })))
          .sort((left, right) => compareStrings(
            left.map(optionSignature).sort(compareStrings).join(";"),
            right.map(optionSignature).sort(compareStrings).join(";"),
          ));
        return normalized;
      }).sort((left, right) => compareStrings(left.code, right.code));
    }

    /*
     * Search helpers intentionally live next to findBestPlan so the exact
     * engine has one implementation of candidate construction, occupancy
     * checks, bounds, and final validation.  A candidate is renderer-shaped
     * ({code, name, pick}) plus private search metadata kept in a descriptor.
     */
    function findBestPlan(plans, options, hooks) {
      const progressCallback = typeof hooks === "function"
        ? hooks
        : hooks && typeof hooks.onProgress === "function"
          ? hooks.onProgress
          : null;
      const debugCallback = hooks && typeof hooks.onDebug === "function"
        ? hooks.onDebug
        : null;
      const PROGRESS_INTERVAL = 128;
      const requestedSearchCountOffset = Number(
        options && options.__searchCountOffset,
      );
      const searchCountOffset = Number.isFinite(requestedSearchCountOffset)
        ? Math.max(0, Math.floor(requestedSearchCountOffset)) : 0;
      // Keep the public/protocol name for compatibility, but count recursive
      // search states rather than only complete timetable evaluations.
      let combinationsSearched = searchCountOffset;
      const emitProgress = (done = false) => {
        if (!progressCallback) return;
        if (done || combinationsSearched === 1 ||
          combinationsSearched % PROGRESS_INTERVAL === 0) {
          progressCallback({ combinationsSearched, done });
        }
      };
      const countSearchState = () => {
        combinationsSearched++;
        emitProgress(false);
      };
      const finishResult = result => {
        emitProgress(true);
        const diagnostics = result.diagnostics
          ? Object.assign({}, result.diagnostics, { combinationsSearched })
          : result.diagnostics;
        return Object.assign({}, result, { combinationsSearched, diagnostics });
      };

      const normalizedPlans = normalizePlanInput(plans);
      const opts = normalizeOptions(options);
      // The first lunch-enabled pass can safely omit candidates whose own
      // schedule already destroys the lunch gap, because a zero-deficit plan
      // is always preferable. If that restricted pass cannot find zero lunch
      // deficit, rerun exactly with every candidate so a positive-deficit
      // optimum remains available.
      const includePositiveLunchCandidates = !!(
        options && options.__includePositiveLunchDeficitCandidates
      );
      const filterUnsafeLunchCandidates = opts.lunch !== 0 &&
        !includePositiveLunchCandidates;
      const retryWithAllLunchCandidates = () => findBestPlan(
        plans,
        Object.assign({}, options || {}, {
          __includePositiveLunchDeficitCandidates: true,
          __searchCountOffset: combinationsSearched,
        }),
        hooks,
      );
      const lockDiagnostics = validateLockedSections(normalizedPlans, { details: true });
      const diagnostics = normalizedPlans.length ? lockDiagnostics : {
        valid: false,
        conflict: null,
        conflicts: [],
        status: "NO_SOLUTION",
        reason: "NO_COURSES",
      };
      const base = {
        plan: null,
        status: "NO_SOLUTION",
        complete: true,
        optimal: true,
        nodesVisited: 0,
        combinationsSearched: 0,
        evaluation: null,
        objective: null,
        score: null,
        signature: null,
        options: opts,
        diagnostics: Object.assign({}, diagnostics, { combinationsSearched: 0 }),
      };

      // Lock conflicts are rejected before candidate enumeration.  In
      // particular, this catches two active locks from the same course rather
      // than allowing the current course's locks to bypass one another.
      if (!normalizedPlans.length || !diagnostics.valid) return finishResult(base);

      const duplicateCodes = new Set();
      for (const course of normalizedPlans) {
        if (duplicateCodes.has(course.code)) {
          return finishResult(Object.assign({}, base, {
            diagnostics: Object.assign({}, diagnostics, {
              valid: false,
              status: "NO_SOLUTION",
              reason: "DUPLICATE_COURSE_CODE",
            }),
          }));
        }
        duplicateCodes.add(course.code);
      }

      const candidateEventList = (candidate) => {
        const result = [];
        for (const item of candidateItems(candidate)) {
          for (const meeting of optionMeetings(item)) result.push(meeting);
        }
        return result;
      };

      const candidateStats = (events) => {
        const days = new Set();
        let sumStartMs = 0;
        let sumEndMs = 0;
        for (const meeting of events) {
          days.add(meeting.day);
          sumStartMs += meeting.start;
          sumEndMs += meeting.end;
        }
        return { days, sumStartMs, sumEndMs };
      };

      // Lunch deficit is monotone under adding meetings: a candidate that
      // already consumes too much of a day's lunch window can never appear in
      // a zero-deficit completion. Keep that fact on the candidate rather than
      // discarding it during construction, because lunch is an objective: when
      // no zero-deficit timetable exists, a positive-deficit candidate may be
      // part of the exact optimum.
      const candidateHasLunchGap = events => {
        if (!opts.lunch) return true;
        const byDay = new Map();
        for (const meeting of events) {
          if (!byDay.has(meeting.day)) byDay.set(meeting.day, []);
          byDay.get(meeting.day).push(meeting);
        }
        for (const blocks of byDay.values()) {
          const free = (LUNCH_END - LUNCH_START) -
            mergedOccupiedMs(blocks, LUNCH_START, LUNCH_END);
          if (free < HOUR) return false;
        }
        return true;
      };

      /*
       * Convert every meeting endpoint in the finite input to elementary
       * weekly segments.  A candidate's BigInt mask contains exactly the
       * positive-duration segments it occupies.  Therefore a mask intersection
       * is equivalent to overlaps(), including the endpoint-touching rule,
       * without making assumptions about hour/minute granularity.
       */
      const candidateSets = [];
      const allBoundaries = new Map();
      const addBoundary = (day, value) => {
        if (!allBoundaries.has(day)) allBoundaries.set(day, new Set());
        allBoundaries.get(day).add(value);
      };

      for (const course of normalizedPlans) {
        const sourceCombos = course.poolTypes.length
          ? course.combos
          : [[]];
        const unique = new Map();
        for (const rawCombo of sourceCombos || []) {
          const combo = Array.isArray(rawCombo) ? rawCombo : [];
          if (course.poolTypes.length && (
            combo.length !== course.poolTypes.length ||
            combo.some(option => {
              const events = optionMeetings(option);
              return !events.length || events.some(meeting => meeting.end <= meeting.start);
            })
          )) continue;
          const pick = (course.locked || []).concat(combo);
          const candidate = {
            code: course.code,
            name: course.name,
            pick,
          };
          // This is a defensive second check in addition to buildCoursePlans:
          // callers may provide normalized plans directly, and no internally
          // conflicting candidate may enter the exact search.
          if (!isClashFree([candidate])) continue;
          const events = candidateEventList(candidate);
          const lunchSafe = candidateHasLunchGap(events);
          if (filterUnsafeLunchCandidates && !lunchSafe) continue;
          const signature = candidateSignature(candidate);
          const equivalenceKey = candidateItems(candidate)
            .map(item => `${optionType(item)}:${optionMeetings(item)
              .map(meetingSignature).sort(compareStrings).join(",")}`)
            .sort(compareStrings)
            .join("|");
          const previous = unique.get(equivalenceKey);
          // Candidates with identical typed event schedules have identical
          // feasibility and objective behavior. Retain the lexicographically
          // smallest section signature so deduplication cannot change the
          // stable tie contract or attendance/component shape.
          if (previous && compareStrings(previous.signature, signature) <= 0) continue;
          for (const meeting of events) {
            if (meeting.end > meeting.start) {
              addBoundary(meeting.day, meeting.start);
              addBoundary(meeting.day, meeting.end);
            }
          }
          const stats = candidateStats(events);
          unique.set(equivalenceKey, {
            plan: candidate,
            combo,
            signature,
            lunchSafe,
            events,
            days: stats.days,
            sumStartMs: stats.sumStartMs,
            sumEndMs: stats.sumEndMs,
            masks: new Map(),
          });
        }
        const candidates = Array.from(unique.values())
          .sort((left, right) => compareStrings(left.signature, right.signature));
        candidateSets.push({ course, candidates, possibleMasks: new Map() });
      }

      // A candidate that overlaps a fixed lock from another course can never
      // participate in a valid plan. Apply this cross-course lock filter once
      // before the recursive search; locks in the candidate's own course are
      // intentionally ignored because they were already validated together.
      const lockedEventsByCode = new Map(normalizedPlans.map(course => [
        course.code,
        (course.locked || []).flatMap(lock => optionMeetings(lock), []),
      ]));
      for (const entry of candidateSets) {
        const otherLockedEvents = [];
        for (const [code, events] of lockedEventsByCode.entries()) {
          if (code !== entry.course.code) otherLockedEvents.push(...events);
        }
        if (!otherLockedEvents.length) continue;
        entry.candidates = entry.candidates.filter(candidate =>
          !candidate.events.some(event =>
            otherLockedEvents.some(lockedEvent => overlaps(event, lockedEvent)),
          ));
      }

      const noCandidate = candidateSets.find(entry => entry.candidates.length === 0);
      if (noCandidate) {
        if (filterUnsafeLunchCandidates) return retryWithAllLunchCandidates();
        return finishResult(Object.assign({}, base, {
          diagnostics: Object.assign({}, diagnostics, {
            status: "NO_SOLUTION",
            reason: "NO_FEASIBLE_CANDIDATE",
            courseCode: noCandidate.course.code,
          }),
        }));
      }

      const boundaryIndexes = new Map();
      for (const [day, values] of allBoundaries.entries()) {
        const sorted = Array.from(values).sort(compareNumbers);
        const indexes = new Map(sorted.map((value, index) => [value, index]));
        boundaryIndexes.set(day, { values: sorted, indexes });
      }

      const maskForMeeting = (meeting) => {
        if (!(meeting.end > meeting.start)) return 0n;
        const day = boundaryIndexes.get(meeting.day);
        if (!day) return 0n;
        const startIndex = day.indexes.get(meeting.start);
        const endIndex = day.indexes.get(meeting.end);
        if (startIndex === undefined || endIndex === undefined || endIndex <= startIndex)
          return 0n;
        const width = BigInt(endIndex - startIndex);
        return ((1n << width) - 1n) << BigInt(startIndex);
      };

      for (const entry of candidateSets) {
        for (const candidate of entry.candidates) {
          for (const meeting of candidate.events) {
            const mask = maskForMeeting(meeting);
            if (mask === 0n) continue;
            candidate.masks.set(meeting.day,
              (candidate.masks.get(meeting.day) || 0n) | mask);
          }
        }
        for (const candidate of entry.candidates) {
          for (const [day, mask] of candidate.masks.entries())
            entry.possibleMasks.set(day, (entry.possibleMasks.get(day) || 0n) | mask);
        }
      }

      const masksOverlap = (left, right) => {
        for (const [day, mask] of left.entries()) {
          if (((right.get(day) || 0n) & mask) !== 0n) return true;
        }
        return false;
      };

      // Most-constrained first: the smallest viable candidate set, followed by
      // the greatest number of other courses that can potentially conflict,
      // then the course code.  The degree uses union masks, so ordering remains
      // deterministic without an O(candidate^2) pairwise precomputation.
      for (let i = 0; i < candidateSets.length; i++) {
        let degree = 0;
        for (let j = 0; j < candidateSets.length; j++) {
          if (i === j) continue;
          if (masksOverlap(candidateSets[i].possibleMasks, candidateSets[j].possibleMasks))
            degree++;
        }
        candidateSets[i].conflictDegree = degree;
      }
      candidateSets.sort((left, right) =>
        compareNumbers(left.candidates.length, right.candidates.length) ||
        compareNumbers(right.conflictDegree, left.conflictDegree) ||
        compareStrings(left.course.code, right.course.code));
      if (debugCallback) debugCallback({
        phase: "candidate-sets",
        counts: candidateSets.map(entry => ({
          code: entry.course.code,
          candidates: entry.candidates.length,
        })),
      });

      const dayBitMask = (days) => {
        let mask = 0;
        for (const day of days) {
          const number = Number(day);
          if (number >= 1 && number <= 30) mask |= 1 << (number - 1);
        }
        return mask >>> 0;
      };

      for (let index = 0; index < candidateSets.length; index++) {
        const entry = candidateSets[index];
        let minimumEnd = Infinity;
        let maximumStart = -Infinity;
        const dayMasks = new Set();
        for (const candidate of entry.candidates) {
          minimumEnd = Math.min(minimumEnd, candidate.sumEndMs);
          maximumStart = Math.max(maximumStart, candidate.sumStartMs);
          dayMasks.add(dayBitMask(candidate.days));
        }
        entry.minimumEnd = minimumEnd;
        entry.maximumStart = maximumStart;
        entry.dayMasks = Array.from(dayMasks);
        // Search inputs in the application are small enough for a numeric
        // remaining-course mask. Keep a fallback for larger direct inputs.
        entry.searchBit = candidateSets.length <= 30 ? 2 ** index : 0;
      }

      const subsetCacheEnabled = candidateSets.length <= 30;
      const allRemainingMask = subsetCacheEnabled
        ? (2 ** candidateSets.length) - 1 : 0;
      const possibleMasksByRemaining = new Map([[0, new Map()]]);
      const possibleMasksForRemaining = remainingMask => {
        if (!subsetCacheEnabled) return null;
        const cached = possibleMasksByRemaining.get(remainingMask);
        if (cached) return cached;
        const low = remainingMask & -remainingMask;
        const entryIndex = Math.log2(low);
        const previous = possibleMasksForRemaining(remainingMask - low);
        const entry = candidateSets[entryIndex];
        const result = new Map(previous);
        for (const [day, mask] of entry.possibleMasks.entries())
          result.set(day, (result.get(day) || 0n) | mask);
        possibleMasksByRemaining.set(remainingMask, result);
        return result;
      };
      const subsetTableEnabled = candidateSets.length <= 16;
      const remainingSubsetCount = subsetTableEnabled ? 2 ** candidateSets.length : 0;
      const minimumEndByRemaining = subsetTableEnabled
        ? new Float64Array(remainingSubsetCount) : null;
      const maximumStartByRemaining = subsetTableEnabled
        ? new Float64Array(remainingSubsetCount) : null;
      if (subsetTableEnabled) {
        for (let mask = 1; mask < remainingSubsetCount; mask++) {
          const low = mask & -mask;
          const entryIndex = Math.log2(low);
          const previous = mask - low;
          minimumEndByRemaining[mask] =
            minimumEndByRemaining[previous] + candidateSets[entryIndex].minimumEnd;
          maximumStartByRemaining[mask] =
            maximumStartByRemaining[previous] + candidateSets[entryIndex].maximumStart;
        }
      }

      const popcount32 = (value) => {
        let number = value >>> 0;
        number = number - ((number >>> 1) & 0x55555555);
        number = (number & 0x33333333) + ((number >>> 2) & 0x33333333);
        return (((number + (number >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
      };
      const lowestSetBitIndex = (value) => {
        const lowest = value & -value;
        return lowest.toString(2).length - 1;
      };

      /*
       * Build an exact candidate bitset index for every elementary segment.
       * A posting word has one bit per candidate that occupies that segment;
       * OR-ing postings for the current occupancy produces the forbidden set.
       * This is very fast for small domains, but materializing a target-course
       * bitset for every candidate can itself be much more expensive than the
       * search for a large real cache. Estimate that allocation first and use
       * the equivalent occupancy-mask check on demand when it would exceed a
       * bounded working-set budget.
       */
      const totalCandidateCount = candidateSets.reduce((total, entry) =>
        total + entry.candidates.length, 0);
      const totalPostingWords = candidateSets.reduce((total, entry) =>
        total + Math.ceil(entry.candidates.length / 32), 0);
      const estimatedBlockedWords = candidateSets.reduce((total, entry) =>
        total + entry.candidates.length * (totalPostingWords -
          Math.ceil(entry.candidates.length / 32)), 0);
      // Uint32 words are only part of the indexed representation; Maps and
      // per-candidate typed arrays add substantial overhead. Keep this bound
      // deliberately conservative so large cache inputs never spend minutes
      // compiling an index that competes with the actual search for memory.
      const MAX_INDEXED_BLOCKED_WORDS = 2_000_000;
      const useIndexedAvailability = estimatedBlockedWords <= MAX_INDEXED_BLOCKED_WORDS;
      const segmentTargetsByDay = useIndexedAvailability ? new Map() : null;
      const addSegmentTarget = (day, segmentIndex, entry, posting) => {
        let targetsBySegment = segmentTargetsByDay.get(day);
        if (!targetsBySegment) {
          targetsBySegment = [];
          segmentTargetsByDay.set(day, targetsBySegment);
        }
        let targets = targetsBySegment[segmentIndex];
        if (!targets) {
          targets = [];
          targetsBySegment[segmentIndex] = targets;
        }
        targets.push({ entry, posting });
      };

      for (const entry of candidateSets) {
        const wordCount = Math.ceil(entry.candidates.length / 32);
        entry.wordCount = wordCount;
        entry.blockedCount = 0;
        entry.blockedDepth = 0;
        entry.selected = false;
        for (const candidate of entry.candidates) candidate.ownerEntry = entry;
        if (!useIndexedAvailability) continue;

        const allWords = new Uint32Array(wordCount);
        allWords.fill(0xffffffff);
        const remainder = entry.candidates.length % 32;
        if (remainder) allWords[wordCount - 1] = (2 ** remainder - 1) >>> 0;
        entry.allWords = allWords;
        entry.blockedWords = new Uint32Array(wordCount);
        entry.postingsByDay = new Map();
        for (let candidateIndex = 0; candidateIndex < entry.candidates.length; candidateIndex++) {
          const candidate = entry.candidates[candidateIndex];
          candidate.occupiedSegments = [];
          for (const [day, mask] of candidate.masks.entries()) {
            const boundary = boundaryIndexes.get(day);
            if (!boundary) continue;
            let postings = entry.postingsByDay.get(day);
            if (!postings) {
              postings = new Array(Math.max(0, boundary.values.length - 1));
              entry.postingsByDay.set(day, postings);
            }
            let remainingMask = mask;
            while (remainingMask !== 0n) {
              const segmentIndex = lowestSetBitIndex(remainingMask);
              candidate.occupiedSegments.push({ day, segmentIndex });
              let posting = postings[segmentIndex];
              if (!posting) {
                posting = new Uint32Array(wordCount);
                postings[segmentIndex] = posting;
                addSegmentTarget(day, segmentIndex, entry, posting);
              }
              const word = candidateIndex >>> 5;
              posting[word] |= (1 << (candidateIndex & 31));
              remainingMask &= remainingMask - 1n;
            }
          }
        }
      }

      if (useIndexedAvailability) {
        // Collapse all occupied segments of one candidate into one posting
        // union per target course. A candidate can occupy several elementary
        // segments; applying their OR once avoids repeated word updates.
        for (const entry of candidateSets) {
          for (const candidate of entry.candidates) {
            const updates = new Map();
            for (const segment of candidate.occupiedSegments) {
              const targetsBySegment = segmentTargetsByDay.get(segment.day);
              const targets = targetsBySegment && targetsBySegment[segment.segmentIndex];
              if (!targets) continue;
              for (const target of targets) {
                if (target.entry === entry) continue;
                let words = updates.get(target.entry);
                if (!words) {
                  words = new Uint32Array(target.entry.wordCount);
                  updates.set(target.entry, words);
                }
                for (let word = 0; word < target.entry.wordCount; word++)
                  words[word] |= target.posting[word];
              }
            }
            candidate.blockedUpdatesByEntry = updates;
            candidate.occupiedSegments = null;
          }
        }
        // The search uses the compiled candidate updates, not the construction
        // postings. Release the temporary reverse index before traversal.
        for (const entry of candidateSets) entry.postingsByDay = null;
        segmentTargetsByDay.clear();
      }
      if (debugCallback) debugCallback({
        phase: "candidate-availability",
        mode: useIndexedAvailability ? "indexed" : "on-demand",
        candidates: totalCandidateCount,
        estimatedBlockedWords,
      });

      const occupancy = new Map();
      const selected = [];
      const selectedDays = new Set();
      let selectedDayMask = 0;
      const selectedBlocks = new Map();
      let selectedStartMs = 0;
      let selectedEndMs = 0;
      let nodesVisited = searchCountOffset;
      let prunedNodes = 0;
      let bestPlan = null;
      let bestEvaluation = null;
      let bestObjective = null;

      /*
       * The lunch bound is a monotone prefix value: adding a candidate can
       * only increase the occupied union inside the lunch window.  Keep that
       * union incrementally instead of rebuilding and sorting every selected
       * meeting at every search state.  Intervals are copied on update, so the
       * previous array can be restored directly by the LIFO backtracker.
       */
      const lunchEnabled = opts.lunch !== 0;
      const lunchBlocks = new Map();
      const lunchDayDeficits = new Map();
      let selectedLunchDeficit = 0;

      const lunchDeficitForBlocks = blocks => {
        let occupied = 0;
        for (const block of blocks) occupied += block.end - block.start;
        const free = (LUNCH_END - LUNCH_START) - occupied;
        return free < HOUR ? HOUR - free : 0;
      };

      const insertLunchBlock = (blocks, block) => {
        const merged = [];
        let start = block.start;
        let end = block.end;
        let inserted = false;
        for (const existing of blocks) {
          // Touching intervals belong to the same occupied union, matching
          // mergeBlocks() and the evaluator's endpoint semantics.
          if (existing.end < start) {
            merged.push(existing);
          } else if (end < existing.start) {
            if (!inserted) {
              merged.push({ start, end });
              inserted = true;
            }
            merged.push(existing);
          } else {
            start = Math.min(start, existing.start);
            end = Math.max(end, existing.end);
          }
        }
        if (!inserted) merged.push({ start, end });
        return merged;
      };

      const candidateLunchIntervals = candidate => {
        const byDay = new Map();
        for (const meeting of candidate.events) {
          const start = Math.max(LUNCH_START, meeting.start);
          const end = Math.min(LUNCH_END, meeting.end);
          if (!(end > start)) continue;
          if (!byDay.has(meeting.day)) byDay.set(meeting.day, []);
          byDay.get(meeting.day).push({ start, end });
        }
        for (const [day, blocks] of byDay.entries())
          byDay.set(day, mergeBlocks(blocks));
        return byDay;
      };

      const intersectLunchBlocks = (left, right) => {
        const result = [];
        let leftIndex = 0;
        let rightIndex = 0;
        while (leftIndex < left.length && rightIndex < right.length) {
          const start = Math.max(left[leftIndex].start, right[rightIndex].start);
          const end = Math.min(left[leftIndex].end, right[rightIndex].end);
          if (end > start) result.push({ start, end });
          if (left[leftIndex].end < right[rightIndex].end) leftIndex++;
          else rightIndex++;
        }
        return result;
      };

      const unionLunchMaps = (left, right) => {
        const result = new Map(left);
        for (const [day, blocks] of right.entries()) {
          let merged = result.get(day) || [];
          for (const block of blocks) merged = insertLunchBlock(merged, block);
          if (merged.length) result.set(day, merged);
        }
        return result;
      };

      /*
       * Every completion must occupy the intersection of the lunch intervals
       * shared by all candidates of each remaining course.  Unioning those
       * mandatory intervals with the selected prefix gives an admissible,
       * substantially stronger lunch lower bound than the prefix alone.
       */
      const mandatoryLunchByEntry = new Map();
      if (lunchEnabled) {
        for (const entry of candidateSets) {
          let mandatory = null;
          for (const candidate of entry.candidates) {
            candidate.lunchIntervals = candidateLunchIntervals(candidate);
            if (mandatory === null) {
              mandatory = new Map(candidate.lunchIntervals);
              continue;
            }
            for (const day of Array.from(mandatory.keys())) {
              const intersection = intersectLunchBlocks(
                mandatory.get(day),
                candidate.lunchIntervals.get(day) || [],
              );
              if (intersection.length) mandatory.set(day, intersection);
              else mandatory.delete(day);
            }
          }
          mandatoryLunchByEntry.set(entry, mandatory || new Map());
        }
      }
      if (debugCallback) debugCallback({
        phase: "mandatory-lunch",
        entries: candidateSets.map(entry => {
          const mandatory = mandatoryLunchByEntry.get(entry) || new Map();
          return {
            code: entry.course.code,
            days: Array.from(mandatory.keys()),
            blocks: Array.from(mandatory.values())
              .reduce((total, blocks) => total + blocks.length, 0),
          };
        }),
      });

      const mandatoryLunchByRemaining = new Map([[0, new Map()]]);
      const mandatoryLunchForRemaining = remainingMask => {
        if (!lunchEnabled || !subsetCacheEnabled) return null;
        const cached = mandatoryLunchByRemaining.get(remainingMask);
        if (cached) return cached;
        const low = remainingMask & -remainingMask;
        const entryIndex = Math.log2(low);
        const previous = mandatoryLunchForRemaining(remainingMask - low);
        const entry = candidateSets[entryIndex];
        const result = unionLunchMaps(previous, mandatoryLunchByEntry.get(entry));
        mandatoryLunchByRemaining.set(remainingMask, result);
        return result;
      };

      const mandatoryLunchFor = (remaining, remainingMask) => {
        let mandatory = mandatoryLunchForRemaining(remainingMask);
        if (!mandatory) {
          mandatory = new Map();
          for (const entry of remaining)
            mandatory = unionLunchMaps(mandatory, mandatoryLunchByEntry.get(entry));
        }
        return mandatory;
      };

      const lunchLowerBound = (remaining, remainingMask) => {
        if (!lunchEnabled) return 0;
        const mandatory = mandatoryLunchFor(remaining, remainingMask);

        const days = new Set(lunchBlocks.keys());
        for (const day of mandatory.keys()) days.add(day);
        let deficit = 0;
        for (const day of days) {
          let blocks = lunchBlocks.get(day) || [];
          for (const block of mandatory.get(day) || [])
            blocks = insertLunchBlock(blocks, block);
          deficit += lunchDeficitForBlocks(blocks);
        }
        return deficit;
      };

      const addLunchState = candidate => {
        const previous = {
          lunchDeficit: selectedLunchDeficit,
          days: [],
        };
        if (!lunchEnabled) return previous;

        const savedDays = new Set();
        for (const meeting of candidate.events) {
          const start = Math.max(LUNCH_START, meeting.start);
          const end = Math.min(LUNCH_END, meeting.end);
          if (!(end > start)) continue;

          const day = meeting.day;
          if (!savedDays.has(day)) {
            savedDays.add(day);
            previous.days.push({
              day,
              hadBlocks: lunchBlocks.has(day),
              blocks: lunchBlocks.get(day),
              hadDeficit: lunchDayDeficits.has(day),
              deficit: lunchDayDeficits.get(day),
            });
          }

          const blocks = lunchBlocks.get(day) || [];
          const merged = insertLunchBlock(blocks, { start, end });
          const oldDeficit = lunchDayDeficits.get(day) || 0;
          const newDeficit = lunchDeficitForBlocks(merged);
          lunchBlocks.set(day, merged);
          if (newDeficit) lunchDayDeficits.set(day, newDeficit);
          else lunchDayDeficits.delete(day);
          selectedLunchDeficit += newDeficit - oldDeficit;
        }
        return previous;
      };

      const currentLunchDeficit = () => selectedLunchDeficit;

      const gapsForMask = (day, mask) => {
        if (mask === 0n) return 0;
        const boundary = boundaryIndexes.get(day);
        if (!boundary) return 0;
        let remainingMask = mask;
        let previousEnd = -1;
        let gaps = 0;
        while (remainingMask !== 0n) {
          const first = lowestSetBitIndex(remainingMask);
          let runLength = 0;
          let run = remainingMask >> BigInt(first);
          while ((run & 1n) !== 0n) {
            runLength++;
            run >>= 1n;
          }
          const end = first + runLength;
          if (previousEnd >= 0)
            gaps += boundary.values[first] - boundary.values[previousEnd];
          previousEnd = end;
          const runMask = ((1n << BigInt(runLength)) - 1n) << BigInt(first);
          remainingMask &= ~runMask;
        }
        return gaps;
      };

      const gapMaskForOccupied = (mask) => {
        if (mask === 0n) return 0n;
        const first = lowestSetBitIndex(mask);
        const last = mask.toString(2).length - 1;
        const span = ((1n << BigInt(last - first + 1)) - 1n) << BigInt(first);
        return span & ~mask;
      };

      const possibleDayMasksByRemaining = new Map();
      const possibleDayMasksForRemaining = (remaining, remainingMask) => {
        if (subsetCacheEnabled) {
          const cached = possibleDayMasksByRemaining.get(remainingMask);
          if (cached) return cached;
        }

        let unions = new Set([0]);
        for (const entry of remaining) {
          const next = new Set();
          for (const current of unions) {
            for (const candidateMask of entry.dayMasks)
              next.add((current | candidateMask) >>> 0);
          }
          unions = next;
        }
        if (subsetCacheEnabled) possibleDayMasksByRemaining.set(remainingMask, unions);
        return unions;
      };

      const minimumActiveDayCount = (remaining, remainingMask) => {
        const unions = possibleDayMasksForRemaining(remaining, remainingMask);
        const mandatory = lunchEnabled
          ? mandatoryLunchFor(remaining, remainingMask)
          : null;
        let minimum = Infinity;
        for (const remainingMaskValue of unions) {
          const mask = (selectedDayMask | remainingMaskValue) >>> 0;
          if (mandatory) {
            let lunchPossible = true;
            for (const day of allBoundaries.keys()) {
              const number = Number(day);
              if (number < 1 || number > 30 ||
                (mask & (1 << (number - 1))) === 0) continue;
              let blocks = lunchBlocks.get(day) || [];
              for (const block of mandatory.get(day) || [])
                blocks = insertLunchBlock(blocks, block);
              if (lunchDeficitForBlocks(blocks) > 0) {
                lunchPossible = false;
                break;
              }
            }
            if (!lunchPossible) continue;
          }

          let value = mask;
          let count = 0;
          while (value) {
            value = (value & (value - 1)) >>> 0;
            count++;
          }
          minimum = Math.min(minimum, count);
        }
        return Number.isFinite(minimum) ? minimum : selectedDays.size;
      };

      /*
       * A safe stronger campus lower bound. Future meetings may fill a gap
       * between already occupied blocks, so that gap cannot be counted as a
       * lower bound. They cannot improve the schedule by adding an event
       * outside the current occupied span, so those optional outer events are
       * ignored here. The result is an optimistic (never too high) campus
       * value and remains admissible for branch-and-bound.
       */
      const optimisticCampusMs = (remaining, remainingMask) => {
        let gaps = 0;
        const possibleForRemaining = possibleMasksForRemaining(remainingMask);
        for (const day of selectedDays) {
          const current = occupancy.get(day) || 0n;
          if (current === 0n) continue;
          let possible = current;
          if (possibleForRemaining) {
            possible |= possibleForRemaining.get(day) || 0n;
          } else {
            for (const entry of remaining)
              possible |= entry.possibleMasks.get(day) || 0n;
          }
          const fillable = possible & gapMaskForOccupied(current);
          gaps += gapsForMask(day, current | fillable);
        }
        return minimumActiveDayCount(remaining, remainingMask) * HOUR + gaps;
      };


      // Candidate masks are built from every positive-duration event boundary,
      // so an occupancy-mask intersection is the exact positive-overlap
      // predicate for every candidate that can reach this search. Small inputs
      // use the compiled blocked bitsets; large inputs check the same masks on
      // demand so search setup stays bounded.
      const blockedTrail = [];
      const addCandidate = (candidate) => {
        const previousMasks = [];
        const blockedTrailMark = blockedTrail.length;
        const previousDayMask = selectedDayMask;
        const previousLunchState = addLunchState(candidate);
        selectedDayMask |= dayBitMask(candidate.days);
        candidate.ownerEntry.selected = true;
        for (const [day, mask] of candidate.masks.entries()) {
          previousMasks.push({ day, had: occupancy.has(day), value: occupancy.get(day) });
          occupancy.set(day, (occupancy.get(day) || 0n) | mask);
        }
        for (const meeting of candidate.events) {
          if (!selectedBlocks.has(meeting.day)) selectedBlocks.set(meeting.day, []);
          selectedBlocks.get(meeting.day).push(meeting);
          selectedDays.add(meeting.day);
        }
        selectedStartMs += candidate.sumStartMs;
        selectedEndMs += candidate.sumEndMs;
        selected.push(candidate);
        return { previousMasks, blockedTrailMark, previousDayMask, previousLunchState };
      };

      const ensureAvailable = (entry) => {
        if (!useIndexedAvailability) return;
        const targetDepth = selected.length;
        if (entry.blockedDepth >= targetDepth) return;
        const previousDepth = entry.blockedDepth;
        const previousWords = entry.blockedWords.slice();
        const previousCount = entry.blockedCount;
        for (let depth = previousDepth; depth < targetDepth; depth++) {
          const update = selected[depth].blockedUpdatesByEntry.get(entry);
          if (!update) continue;
          for (let word = 0; word < entry.wordCount; word++) {
            const previous = entry.blockedWords[word];
            const added = (update[word] & ~previous) >>> 0;
            if (!added) continue;
            entry.blockedWords[word] = (previous | update[word]) >>> 0;
            entry.blockedCount += popcount32(added);
          }
        }
        entry.blockedDepth = targetDepth;
        blockedTrail.push({
          entry,
          words: previousWords,
          count: previousCount,
          depth: previousDepth,
        });
      };

      // Enumerate candidates in stable candidate order. In on-demand mode the
      // mask check is equivalent to the indexed forbidden-bit calculation.
      const compatibleCandidates = (entry) => {
        if (!useIndexedAvailability) {
          return entry.candidates.filter(candidate =>
            !masksOverlap(candidate.masks, occupancy));
        }
        const result = [];
        for (let word = 0; word < entry.wordCount; word++) {
          let allowed = (entry.allWords[word] & ~entry.blockedWords[word]) >>> 0;
          while (allowed) {
            const low = (allowed & -allowed) >>> 0;
            const bitIndex = 31 - Math.clz32(low);
            const candidate = entry.candidates[(word << 5) + bitIndex];
            if (candidate) result.push(candidate);
            allowed = (allowed & (allowed - 1)) >>> 0;
          }
        }
        return result;
      };

      const removeCandidate = (candidate, previousState) => {
        selected.pop();
        selectedStartMs -= candidate.sumStartMs;
        selectedEndMs -= candidate.sumEndMs;
        selectedDayMask = previousState.previousDayMask;
        const previousLunchState = previousState.previousLunchState;
        selectedLunchDeficit = previousLunchState.lunchDeficit;
        for (let index = previousLunchState.days.length - 1; index >= 0; index--) {
          const previous = previousLunchState.days[index];
          if (previous.hadBlocks) lunchBlocks.set(previous.day, previous.blocks);
          else lunchBlocks.delete(previous.day);
          if (previous.hadDeficit) lunchDayDeficits.set(previous.day, previous.deficit);
          else lunchDayDeficits.delete(previous.day);
        }
        for (let index = candidate.events.length - 1; index >= 0; index--) {
          const meeting = candidate.events[index];
          const blocks = selectedBlocks.get(meeting.day);
          blocks.pop();
          if (!blocks.length) {
            selectedBlocks.delete(meeting.day);
            selectedDays.delete(meeting.day);
          }
        }
        for (let index = previousState.previousMasks.length - 1; index >= 0; index--) {
          const previous = previousState.previousMasks[index];
          if (previous.had) occupancy.set(previous.day, previous.value);
          else occupancy.delete(previous.day);
        }
        while (blockedTrail.length > previousState.blockedTrailMark) {
          const change = blockedTrail.pop();
          change.entry.blockedWords.set(change.words);
          change.entry.blockedCount = change.count;
          change.entry.blockedDepth = change.depth;
        }
        candidate.ownerEntry.selected = false;
      };

      const compareObjectiveKeys = (left, right) => {
        if (left.lunchDeficitMs !== right.lunchDeficitMs)
          return left.lunchDeficitMs < right.lunchDeficitMs ? -1 : 1;
        if (left.combinedMs !== right.combinedMs)
          return left.combinedMs < right.combinedMs ? -1 : 1;
        return 0;
      };

      const canUseBounds = opts.campus >= 0 && opts.lunch >= 0 &&
        opts.early >= 0 && opts.late >= 0;
      const activeDaysCanImprove = (baseMask, remaining, remainingMask) => {
        if (!bestObjective || opts.campus <= 0 || opts.early || opts.late ||
          (opts.lunch && bestObjective.lunchDeficitMs !== 0)) return true;
        return Array.from(possibleDayMasksForRemaining(remaining, remainingMask))
          .some(mask => opts.campus * popcount32((baseMask | mask) >>> 0) * HOUR <
            bestObjective.combinedMs);
      };
      const shouldPrune = (remaining, pruneEqual, remainingMask = 0) => {
        if (!bestObjective || !canUseBounds) return false;
        // When the incumbent already has a feasible lunch and the objective
        // contains only campus time, any strict improvement must use fewer
        // active days than the incumbent's campus lower bound permits. Reject
        // day masks that cannot improve before examining detailed gaps. This
        // is especially effective for real first-year caches: a five-day
        // incumbent reduces the proof search to the few possible four-day
        // unions instead of traversing every five-day prefix.
        if (pruneEqual && !activeDaysCanImprove(
          selectedDayMask, remaining, remainingMask,
        )) return true;
        const lowerLunch = opts.lunch ? lunchLowerBound(remaining, remainingMask) : 0;
        if (opts.lunch && lowerLunch > bestObjective.lunchDeficitMs) return true;
        if (opts.lunch && lowerLunch < bestObjective.lunchDeficitMs) return false;
        let minimumRemainingEnd = 0;
        let maximumRemainingStart = 0;
        if (subsetTableEnabled) {
          minimumRemainingEnd = minimumEndByRemaining[remainingMask];
          maximumRemainingStart = maximumStartByRemaining[remainingMask];
        } else {
          for (const entry of remaining) {
            minimumRemainingEnd += entry.minimumEnd;
            maximumRemainingStart += entry.maximumStart;
          }
        }
        const lowerCampus = optimisticCampusMs(remaining, remainingMask);
        const lowerEnd = selectedEndMs + minimumRemainingEnd;
        const upperStart = selectedStartMs + maximumRemainingStart;
        const lowerCombined = opts.campus * lowerCampus +
          opts.early * lowerEnd - opts.late * upperStart;
        // The lower bound is admissible for the objective key. During the first
        // pass equality can be pruned because only the objective value matters;
        // the second pass keeps equality so it can find the stable tie.
        if (lowerCombined < bestObjective.combinedMs) return false;
        if (lowerCombined > bestObjective.combinedMs) return true;
        return pruneEqual;
      };

      const lunchPrefixExceedsIncumbent = () =>
        lunchEnabled && bestObjective &&
        selectedLunchDeficit > bestObjective.lunchDeficitMs;

      const lunchCompatibleWithSelected = candidate => {
        if (!lunchEnabled || !candidate.lunchIntervals || !bestObjective)
          return true;
        if (bestObjective.lunchDeficitMs === 0 && !candidate.lunchSafe)
          return false;
        if (bestObjective.lunchDeficitMs === 0) {
          if (!candidate.lunchSafe) return false;
          const days = new Set(selectedDays);
          for (const day of candidate.days) days.add(day);
          for (const day of days) {
            let blocks = lunchBlocks.get(day) || [];
            for (const interval of candidate.lunchIntervals.get(day) || [])
              blocks = insertLunchBlock(blocks, interval);
            if (lunchDeficitForBlocks(blocks) > 0) return false;
          }
          return true;
        }
        let deficit = selectedLunchDeficit;
        for (const [day, intervals] of candidate.lunchIntervals.entries()) {
          let blocks = lunchBlocks.get(day) || [];
          for (const interval of intervals)
            blocks = insertLunchBlock(blocks, interval);
          const previous = lunchDayDeficits.get(day) || 0;
          deficit += lunchDeficitForBlocks(blocks) - previous;
          if (deficit > bestObjective.lunchDeficitMs) return false;
        }
        return deficit <= bestObjective.lunchDeficitMs;
      };

      const declaredOptionType = (option) => {
        if (!option) return "";
        if (option.lec) return "LEC";
        const source = option.tm || option.teachMethod || option.type ||
          (option.sec && (option.sec.teachMethod || option.sec.type ||
            option.sec.tm || option.sec.componentType));
        return source === undefined ? "" : componentType(source);
      };

      const finalCourseInvariant = (course, candidate) => {
        const items = candidateItems(candidate.plan);
        for (const lock of course.locked) {
          const requiredMeetings = meetings(lock.ms || []);
          const found = items.some(item => {
            const itemType = componentType(item.tm || item.teachMethod || item.type || item.sec);
            if (itemType !== lock.tm || sectionName(item.sec) !== sectionName(lock.sec)) return false;
            const actual = meetings(optionMeetings(item));
            return actual.length === requiredMeetings.length &&
              actual.every((meeting, index) =>
                meetingSignature(meeting) === meetingSignature(requiredMeetings[index]));
          });
          if (!found) return false;
        }
        // buildCoursePlans supplies one combo option for each active pool type.
        // Checking the combo cardinality also supports synthetic/custom types
        // whose option object has no teachMethod field. For standard component
        // types, additionally require one option of every declared type so a
        // malformed direct-plan input cannot silently replace a required class.
        if (course.poolTypes.length) {
          if (candidate.combo.length !== course.poolTypes.length) return false;
          const required = new Map();
          for (const type of course.poolTypes) {
            if (Object.prototype.hasOwnProperty.call(COMPONENT_ORDER, type))
              required.set(type, (required.get(type) || 0) + 1);
          }
          for (const option of candidate.combo) {
            const type = declaredOptionType(option);
            if (required.has(type)) required.set(type, required.get(type) - 1);
          }
          for (const count of required.values()) {
            if (count !== 0) return false;
          }
        }
        return true;
      };

      const finalPlanInvariant = (plan) => {
        if (!Array.isArray(plan) || plan.length !== normalizedPlans.length) return false;
        if (!isClashFree(plan)) return false;
        const byCode = new Map(plan.map(course => [String(course.code), course]));
        for (const course of normalizedPlans) {
          const candidate = byCode.get(course.code);
          if (!candidate) return false;
          const descriptor = selected.find(item => item.plan === candidate);
          if (!descriptor || !finalCourseInvariant(course, descriptor)) return false;
        }
        return true;
      };

      const chooseNext = (remaining) => {
        const choices = [];
        const useLunchFilter = lunchEnabled && !!bestObjective;
        for (const entry of remaining) {
          ensureAvailable(entry);
          const geometricCount = entry.candidates.length - entry.blockedCount;
          if (!geometricCount) return null;
          let compatible = null;
          let count = geometricCount;
          if (useLunchFilter) {
            compatible = compatibleCandidates(entry)
              .filter(lunchCompatibleWithSelected);
            count = compatible.length;
            if (!count) return null;
          }
          choices.push({ entry, count, compatible });
        }
        choices.sort((left, right) =>
          compareNumbers(left.count, right.count) ||
          compareNumbers(right.entry.conflictDegree, left.entry.conflictDegree) ||
          compareStrings(left.entry.course.code, right.entry.course.code));
        const choice = choices[0];
        const compatible = choice.compatible || compatibleCandidates(choice.entry);
        if (!compatible.length) return null;
        return { entry: choice.entry, compatible };
      };

      const partialCampusMs = () => {
        let gaps = 0;
        for (const [day, mask] of occupancy.entries())
          gaps += gapsForMask(day, mask);
        return selectedDays.size * HOUR + gaps;
      };

      const runGreedySeed = (
        selectCandidate,
        chooseChoice = chooseNext,
        seedOrder = candidateSets,
      ) => {
        const remaining = seedOrder.slice();
        const added = [];
        while (remaining.length) {
          const choice = chooseChoice(remaining);
          if (!choice) break;
          const candidate = selectCandidate(choice, remaining);
          if (!candidate) break;
          const previousMasks = addCandidate(candidate);
          added.push({ candidate, previousMasks });
          remaining.splice(remaining.indexOf(choice.entry), 1);
        }
        let seeded = false;
        if (!remaining.length) {
          const plan = selected.map(candidate => candidate.plan)
            .sort((left, right) => compareStrings(left.code, right.code));
          if (finalPlanInvariant(plan)) {
            const evaluation = evaluatePlan(plan);
            const objective = objectiveKey(evaluation, opts);
            if (!bestPlan || compareObjectiveKeys(objective, bestObjective) < 0) {
              bestPlan = plan;
              bestEvaluation = evaluation;
              bestObjective = objective;
            }
            seeded = true;
          }
        }
        for (let index = added.length - 1; index >= 0; index--)
          removeCandidate(added[index].candidate, added[index].previousMasks);
        return seeded;
      };

      const refineLunchSeed = () => {
        if (!bestPlan || !bestObjective) return false;
        let improved = false;
        for (let pass = 0; pass < 3; pass++) {
          let passImproved = false;
          for (const entry of candidateSets) {
            const currentCode = String(entry.course.code);
            const otherPlans = bestPlan.filter(plan =>
              String(plan.code) !== currentCode);
            let replacementPlan = null;
            let replacementEvaluation = null;
            let replacementObjective = null;
            for (const candidate of entry.candidates) {
              const plan = [candidate.plan, ...otherPlans];
              if (!isClashFree(plan)) continue;
              const evaluation = evaluatePlan(plan);
              const objective = objectiveKey(evaluation, opts);
              if (compareObjectiveKeys(objective, bestObjective) >= 0) continue;
              if (!replacementObjective ||
                compareObjectiveKeys(objective, replacementObjective) < 0) {
                replacementPlan = plan;
                replacementEvaluation = evaluation;
                replacementObjective = objective;
              }
            }
            if (!replacementPlan) continue;
            bestPlan = replacementPlan.sort((left, right) =>
              compareStrings(left.code, right.code));
            bestEvaluation = replacementEvaluation;
            bestObjective = replacementObjective;
            passImproved = true;
            improved = true;
          }
          if (!passImproved) break;
        }
        return improved;
      };

      const greedySeed = () => {
        if (lunchEnabled) {
          const lunchCandidateSelector = (choice, remaining) => {
            const nextRemaining = remaining.filter(entry => entry !== choice.entry);
            const nextRemainingMask = subsetCacheEnabled
              ? remaining.reduce((mask, entry) => mask | entry.searchBit, 0) &
              ~choice.entry.searchBit
              : 0;
            let selectedCandidate = null;
            let selectedKey = null;
            for (const candidate of choice.compatible) {
              const previousMasks = addCandidate(candidate);
              if (selectedLunchDeficit === 0) {
                const key = [
                  partialCampusMs(),
                  optimisticCampusMs(nextRemaining, nextRemainingMask),
                  candidate.signature,
                ];
                if (!selectedKey ||
                  key[0] < selectedKey[0] ||
                  (key[0] === selectedKey[0] && key[1] < selectedKey[1]) ||
                  (key[0] === selectedKey[0] && key[1] === selectedKey[1] &&
                    compareStrings(key[2], selectedKey[2]) < 0)) {
                  selectedCandidate = candidate;
                  selectedKey = key;
                }
              }
              removeCandidate(candidate, previousMasks);
            }
            return selectedCandidate;
          };
          const fixedChoice = remaining => {
            const entry = remaining[0];
            ensureAvailable(entry);
            const compatible = compatibleCandidates(entry);
            return compatible.length ? { entry, compatible } : null;
          };
          const largestUnlocked = candidateSets
            .filter(entry => !(entry.course.locked || []).length)
            .slice().sort((left, right) =>
              compareNumbers(right.candidates.length, left.candidates.length) ||
              compareStrings(left.course.code, right.course.code))[0];
          const lockedEntries = candidateSets
            .filter(entry => (entry.course.locked || []).length);
          const largestLocked = lockedEntries.slice().sort((left, right) =>
            compareNumbers(right.candidates.length, left.candidates.length) ||
            compareStrings(left.course.code, right.course.code))[0];
          const heuristicSeedOrder = [
            largestUnlocked,
            ...lockedEntries.filter(entry => entry !== largestLocked)
              .sort((left, right) =>
                compareNumbers(right.candidates.length, left.candidates.length) ||
                compareStrings(left.course.code, right.course.code)),
            ...candidateSets.filter(entry => entry !== largestUnlocked &&
              entry !== largestLocked && !(entry.course.locked || []).length)
              .sort((left, right) =>
                compareNumbers(left.candidates.length, right.candidates.length) ||
                compareStrings(left.course.code, right.course.code)),
            largestLocked,
          ].filter(Boolean);
          const lunchOrders = [
            { order: candidateSets, choose: chooseNext },
            {
              order: candidateSets.slice().sort((left, right) =>
                compareStrings(left.course.code, right.course.code)),
              choose: fixedChoice,
            },
            {
              order: candidateSets.slice().sort((left, right) =>
                compareNumbers(right.candidates.length, left.candidates.length) ||
                compareStrings(left.course.code, right.course.code)),
              choose: fixedChoice,
            },
            {
              order: candidateSets.slice().sort((left, right) =>
                compareNumbers(
                  (mandatoryLunchByEntry.get(right) || new Map()).size,
                  (mandatoryLunchByEntry.get(left) || new Map()).size,
                ) || compareNumbers(right.candidates.length, left.candidates.length) ||
                compareStrings(left.course.code, right.course.code)),
              choose: fixedChoice,
            },
          ];
          if (heuristicSeedOrder.length === candidateSets.length)
            lunchOrders.push({ order: heuristicSeedOrder, choose: fixedChoice });
          let lunchSeeded = false;
          for (const attempt of lunchOrders) {
            if (runGreedySeed(
              lunchCandidateSelector,
              attempt.choose,
              attempt.order,
            )) {
              lunchSeeded = true;
              refineLunchSeed();
            }
          }
          if (lunchSeeded) return true;
        }

        // Reverse traversal is still deterministic and deliberately differs
        // from the proof traversal, making the fallback useful on first-fit
        // schedules where the stable-first candidate is a dead end.
        const fallbackSeeded = runGreedySeed(choice =>
          choice.compatible[choice.compatible.length - 1]);
        if (lunchEnabled && fallbackSeeded)
          refineLunchSeed();
        return fallbackSeeded;
      };

      const searchOrder = [];
      const objectiveStateMemo = new Set();
      const objectiveStateKey = (remaining, remainingMask) => {
        const remainingKey = subsetCacheEnabled
          ? String(remainingMask)
          : remaining.map(entry => entry.course.code).sort(compareStrings).join(",");
        const occupancyKey = Array.from(occupancy.entries())
          .sort((left, right) => compareNumbers(left[0], right[0]))
          .map(([day, mask]) => `${day}:${mask.toString(16)}`)
          .join(";");
        const metricKey = opts.early || opts.late
          ? `:${selectedStartMs}:${selectedEndMs}` : "";
        return `${remainingKey}${metricKey}|${occupancyKey}`;
      };
      const visitObjective = (remaining, remainingMask) => {
        nodesVisited++;
        countSearchState();
        const stateKey = objectiveStateKey(remaining, remainingMask);
        if (objectiveStateMemo.has(stateKey)) {
          prunedNodes++;
          return;
        }
        objectiveStateMemo.add(stateKey);
        if (debugCallback && nodesVisited <= 3) debugCallback({
          phase: "objective-before-prune",
          node: nodesVisited,
          depth: selected.length,
          remaining: remaining.map(entry => entry.course.code),
        });

        const objectivePruned = shouldPrune(remaining, true, remainingMask);
        if (debugCallback && nodesVisited <= 3) debugCallback({
          phase: "objective-after-prune",
          node: nodesVisited,
          pruned: objectivePruned,
        });
        if (objectivePruned) {
          prunedNodes++;
          return;
        }
        if (!remaining.length) {
          const plan = selected.map(candidate => candidate.plan)
            .sort((left, right) => compareStrings(left.code, right.code));
          if (!finalPlanInvariant(plan)) return;

          const evaluation = evaluatePlan(plan);
          const objective = objectiveKey(evaluation, opts);
          const improvedObjective = !bestPlan ||
            compareObjectiveKeys(objective, bestObjective) < 0;
          if (improvedObjective) {
            bestPlan = plan;
            bestEvaluation = evaluation;
            bestObjective = objective;
            if (debugCallback) debugCallback({
              phase: "objective-improved",
              node: nodesVisited,
              objective,
            });
          }
          return;
        }

        // Dynamic MRV ordering remains the fast objective-search traversal.
        const choice = chooseNext(remaining);
        if (debugCallback && nodesVisited <= 3) debugCallback({
          phase: "objective-after-choice",
          node: nodesVisited,
          choice: choice && {
            code: choice.entry.course.code,
            compatible: choice.compatible.length,
          },
        });
        if (!choice) {
          prunedNodes++;
          return;
        }
        if (!searchOrder.includes(choice.entry.course.code))
          searchOrder.push(choice.entry.course.code);
        const nextRemaining = remaining.filter(entry => entry !== choice.entry);
        const nextRemainingMask = subsetCacheEnabled
          ? remainingMask & ~choice.entry.searchBit : 0;
        for (const candidate of choice.compatible) {
          if (!activeDaysCanImprove(
            selectedDayMask | dayBitMask(candidate.days),
            nextRemaining,
            nextRemainingMask,
          )) continue;
          const previousMasks = addCandidate(candidate);
          if (!lunchPrefixExceedsIncumbent())
            visitObjective(nextRemaining, nextRemainingMask);
          removeCandidate(candidate, previousMasks);
        }
      };

      // The cooperative branch below owns the greedy/objective/stable passes
      // when requested. The synchronous path runs the same existing recursive
      // traversal directly for maximum performance.
      const lexCandidateSets = candidateSets.slice().sort((left, right) =>
        compareStrings(left.course.code, right.course.code));
      const visitCanonicalStableTie = (remaining, remainingMask) => {
        nodesVisited++;
        countSearchState();

        if (shouldPrune(remaining, false, remainingMask)) {
          prunedNodes++;
          return false;
        }
        if (!remaining.length) {
          const plan = selected.map(candidate => candidate.plan)
            .sort((left, right) => compareStrings(left.code, right.code));
          if (!finalPlanInvariant(plan)) return false;

          const evaluation = evaluatePlan(plan);
          const objective = objectiveKey(evaluation, opts);
          if (compareObjectiveKeys(objective, bestObjective) !== 0) return false;
          bestPlan = plan;
          bestEvaluation = evaluation;
          bestObjective = objective;
          return true;
        }

        const entry = remaining[0];
        ensureAvailable(entry);
        if (entry.candidates.length - entry.blockedCount <= 0) {
          prunedNodes++;
          return false;
        }
        const compatible = compatibleCandidates(entry);
        if (!compatible.length) {
          prunedNodes++;
          return false;
        }
        const nextRemaining = remaining.slice(1);
        const nextRemainingMask = subsetCacheEnabled
          ? remainingMask & ~entry.searchBit : 0;
        for (const candidate of compatible) {
          const previousMasks = addCandidate(candidate);
          const found = visitCanonicalStableTie(nextRemaining, nextRemainingMask);
          removeCandidate(candidate, previousMasks);
          if (found) return true;
        }
        return false;
      };

      /*
       * Lunch-enabled stable ties use the canonical course-code order only
       * for choosing the prefix.  Once a prefix candidate is fixed, the
       * remaining completion is a feasibility query and can use MRV ordering;
       * its order cannot affect which prefix is lexicographically first.
       * This preserves the stable result while avoiding the enormous fixed
       * Cartesian traversal seen in the lunch-enabled case.
       */
      const lunchCompletionMemo = new Map();
      const hasLunchObjectiveCompletionUncached = (remaining, remainingMask) => {
        nodesVisited++;
        countSearchState();

        if (shouldPrune(remaining, false, remainingMask)) {
          prunedNodes++;
          return false;
        }
        if (!remaining.length) {
          const plan = selected.map(candidate => candidate.plan)
            .sort((left, right) => compareStrings(left.code, right.code));
          if (!finalPlanInvariant(plan)) return false;
          const evaluation = evaluatePlan(plan);
          return compareObjectiveKeys(objectiveKey(evaluation, opts), bestObjective) === 0;
        }

        const choice = chooseNext(remaining);
        if (!choice) {
          prunedNodes++;
          return false;
        }
        const nextRemaining = remaining.filter(entry => entry !== choice.entry);
        const nextRemainingMask = subsetCacheEnabled
          ? remainingMask & ~choice.entry.searchBit : 0;
        for (const candidate of choice.compatible) {
          const previousMasks = addCandidate(candidate);
          const found = !lunchPrefixExceedsIncumbent() &&
            hasLunchObjectiveCompletion(nextRemaining, nextRemainingMask);
          removeCandidate(candidate, previousMasks);
          if (found) return true;
        }
        return false;
      };

      const hasLunchObjectiveCompletion = (remaining, remainingMask) => {
        const key = objectiveStateKey(remaining, remainingMask);
        if (lunchCompletionMemo.has(key)) return lunchCompletionMemo.get(key);
        const result = hasLunchObjectiveCompletionUncached(remaining, remainingMask);
        lunchCompletionMemo.set(key, result);
        return result;
      };

      const visitLunchStableTie = (remaining, remainingMask) => {
        nodesVisited++;
        countSearchState();

        if (shouldPrune(remaining, false, remainingMask)) {
          prunedNodes++;
          return false;
        }
        if (!remaining.length) {
          const plan = selected.map(candidate => candidate.plan)
            .sort((left, right) => compareStrings(left.code, right.code));
          if (!finalPlanInvariant(plan)) return false;
          const evaluation = evaluatePlan(plan);
          const objective = objectiveKey(evaluation, opts);
          if (compareObjectiveKeys(objective, bestObjective) !== 0) return false;
          bestPlan = plan;
          bestEvaluation = evaluation;
          bestObjective = objective;
          return true;
        }

        const entry = remaining[0];
        ensureAvailable(entry);
        if (entry.candidates.length - entry.blockedCount <= 0) {
          prunedNodes++;
          return false;
        }
        const compatible = compatibleCandidates(entry);
        if (!compatible.length) {
          prunedNodes++;
          return false;
        }
        const nextRemaining = remaining.slice(1);
        const nextRemainingMask = subsetCacheEnabled
          ? remainingMask & ~entry.searchBit : 0;
        for (const candidate of compatible) {
          const previousMasks = addCandidate(candidate);
          const feasible = !lunchPrefixExceedsIncumbent() &&
            (nextRemaining.length === 0 ||
              hasLunchObjectiveCompletion(nextRemaining, nextRemainingMask));
          removeCandidate(candidate, previousMasks);
          if (!feasible) continue;

          const committed = addCandidate(candidate);
          const found = visitLunchStableTie(nextRemaining, nextRemainingMask);
          removeCandidate(candidate, committed);
          if (found) return true;
        }
        return false;
      };

      let seeded = false;
      const needsLunchFallback = () => filterUnsafeLunchCandidates &&
        (!bestPlan || !bestObjective || bestObjective.lunchDeficitMs !== 0);
      const finalizeSearch = () => {
        const resultDiagnostics = Object.assign({}, diagnostics, {
          nodesVisited,
          prunedNodes,
          seeded,
          combinationsSearched,
          courseOrder: searchOrder,
        });
        if (!bestPlan) {
          return finishResult(Object.assign({}, base, {
            nodesVisited,
            combinationsSearched,
            diagnostics: Object.assign(resultDiagnostics, {
              status: "NO_SOLUTION",
              reason: "NO_FEASIBLE_PLAN",
            }),
          }));
        }

        return finishResult({
          plan: bestPlan,
          status: "OPTIMAL",
          complete: true,
          optimal: true,
          nodesVisited,
          combinationsSearched,
          evaluation: bestEvaluation,
          objective: bestObjective,
          score: scoreEvaluation(bestEvaluation, opts),
          signature: planSignature(bestPlan),
          options: opts,
          diagnostics: resultDiagnostics,
        });
      };

      const cooperativeSearch = !!(hooks && hooks.cooperative);
      if (cooperativeSearch) {
        const makeFrame = (remaining, remainingMask) => ({
          remaining,
          remainingMask,
          entered: false,
          compatible: null,
          nextRemaining: null,
          nextRemainingMask: 0,
          index: 0,
          active: null,
        });

        const objectiveTraversal = function* () {
          const stack = [makeFrame(candidateSets.slice(), allRemainingMask)];
          while (stack.length) {
            const frame = stack[stack.length - 1];
            if (frame.active) {
              removeCandidate(frame.active.candidate, frame.active.state);
              frame.active = null;
            }
            if (!frame.entered) {
              frame.entered = true;
              nodesVisited++;
              countSearchState();
              const stateKey = objectiveStateKey(frame.remaining, frame.remainingMask);
              if (objectiveStateMemo.has(stateKey)) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              objectiveStateMemo.add(stateKey);
              if (nodesVisited % 64 === 0) yield null;

              if (shouldPrune(frame.remaining, true, frame.remainingMask)) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              if (!frame.remaining.length) {
                const plan = selected.map(candidate => candidate.plan)
                  .sort((left, right) => compareStrings(left.code, right.code));
                if (finalPlanInvariant(plan)) {
                  const evaluation = evaluatePlan(plan);
                  const objective = objectiveKey(evaluation, opts);
                  if (!bestPlan || compareObjectiveKeys(objective, bestObjective) < 0) {
                    bestPlan = plan;
                    bestEvaluation = evaluation;
                    bestObjective = objective;
                  }
                }
                stack.pop();
                continue;
              }

              const choice = chooseNext(frame.remaining);
              if (!choice) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              if (!searchOrder.includes(choice.entry.course.code))
                searchOrder.push(choice.entry.course.code);
              frame.compatible = choice.compatible;
              frame.nextRemaining = frame.remaining
                .filter(entry => entry !== choice.entry);
              frame.nextRemainingMask = subsetCacheEnabled
                ? frame.remainingMask & ~choice.entry.searchBit : 0;
            }

            if (frame.index >= frame.compatible.length) {
              stack.pop();
              continue;
            }
            const candidate = frame.compatible[frame.index++];
            if (!activeDaysCanImprove(
              selectedDayMask | dayBitMask(candidate.days),
              frame.nextRemaining,
              frame.nextRemainingMask,
            )) continue;
            const state = addCandidate(candidate);
            if (lunchPrefixExceedsIncumbent()) {
              removeCandidate(candidate, state);
              continue;
            }
            frame.active = {
              candidate,
              state,
            };
            stack.push(makeFrame(frame.nextRemaining, frame.nextRemainingMask));
          }
        };

        const canonicalStableTraversal = function* () {
          const stack = [makeFrame(lexCandidateSets, allRemainingMask)];
          let found = false;
          while (stack.length) {
            const frame = stack[stack.length - 1];
            if (frame.active) {
              removeCandidate(frame.active.candidate, frame.active.state);
              frame.active = null;
            }
            if (found) {
              stack.pop();
              continue;
            }
            if (!frame.entered) {
              frame.entered = true;
              nodesVisited++;
              countSearchState();
              if (nodesVisited % 64 === 0) yield null;

              if (shouldPrune(frame.remaining, false, frame.remainingMask)) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              if (!frame.remaining.length) {
                const plan = selected.map(candidate => candidate.plan)
                  .sort((left, right) => compareStrings(left.code, right.code));
                if (finalPlanInvariant(plan)) {
                  const evaluation = evaluatePlan(plan);
                  const objective = objectiveKey(evaluation, opts);
                  if (compareObjectiveKeys(objective, bestObjective) === 0) {
                    bestPlan = plan;
                    bestEvaluation = evaluation;
                    bestObjective = objective;
                    found = true;
                  }
                }
                stack.pop();
                continue;
              }

              const entry = frame.remaining[0];
              ensureAvailable(entry);
              if (entry.candidates.length - entry.blockedCount <= 0) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              frame.compatible = compatibleCandidates(entry);
              if (!frame.compatible.length) {
                prunedNodes++;
                stack.pop();
                continue;
              }
              frame.nextRemaining = frame.remaining.slice(1);
              frame.nextRemainingMask = subsetCacheEnabled
                ? frame.remainingMask & ~entry.searchBit : 0;
            }

            if (frame.index >= frame.compatible.length) {
              stack.pop();
              continue;
            }
            const candidate = frame.compatible[frame.index++];
            const state = addCandidate(candidate);
            if (lunchPrefixExceedsIncumbent()) {
              removeCandidate(candidate, state);
              continue;
            }
            frame.active = {
              candidate,
              state,
            };
            stack.push(makeFrame(frame.nextRemaining, frame.nextRemainingMask));
          }
        };

        const hasLunchObjectiveCompletionCooperative = function* (remaining, remainingMask) {
          nodesVisited++;
          countSearchState();
          if (nodesVisited % 64 === 0) yield null;

          if (shouldPrune(remaining, false, remainingMask)) {
            prunedNodes++;
            return false;
          }
          if (!remaining.length) {
            const plan = selected.map(candidate => candidate.plan)
              .sort((left, right) => compareStrings(left.code, right.code));
            if (!finalPlanInvariant(plan)) return false;
            const evaluation = evaluatePlan(plan);
            return compareObjectiveKeys(objectiveKey(evaluation, opts), bestObjective) === 0;
          }

          const choice = chooseNext(remaining);
          if (!choice) {
            prunedNodes++;
            return false;
          }
          const nextRemaining = remaining.filter(entry => entry !== choice.entry);
          const nextRemainingMask = subsetCacheEnabled
            ? remainingMask & ~choice.entry.searchBit : 0;
          for (const candidate of choice.compatible) {
            const previousMasks = addCandidate(candidate);
            const found = !lunchPrefixExceedsIncumbent() &&
              (yield* hasLunchObjectiveCompletionCooperative(
                nextRemaining,
                nextRemainingMask,
              ));
            removeCandidate(candidate, previousMasks);
            if (found) return true;
          }
          return false;
        };

        const visitLunchStableTieCooperative = function* (remaining, remainingMask) {
          nodesVisited++;
          countSearchState();
          if (nodesVisited % 64 === 0) yield null;

          if (shouldPrune(remaining, false, remainingMask)) {
            prunedNodes++;
            return false;
          }
          if (!remaining.length) {
            const plan = selected.map(candidate => candidate.plan)
              .sort((left, right) => compareStrings(left.code, right.code));
            if (!finalPlanInvariant(plan)) return false;
            const evaluation = evaluatePlan(plan);
            const objective = objectiveKey(evaluation, opts);
            if (compareObjectiveKeys(objective, bestObjective) !== 0) return false;
            bestPlan = plan;
            bestEvaluation = evaluation;
            bestObjective = objective;
            return true;
          }

          const entry = remaining[0];
          ensureAvailable(entry);
          if (entry.candidates.length - entry.blockedCount <= 0) {
            prunedNodes++;
            return false;
          }
          const compatible = compatibleCandidates(entry);
          if (!compatible.length) {
            prunedNodes++;
            return false;
          }
          const nextRemaining = remaining.slice(1);
          const nextRemainingMask = subsetCacheEnabled
            ? remainingMask & ~entry.searchBit : 0;
          for (const candidate of compatible) {
            const previousMasks = addCandidate(candidate);
            const feasible = !lunchPrefixExceedsIncumbent() &&
              (nextRemaining.length === 0 ||
                (yield* hasLunchObjectiveCompletionCooperative(
                  nextRemaining,
                  nextRemainingMask,
                )));
            removeCandidate(candidate, previousMasks);
            if (!feasible) continue;

            const committed = addCandidate(candidate);
            const found = yield* visitLunchStableTieCooperative(
              nextRemaining,
              nextRemainingMask,
            );
            removeCandidate(candidate, committed);
            if (found) return true;
          }
          return false;
        };

        const stableTraversal = lunchEnabled
          ? function* () {
            yield* visitLunchStableTieCooperative(lexCandidateSets, allRemainingMask);
          }
          : canonicalStableTraversal;

        const cooperativeRun = function* () {
          seeded = greedySeed();
          yield* objectiveTraversal();
          if (bestPlan) yield* stableTraversal();
          return needsLunchFallback()
            ? { __retryAllLunchCandidates: true }
            : finalizeSearch();
        };
        const iterator = cooperativeRun();
        return new Promise((resolve, reject) => {
          const fail = error => {
            if (hooks && typeof hooks.onError === "function") hooks.onError(error);
            reject(error);
          };
          const drive = () => {
            if (hooks && typeof hooks.shouldContinue === "function" &&
              !hooks.shouldContinue()) {
              const error = new Error("Optimization canceled");
              error.code = "OPTIMIZATION_CANCELED";
              fail(error);
              return;
            }
            try {
              let yields = 0;
              while (yields < 16) {
                const next = iterator.next();
                if (next.done) {
                  if (next.value && next.value.__retryAllLunchCandidates) {
                    try {
                      const retry = retryWithAllLunchCandidates();
                      if (retry && typeof retry.then === "function") {
                        retry.then(resolve, reject);
                      } else {
                        if (hooks && typeof hooks.onComplete === "function")
                          hooks.onComplete(retry);
                        resolve(retry);
                      }
                    } catch (error) {
                      fail(error);
                    }
                    return;
                  }
                  if (hooks && typeof hooks.onComplete === "function")
                    hooks.onComplete(next.value);
                  resolve(next.value);
                  return;
                }
                yields++;
              }
            } catch (error) {
              fail(error);
              return;
            }
            const schedule = hooks && typeof hooks.schedule === "function"
              ? hooks.schedule
              : callback => setTimeout(callback, 0);
            try {
              const timer = schedule(drive);
              if (hooks && typeof hooks.onSchedule === "function")
                hooks.onSchedule(timer);
            } catch (error) {
              fail(error);
            }
          };
          drive();
        });
      }

      seeded = greedySeed();
      if (debugCallback) debugCallback({
        phase: "seed-done",
        seeded,
        bestObjective,
        bestEvaluation,
        seedSignature: bestPlan && planSignature(bestPlan),
      });
      visitObjective(candidateSets.slice(), allRemainingMask);
      if (debugCallback) debugCallback({
        phase: "objective-done",
        nodesVisited,
        combinationsSearched,
        bestObjective,
      });

      // With a proven objective value in hand, search in the same order as the
      // canonical plan signature. Keeping objective equality and stopping at
      // the first feasible optimum avoids enumerating every equal-cost tie.
      const stableTieFound = bestPlan
        ? (lunchEnabled
          ? visitLunchStableTie(lexCandidateSets, allRemainingMask)
          : visitCanonicalStableTie(lexCandidateSets, allRemainingMask))
        : false;
      if (needsLunchFallback()) return retryWithAllLunchCandidates();
      return finalizeSearch();
    }

    return {
      HOUR,
      LUNCH_START,
      LUNCH_END,
      stableStringify,
      normalizeMeeting,
      meetings,
      overlaps,
      meetingSignature,
      stableMeetingSignature: meetingSignature,
      componentType,
      sectionName,
      sectionSignature,
      stableSectionSignature: sectionSignature,
      optionSignature,
      stableOptionSignature: optionSignature,
      candidateSignature,
      stableCandidateSignature: candidateSignature,
      planSignature,
      stablePlanSignature: planSignature,
      groupCourses,
      buildLecOptions,
      buildCoursePlans,
      validateLockedSections,
      findLockedConflict: lockedConflict,
      findLockedConflicts: lockedConflicts,
      isClashFree,
      evaluatePlan,
      scorePlan,
      objectiveKey,
      comparePlans,
      normalizeOptions,
      findBestPlan,
    };
  },
));
