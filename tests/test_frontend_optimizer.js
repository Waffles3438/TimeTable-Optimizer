"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const INDEX = path.join(ROOT, "web", "index.html");
const DATA_DIR = path.join(ROOT, "web", "data");
const HOUR = 60 * 60 * 1000;
const LUNCH_START = 11 * HOUR;
const LUNCH_END = 13 * HOUR;

/*
 * Task 1 is deliberately an exploration suite.  It loads the exact inline
 * script from index.html in a small DOM adapter, runs the unfixed sampled
 * functions, and compares their observations with an independent finite
 * reference.  The objective assertions below are expected to fail against F:
 * the failure message is the preserved counterexample, not a test defect.
 *
 * Once web/optimizer.js exists, the adapter uses its findBestPlan function for
 * the same fixtures.  This keeps the captured inputs and expectedBehavior
 * assertions usable by the later fixed-engine verification task without
 * replacing this exploration with a second test.
 */

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
}

function cloneForWorkerBoundary(value) {
  if (typeof globalThis.structuredClone === "function")
    return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function inlineScript() {
  const html = fs.readFileSync(INDEX, "utf8");
  const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error("HARNESS FAILURE: index.html has no inline UI script");
  return match[1];
}

function makeElement(id) {
  let html = "";
  const element = {
    id,
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    textContent: "",
    options: [],
    selectedIndex: 0,
    selectedOptions: [],
    listeners: new Map(),
    children: [],
    parentNode: null,
    dataset: {},
    className: "",
    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || makeElement(`${id}:query`);
    },
    querySelectorAll(selector) {
      const wanted = String(selector || "").trim();
      const checkedOnly = wanted.endsWith(":checked");
      const base = checkedOnly ? wanted.slice(0, -8) : wanted;
      const matches = node => {
        if (!node || !node.tagName && !node.className) return false;
        const tag = base.match(/^([a-zA-Z][\w-]*)/);
        if (tag && String(node.tagName || "").toLowerCase() !== tag[1].toLowerCase()) return false;
        const classes = [...base.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
        if (classes.some(name => !node.classList.contains(name))) return false;
        const types = [...base.matchAll(/\[type=["']?([^\]"']+)["']?\]/g)].map(match => match[1]);
        if (types.some(type => String(node.type || "").toLowerCase() !== type.toLowerCase())) return false;
        return !checkedOnly || !!node.checked;
      };
      const result = [];
      const visit = node => {
        for (const child of node.children || []) {
          if (matches(child)) result.push(child);
          visit(child);
        }
      };
      visit(this);
      return result;
    },
    appendChild(child) {
      if (!child) return child;
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    setAttribute(name, value) {
      this[name] = String(value);
    },
  };
  Object.defineProperty(element, "innerHTML", {
    get() { return html; },
    set(value) {
      html = String(value == null ? "" : value);
      element.children.length = 0;
    },
  });
  element.classList = {
    contains(name) {
      return String(element.className || "").split(/\s+/).includes(String(name));
    },
    add(name) {
      if (!this.contains(name)) element.className = `${element.className} ${name}`.trim();
    },
    remove(name) {
      element.className = String(element.className || "").split(/\s+/)
        .filter(value => value && value !== String(name)).join(" ");
    },
  };
  return element;
}

function makeInlinePageHarness(harnessOptions = {}) {
  const elements = new Map();
  const checkedBoxes = [];
  const fetchCalls = [];
  const workerInstances = [];
  const storage = harnessOptions.storage || new Map();
  const storageReads = [];
  const storageWrites = [];
  const eventLoop = {
    pending: [],
    trace: [],
    active: false,
    returned: true,
    controlProbeQueued: false,
    controlDuringSearch: false,
    controlAfterReturn: false,
    lastSolverResult: null,
    begin() {
      this.pending = [];
      this.trace = [];
      this.active = true;
      this.returned = false;
      this.controlProbeQueued = false;
      this.controlDuringSearch = false;
      this.controlAfterReturn = false;
      this.lastSolverResult = null;
    },
    end() {
      this.returned = true;
      this.active = false;
    },
    queueControlProbe() {
      this.controlProbeQueued = true;
      this.pending.push({ kind: "control", fn: () => this.runControlProbe() });
    },
    runControlProbe() {
      if (!this.controlProbeQueued) return false;
      this.controlProbeQueued = false;
      this.trace.push("control-event");
      if (this.returned) this.controlAfterReturn = true;
      else this.controlDuringSearch = true;
      return true;
    },
    yieldToControl() {
      const index = this.pending.findIndex(task => task.kind === "control");
      if (index < 0) return false;
      const [task] = this.pending.splice(index, 1);
      return task.fn();
    },
    flush() {
      let guard = 0;
      while (this.pending.length) {
        if (++guard > 100000) throw new Error("HARNESS FAILURE: event queue did not drain");
        const task = this.pending.shift();
        task.fn();
      }
    },
  };
  const getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const courseList = getElementById("courseList");

  const document = {
    getElementById,
    querySelectorAll(selector) {
      if (selector === "#courseList input:checked") {
        return checkedBoxes.filter(box => box.checked);
      }
      return [];
    },
    createElement(tag) {
      const element = makeElement(tag);
      element.tagName = String(tag).toUpperCase();
      return element;
    },
  };

  const localStorage = {
    getItem(key) {
      storageReads.push(String(key));
      if (storage instanceof Map) return storage.has(key) ? storage.get(key) : null;
      return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
    },
    setItem(key, value) {
      storageWrites.push({ key: String(key), value: String(value) });
      if (storage instanceof Map) storage.set(key, String(value));
      else storage[key] = String(value);
    },
  };

  // The default harness does not call load(); returning a failed manifest
  // response prevents initialization from entering the real DOM renderer while
  // keeping the page's normal manifest error fallback intact. Cache-focused
  // tests inject a fetch implementation and observe the same load() boundary.
  const defaultFetch = async () => ({
    ok: false,
    status: 404,
    async json() { return {}; },
  });
  const fetch = (...args) => {
    fetchCalls.push({ url: String(args[0]), options: args[1] || {} });
    return typeof harnessOptions.fetch === "function"
      ? harnessOptions.fetch(...args)
      : defaultFetch(...args);
  };

  const schedule = (fn) => {
    eventLoop.pending.push({ kind: "scheduled", fn });
    // A cooperative fixed fallback may yield through a timer or microtask.
    // The baseline synchronous handler never reaches this hook, so this is a
    // deterministic control-return probe rather than a wall-clock threshold.
    if (eventLoop.active) eventLoop.yieldToControl();
    return eventLoop.pending.length;
  };
  const shared = sharedOptimizerIfPresent();
  const context = vm.createContext({
    console,
    document,
    localStorage,
    fetch,
    setTimeout: schedule,
    clearTimeout() { },
    queueMicrotask: schedule,
    requestAnimationFrame: schedule,
    window: { TimetableOptimizer: shared },
  });
  vm.runInContext(inlineScript(), context, { filename: INDEX });

  const harness = {
    context,
    checkedBoxes,
    elements,
    eventLoop,
    fetchCalls,
    workerInstances,
    storage,
    storageReads,
    storageWrites,
    async settleAsync() {
      // loadManifest() starts during inline-script evaluation. A real turn covers
      // both the injected fetch promise and the VM context's async continuation.
      await new Promise(resolve => setImmediate(resolve));
      await Promise.resolve();
      await Promise.resolve();
    },
    installDeterministicWorker() {
      const page = this;
      // This worker adapter is intentionally only a test boundary. It invokes
      // the same shared optimizer module and never constructs a second solver.
      this.context.Worker = class DeterministicOptimizerWorker {
        constructor(url) {
          this.url = url;
          this.onmessage = null;
          this.onerror = null;
          this.terminated = false;
          this.messages = [];
          workerInstances.push(this);
          eventLoop.trace.push(`worker-created:${url}`);
        }
        postMessage(message) {
          this.messages.push(message);
          eventLoop.trace.push("worker-post");
          eventLoop.yieldToControl();
          eventLoop.pending.push({
            kind: "worker-result",
            fn: () => {
              try {
                const input = message && message.input ? message.input : message || {};
                const plans = input.plans || message.plans;
                const opts = input.options || input.opts || message.options || message.opts || {};
                if (!shared || typeof shared.findBestPlan !== "function") {
                  throw new Error("shared optimizer unavailable in worker adapter");
                }
                const emitProgress = progress => {
                  const data = {
                    type: "progress",
                    requestId: message.requestId,
                    generation: message.generation,
                    key: message.key,
                    combinationsSearched: progress && progress.combinationsSearched,
                    done: !!(progress && progress.done),
                  };
                  if (typeof this.onmessage === "function") this.onmessage({ data });
                };
                const result = shared.findBestPlan(plans, opts, {
                  onProgress: emitProgress,
                });
                const data = Object.assign({}, result, {
                  result,
                  requestId: message.requestId,
                  generation: message.generation,
                  key: message.key,
                });
                if (typeof this.onmessage === "function") this.onmessage({ data });
              } catch (error) {
                if (typeof this.onerror === "function") this.onerror(error);
                else throw error;
              }
            },
          });
        }
        terminate() {
          this.terminated = true;
          eventLoop.trace.push("worker-terminate");
        }
      };
      this.context.window.Worker = this.context.Worker;
      return page;
    },
    runPageOptimize(opts) {
      const encodedOpts = JSON.stringify(opts);
      this.eventLoop.begin();
      this.eventLoop.queueControlProbe();
      let thrown = null;
      const originalFindBestPlan = shared && shared.findBestPlan;
      if (typeof originalFindBestPlan === "function") {
        shared.findBestPlan = (...args) => {
          const result = originalFindBestPlan(...args);
          this.eventLoop.lastSolverResult = result;
          return result;
        };
      }
      try {
        try {
          vm.runInContext(`(function(opts) {
            document.getElementById("optCampus").checked = !!opts.campus;
            document.getElementById("optLunch").checked = !!opts.lunch;
            document.getElementById("optEarly").checked = !!opts.early;
            document.getElementById("optLate").checked = !!opts.late;
            optimize();
          })(${encodedOpts})`, this.context);
        } catch (error) {
          thrown = error;
        } finally {
          this.eventLoop.end();
        }
        this.eventLoop.flush();
      } finally {
        if (typeof originalFindBestPlan === "function")
          shared.findBestPlan = originalFindBestPlan;
      }
      const pageState = vm.runInContext(`({
        plan: typeof bestSoFar === "undefined" ? null : bestSoFar,
        result: typeof bestSoFarResult === "undefined" ? null : bestSoFarResult,
        status: document.getElementById("status").textContent,
        timetable: document.getElementById("timetable").innerHTML,
      })`, this.context);
      return Object.assign(pageState, {
        thrown,
        solverResult: this.eventLoop.lastSolverResult,
        controlDuringSearch: this.eventLoop.controlDuringSearch,
        controlAfterReturn: this.eventLoop.controlAfterReturn,
        trace: this.eventLoop.trace.slice(),
      });
    },
  };

  return Object.assign(harness, {
    installCourses(rawData, includeCodes = null) {
      const raw = JSON.stringify(rawData);
      const codes = includeCodes === null ? "null" : JSON.stringify(includeCodes);
      // Load the same shared grouping helper used by the browser's async load().
      vm.runInContext(`COURSES = OPTIMIZER.groupCourses(${raw}, {
        includeCombos: false,
        includeCodes: ${codes},
      });`, this.context);
    },
    setLocks(locks) {
      this.checkedBoxes.length = 0;
      for (const lock of locks) {
        this.checkedBoxes.push({
          checked: true,
          dataset: { code: lock.code, tm: lock.tm, sec: lock.sec },
        });
      }
    },
    setExclusions({ tut = [], pra = [], lec = [] } = {}) {
      const quote = value => JSON.stringify(value);
      vm.runInContext(`
        uselessTut.clear(); uselessPra.clear(); uselessLec.clear();
        for (const code of ${quote(tut)}) uselessTut.add(code);
        for (const key of ${quote(pra)}) uselessPra.add(key);
        for (const code of ${quote(lec)}) uselessLec.add(code);
        tutAttend.clear();
      `, this.context);
    },
    selectedPlans() {
      return vm.runInContext("selectedPlan()", this.context);
    },
    renderCourses() {
      return vm.runInContext("renderCourseList()", this.context);
    },
    setRandomSequence(values) {
      let cursor = 0;
      const deterministicMath = Object.create(Math);
      deterministicMath.random = () => {
        const value = values[cursor % values.length];
        cursor += 1;
        return value;
      };
      this.context.Math = deterministicMath;
    },
    runLegacySample(plans, opts, randomValues) {
      this.setRandomSequence(randomValues);
      this.context.__explorationInput = { plans, opts };
      return vm.runInContext(
        "solveBest(__explorationInput.plans, 1, __explorationInput.opts)",
        this.context,
      );
    },
  });
}

function sharedOptimizerIfPresent() {
  const optimizerPath = path.join(ROOT, "web", "optimizer.js");
  if (!fs.existsSync(optimizerPath)) return null;
  // Requiring this file is intentionally conditional: Task 1 must execute the
  // current inline implementation before the production module is created.
  return require(optimizerPath);
}

function normalizeObserved(raw) {
  if (Array.isArray(raw)) {
    return {
      plan: raw.length ? raw : null,
      status: raw.length ? "LEGACY_PLAN" : "NO_SOLUTION",
      complete: false,
      rawShape: "legacy-array",
    };
  }
  if (raw && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "plan")) {
    return {
      plan: raw.plan || null,
      status: raw.status || (raw.plan ? "PLAN" : "NO_SOLUTION"),
      complete: raw.complete === true,
      rawShape: "search-result",
      raw,
    };
  }
  return {
    plan: raw || null,
    status: raw ? "PLAN" : "NO_SOLUTION",
    complete: false,
    rawShape: "unknown",
    raw,
  };
}

function makeOptimizerRunner(page) {
  const shared = sharedOptimizerIfPresent();
  return {
    shared,
    run(plans, opts, randomValues = [0.5]) {
      if (shared && typeof shared.findBestPlan === "function") {
        return normalizeObserved(shared.findBestPlan(plans, opts));
      }
      return normalizeObserved(page.runLegacySample(plans, opts, randomValues));
    },
  };
}

function eventList(plan) {
  const events = [];
  for (const course of plan || []) {
    for (const item of course.pick || []) {
      for (const meeting of item.ms || []) {
        events.push({
          day: Number(meeting.day),
          start: Number(meeting.start),
          end: Number(meeting.end),
          code: course.code,
          section: item.lec ? (item.secs || ["LEC*"])[0] :
            (item.sec && item.sec.name) || "?",
        });
      }
    }
  }
  return events;
}

function eventOverlap(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

function planIsClashFree(plan) {
  const events = eventList(plan);
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      if (eventOverlap(events[i], events[j])) return false;
    }
  }
  return true;
}

function sameMeeting(a, b) {
  return a.day === b.day && a.start === b.start && a.end === b.end;
}

function containsLockedMeetings(plan, plans) {
  const actual = eventList(plan);
  return plans.every(course => course.locked.every(lock =>
    (lock.ms || []).every(meeting => actual.some(event => sameMeeting(event, meeting)))
  ));
}

function stablePlanSignature(plan) {
  return eventList(plan)
    .map(event => `${event.code}:${event.section}:${event.day}:${event.start}:${event.end}`)
    .sort()
    .join("|");
}

function evaluateReference(plan) {
  const byDay = new Map();
  for (const event of eventList(plan)) {
    if (!byDay.has(event.day)) byDay.set(event.day, []);
    byDay.get(event.day).push({ start: event.start, end: event.end });
  }

  let gapsMs = 0;
  let campusMs = 0;
  let lunchDeficitMs = 0;
  let sumStartMs = 0;
  let sumEndMs = 0;
  for (const blocks of byDay.values()) {
    blocks.sort((a, b) => a.start - b.start || a.end - b.end);
    if (blocks.length)
      campusMs += blocks[blocks.length - 1].end - blocks[0].start;
    for (let i = 1; i < blocks.length; i++) {
      gapsMs += Math.max(0, blocks[i].start - blocks[i - 1].end);
    }

    let occupiedLunchMs = 0;
    for (const block of blocks) {
      occupiedLunchMs += Math.max(
        0,
        Math.min(block.end, LUNCH_END) - Math.max(block.start, LUNCH_START),
      );
      sumStartMs += block.start;
      sumEndMs += block.end;
    }
    const freeLunchMs = (LUNCH_END - LUNCH_START) - occupiedLunchMs;
    if (freeLunchMs < HOUR) lunchDeficitMs += HOUR;
  }

  return {
    activeDays: byDay.size,
    gapsMs,
    campusMs,
    lunchDeficitMs,
    sumStartMs,
    sumEndMs,
    sumEndHours: sumEndMs / HOUR,
    sumStartHours: sumStartMs / HOUR,
  };
}

function objectiveValue(evaluation, opts) {
  return (opts.campus ? evaluation.campusMs / HOUR : 0) +
    (opts.lunch ? evaluation.lunchDeficitMs / HOUR : 0) +
    (opts.early ? evaluation.sumEndHours : 0) +
    (opts.late ? -evaluation.sumStartHours : 0);
}

function compareReference(left, right, opts) {
  // This is intentionally independent from the page's scorePlan.  For the
  // single-preference exploration cases all terms are isolated; lunch is also
  // compared as a first-class deficit for the later fixed contract.
  if (opts.lunch && left.lunchDeficitMs !== right.lunchDeficitMs)
    return left.lunchDeficitMs < right.lunchDeficitMs ? -1 : 1;
  const leftValue = objectiveValue(left, opts);
  const rightValue = objectiveValue(right, opts);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function candidatePlans(plans) {
  const candidates = plans.map(course => {
    const combos = course.poolTypes && course.poolTypes.length
      ? course.combos
      : [[]];
    return (combos || []).map(combo => ({
      code: course.code,
      name: course.name,
      pick: [...(course.locked || []), ...combo],
    })).filter(candidate => planIsClashFree([candidate]));
  });
  const all = [];
  const chosen = [];
  function visit(index) {
    if (index === candidatePlans.current.length) {
      all.push(chosen.map(plan => ({ ...plan, pick: plan.pick.slice() })));
      return;
    }
    for (const candidate of candidatePlans.current[index]) {
      const existing = eventList(chosen);
      if (eventList([candidate]).some(event => existing.some(other => eventOverlap(event, other))))
        continue;
      chosen.push(candidate);
      visit(index + 1);
      chosen.pop();
    }
  }
  candidatePlans.current = candidates;
  visit(0);
  delete candidatePlans.current;
  return all;
}

function referenceMinimum(plans, opts) {
  const feasible = candidatePlans(plans);
  let best = null;
  let bestEvaluation = null;
  for (const plan of feasible) {
    const evaluation = evaluateReference(plan);
    if (!best || compareReference(evaluation, bestEvaluation, opts) < 0) {
      best = plan;
      bestEvaluation = evaluation;
    }
  }
  if (!best) {
    throw new Error("HARNESS FAILURE: independent reference found no feasible plan");
  }
  return { plan: best, evaluation: bestEvaluation, feasibleCount: feasible.length };
}

function lockedClash(plans) {
  for (const course of plans) {
    const locked = course.locked || [];
    for (let i = 0; i < locked.length; i++) {
      for (let j = i + 1; j < locked.length; j++) {
        for (const left of locked[i].ms || []) {
          for (const right of locked[j].ms || []) {
            if (eventOverlap(left, right)) {
              return {
                code: course.code,
                left: locked[i].sec && locked[i].sec.name,
                right: locked[j].sec && locked[j].sec.name,
                meeting: { left, right },
              };
            }
          }
        }
      }
    }
  }
  return null;
}

function expectedBehavior(input, observed, oracle = null) {
  if (input.lockedClash) {
    const ok = observed.plan === null &&
      observed.status === "NO_SOLUTION" && observed.complete === true;
    return {
      ok,
      contract: { plan: null, status: "NO_SOLUTION", complete: true },
    };
  }

  const actualEvaluation = observed.plan ? evaluateReference(observed.plan) : null;
  const ok = observed.plan !== null &&
    observed.complete === true &&
    planIsClashFree(observed.plan) &&
    containsLockedMeetings(observed.plan, input.plans) &&
    oracle !== null &&
    compareReference(actualEvaluation, oracle.evaluation, input.opts) === 0;
  return {
    ok,
    contract: {
      plan: "complete, clash-free",
      objective: oracle && oracle.evaluation,
      feasibleCount: oracle && oracle.feasibleCount,
    },
  };
}

function counterexampleMessage(input, observed, oracle, verdict) {
  const actualEvaluation = observed.plan ? evaluateReference(observed.plan) : null;
  return [
    "BUG-CONDITION EXPLORATION COUNTEREXAMPLE (expected failure on F)",
    `input: ${input.name}`,
    `seed: ${input.seed || "n/a"}`,
    `expectedBehavior: ${JSON.stringify(verdict.contract)}`,
    `observed legacy shape: ${observed.rawShape}`,
    `observed status/complete: ${observed.status}/${observed.complete}`,
    `observed objective: ${JSON.stringify(actualEvaluation)}`,
    `independent minimum: ${JSON.stringify(oracle && oracle.evaluation)}`,
    `independent feasible plans: ${oracle && oracle.feasibleCount}`,
    `observed plan signature: ${observed.plan && stablePlanSignature(observed.plan)}`,
    `active lock clash: ${JSON.stringify(input.lockedClash)}`,
  ].join("\n");
}

function assertExpectedBehavior(input, observed, oracle = null) {
  const verdict = expectedBehavior(input, observed, oracle);
  assert.equal(verdict.ok, true, counterexampleMessage(input, observed, oracle, verdict));
}

function lockedInput(page, rawData, courseCodes, locks, exclusions) {
  page.installCourses(rawData, courseCodes);
  page.setExclusions(exclusions);
  page.setLocks(locks);
  const plans = page.selectedPlans();
  assert.ok(plans.length > 0, `HARNESS FAILURE: no plans built for ${courseCodes.join(", ")}`);
  return plans;
}

const campusOptions = { campus: 1, lunch: 0, early: 0, late: 0 };
const lunchOptions = { campus: 0, lunch: 1, early: 0, late: 0 };
const earlyOptions = { campus: 0, lunch: 0, early: 1, late: 0 };
const lateOptions = { campus: 0, lunch: 0, early: 0, late: 1 };

function choicePlan(code, choices) {
  return {
    code,
    name: code,
    locked: [],
    poolTypes: ["CHOICE"],
    combos: choices.map((meetings, index) => [{
      sec: { name: `CHOICE${index + 1}` },
      ms: meetings,
    }]),
  };
}

function runSyntheticObjectiveCase(runner, name, opts, choices, seed) {
  const plans = [choicePlan(name, choices)];
  const oracle = referenceMinimum(plans, opts);
  const observed = runner.run(plans, opts, seed);
  assertExpectedBehavior({ name, opts, plans, seed: seed.join(",") }, observed, oracle);
}

// These sequences are intentionally fixed.  In the current V8 implementation,
// the two-element Array#sort-based shuffle with 0.1 selects the second entry;
// the synthetic choices below therefore place the worse alternative second.
const WORSE_FIRST_SEED = [0.1];


test("expectedBehavior: Computer/ECE Fall campus reproduction has a sampled miss", () => {
  const rawData = readJson("computer-1-fall.json");
  const page = makeInlinePageHarness();
  const runner = makeOptimizerRunner(page);
  const relevantCodes = ["APS100H1", "APS110H1", "APS111H1"];
  const locks = [
    { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
    { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
  ];
  const plans = lockedInput(page, rawData, relevantCodes, locks, {
    tut: ["APS110H1"],
  });
  assert.equal(plans.length, 3, "HARNESS FAILURE: reproduction slice lost a required course");
  assert.equal(
    plans.find(plan => plan.code === "APS100H1").locked.length,
    1,
    "HARNESS FAILURE: APS100H1 TUT0106 was not active/locked",
  );
  assert.equal(
    plans.find(plan => plan.code === "APS111H1").locked.length,
    1,
    "HARNESS FAILURE: APS111H1 TUT0106 was not active/locked",
  );
  assert.equal(
    plans.find(plan => plan.code === "APS110H1").poolTypes.includes("TUT"),
    false,
    "HARNESS FAILURE: APS110H1 tutorials were not excluded",
  );

  const oracle = referenceMinimum(plans, campusOptions);
  assert.ok(oracle.feasibleCount > 1,
    "HARNESS FAILURE: reproduction slice did not expose alternative feasible plans");
  const observed = runner.run(plans, campusOptions, WORSE_FIRST_SEED);
  const input = {
    name: "computer-1-fall APS100H1/APS111H1 locks + APS110H1 TUT exclusion",
    opts: campusOptions,
    plans,
    seed: WORSE_FIRST_SEED.join(","),
  };

  if (!runner.shared) {
    assert.ok(observed.plan,
      `HARNESS FAILURE: unfixed solveBest returned no plan for ${input.name}`);
    assert.ok(
      compareReference(evaluateReference(observed.plan), oracle.evaluation, campusOptions) > 0,
      `HARNESS FAILURE: captured seed was not a campus miss; observed=${JSON.stringify(
        evaluateReference(observed.plan))} minimum=${JSON.stringify(oracle.evaluation)}`,
    );
  }
  assertExpectedBehavior(input, observed, oracle);
});


function pageContractViolations(observed, plans, opts, oracle, optimizer, label) {
  const violations = [];
  if (observed.thrown) violations.push(`page threw: ${observed.thrown.message || observed.thrown}`);
  if (!observed.controlDuringSearch) {
    violations.push("control callback did not run before optimize returned (synchronous page boundary)");
  }

  const result = observed.solverResult;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    violations.push(`solver returned no proof-carrying result: ${JSON.stringify(result)}`);
    return violations;
  }
  for (const [key, expected] of [["complete", true], ["optimal", true], ["status", "OPTIMAL"]]) {
    if (result[key] !== expected)
      violations.push(`solver result ${key}=${JSON.stringify(result[key])}, expected ${JSON.stringify(expected)}`);
  }
  for (const key of ["deadline", "timedOut", "sampled", "random", "fallback", "iterations"]) {
    if (Object.prototype.hasOwnProperty.call(result, key))
      violations.push(`solver result exposed forbidden ${key} metadata`);
  }

  if (!result.plan) {
    violations.push("feasible reference case returned no plan");
    return violations;
  }
  if (!planIsClashFree(result.plan)) violations.push("solver plan has a positive-duration clash");
  if (!containsLockedMeetings(result.plan, plans)) violations.push("solver plan changed an active locked meeting");
  if (result.plan.length !== plans.length)
    violations.push(`solver plan has ${result.plan.length} courses, expected ${plans.length}`);

  const actualByCode = new Map(result.plan.map(course => [String(course.code), course]));
  for (const inputCourse of plans) {
    const actual = actualByCode.get(String(inputCourse.code));
    if (!actual) {
      violations.push(`solver plan omitted required course ${inputCourse.code}`);
      continue;
    }
    for (const requiredType of inputCourse.poolTypes || []) {
      const present = (actual.pick || []).some(item => {
        if (item && item.lec) return requiredType === "LEC";
        return optimizer.componentType(item && (item.tm || item.teachMethod || item.type || item.sec || item)) ===
          requiredType;
      });
      if (!present) violations.push(`${inputCourse.code} omitted required ${requiredType}`);
    }
  }
  const aps110 = actualByCode.get("APS110H1");
  if (aps110 && (aps110.pick || []).some(item =>
    optimizer.componentType(item && (item.tm || item.teachMethod || item.type || item.sec || item)) === "TUT")) {
    violations.push("APS110H1 retained an excluded tutorial");
  }

  const actualEvaluation = evaluateReference(result.plan);
  if (optimizer.stableStringify &&
    optimizer.stableStringify(result.evaluation) !== optimizer.stableStringify(optimizer.evaluatePlan(result.plan))) {
    violations.push("solver evaluation does not match evaluatePlan");
  }
  if (optimizer.stableStringify &&
    optimizer.stableStringify(result.objective) !==
    optimizer.stableStringify(optimizer.objectiveKey(result.evaluation, opts))) {
    violations.push("solver objective does not match objectiveKey");
  }
  if (result.signature !== optimizer.planSignature(result.plan))
    violations.push("solver signature does not match planSignature");
  if (compareReference(actualEvaluation, oracle.evaluation, opts) !== 0) {
    violations.push(`objective miss: observed=${JSON.stringify(actualEvaluation)} ` +
      `reference=${JSON.stringify(oracle.evaluation)}`);
  }

  if (!observed.result) violations.push("page did not retain the complete solver result proof");
  if (!observed.plan) violations.push("page did not retain/render the feasible plan");
  if (!observed.timetable) violations.push("page rendered no timetable for a feasible result");
  return violations;
}

function noSolutionPageViolations(observed) {
  const violations = [];
  if (observed.thrown) violations.push(`no-solution page threw: ${observed.thrown.message || observed.thrown}`);
  if (!observed.controlDuringSearch)
    violations.push("no-solution search did not return control before completion");
  const result = observed.solverResult;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    violations.push(`no-solution search returned no result object: ${JSON.stringify(result)}`);
  } else {
    for (const [key, expected] of [["plan", null], ["status", "NO_SOLUTION"],
    ["complete", true], ["optimal", true], ["evaluation", null], ["objective", null]]) {
      if (result[key] !== expected)
        violations.push(`no-solution ${key}=${JSON.stringify(result[key])}, expected ${JSON.stringify(expected)}`);
    }
  }
  if (observed.plan !== null) violations.push("page retained a plan after proven no-solution");
  if (observed.timetable !== "") violations.push("page retained a timetable after proven no-solution");
  if (!/Could not build a clash-free timetable/.test(observed.status))
    violations.push(`page did not show no-solution guidance: ${observed.status}`);
  if (!/Searched \d+ combinations\.$/.test(observed.status))
    violations.push(`page did not show searched-combination count: ${observed.status}`);
  return violations;
}


test("bug condition exploration: exact Fall locks use the real page boundary", () => {
  const rawData = readJson("computer-1-fall.json");
  const locks = [
    { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
    { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
  ];
  const exclusions = { tut: ["APS110H1"] };
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "HARNESS FAILURE: shared optimizer module is required for the page adapter");

  // Construct the complete cache-backed input first. This proves that the
  // reproduction state is not merely a hand-written three-course fixture.
  const fullPage = makeInlinePageHarness();
  fullPage.installCourses(rawData);
  fullPage.setExclusions(exclusions);
  fullPage.setLocks(locks);
  const fullPlans = fullPage.selectedPlans();
  assert.equal(fullPlans.length, rawData.length,
    "HARNESS FAILURE: computer-1-fall page input lost a loaded course");
  assert.equal(fullPlans.reduce((count, course) => count + course.locked.length, 0), 2,
    "HARNESS FAILURE: exact reproduction must have only the two active locks");
  for (const lock of locks) {
    const course = fullPlans.find(candidate => candidate.code === lock.code);
    assert.ok(course, `HARNESS FAILURE: missing locked course ${lock.code}`);
    assert.ok(course.locked.some(active => active.tm === lock.tm &&
      active.sec && active.sec.name === lock.sec),
      `HARNESS FAILURE: ${lock.code} ${lock.sec} was not retained by selectedPlan()`);
  }
  const excludedCourse = fullPlans.find(course => course.code === "APS110H1");
  assert.ok(excludedCourse, "HARNESS FAILURE: APS110H1 missing from the full cache input");
  assert.equal(excludedCourse.poolTypes.includes("TUT"), false,
    "HARNESS FAILURE: APS110H1 tutorial pool was not removed before search");

  // The full cache has a very large finite product. The page-boundary probe
  // uses the exact locked/excluded cache slice already present in the report so
  // the exploration is deterministic and terminates on both the legacy and
  // fixed paths; the independent oracle still enumerates every slice choice.
  const relevantCodes = ["APS100H1", "APS110H1", "APS111H1"];
  const relevantRaw = rawData.filter(course => relevantCodes.includes(course.code));
  const page = makeInlinePageHarness().installDeterministicWorker();
  page.installCourses(relevantRaw);
  page.setExclusions(exclusions);
  page.setLocks(locks);
  const plans = page.selectedPlans();
  const oracle = referenceMinimum(plans, campusOptions);
  assert.ok(oracle.feasibleCount > 1,
    "HARNESS FAILURE: locked/excluded reproduction slice has no objective alternatives");
  const observed = page.runPageOptimize(campusOptions);
  const repeated = page.runPageOptimize(campusOptions);
  const violations = pageContractViolations(
    observed,
    plans,
    campusOptions,
    oracle,
    optimizer,
    "Computer/ECE Fall locked reproduction",
  );
  if (observed.solverResult && repeated.solverResult) {
    for (const key of ["status", "complete", "optimal", "signature"]) {
      if (observed.solverResult[key] !== repeated.solverResult[key])
        violations.push(`repeated page search changed ${key}`);
    }
    if (optimizer.stableStringify(observed.solverResult.evaluation) !==
      optimizer.stableStringify(repeated.solverResult.evaluation)) {
      violations.push("repeated page search changed evaluation");
    }
    if (optimizer.stableStringify(observed.solverResult.objective) !==
      optimizer.stableStringify(repeated.solverResult.objective)) {
      violations.push("repeated page search changed objective");
    }
    if (stablePlanSignature(observed.solverResult.plan) !==
      stablePlanSignature(repeated.solverResult.plan)) {
      violations.push("repeated page search changed the rendered event signature");
    }
  }
  const reproductionMessage = [
    "BUG-CONDITION EXPLORATION COUNTEREXAMPLE (expected failure on F)",
    "input: computer-1-fall, program=computer, year=1, session=fall",
    "locks: APS100H1:TUT0106, APS111H1:TUT0106",
    "exclusions: all APS110H1 tutorials",
    "options: campus=1,lunch=0,early=0,late=0",
    `violations: ${JSON.stringify(violations)}`,
    `control trace: ${JSON.stringify(observed.trace)}`,
    `solver status/complete/optimal: ${JSON.stringify(observed.solverResult && {
      status: observed.solverResult.status,
      complete: observed.solverResult.complete,
      optimal: observed.solverResult.optimal,
    })}`,
    `observed objective: ${JSON.stringify(observed.solverResult && observed.solverResult.plan &&
      evaluateReference(observed.solverResult.plan))}`,
    `reference minimum: ${JSON.stringify(oracle.evaluation)}`,
    `observed signature: ${observed.solverResult && observed.solverResult.signature}`,
  ].join("\n");

  const conflictPage = makeInlinePageHarness().installDeterministicWorker();
  conflictPage.installCourses(rawData, ["MAT188H1"]);
  conflictPage.setExclusions({});
  conflictPage.setLocks([
    { code: "MAT188H1", tm: "PRA", sec: "PRA0106" },
    { code: "MAT188H1", tm: "TUT", sec: "TUT0115" },
  ]);
  const conflictObserved = conflictPage.runPageOptimize(campusOptions);
  const conflictViolations = noSolutionPageViolations(conflictObserved);
  const conflictMessage = [
    "BUG-CONDITION EXPLORATION COUNTEREXAMPLE (expected failure on F)",
    "input: computer-1-fall MAT188H1 overlapping PRA0106/TUT0115 locks",
    `violations: ${JSON.stringify(conflictViolations)}`,
    `control trace: ${JSON.stringify(conflictObserved.trace)}`,
    `solver result: ${JSON.stringify(conflictObserved.solverResult && {
      status: conflictObserved.solverResult.status,
      complete: conflictObserved.solverResult.complete,
      optimal: conflictObserved.solverResult.optimal,
      reason: conflictObserved.solverResult.diagnostics && conflictObserved.solverResult.diagnostics.reason,
    })}`,
    `rendered timetable length: ${conflictObserved.timetable.length}`,
  ].join("\n");
  const allViolations = violations.concat(conflictViolations.map(value => `no-solution: ${value}`));
  assert.equal(allViolations.length, 0, `${reproductionMessage}\n${conflictMessage}`);
});


test("expectedBehavior: lunch sampling miss loses the full-hour alternative", () => {
  const page = makeInlinePageHarness();
  const runner = makeOptimizerRunner(page);
  runSyntheticObjectiveCase(runner, "lunch-synthetic", lunchOptions, [
    [{ day: 1, start: 11 * HOUR, end: 12 * HOUR }],
    [{ day: 1, start: 11 * HOUR, end: 13 * HOUR }],
  ], WORSE_FIRST_SEED);
});


test("expectedBehavior: end-early sampling miss returns the later alternative", () => {
  const page = makeInlinePageHarness();
  const runner = makeOptimizerRunner(page);
  runSyntheticObjectiveCase(runner, "end-early-synthetic", earlyOptions, [
    [{ day: 1, start: 9 * HOUR, end: 12 * HOUR }],
    [{ day: 1, start: 9 * HOUR, end: 14 * HOUR }],
  ], WORSE_FIRST_SEED);
});


test("expectedBehavior: start-late sampling miss returns the earlier alternative", () => {
  const page = makeInlinePageHarness();
  const runner = makeOptimizerRunner(page);
  runSyntheticObjectiveCase(runner, "start-late-synthetic", lateOptions, [
    [{ day: 1, start: 10 * HOUR, end: 11 * HOUR }],
    [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
  ], WORSE_FIRST_SEED);
});


test("expectedBehavior: MAT188H1 accepts an overlapping same-course lock on F", () => {
  const rawData = readJson("computer-1-fall.json");
  const page = makeInlinePageHarness();
  const runner = makeOptimizerRunner(page);
  const plans = lockedInput(page, rawData, ["MAT188H1"], [
    { code: "MAT188H1", tm: "PRA", sec: "PRA0106" },
    { code: "MAT188H1", tm: "TUT", sec: "TUT0115" },
  ]);
  const clash = lockedClash(plans);
  assert.ok(clash, "HARNESS FAILURE: MAT188H1 lock pair was not detected as overlapping");
  assert.equal(clash.code, "MAT188H1");
  assert.deepEqual(
    new Set([clash.left, clash.right]),
    new Set(["PRA0106", "TUT0115"]),
  );

  const observed = runner.run(plans, campusOptions, [0.5]);
  if (!runner.shared) {
    assert.ok(observed.plan,
      "HARNESS FAILURE: old solver did not return its known accepted conflicting lock plan");
    const events = eventList(observed.plan).filter(event => event.code === "MAT188H1");
    assert.ok(
      events.some(event => eventOverlap(events[0], event)) && events.length >= 2,
      "HARNESS FAILURE: accepted legacy plan did not retain the overlapping lock events",
    );
  }
  assertExpectedBehavior({
    name: "computer-1-fall MAT188H1 PRA0106 + TUT0115 active locks",
    plans,
    opts: campusOptions,
    lockedClash: clash,
  }, observed);

  // Verify the same original lock counterexample through the page boundary:
  // a complete no-solution result must clear the rendered timetable rather
  // than allowing the overlapping locks to reach renderPlan.
  const displayed = preservationRunPageOptimize(page, campusOptions, [0.5]);
  assert.equal(displayed.plan, null,
    "MAT188H1 overlapping locks must not leave a page-level plan");
  assert.equal(displayed.timetable, "",
    "MAT188H1 overlapping locks must clear the page timetable");
  assert.match(displayed.status, /Could not build a clash-free timetable/,
    "MAT188H1 overlapping locks must use the existing no-solution guidance");
});


test("coverage gap: existing Python validation does not execute the browser optimizer", () => {
  const pythonFiles = [
    path.join(ROOT, "tests", "test_frontend_catalog.py"),
    path.join(ROOT, "tests", "test_data_contract.py"),
  ];
  const source = pythonFiles.map(file => fs.readFileSync(file, "utf8")).join("\n");
  const browserExecution = /\b(?:selectedPlan|scorePlan|solveBest|findBestPlan)\s*\(/.test(source);
  const coverageGap = {
    checksCacheAndShape: source.includes("test_first_year_matrix_has_valid_course_and_section_shapes"),
    executesBrowserOptimizer: browserExecution,
    firstYearMatrix: 8 * 2,
  };
  assert.equal(coverageGap.checksCacheAndShape, true);
  assert.equal(coverageGap.executesBrowserOptimizer, false);
  console.log("COVERAGE GAP CAPTURED:", JSON.stringify(coverageGap));
});


// ---------------------------------------------------------------------------
// Task 2: preservation/property baselines against the unfixed page.
// These checks deliberately assert attendance, feasibility, and loading
// invariants rather than a particular randomly selected section identity.

const PRESERVATION_NO_OPTIONS = { campus: 0, lunch: 0, early: 0, late: 0 };
const PRESERVATION_PROGRAMS = [
  "computer", "mechanical", "industrial", "chemical",
  "materials", "civil", "mineral", "trackone",
];

function preservationSection(name, teachMethod, meetingValues) {
  return {
    name,
    teachMethod,
    meetingTimes: meetingValues.map(m => ({
      start: { day: m.day, millisofday: m.start },
      end: { day: m.day, millisofday: m.end },
    })),
  };
}

function preservationCourse(code, sections) {
  return { code, name: code, sections };
}

test("Task 1: strict canonical instructor identity and section extraction", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available for canonical helpers");
  assert.equal(
    optimizer.canonicalInstructorIdentity({ firstName: " Ada \n  Lovelace ", lastName: "  Byron  " }),
    "ada lovelace byron",
  );
  assert.equal(
    optimizer.instructorIdentity({ givenName: "ADA", familyName: "LOVELACE" }),
    "",
    "legacy given/family aliases must not become instructor identities",
  );
  assert.equal(
    optimizer.canonicalInstructorIdentity({
      utorid: "  GHOPPER  ", firstName: "Grace", lastName: "Hopper",
    }),
    "grace hopper",
    "stable identifiers must be ignored in favor of firstName + lastName",
  );
  assert.equal(optimizer.canonicalInstructorIdentity({ displayName: "Grace Hopper" }), "");
  assert.equal(optimizer.canonicalInstructorIdentity({ firstName: "Ada" }), "");
  assert.equal(optimizer.canonicalInstructorIdentity({ firstName: "  ", lastName: "Lovelace" }), "");
  assert.equal(optimizer.canonicalInstructorIdentity("Ada Lovelace"), "");
  assert.equal(optimizer.canonicalInstructorIdentity(null), "");
  assert.equal(optimizer.canonicalInstructorIdentity({}), "");
  assert.deepEqual(optimizer.canonicalPreferredInstructors(" ada   lovelace "), [
    "ada lovelace",
  ]);
  assert.deepEqual(
    optimizer.canonicalPreferredInstructors({ firstName: " Ada ", lastName: " Lovelace " }),
    ["ada lovelace"],
  );
  assert.deepEqual(optimizer.canonicalPreferredInstructors([
    "ada lovelace",
    { firstName: " Grace ", lastName: " Hopper " },
  ]), ["ada lovelace", "grace hopper"]);
  assert.deepEqual(optimizer.canonicalPreferredInstructors({
    displayName: "Grace Hopper",
  }), []);
  assert.deepEqual(optimizer.canonicalPreferredInstructors({
    id: "ghopper",
  }), []);
  assert.deepEqual(optimizer.canonicalPreferredInstructors({
    displayName: "Grace Hopper",
    id: "ghopper",
  }), []);

  const lecture = {
    name: "LEC0101",
    teachMethod: "LEC",
    instructors: [
      { firstName: " Ada ", lastName: " Lovelace " },
      { firstName: "Grace", lastName: "Hopper", email: "grace@example.test" },
      { givenName: "ADA", familyName: "LOVELACE" },
      { displayName: "Ignored Person" },
      { utorid: "GHOPPER" },
      null,
    ],
  };
  const tutorial = {
    name: "TUT0101",
    teachMethod: "TUT",
    instructor: { firstName: " Grace ", lastName: " Hopper " },
    teachers: [{ firstName: "Alan", lastName: "Turing" }],
    faculty: [{ firstName: "Katherine", lastName: "Johnson" }],
  };
  const course = { code: "CANON", sections: [lecture, tutorial] };

  assert.deepEqual(optimizer.extractSections(course), [lecture, tutorial]);
  assert.deepEqual(optimizer.extractSectionRecords(course), [lecture, tutorial]);
  assert.deepEqual(optimizer.extractSections({ sec: lecture }), [lecture]);
  assert.deepEqual(optimizer.extractSections({ section: tutorial }), [tutorial]);
  assert.deepEqual(optimizer.extractSections({ code: "EMPTY" }), []);
  assert.deepEqual(optimizer.extractSectionInstructors(lecture), [
    "ada lovelace", "grace hopper",
  ]);
  assert.deepEqual(optimizer.sectionInstructors(course), [
    "ada lovelace", "grace hopper",
  ]);
  assert.deepEqual(optimizer.extractSectionInstructors({ sec: tutorial }), []);
  assert.deepEqual(optimizer.extractSectionInstructors({
    name: "NON_ARRAY",
    teachMethod: "TUT",
    instructors: { firstName: "Grace", lastName: "Hopper" },
  }), []);
  assert.deepEqual(optimizer.extractSectionInstructors({
    name: "MISSING",
    teachMethod: "TUT",
  }), []);
});

test("Task 2: lecture provenance remains aligned through normalization", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const first = preservationSection("LEC-A", "LEC", [
    { day: 5, start: 8 * HOUR, end: 9 * HOUR },
    { day: 6, start: 8 * HOUR, end: 9 * HOUR },
  ]);
  first.instructors = [{ firstName: " Ada ", lastName: " Lovelace " }];
  const second = preservationSection("LEC-B", "LEC", [
    { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    { day: 2, start: 10 * HOUR, end: 11 * HOUR },
  ]);
  second.instructors = [{ firstName: " Grace ", lastName: " Hopper " }];

  const lectureOptions = optimizer.buildLecOptions([first, second]);
  assert.equal(lectureOptions.length, 2,
    "each multi-meeting lecture section must remain one complete candidate");
  assert.deepEqual(
    lectureOptions.map(option => option.lectureProvenance.map(entry => entry.sectionName)),
    [["LEC-A", "LEC-A"], ["LEC-B", "LEC-B"]],
    "lecture candidates must not mix source sections by meeting position",
  );

  // Use a deliberately mixed legacy-shaped option to keep testing that
  // normalization preserves meeting/source/instructor alignment at boundaries.
  const firstMeeting = optimizer.meetings(first)[0];
  const secondMeeting = optimizer.meetings(second)[0];
  const mixed = {
    lec: true,
    sec: { name: "LEC*" },
    ms: [firstMeeting, secondMeeting],
    secs: ["LEC-A", "LEC-B"],
    lectureProvenance: [
      {
        meeting: firstMeeting,
        sourceSection: first,
        sectionName: "LEC-A",
        instructors: ["ada lovelace"],
      },
      {
        meeting: secondMeeting,
        sourceSection: second,
        sectionName: "LEC-B",
        instructors: ["grace hopper"],
      },
    ],
  };
  assert.deepEqual(
    mixed.ms.map(preservationMeetingKey),
    mixed.lectureProvenance.map(entry => preservationMeetingKey(entry.meeting)),
    "provenance must initially align one-for-one with ms",
  );
  assert.deepEqual(mixed.lectureProvenance.map(entry => entry.instructors), [
    ["ada lovelace"], ["grace hopper"],
  ]);

  const normalizedPlans = optimizer.normalizePlanInput([{
    code: "PROVENANCE",
    name: "PROVENANCE",
    preferredInstructors: [
      { firstName: " ADA ", lastName: " LOVELACE " },
      { firstName: "", lastName: "Invalid" },
      " grace   hopper ",
      { displayName: "Rejected Display Name" },
    ],
    poolTypes: ["LEC"],
    combos: [[mixed]],
  }]);
  assert.deepEqual(normalizedPlans[0].preferredInstructors, ["ada lovelace", "grace hopper"]);
  const normalized = normalizedPlans[0].combos[0][0];
  assert.deepEqual(normalized.ms.map(preservationMeetingKey), [
    "1:36000000:39600000", "5:28800000:32400000",
  ], "normalization must sort meetings deterministically");
  assert.deepEqual(normalized.secs, ["LEC-B", "LEC-A"],
    "normalization must move section names with their meetings");
  assert.deepEqual(normalized.lectureProvenance.map(entry => entry.sectionName), ["LEC-B", "LEC-A"]);
  assert.deepEqual(normalized.lectureProvenance.map(entry => entry.instructors), [
    ["grace hopper"], ["ada lovelace"],
  ], "normalization must move instructor identities with their meetings");

  const sameTimeAda = preservationSection("LEC-SAME", "LEC", [
    { day: 3, start: 9 * HOUR, end: 10 * HOUR },
  ]);
  sameTimeAda.instructors = [{ firstName: "Ada", lastName: "Lovelace" }];
  const sameTimeGrace = preservationSection("LEC-SAME", "LEC", [
    { day: 3, start: 9 * HOUR, end: 10 * HOUR },
  ]);
  sameTimeGrace.instructors = [{ firstName: "Grace", lastName: "Hopper" }];
  const sameTimeOptions = optimizer.buildLecOptions([sameTimeAda, sameTimeGrace]);
  assert.equal(sameTimeOptions.length, 2,
    "same-time lecture candidates with different instructors must not collapse");
  assert.equal(new Set(sameTimeOptions.map(optimizer.optionSignature)).size, 2);
  const sameTimePlans = optimizer.buildCoursePlans([{
    code: "SAME-TIME",
    sections: [sameTimeAda, sameTimeGrace],
  }], {});
  assert.equal(sameTimePlans[0].combos.length, 2,
    "course construction must retain same-time different-instructor candidates");
});

test("Task 4: MAT290 preferred lectures keep section integrity and report mixed provenance", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = readJson("computer-2-fall.json");
  const mat = raw.find(course => course.code === "MAT290H1");
  assert.ok(mat, "MAT290H1 must exist in the Computer Fall cache");

  const plans = optimizer.buildCoursePlans([mat], {
    preferredInstructors: { MAT290H1: ["manfredi maggiore"] },
  });
  const result = optimizer.findBestPlan(plans, {
    campus: 0, lunch: 0, early: 0, late: 0,
  });
  assert.equal(result.status, "OPTIMAL");
  const selectedLecture = result.plan[0].pick.find(item => item.lec);
  assert.ok(selectedLecture, "MAT290 result must contain a lecture candidate");
  assert.deepEqual(
    [...new Set(selectedLecture.lectureProvenance.map(entry => entry.sectionName))],
    ["LEC0102"],
    "preferred MAT290 lectures must use one complete source section",
  );
  assert.ok(selectedLecture.lectureProvenance.every(entry =>
    entry.instructors.includes("manfredi maggiore"),
  ));
  assert.equal(result.evaluation.matchedCourseCount, 1);
  assert.equal(result.evaluation.missedCourseCount, 0);

  const lectureSections = new Map(
    mat.sections.filter(section => section.teachMethod === "LEC")
      .map(section => [section.name, section]),
  );
  const mixedEntries = [
    ["LEC0103", 0],
    ["LEC0101", 1],
    ["LEC0102", 2],
  ].map(([name, index]) => {
    const section = lectureSections.get(name);
    const meeting = optimizer.meetings(section)[index];
    const instructors = section.instructors
      .map(optimizer.canonicalInstructorIdentity).filter(Boolean);
    return {
      meeting,
      sourceSection: { name, instructors: section.instructors },
      sectionName: name,
      instructors,
    };
  });
  const mixedPlan = [{
    code: "MAT290H1",
    name: "Advanced Engineering Mathematics",
    preferredInstructors: ["manfredi maggiore"],
    pick: [{
      lec: true,
      sec: { name: "LEC*" },
      ms: mixedEntries.map(entry => entry.meeting),
      secs: mixedEntries.map(entry => entry.sectionName),
      lectureProvenance: mixedEntries,
    }],
  }];
  assert.deepEqual(optimizer.evaluateInstructorPreferences(mixedPlan), {
    preferredCourseCount: 1,
    matchedCourseCount: 0,
    missedCourseCount: 1,
  }, "a mixed preferred/non-preferred lecture must count as a miss");

  const page = makeInlinePageHarness();
  const labels = vm.runInContext(
    `nonPreferredLectureLabels(${JSON.stringify(mixedPlan)})`,
    page.context,
  );
  assert.equal(labels.length, 2,
    "mixed provenance must report each non-preferred lecture entry");
  assert.ok(labels.some(label => label.includes("LEC0103") && label.includes("Adrian Nachman")));
  assert.ok(labels.some(label => label.includes("LEC0101") && label.includes("Erfan Meskar")));
  assert.equal(labels.some(label => label.includes("LEC0102")), false,
    "the preferred Manfredi entry must not be reported as non-preferred");
});

function lectureSourcePositions(optimizer, option, sourceSections) {
  const byName = new Map((sourceSections || []).map(section => [section.name, section]));
  return (option.lectureProvenance || []).map(entry => {
    const source = entry.sourceSection || byName.get(entry.sectionName);
    assert.ok(source, `missing source section for ${entry.sectionName}`);
    const signature = optimizer.meetingSignature(entry.meeting);
    const position = optimizer.meetings(source).findIndex(meeting =>
      optimizer.meetingSignature(meeting) === signature);
    assert.ok(position >= 0,
      `${entry.sectionName} does not contain ${signature}`);
    return position + 1;
  });
}

function assertStrictlyIncreasing(values, label) {
  for (let index = 1; index < values.length; index++) {
    assert.ok(values[index - 1] < values[index],
      `${label}: source positions ${values.join(",")} are not strictly increasing`);
  }
}

test("mixed lecture generation rejects a clash-free source-position inversion before normalization", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  // The old recursive generator selected A's position 1 (Tuesday 12:00) and
  // B's position 2 (Tuesday 09:00), then normalization reordered the result to
  // B position 2 followed by A position 1. The events do not overlap, so a
  // clash-only check cannot detect this provenance inversion.
  const first = preservationSection("LEC-A", "LEC", [
    { day: 2, start: 12 * HOUR, end: 13 * HOUR },
    { day: 3, start: 9 * HOUR, end: 10 * HOUR },
  ]);
  const second = preservationSection("LEC-B", "LEC", [
    { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    { day: 2, start: 9 * HOUR, end: 10 * HOUR },
  ]);
  first.instructors = [{ firstName: "Shared", lastName: "Instructor" }];
  second.instructors = [{ firstName: "Shared", lastName: "Instructor" }];

  const firstMeetings = optimizer.meetings(first);
  const secondMeetings = optimizer.meetings(second);
  const legacyInversion = {
    lec: true,
    sec: { name: "LEC*" },
    ms: [secondMeetings[1], firstMeetings[0]],
    secs: ["LEC-B", "LEC-A"],
  };
  assert.equal(
    optimizer.isClashFree([{ code: "AB", pick: [legacyInversion] }]),
    true,
    "the captured source-position inversion is intentionally clash-free",
  );

  const options = optimizer.buildLecOptions([first, second], {
    allowMixedSections: true,
  });
  const inversion = options.find(option => {
    const positions = lectureSourcePositions(optimizer, option, [first, second]);
    return positions[0] === 2 && positions[1] === 1;
  });
  assert.equal(inversion, undefined,
    "mixed generation must not emit [source position 2, source position 1]");
  for (const option of options)
    assertStrictlyIncreasing(
      lectureSourcePositions(optimizer, option, [first, second]),
      `A/B option ${optimizer.optionSignature(option)}`,
    );
});

test("MAT291 mixed lectures preserve chronological source positions through the page worker", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = readJson("computer-2-fall.json");
  const mat = raw.find(course => course.code === "MAT291H1");
  assert.ok(mat, "MAT291H1 must exist in the Computer Fall cache");
  const lectureSections = mat.sections.filter(section =>
    ["LEC0103", "LEC0104"].includes(section.name));
  assert.equal(lectureSections.length, 2,
    "MAT291 must expose the two Parinaz lecture source sections");

  const lec103 = lectureSections.find(section => section.name === "LEC0103");
  const lec104 = lectureSections.find(section => section.name === "LEC0104");
  const lec103Meetings = optimizer.meetings(lec103);
  const lec104Meetings = optimizer.meetings(lec104);
  assert.equal(optimizer.meetingSignature(lec104Meetings[1]),
    "2:32400000:36000000");
  assert.equal(optimizer.meetingSignature(lec103Meetings[0]),
    "2:43200000:46800000");
  assert.equal(optimizer.overlaps(lec104Meetings[1], lec103Meetings[0]), false,
    "the reported Tuesday 09:00/12:00 inversion is clash-free");

  const options = optimizer.buildLecOptions(lectureSections, {
    allowMixedSections: true,
  });
  assert.ok(options.some(option =>
    new Set(option.lectureProvenance.map(entry => entry.sectionName)).size > 1),
    "MAT291 must retain legal same-instructor mixed candidates");

  for (const option of options) {
    const positions = lectureSourcePositions(optimizer, option, lectureSections);
    assert.equal(positions.length, 3,
      `MAT291 option must retain all three weekly positions: ${optimizer.optionSignature(option)}`);
    assertStrictlyIncreasing(positions, `MAT291 option ${optimizer.optionSignature(option)}`);
  }

  const explicitInversion = options.some(option => {
    const entries = option.lectureProvenance || [];
    return entries.length >= 2 &&
      entries[0].sectionName === "LEC0104" &&
      optimizer.meetingSignature(entries[0].meeting) ===
      optimizer.meetingSignature(lec104Meetings[1]) &&
      entries[1].sectionName === "LEC0103" &&
      optimizer.meetingSignature(entries[1].meeting) ===
      optimizer.meetingSignature(lec103Meetings[0]);
  });
  assert.equal(explicitInversion, false,
    "MAT291 must not retain the [LEC0104 position 2, LEC0103 position 1] sequence");

  // Exercise selectedPlan -> worker -> result validation -> renderPlan. The
  // tutorial is excluded only to isolate the lecture candidate seam; mixed
  // lecture mode remains enabled for this course.
  const page = makeInlinePageHarness().installDeterministicWorker();
  page.installCourses([mat]);
  vm.runInContext("mixedLecturesByCode.add('MAT291H1')", page.context);
  page.setExclusions({ tut: ["MAT291H1"] });
  const selected = page.selectedPlans();
  assert.equal(selected.length, 1);
  assert.deepEqual(selected[0].poolTypes, ["LEC"]);

  const displayed = preservationRunPageOptimize(page, {
    campus: 0, lunch: 0, early: 0, late: 0,
  }, [0.5]);
  assert.equal(page.workerInstances.length, 1,
    "MAT291 optimization must use the existing worker boundary");
  const sent = page.workerInstances[0].messages[0].input.plans[0];
  for (const combo of sent.combos) {
    const sentLecture = combo.find(item => item.lec);
    assert.ok(sentLecture, "worker input must contain a lecture candidate");
    assertStrictlyIncreasing(
      lectureSourcePositions(optimizer, sentLecture, lectureSections),
      `worker MAT291 option ${optimizer.optionSignature(sentLecture)}`,
    );
  }
  assert.match(displayed.status, /Built a timetable/);
  assert.ok(displayed.plan, "worker must return a selected MAT291 plan");
  const renderedLecture = displayed.plan[0].pick.find(item => item.lec);
  assert.ok(renderedLecture, "rendered MAT291 plan must contain a lecture");
  assertStrictlyIncreasing(
    lectureSourcePositions(optimizer, renderedLecture, lectureSections),
    "rendered MAT291 lecture",
  );
  assert.notEqual(displayed.timetable, "",
    "the legal worker result must reach the existing timetable renderer");
});


function task4InstructorCourse(code = "INSTR") {
  const lecture = preservationSection("LEC1", "LEC", [
    { day: 1, start: 8 * HOUR, end: 9 * HOUR },
  ]);
  lecture.instructors = [
    { firstName: " Ada ", lastName: " Lovelace " },
    { firstName: "ada", lastName: "lovelace" },
    { firstName: " Grace ", lastName: "Hopper " },
    { displayName: "Ignored tutorial-style record" },
    { firstName: "Only", lastName: "" },
  ];
  const tutorial = preservationSection("TUT1", "TUT", [
    { day: 1, start: 9 * HOUR, end: 10 * HOUR },
  ]);
  tutorial.instructors = [{ firstName: "Alan", lastName: "Turing" }];
  return preservationCourse(code, [lecture, tutorial]);
}

function task4InstructorBoxes(page) {
  return page.elements.get("courseList").querySelectorAll("input.lecInstructor");
}

function task4InstructorGroups(page) {
  return page.elements.get("courseList").querySelectorAll(".lec-instructor-group");
}

test("Task 4: preferred instructor choices use only valid lecture records", () => {
  const page = makeInlinePageHarness();
  page.installCourses([task4InstructorCourse()]);
  page.renderCourses();

  const boxes = task4InstructorBoxes(page);
  assert.deepEqual(boxes.map(box => box.dataset.instructor), [
    "ada lovelace", "grace hopper",
  ]);
  assert.deepEqual(boxes.map(box => box.parentNode.children[1].textContent), [
    "Ada Lovelace", "Grace Hopper",
  ]);
  assert.equal(task4InstructorGroups(page).length, 1);
  assert.ok(boxes.every(box => !Object.prototype.hasOwnProperty.call(box.dataset, "tm") &&
    !Object.prototype.hasOwnProperty.call(box.dataset, "sec")),
    "instructor checkboxes must not carry section-lock metadata");
});

test("Task 4: missing or invalid lecture instructor data renders no group", () => {
  const lecture = preservationSection("LEC1", "LEC", [
    { day: 1, start: 8 * HOUR, end: 9 * HOUR },
  ]);
  lecture.instructors = [
    { firstName: "Only", lastName: "" },
    { displayName: "Not a canonical instructor" },
  ];
  const page = makeInlinePageHarness();
  page.installCourses([preservationCourse("NO-INSTRUCTOR", [lecture])]);
  page.renderCourses();
  assert.equal(task4InstructorGroups(page).length, 0);
  assert.equal(task4InstructorBoxes(page).length, 0);
});

test("Task 4: preferences survive re-render and lecture exclusion without becoming locks", () => {
  const page = makeInlinePageHarness();
  page.installCourses([task4InstructorCourse()]);
  page.renderCourses();

  const first = task4InstructorBoxes(page)[0];
  first.checked = true;
  page.elements.get("courseList").onchange({ target: first });
  assert.deepEqual(page.selectedPlans()[0].preferredInstructors, ["ada lovelace"]);
  assert.equal(page.selectedPlans()[0].locked.length, 0,
    "instructor checkboxes must not be interpreted as section locks");

  page.renderCourses();
  assert.equal(task4InstructorBoxes(page)[0].checked, true,
    "normal course-list re-renders must preserve selected instructors");

  vm.runInContext("uselessLec.add('INSTR'); renderCourseList()", page.context);
  assert.equal(task4InstructorGroups(page)[0].hidden, true,
    "the instructor group must hide while lectures are excluded");
  assert.deepEqual(page.selectedPlans()[0].preferredInstructors, [],
    "hidden preferences must be omitted from excluded lecture plans");

  vm.runInContext("uselessLec.delete('INSTR'); renderCourseList()", page.context);
  assert.equal(task4InstructorGroups(page)[0].hidden, false);
  assert.equal(task4InstructorBoxes(page)[0].checked, true,
    "unchecking lecture exclusion must restore retained preferences");
  assert.deepEqual(page.selectedPlans()[0].preferredInstructors, ["ada lovelace"]);

  vm.runInContext("resetOptimizerState(); renderCourseList()", page.context);
  assert.equal(task4InstructorBoxes(page)[0].checked, false,
    "a new catalog reset must clear instructor preferences");
  assert.equal(vm.runInContext("preferredInstructorsByCode.size", page.context), 0);
});

function preservationMeetingKey(m) {
  return `${m.day}:${m.start}:${m.end}`;
}

function preservationRawMeetingKey(m) {
  return `${m.day}:${m.start}:${m.end}`;
}

function preservationSetTutorialAttendance(page, code, section, indices) {
  const key = `${code}|${section}`;
  vm.runInContext(
    `tutAttend.set(${JSON.stringify(key)}, new Set(${JSON.stringify(indices)}));`,
    page.context,
  );
}

function preservationRunPageOptimize(page, opts, randomValues) {
  page.setRandomSequence(randomValues);
  const encodedOpts = JSON.stringify(opts);
  vm.runInContext(`(function(opts) {
    document.getElementById("optCampus").checked = !!opts.campus;
    document.getElementById("optLunch").checked = !!opts.lunch;
    document.getElementById("optEarly").checked = !!opts.early;
    document.getElementById("optLate").checked = !!opts.late;
    optimize();
  })(${encodedOpts})`, page.context);
  // Task 3.3 makes the page boundary asynchronous even when Worker is not
  // available. Drain the deterministic harness queue before observing state.
  if (page.eventLoop) page.eventLoop.flush();
  return vm.runInContext(`({
    plan: typeof bestSoFar === "undefined" ? null : bestSoFar,
    score: (typeof bestSoFarResult !== "undefined" && bestSoFarResult &&
      typeof bestSoFarResult.score === "number") ? bestSoFarResult.score : null,
    status: document.getElementById("status").textContent,
    timetable: document.getElementById("timetable").innerHTML,
  })`, page.context);
}

function preservationAssertValidObserved(observed, label) {
  assert.ok(observed.plan, `${label}: expected a valid plan`);
  assert.equal(planIsClashFree(observed.plan), true,
    `${label}: returned plan must be clash-free`);
  // The old implementation returns a raw array. The fixed shared engine will
  // return a complete search-result object; both shapes must preserve validity.
  if (observed.rawShape === "search-result") {
    assert.equal(observed.complete, true, `${label}: search result must be complete`);
  }
}

function preservationAssertNoSolution(observed, label) {
  assert.equal(observed.plan, null, `${label}: no-solution result must have no plan`);
  assert.equal(observed.status, "NO_SOLUTION",
    `${label}: no-solution status must be preserved`);
  if (observed.rawShape === "search-result") {
    assert.equal(observed.complete, true,
      `${label}: fixed no-solution result must be complete`);
  }
}

function preservationObservedScore(result, opts) {
  if (typeof result.score === "number") return result.score;
  assert.ok(result.plan, "cannot score an empty displayed result");
  return objectiveValue(evaluateReference(result.plan), opts);
}

function preservationEventsForCode(plan, code) {
  return eventList(plan).filter(event => event.code === code);
}

function preservationRunSimpleCourse(exclusions = {}, locks = []) {
  const page = makeInlinePageHarness();
  const raw = [preservationCourse("PRES", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
  ])];
  page.installCourses(raw);
  page.setExclusions(exclusions);
  page.setLocks(locks);
  const runner = makeOptimizerRunner(page);
  const plans = page.selectedPlans();
  const observed = runner.run(plans, PRESERVATION_NO_OPTIONS, [0.5]);
  return { page, runner, plans, observed };
}

function preservationCacheResponse(value, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      // Each response gets a detached copy so the browser cache observation
      // cannot mutate the read-only fixture loaded from web/data.
      return JSON.parse(JSON.stringify(value));
    },
  };
}

function makePreservationCacheHarness(storage = new Map()) {
  const manifest = readJson("manifest.json");
  return makeInlinePageHarness({
    storage,
    fetch(url) {
      const request = String(url);
      if (request === "data/manifest.json") return preservationCacheResponse(manifest);
      const fileName = request.startsWith("data/") ? request.slice("data/".length) : request;
      if (!/^[^/]+\.json$/.test(fileName) || !fs.existsSync(path.join(DATA_DIR, fileName)))
        return preservationCacheResponse({}, false, 404);
      return preservationCacheResponse(readJson(fileName));
    },
  });
}

function preservationSelect(page, track, year, session) {
  const values = {
    selTrack: ["computer", "mechanical", "industrial", "chemical", "materials",
      "civil", "mineral", "trackone", "electrical"],
    selYear: ["1", "2", "3", "4"],
    selSession: ["fall", "winter"],
  };
  const selected = { selTrack: track, selYear: String(year), selSession: session };
  for (const [id, choices] of Object.entries(values)) {
    const element = page.elements.get(id);
    element.options = choices.map(value => ({
      value,
      textContent: value,
      disabled: false,
    }));
    element.selectedIndex = choices.indexOf(selected[id]);
    element.value = selected[id];
    element.selectedOptions = [element.options[element.selectedIndex]];
  }
  vm.runInContext("updateAvailability()", page.context);
}

async function preservationLoad(page) {
  await vm.runInContext("load()", page.context);
  await page.settleAsync();
}

function preservationLoadedCodes(page) {
  return vm.runInContext(
    "COURSES.map(course => String(course.code)).sort()",
    page.context,
  );
}

function preservationDataFetches(page) {
  return page.fetchCalls
    .map(call => call.url)
    .filter(url => url !== "data/manifest.json");
}


test("preservation baseline: cache loading, reset-on-load, and dropdown/load distinction are observable", async () => {
  const storage = new Map();
  const page = makePreservationCacheHarness(storage);
  await page.settleAsync();

  const manifestCombos = vm.runInContext(
    "availableCombos ? Array.from(availableCombos).sort() : null",
    page.context,
  );
  assert.ok(manifestCombos, "manifest-backed availability must be loaded");
  for (const program of PRESERVATION_PROGRAMS) {
    for (const semester of ["fall", "winter"])
      assert.ok(manifestCombos.includes(`${program}|1|${semester}`),
        `manifest availability must include ${program} first-year ${semester}`);
  }

  preservationSelect(page, "computer", "1", "fall");
  await preservationLoad(page);
  const computerCodes = preservationLoadedCodes(page);
  assert.deepEqual(computerCodes,
    readJson("computer-1-fall.json").map(course => String(course.code)).sort(),
    "Load must populate COURSES from the selected cache path");
  assert.deepEqual(preservationDataFetches(page), ["data/computer-1-fall.json"]);
  const manifestVersion = readJson("manifest.json").version;
  assert.match(manifestVersion, /^[0-9a-f]{16}$/,
    "manifest must publish a cache revision");
  assert.ok(page.storageWrites.some(entry =>
    entry.key === `ttb:${manifestVersion}:data/computer-1-fall.json`),
    "a fetched cache must be written under the revisioned localStorage key");

  // Dropdown changes only change the displayed selection. They do not fetch,
  // clear COURSES, clear the displayed timetable, or clear cumulative state
  // until the user activates the actual Load action.
  vm.runInContext(`
    bestSoFar = [{ code: "STALE", pick: [] }];
    bestSoFarResult = { stale: true };
    bestSoFarKey = "stale";
    uselessTut.add("APS100H1");
    document.getElementById("optCampus").checked = true;
    document.getElementById("timetable").innerHTML = "displayed-before-dropdown-change";
  `, page.context);
  const beforeDropdownFetches = preservationDataFetches(page).length;
  preservationSelect(page, "electrical", "2", "winter");
  assert.deepEqual(preservationLoadedCodes(page), computerCodes,
    "changing dropdowns must not replace the loaded course catalog");
  assert.equal(preservationDataFetches(page).length, beforeDropdownFetches,
    "changing dropdowns must not fetch a cache before Load is clicked");
  assert.equal(
    vm.runInContext("document.getElementById('timetable').innerHTML", page.context),
    "displayed-before-dropdown-change",
    "changing dropdowns must not clear the displayed timetable",
  );
  assert.ok(vm.runInContext("bestSoFar !== null && bestSoFarKey === 'stale'", page.context),
    "changing dropdowns must not reset cumulative optimizer state");

  await preservationLoad(page);
  assert.ok(preservationDataFetches(page).includes("data/electrical-2-winter.json"),
    "the actual Load action must use the selected data/${program}-${year}-${semester}.json path");
  assert.deepEqual(preservationLoadedCodes(page),
    readJson("electrical-2-winter.json").map(course => String(course.code)).sort(),
    "actual Load must replace COURSES with the newly selected catalog");
  assert.equal(vm.runInContext("bestSoFar", page.context), null,
    "new data load must clear bestSoFar");
  assert.equal(vm.runInContext("bestSoFarResult", page.context), null,
    "new data load must clear bestSoFarResult");
  assert.equal(vm.runInContext("bestSoFarKey", page.context), null,
    "new data load must clear bestSoFarKey");
  assert.equal(vm.runInContext("document.getElementById('timetable').innerHTML", page.context), "",
    "new data load must clear the rendered timetable");
  assert.equal(vm.runInContext("document.getElementById('optCampus').checked", page.context), false,
    "new data load must reset objective controls");

  const dataFetchCount = preservationDataFetches(page).length;
  await preservationLoad(page);
  assert.equal(preservationDataFetches(page).length, dataFetchCount,
    "reloading the same key must use _memCache without a second data fetch");

  // A fresh page with the serialized revisioned entry takes the localStorage
  // path and must not fetch the corresponding data file.
  const revisionedStorageKey = `ttb:${manifestVersion}:data/computer-1-fall.json`;
  const localStorageOnly = new Map([
    [revisionedStorageKey, JSON.stringify(readJson("computer-1-fall.json"))],
  ]);
  const storagePage = makePreservationCacheHarness(localStorageOnly);
  await storagePage.settleAsync();
  preservationSelect(storagePage, "computer", "1", "fall");
  await preservationLoad(storagePage);
  assert.equal(preservationDataFetches(storagePage).length, 0,
    "an existing revisioned cache entry must avoid a data fetch");
  assert.ok(storagePage.storageReads.includes(revisionedStorageKey),
    "the localStorage fallback must read the revisioned cache key");
  assert.deepEqual(preservationLoadedCodes(storagePage), computerCodes,
    "the localStorage cache must load the same catalog as the fetched path");

  // An old unversioned entry must not win over the current published cache.
  const staleStorage = new Map([
    ["ttb:data/computer-1-fall.json", JSON.stringify(readJson("electrical-2-winter.json"))],
  ]);
  const stalePage = makePreservationCacheHarness(staleStorage);
  await stalePage.settleAsync();
  preservationSelect(stalePage, "computer", "1", "fall");
  await preservationLoad(stalePage);
  assert.equal(preservationDataFetches(stalePage).length, 1,
    "an old unversioned cache entry must be bypassed");
  assert.deepEqual(preservationLoadedCodes(stalePage), computerCodes,
    "bypassing stale storage must load the current catalog");
});


test("preservation baseline: selected/build plans retain components, deduplicate exact sections, and preserve clash boundaries", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available for build observations");
  const raw = [preservationCourse("SHAPE", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
  ])];
  const grouped = optimizer.groupCourses(raw, { includeCombos: false });
  assert.equal(grouped[0].sections.length, 3,
    "equivalent duplicate section records must collapse to one section");
  const built = optimizer.buildCoursePlans(grouped, {});
  assert.deepEqual(built[0].poolTypes, ["LEC", "PRA", "TUT"],
    "selected/build plans must retain every active component type");
  assert.equal(built[0].combos.length, 1,
    "one internally clash-free candidate must remain after duplicate removal");

  const equivalent = optimizer.buildCoursePlans([preservationCourse("EQUIV", [
    preservationSection("TUT-B", "TUT", [
      { day: 4, start: 12 * HOUR, end: 13 * HOUR },
    ]),
    preservationSection("TUT-A", "TUT", [
      { day: 4, start: 12 * HOUR, end: 13 * HOUR },
    ]),
  ])], {});
  assert.deepEqual(equivalent[0].combos.map(combo => combo[0].sec.name), ["TUT-A", "TUT-B"],
    "equivalent schedules retain distinct stable section identities at the build boundary");

  const positive = [
    {
      code: "POS-A", pick: [{
        sec: { name: "A" }, ms: [
          { day: 2, start: 9 * HOUR, end: 10 * HOUR },
        ]
      }]
    },
    {
      code: "POS-B", pick: [{
        sec: { name: "B" }, ms: [
          { day: 2, start: 9 * HOUR + 1, end: 10 * HOUR + 1 },
        ]
      }]
    },
  ];
  const touching = [
    {
      code: "TOUCH-A", pick: [{
        sec: { name: "A" }, ms: [
          { day: 2, start: 9 * HOUR, end: 10 * HOUR },
        ]
      }]
    },
    {
      code: "TOUCH-B", pick: [{
        sec: { name: "B" }, ms: [
          { day: 2, start: 10 * HOUR, end: 11 * HOUR },
        ]
      }]
    },
  ];
  assert.equal(planIsClashFree(positive), false,
    "positive-duration intersections must remain clashes");
  assert.equal(planIsClashFree(touching), true,
    "endpoint-touching intervals must remain eligible");
  assert.equal(optimizer.overlaps(
    { day: 2, start: 9 * HOUR, end: 10 * HOUR },
    { day: 2, start: 10 * HOUR, end: 11 * HOUR },
  ), false);

  const unfillable = optimizer.buildCoursePlans([preservationCourse("REQUIRED", [
    preservationSection("LEC1", "LEC", [
      { day: 3, start: 8 * HOUR, end: 9 * HOUR },
      { day: 3, start: 8 * HOUR + 30 * 60 * 1000, end: 9 * HOUR + 30 * 60 * 1000 },
    ]),
  ])], {});
  assert.deepEqual(unfillable[0].poolTypes, ["LEC"],
    "an active component type with no viable option must remain required");
  assert.equal(unfillable[0].combos.length, 0,
    "an unfillable active component must not silently disappear");
  const noSolution = optimizer.findBestPlan(unfillable, PRESERVATION_NO_OPTIONS);
  assert.equal(noSolution.plan, null);
  assert.equal(noSolution.status, "NO_SOLUTION");
});


test("preservation baseline: objective measurements and deterministic ties retain established semantics", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available for objective observations");
  const plan = objectivePlan("OBJECTIVE-BASELINE", [
    objectiveSection("AM", [objectiveMeeting(1, 9, 10)]),
    objectiveSection("PM", [objectiveMeeting(1, 11, 12)]),
    objectiveSection("OTHER-DAY", [objectiveMeeting(3, 8, 9)]),
  ]);
  const reference = evaluateReference(plan);
  assert.equal(reference.activeDays, 2);
  assert.equal(reference.gapsMs, HOUR);
  assert.equal(reference.campusMs, 4 * HOUR,
    "campus time sums each day's first start to last end");
  assert.equal(reference.lunchDeficitMs, 0,
    "one free hour in the 11:00–13:00 window satisfies lunch");
  assert.equal(reference.sumEndMs, 31 * HOUR,
    "end-early uses the sum of selected class end times");
  assert.equal(reference.sumStartMs, 28 * HOUR,
    "start-late uses the negative sum of selected class start times");
  assert.deepEqual(
    Object.fromEntries(Object.entries(optimizer.evaluatePlan(plan)).filter(([key]) =>
      ["activeDays", "gapsMs", "campusMs", "lunchDeficitMs", "sumStartMs", "sumEndMs"].includes(key))),
    {
      activeDays: 2,
      gapsMs: HOUR,
      campusMs: 4 * HOUR,
      lunchDeficitMs: 0,
      sumStartMs: 28 * HOUR,
      sumEndMs: 31 * HOUR,
    },
  );

  const exactlyEnough = objectivePlan("LUNCH-BASELINE", [
    objectiveSection("FIRST", [{ day: 1, start: 11 * HOUR, end: 11.5 * HOUR }]),
    objectiveSection("SECOND", [{ day: 1, start: 11.25 * HOUR, end: 12 * HOUR }]),
  ]);
  assert.equal(evaluateReference(exactlyEnough).lunchDeficitMs, HOUR,
    "the independent baseline helper applies one penalty to a deficient day");
  assert.equal(optimizer.evaluatePlan(exactlyEnough).lunchDeficitMs, 0,
    "the established optimizer behavior unions overlapping lunch blocks before the threshold");

  const options = {
    none: { campus: 0, lunch: 0, early: 0, late: 0 },
    campus: { campus: 1, lunch: 0, early: 0, late: 0 },
    lunch: { campus: 0, lunch: 1, early: 0, late: 0 },
    early: { campus: 0, lunch: 0, early: 1, late: 0 },
    late: { campus: 0, lunch: 0, early: 0, late: 1 },
    combined: { campus: 1, lunch: 1, early: 1, late: 1 },
  };
  for (const [name, opts] of Object.entries(options)) {
    const expected = objectiveValue(reference, opts);
    assert.equal(optimizer.scorePlan(plan, opts), expected,
      `${name} objective must retain its established measurement`);
  }

  const tieA = objectivePlan("TIE-BASELINE-A", [
    objectiveSection("SAME", [objectiveMeeting(2, 9, 10)]),
  ]);
  const tieB = objectivePlan("TIE-BASELINE-B", [
    objectiveSection("SAME", [objectiveMeeting(2, 9, 10)]),
  ]);
  assert.equal(optimizer.comparePlans(tieA, tieA, options.none), 0);
  assert.equal(optimizer.comparePlans(tieA, tieB, options.none), -1,
    "equal objective values must use a deterministic stable signature tie-break");
  assert.equal(optimizer.comparePlans(tieB, tieA, options.none), 1);
});


test("preservation baseline: first-year matrix and ECE track identities remain read-only", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available for catalog observations");
  const firstYear = [];
  for (const program of PRESERVATION_PROGRAMS) {
    for (const semester of ["fall", "winter"]) {
      const fileName = `${program}-1-${semester}.json`;
      const raw = readJson(fileName);
      const grouped = optimizer.groupCourses(raw, { includeCombos: false });
      firstYear.push(`${program}|${semester}`);
      assert.deepEqual(
        grouped.map(course => String(course.code)).sort(),
        raw.map(course => String(course.code)).sort(),
        `${fileName}: grouping must preserve every course code`,
      );
      assert.equal(fs.existsSync(path.join(DATA_DIR, fileName)), true,
        `${fileName}: fixture must remain available and read-only`);
    }
  }
  assert.equal(firstYear.length, 16);

  for (const semester of ["fall", "winter"]) {
    const computer = readJson(`computer-1-${semester}.json`);
    const trackOne = readJson(`trackone-1-${semester}.json`);
    assert.deepEqual(
      computer.map(course => ({ code: course.code, sections: course.sections })).sort((a, b) =>
        String(a.code).localeCompare(String(b.code))),
      trackOne.map(course => ({ code: course.code, sections: course.sections })).sort((a, b) =>
        String(a.code).localeCompare(String(b.code))),
      `${semester}: Computer and Track One raw catalogs must remain equivalent`,
    );
    const computerBuilt = optimizer.buildCoursePlans(
      optimizer.groupCourses(computer, { includeCombos: false }), {},
    );
    const trackOneBuilt = optimizer.buildCoursePlans(
      optimizer.groupCourses(trackOne, { includeCombos: false }), {},
    );
    assert.deepEqual(
      task35CanonicalBuilt(optimizer, computerBuilt),
      task35CanonicalBuilt(optimizer, trackOneBuilt),
      `${semester}: Computer and Track One built plans must remain equivalent`,
    );
  }

  for (const semester of ["fall", "winter"]) {
    const computerCodes = new Set(readJson(`computer-2-${semester}.json`)
      .map(course => String(course.code)));
    const electricalCodes = new Set(readJson(`electrical-2-${semester}.json`)
      .map(course => String(course.code)));
    if (semester === "winter") {
      assert.notDeepEqual(computerCodes, electricalCodes,
        `${semester}: second-year Computer and Electrical course sets must remain distinct`);
      assert.equal(computerCodes.has("ECE297H1"), true);
      assert.equal(computerCodes.has("ECE295H1"), false);
      assert.equal(electricalCodes.has("ECE295H1"), true);
      assert.equal(electricalCodes.has("ECE297H1"), false);
    } else {
      // Observation on the current cache: Fall shares the common ECE core;
      // Winter is where the Computer/Electrical ECE course sets diverge.
      assert.deepEqual(computerCodes, electricalCodes,
        `${semester}: Fall second-year catalogs preserve the common ECE core`);
    }
  }
});


test("preservation baseline: cache path, manifest, catalog, and legacy tracks remain intact", () => {
  const html = fs.readFileSync(INDEX, "utf8");
  assert.match(html, /return `data\/\$\{t\}-\$\{y\}-\$\{s\}\.json`;/);
  assert.match(html, /fetch\("data\/manifest\.json"/);
  assert.match(html, /function comboKey\(program, year, session\)/);
  assert.match(html, /_memCache/);
  assert.match(html, /ttb:/);
  assert.match(html, /<option value="electrical">Electrical<\/option>/);

  const manifest = readJson("manifest.json");
  const combos = new Set((manifest.combos || []).map(combo =>
    `${combo.program}|${combo.year}|${combo.session}`));
  for (const program of PRESERVATION_PROGRAMS) {
    for (const semester of ["fall", "winter"]) {
      assert.equal(combos.has(`${program}|1|${semester}`), true,
        `manifest must retain ${program} first-year ${semester}`);
      assert.equal(fs.existsSync(path.join(DATA_DIR, `${program}-1-${semester}.json`)), true,
        `cache file must exist for ${program} first-year ${semester}`);
    }
  }

  const computerWinter = new Set(readJson("computer-2-winter.json").map(course => course.code));
  const electricalWinter = new Set(readJson("electrical-2-winter.json").map(course => course.code));
  assert.equal(computerWinter.has("ECE297H1"), true);
  assert.equal(computerWinter.has("ECE295H1"), false);
  assert.equal(electricalWinter.has("ECE295H1"), true);
  assert.equal(electricalWinter.has("ECE297H1"), false);
});


test("preservation: active lecture, PRA, and TUT locks remain fixed", () => {
  const page = makeInlinePageHarness();
  const raw = [preservationCourse("LOCKS", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
  ])];
  page.installCourses(raw);
  page.setExclusions({});
  const locks = [
    { code: "LOCKS", tm: "LEC", sec: "LEC1" },
    { code: "LOCKS", tm: "PRA", sec: "PRA1" },
    { code: "LOCKS", tm: "TUT", sec: "TUT1" },
  ];
  page.setLocks(locks);
  const plans = page.selectedPlans();
  assert.equal(plans.length, 1);
  assert.deepEqual(
    [...plans[0].locked].map(lock => `${lock.tm}:${lock.sec.name}`),
    ["LEC:LEC1", "PRA:PRA1", "TUT:TUT1"],
  );

  const runner = makeOptimizerRunner(page);
  const observed = runner.run(plans, PRESERVATION_NO_OPTIONS, [0.5]);
  preservationAssertValidObserved(observed, "active component locks");
  assert.equal(containsLockedMeetings(observed.plan, plans), true);
  for (const lock of locks) {
    assert.ok(eventList(observed.plan).some(event =>
      event.code === lock.code &&
      event.section === lock.sec &&
      event.start < event.end),
      `locked ${lock.tm} section ${lock.sec} must remain selected`);
  }
});


test("preservation: selected multi-meeting tutorial attendance stays an exact subset", () => {
  const page = makeInlinePageHarness();
  const meetings = [
    { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    { day: 3, start: 10 * HOUR, end: 11 * HOUR },
    { day: 5, start: 12 * HOUR, end: 13 * HOUR },
  ];
  page.installCourses([preservationCourse("ATTEND", [
    preservationSection("TUT1", "TUT", meetings),
  ])]);
  page.setExclusions({});
  page.setLocks([{ code: "ATTEND", tm: "TUT", sec: "TUT1" }]);
  preservationSetTutorialAttendance(page, "ATTEND", "TUT1", [0, 2]);

  const plans = page.selectedPlans();
  const selectedKeys = [...plans[0].locked[0].ms].map(preservationMeetingKey);
  assert.deepEqual(selectedKeys, [
    preservationRawMeetingKey(meetings[0]),
    preservationRawMeetingKey(meetings[2]),
  ]);
  // Re-reading the same unchanged DOM state must not silently restore the
  // omitted middle meeting.
  assert.deepEqual(
    [...page.selectedPlans()[0].locked[0].ms].map(preservationMeetingKey),
    selectedKeys,
  );

  const runner = makeOptimizerRunner(page);
  const observed = runner.run(plans, PRESERVATION_NO_OPTIONS, [0.5]);
  preservationAssertValidObserved(observed, "selected tutorial attendance subset");
  assert.deepEqual(
    preservationEventsForCode(observed.plan, "ATTEND").map(event =>
      preservationMeetingKey(event)),
    selectedKeys,
  );
});


test("preservation: component exclusions omit only the requested component", () => {
  const cases = [
    { name: "none", exclusions: {}, expected: ["LEC1", "PRA1", "TUT1"] },
    { name: "tutorial", exclusions: { tut: ["PRES"] }, expected: ["LEC1", "PRA1"] },
    { name: "practical", exclusions: { pra: ["PRES|PRA1"] }, expected: ["LEC1", "TUT1"] },
    { name: "lecture", exclusions: { lec: ["PRES"] }, expected: ["PRA1", "TUT1"] },
  ];
  for (const fixture of cases) {
    const { observed } = preservationRunSimpleCourse(fixture.exclusions);
    preservationAssertValidObserved(observed, `component exclusion: ${fixture.name}`);
    const names = preservationEventsForCode(observed.plan, "PRES")
      .map(event => event.section).sort();
    assert.deepEqual(names, fixture.expected,
      `component exclusion: ${fixture.name} must not replace another component`);
  }
});


test("preservation: valid clash-free and existing no-solution paths remain observable", () => {
  const validPage = makeInlinePageHarness();
  validPage.installCourses([
    preservationCourse("VALIDA", [preservationSection("TUTA", "TUT", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ])]),
    preservationCourse("VALIDB", [preservationSection("TUTB", "TUT", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ])]),
  ]);
  validPage.setExclusions({});
  validPage.setLocks([]);
  const validRunner = makeOptimizerRunner(validPage);
  const validPlans = validPage.selectedPlans();
  const valid = validRunner.run(validPlans, PRESERVATION_NO_OPTIONS, [0.5]);
  preservationAssertValidObserved(valid, "valid touching-interval input");

  const noSolutionPage = makeInlinePageHarness();
  noSolutionPage.installCourses([
    preservationCourse("CONFLICTA", [preservationSection("TUTA", "TUT", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ])]),
    preservationCourse("CONFLICTB", [preservationSection("TUTB", "TUT", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ])]),
  ]);
  noSolutionPage.setExclusions({});
  noSolutionPage.setLocks([
    { code: "CONFLICTA", tm: "TUT", sec: "TUTA" },
    { code: "CONFLICTB", tm: "TUT", sec: "TUTB" },
  ]);
  const noSolutionRunner = makeOptimizerRunner(noSolutionPage);
  const noSolutionPlans = noSolutionPage.selectedPlans();
  const noSolution = noSolutionRunner.run(
    noSolutionPlans, PRESERVATION_NO_OPTIONS, [0.5]);
  preservationAssertNoSolution(noSolution, "cross-course locked clash");

  const displayed = preservationRunPageOptimize(
    noSolutionPage, PRESERVATION_NO_OPTIONS, [0.5]);
  assert.equal(displayed.plan, null, "no-solution Optimize must not retain a plan");
  assert.equal(displayed.timetable, "", "no-solution Optimize must clear the timetable");
  assert.match(displayed.status, /Could not build a clash-free timetable/);
});


test("preservation: no preference keeps a valid plan at zero configured penalty", () => {
  const { page, runner, plans, observed } = preservationRunSimpleCourse();
  preservationAssertValidObserved(observed, "no-preference plan");
  assert.equal(objectiveValue(evaluateReference(observed.plan), PRESERVATION_NO_OPTIONS), 0);
  if (!runner.shared) {
    page.context.__preservationPlan = observed.plan;
    const score = vm.runInContext(
      "scorePlan(__preservationPlan, { campus: 0, lunch: 0, early: 0, late: 0 })",
      page.context,
    );
    assert.equal(score, 0, "legacy scorePlan must not add an unconfigured penalty");
  }
});


test("preservation: repeated Optimize presses do not regress the remembered result", () => {
  const page = makeInlinePageHarness();
  page.installCourses([
    preservationCourse("REPEAT-A", [
      preservationSection("TUTA", "TUT", [
        { day: 1, start: 9 * HOUR, end: 10 * HOUR },
      ]),
      preservationSection("TUTB", "TUT", [
        { day: 2, start: 9 * HOUR, end: 10 * HOUR },
      ]),
    ]),
    preservationCourse("REPEAT-B", [
      preservationSection("TUTFIX", "TUT", [
        { day: 1, start: 10 * HOUR, end: 11 * HOUR },
      ]),
    ]),
  ]);
  page.setExclusions({});
  page.setLocks([]);
  const opts = { campus: 1, lunch: 0, early: 0, late: 0 };
  const first = preservationRunPageOptimize(page, opts, [0.1]);
  const second = preservationRunPageOptimize(page, opts, [0.9]);
  assert.ok(first.plan, "first unchanged-input Optimize must produce a plan");
  assert.ok(second.plan, "second unchanged-input Optimize must produce a plan");
  const firstScore = preservationObservedScore(first, opts);
  const secondScore = preservationObservedScore(second, opts);
  assert.ok(secondScore <= firstScore,
    `unchanged Optimize regressed: first=${firstScore}, second=${secondScore}`);
  assert.notEqual(second.timetable, "", "remembered valid result must remain rendered");
});

function preservationSeededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return (limit) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % limit;
  };
}

function makeGeneratedPreservationFixture(seed) {
  const next = preservationSeededRandom(seed);
  const courseCount = 1 + next(4);
  const raw = [];
  const locks = [];
  const attendance = [];
  const excludedCodes = [];
  const metadata = [];

  for (let i = 0; i < courseCount; i++) {
    const code = `GEN${seed}-${i}`;
    const choiceCount = 1 + next(3);
    const meetingCount = 1 + next(3);
    const meetings = [];
    for (let m = 0; m < meetingCount; m++) {
      // Every course/meeting occupies its own non-overlapping slot. Choices
      // intentionally share timings, so random section identity is irrelevant.
      meetings.push({
        day: ((i + m) % 5) + 1,
        start: (8 + i * 2 + m) * HOUR,
        end: (9 + i * 2 + m) * HOUR,
      });
    }
    const sections = [];
    for (let choice = 0; choice < choiceCount; choice++) {
      sections.push(preservationSection(`TUT${choice + 1}`, "TUT", meetings));
    }
    raw.push(preservationCourse(code, sections));

    const locked = next(3) === 0;
    const excluded = next(4) === 0;
    const selectedIndices = locked && meetingCount > 1 && next(2) === 0
      ? Array.from({ length: meetingCount - 1 }, (_, index) => index)
      : null;
    if (locked) locks.push({ code, tm: "TUT", sec: "TUT1" });
    if (excluded) excludedCodes.push(code);
    if (selectedIndices) attendance.push({ code, sec: "TUT1", indices: selectedIndices });
    metadata.push({ code, meetings, locked, excluded, selectedIndices });
  }
  return { raw, locks, excludedCodes, attendance, metadata };
}


test("preservation property: seeded non-buggy inputs retain attendance, exclusions, and feasibility", () => {
  const optionSets = [];
  for (let mask = 0; mask < 16; mask++) {
    optionSets.push({
      campus: (mask & 1) ? 1 : 0,
      lunch: (mask & 2) ? 1 : 0,
      early: (mask & 4) ? 1 : 0,
      late: (mask & 8) ? 1 : 0,
    });
  }

  // 20 seeds x 16 preference combinations = 320 deterministic small-domain
  // observations. All alternatives have identical timings and all courses use
  // separated/touching meetings, so these inputs are outside the objective-miss
  // and locked-clash bug conditions.
  for (let seed = 1; seed <= 20; seed++) {
    for (const opts of optionSets) {
      const fixture = makeGeneratedPreservationFixture(seed);
      const page = makeInlinePageHarness();
      page.installCourses(fixture.raw);
      page.setExclusions({ tut: fixture.excludedCodes });
      page.setLocks(fixture.locks);
      for (const selected of fixture.attendance) {
        preservationSetTutorialAttendance(page, selected.code, selected.sec, selected.indices);
      }
      const plans = page.selectedPlans();
      const runner = makeOptimizerRunner(page);
      const observed = runner.run(plans, opts, [seed / 21]);
      preservationAssertValidObserved(
        observed,
        `seed ${seed}, options ${JSON.stringify(opts)}`,
      );

      for (const expected of fixture.metadata) {
        const coursePlan = plans.find(plan => plan.code === expected.code);
        assert.ok(coursePlan, `seed ${seed}: missing plan for ${expected.code}`);
        const events = preservationEventsForCode(observed.plan, expected.code);
        if (expected.excluded) {
          assert.equal(coursePlan.locked.length, 0,
            `seed ${seed}: excluded lock must not remain active for ${expected.code}`);
          assert.equal(events.length, 0,
            `seed ${seed}: excluded component must be omitted for ${expected.code}`);
          continue;
        }
        if (expected.locked) {
          const expectedIndices = expected.selectedIndices ||
            expected.meetings.map((_, index) => index);
          assert.equal(coursePlan.locked.length, 1,
            `seed ${seed}: active lock must remain for ${expected.code}`);
          assert.deepEqual(
            [...coursePlan.locked[0].ms].map(preservationMeetingKey),
            expectedIndices.map(index => preservationRawMeetingKey(expected.meetings[index])),
            `seed ${seed}: selected attendance subset changed for ${expected.code}`,
          );
          assert.deepEqual(
            events.map(event => preservationMeetingKey(event)),
            expectedIndices.map(index => preservationRawMeetingKey(expected.meetings[index])),
            `seed ${seed}: rendered attendance subset changed for ${expected.code}`,
          );
        } else {
          assert.equal(coursePlan.locked.length, 0);
          assert.equal(events.length, expected.meetings.length,
            `seed ${seed}: non-excluded required TUT component was dropped for ${expected.code}`);
        }
      }
    }
  }
});


test("task 3.2: active lock diagnostics reject intra-course and cross-course clashes", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const raw = [preservationCourse("LOCKED", [
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
  ])];
  const overlapping = optimizer.buildCoursePlans(raw, {
    locks: [
      { code: "LOCKED", tm: "PRA", sec: "PRA1" },
      { code: "LOCKED", tm: "TUT", sec: "TUT1" },
    ],
  });
  const intra = optimizer.validateLockedSections(overlapping, { details: true });
  assert.equal(intra.valid, false);
  assert.equal(intra.reason, "INTRA_COURSE_LOCK_CLASH");
  assert.equal(intra.conflicts.length, 1);
  assert.deepEqual(
    new Set([intra.conflict.left.sec.name, intra.conflict.right.sec.name]),
    new Set(["PRA1", "TUT1"]),
  );
  const noSolution = optimizer.findBestPlan(overlapping, { campus: 1 });
  assert.deepEqual(
    { plan: noSolution.plan, status: noSolution.status, complete: noSolution.complete },
    { plan: null, status: "NO_SOLUTION", complete: true },
  );
  assert.equal(noSolution.diagnostics.reason, "INTRA_COURSE_LOCK_CLASH");

  const touchingRaw = [preservationCourse("TOUCHING", [
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 11 * HOUR, end: 12 * HOUR },
    ]),
  ])];
  const touching = optimizer.buildCoursePlans(touchingRaw, {
    locks: [
      { code: "TOUCHING", tm: "PRA", sec: "PRA1" },
      { code: "TOUCHING", tm: "TUT", sec: "TUT1" },
    ],
  });
  assert.equal(optimizer.validateLockedSections(touching), true,
    "endpoint-touching active locks must remain eligible");

  const crossCourse = optimizer.buildCoursePlans([
    preservationCourse("CROSS-A", [preservationSection("TUT1", "TUT", [
      { day: 2, start: 10 * HOUR, end: 11 * HOUR },
    ])]),
    preservationCourse("CROSS-B", [preservationSection("TUT1", "TUT", [
      { day: 2, start: 10 * HOUR, end: 11 * HOUR },
    ])]),
  ], {
    locks: [
      { code: "CROSS-A", tm: "TUT", sec: "TUT1" },
      { code: "CROSS-B", tm: "TUT", sec: "TUT1" },
    ],
  });
  const cross = optimizer.validateLockedSections(crossCourse, { details: true });
  assert.equal(cross.valid, false);
  assert.equal(cross.reason, "CROSS_COURSE_LOCK_CLASH");

  const excluded = optimizer.buildCoursePlans(raw, {
    locks: [
      { code: "LOCKED", tm: "PRA", sec: "PRA1" },
      { code: "LOCKED", tm: "TUT", sec: "TUT1" },
    ],
    uselessPra: new Set(["LOCKED"]),
  });
  assert.deepEqual(excluded[0].locked.map(lock => lock.sec.name), ["TUT1"]);
  assert.equal(optimizer.validateLockedSections(excluded), true,
    "an excluded lock must not create a false conflict");

  const mat = readJson("computer-1-fall.json").find(course => course.code === "MAT188H1");
  const matPlans = optimizer.buildCoursePlans([mat], {
    locks: [
      { code: "MAT188H1", tm: "PRA", sec: "PRA0106" },
      { code: "MAT188H1", tm: "TUT", sec: "TUT0115" },
    ],
  });
  const matDetails = optimizer.validateLockedSections(matPlans, { details: true });
  assert.equal(matDetails.valid, false);
  assert.equal(matDetails.reason, "INTRA_COURSE_LOCK_CLASH");
});


test("task 3.2: candidate construction preserves active types, attendance, and deduplication", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = [preservationCourse("CANDIDATES", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("PRA2", "PRA", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 2, start: 8 * HOUR, end: 9 * HOUR },
      { day: 4, start: 10 * HOUR, end: 11 * HOUR },
      { day: 5, start: 12 * HOUR, end: 13 * HOUR },
    ]),
  ])];
  const plans = optimizer.buildCoursePlans(raw, {
    locks: [{ code: "CANDIDATES", tm: "TUT", sec: "TUT1" }],
    tutAttend: new Map([["CANDIDATES|TUT1", new Set([0, 2])]]),
  });
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0].locked[0].ms.map(preservationMeetingKey), [
    "2:28800000:32400000",
    "5:43200000:46800000",
  ]);
  assert.deepEqual(plans[0].poolTypes, ["LEC", "PRA"]);
  assert.equal(plans[0].combos.length, 2,
    "duplicate sections must not duplicate renderer candidates");
  for (const combo of plans[0].combos) {
    assert.equal(combo.length, plans[0].poolTypes.length,
      "each candidate must select one option for every active component type");
    assert.equal(optimizer.isClashFree(combo), true);
    assert.equal(optimizer.isClashFree(combo, plans[0].locked), true,
      "candidate options must not clash with active locks");
    assert.equal(combo.some(option => option.lec), true);
    assert.equal(combo.some(option => option.sec && option.sec.name === "PRA1" ||
      option.sec && option.sec.name === "PRA2"), true);
  }

  const clashRaw = [preservationCourse("CANDIDATE-CLASH", [
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
    preservationSection("TUT-BAD", "TUT", [
      { day: 1, start: 10 * HOUR, end: 11 * HOUR },
    ]),
    preservationSection("TUT-GOOD", "TUT", [
      { day: 1, start: 11 * HOUR, end: 12 * HOUR },
    ]),
  ])];
  const clashPlans = optimizer.buildCoursePlans(clashRaw);
  assert.deepEqual(clashPlans[0].poolTypes, ["PRA", "TUT"]);
  assert.equal(clashPlans[0].combos.length, 1,
    "internally overlapping component choices must be pruned");
  assert.equal(clashPlans[0].combos[0][1].sec.name, "TUT-GOOD");

  const noLectureOption = [preservationCourse("REQUIRED-LEC", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
      { day: 1, start: 8 * HOUR + 30 * 60 * 1000, end: 9 * HOUR + 30 * 60 * 1000 },
    ]),
  ])];
  const impossible = optimizer.buildCoursePlans(noLectureOption);
  assert.deepEqual(impossible[0].poolTypes, ["LEC"],
    "an active component type must not be silently dropped");
  assert.equal(impossible[0].combos.length, 0);
});


test("task 3.1: unusable sections and invalid active locks cannot be replaced", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const unusable = optimizer.buildCoursePlans([preservationCourse("EMPTY-OPTIONS", [
    preservationSection("PRA-EMPTY", "PRA", []),
    preservationSection("TUT-EMPTY", "TUT", [{ day: 1, start: 10 * HOUR, end: 10 * HOUR }]),
  ])], {});
  assert.deepEqual(unusable[0].poolTypes, ["PRA", "TUT"],
    "component types remain required even when every section is unusable");
  assert.equal(unusable[0].combos.length, 0,
    "empty and zero-duration sections must not become empty candidates");
  const unusableResult = optimizer.findBestPlan(unusable, PRESERVATION_NO_OPTIONS);
  assert.deepEqual(
    { plan: unusableResult.plan, status: unusableResult.status, complete: unusableResult.complete },
    { plan: null, status: "NO_SOLUTION", complete: true },
  );

  const validSection = preservationSection("TUT1", "TUT", [
    { day: 3, start: 12 * HOUR, end: 13 * HOUR },
    { day: 1, start: 8 * HOUR, end: 9 * HOUR },
  ]);
  const valid = optimizer.buildCoursePlans([preservationCourse("LOCK-SHAPE", [validSection])], {
    locks: [{
      code: "LOCK-SHAPE", tm: "TUT", sec: validSection, ms: [
        validSection.meetingTimes[0], validSection.meetingTimes[0], validSection.meetingTimes[1],
      ]
    }],
  });
  assert.deepEqual(valid[0].locked[0].ms.map(preservationMeetingKey), [
    "1:28800000:32400000", "3:43200000:46800000",
  ], "active lock meetings are de-duplicated and stably ordered without replacement");
  assert.equal(optimizer.validateLockedSections(valid), true);

  for (const lock of [
    { code: "LOCK-SHAPE", tm: "TUT", sec: "MISSING" },
    { code: "LOCK-SHAPE", tm: "PRA", sec: "TUT1" },
    {
      code: "LOCK-SHAPE", tm: "TUT", sec: {
        name: "TUT1", teachMethod: "TUT",
        meetingTimes: [{ day: 5, start: 14 * HOUR, end: 15 * HOUR }],
      }
    },
  ]) {
    const built = optimizer.buildCoursePlans([preservationCourse("LOCK-SHAPE", [validSection])], {
      locks: [lock],
    });
    assert.equal(built[0].locked.length, 0,
      "an invalid lock must not be silently retained as a different section");
    assert.equal(built[0].invalidLocks.length, 1);
    const details = optimizer.validateLockedSections(built, { details: true });
    assert.equal(details.valid, false);
    assert.match(details.reason, /^LOCK_/);
    const result = optimizer.findBestPlan(built, PRESERVATION_NO_OPTIONS);
    assert.deepEqual(
      { plan: result.plan, status: result.status, complete: result.complete },
      { plan: null, status: "NO_SOLUTION", complete: true },
      "an invalid active lock must be a proven no-solution, not a replacement candidate",
    );
  }
});
// These tests exercise the pure shared module directly; they do not invoke the
// incomplete search seam or the DOM page integration.

function objectivePlan(code, sections) {
  return [{
    code,
    name: code,
    pick: sections.map(section => ({
      sec: { name: section.name },
      ms: section.ms,
    })),
  }];
}

function objectiveSection(name, meetings) {
  return { name, ms: meetings };
}

function objectiveMeeting(day, startHour, endHour) {
  return {
    day,
    start: startHour * HOUR,
    end: endHour * HOUR,
  };
}

function sign(value) {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}


test("task 3.3: evaluatePlan uses canonical campus, lunch, early, and late measurements", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const plan = objectivePlan("OBJECTIVE", [
    objectiveSection("DAY1-AM", [objectiveMeeting(1, 9, 10)]),
    objectiveSection("DAY1-PM", [objectiveMeeting(1, 11, 12)]),
    objectiveSection("DAY3", [objectiveMeeting(3, 8, 9)]),
  ]);
  const evaluation = optimizer.evaluatePlan(plan);

  assert.equal(evaluation.activeDays, 2);
  assert.equal(evaluation.gapsMs, HOUR,
    "only the one-hour gap between the day-one classes is campus free time");
  assert.equal(evaluation.campusMs, 4 * HOUR,
    "campus time sums each day's first start to last end");
  assert.equal(evaluation.lunchDeficitMs, 0,
    "one free hour from 11:00 to 13:00 satisfies the lunch threshold");
  assert.equal(evaluation.sumStartMs, 28 * HOUR);
  assert.equal(evaluation.sumEndMs, 31 * HOUR);
  assert.equal(evaluation.early, 31);
  assert.equal(evaluation.late, -28);

  const touching = objectivePlan("TOUCHING", [
    objectiveSection("FIRST", [objectiveMeeting(1, 9, 10)]),
    objectiveSection("NEXT", [objectiveMeeting(1, 10, 11)]),
  ]);
  const touchingEvaluation = optimizer.evaluatePlan(touching);
  assert.equal(touchingEvaluation.gapsMs, 0,
    "endpoint-touching classes do not create a campus gap");
  assert.equal(touchingEvaluation.campusMs, 2 * HOUR,
    "touching classes occupy a two-hour first-start-to-last-end span");
});


test("task 3.3: overlapping lunch blocks are unioned before applying the one-hour threshold", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const overlapping = objectivePlan("LUNCH-OVERLAP", [
    objectiveSection("FIRST", [objectiveMeeting(1, 10, 12)]),
    objectiveSection("SECOND", [{
      day: 1,
      start: 11.5 * HOUR,
      end: 13 * HOUR,
    }]),
  ]);
  const evaluation = optimizer.evaluatePlan(overlapping);

  // The lunch union is 11:00-13:00 (two occupied hours), not the sum of the
  // overlapping intersections (which would incorrectly exceed the window).
  assert.equal(evaluation.lunchDeficitMs, HOUR);
  assert.equal(evaluation.gapsMs, 0,
    "overlapping blocks do not create a false campus gap");

  const exactlyEnough = objectivePlan("LUNCH-THRESHOLD", [
    objectiveSection("FIRST", [{
      day: 1,
      start: 11 * HOUR,
      end: 11.5 * HOUR,
    }]),
    objectiveSection("SECOND", [{
      day: 1,
      start: 11.25 * HOUR,
      end: 12 * HOUR,
    }]),
  ]);
  assert.equal(optimizer.evaluatePlan(exactlyEnough).lunchDeficitMs, 0,
    "an overlapping one-hour occupied lunch leaves exactly one free hour");
});


test("task 3.3: scorePlan and comparePlans agree on the shared integer evaluation", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const compact = objectivePlan("COMPACT", [
    objectiveSection("CLASS", [objectiveMeeting(1, 9, 10)]),
  ]);
  const spread = objectivePlan("SPREAD", [
    objectiveSection("FIRST", [objectiveMeeting(1, 9, 10)]),
    objectiveSection("SECOND", [objectiveMeeting(1, 13, 14)]),
  ]);
  const campus = { campus: 1, lunch: 0, early: 0, late: 0 };
  const compactScore = optimizer.scorePlan(compact, campus);
  const spreadScore = optimizer.scorePlan(spread, campus);

  assert.equal(compactScore, 1);
  assert.equal(spreadScore, 5,
    "the spread plan spans five hours from its first start to last end");
  assert.equal(sign(compactScore - spreadScore),
    sign(optimizer.comparePlans(compact, spread, campus)));
  assert.equal(sign(spreadScore - compactScore),
    sign(optimizer.comparePlans(spread, compact, campus)));

  const combinedPlan = objectivePlan("COMBINED", [
    objectiveSection("FIRST", [objectiveMeeting(1, 9, 10)]),
    objectiveSection("SECOND", [objectiveMeeting(1, 11, 12)]),
    objectiveSection("OTHER-DAY", [objectiveMeeting(3, 8, 9)]),
  ]);
  const combined = { campus: 1, lunch: 0, early: 1, late: 1 };
  const combinedEvaluation = optimizer.evaluatePlan(combinedPlan);
  const combinedScore = optimizer.scorePlan(combinedPlan, combined);
  assert.equal(combinedScore,
    (combinedEvaluation.campusMs + combinedEvaluation.sumEndMs -
      combinedEvaluation.sumStartMs) / HOUR);
  assert.equal(combinedScore, 7,
    "combined preferences retain the campus-span/end/start relative terms");
});


test("task 3.3: lunch is an explicit comparator priority over other enabled terms", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const lunchFirst = objectivePlan("LUNCH-FIRST", [
    objectiveSection("LUNCH", [objectiveMeeting(1, 11, 12)]),
    objectiveSection("SECOND-DAY", [objectiveMeeting(2, 8, 9)]),
    objectiveSection("THIRD-DAY", [objectiveMeeting(3, 8, 9)]),
  ]);
  const campusFirst = objectivePlan("CAMPUS-FIRST", [
    objectiveSection("LUNCH", [objectiveMeeting(1, 11, 13)]),
  ]);
  const options = { campus: 1, lunch: 1, early: 0, late: 0 };
  const lunchEvaluation = optimizer.evaluatePlan(lunchFirst);
  const campusEvaluation = optimizer.evaluatePlan(campusFirst);

  assert.equal(lunchEvaluation.lunchDeficitMs, 0);
  assert.equal(campusEvaluation.lunchDeficitMs, HOUR);
  assert.ok(campusEvaluation.campusMs < lunchEvaluation.campusMs,
    "the non-lunch term intentionally favors the lunch-deficient plan");
  assert.equal(optimizer.comparePlans(lunchFirst, campusFirst, options), -1,
    "a feasible one-hour lunch wins before campus trade-offs are considered");
  assert.equal(optimizer.objectiveKey(lunchFirst, options).lunchDeficitMs, 0);
  assert.equal(optimizer.objectiveKey(campusFirst, options).lunchDeficitMs, HOUR);
});


test("task 3.3: no preferences and equal objectives use stable deterministic ties", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const first = objectivePlan("TIE-A", [
    objectiveSection("SAME-TIME-A", [objectiveMeeting(1, 9, 10)]),
  ]);
  const second = objectivePlan("TIE-B", [
    objectiveSection("SAME-TIME-B", [objectiveMeeting(1, 9, 10)]),
  ]);
  const none = { campus: 0, lunch: 0, early: 0, late: 0 };

  assert.equal(optimizer.scorePlan(first, none), 0);
  assert.equal(optimizer.scorePlan(second, none), 0);
  assert.equal(optimizer.comparePlans(first, first, none), 0);
  assert.equal(optimizer.comparePlans(first, second, none), -1,
    "stable signatures provide a deterministic tie order");
  assert.equal(optimizer.comparePlans(second, first, none), 1);
});


test("task 3.3: repeated evaluation and comparison are bit-for-bit deterministic", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const plan = objectivePlan("REPEAT", [
    objectiveSection("LATE", [objectiveMeeting(4, 14, 15)]),
    objectiveSection("EARLY", [objectiveMeeting(2, 8, 9)]),
    objectiveSection("OVERLAP", [{
      day: 4,
      start: 14.5 * HOUR,
      end: 16 * HOUR,
    }]),
  ]);
  const options = { campus: 1, lunch: 1, early: 1, late: 1 };
  const expectedEvaluation = optimizer.evaluatePlan(plan);
  const expectedScore = optimizer.scorePlan(plan, options);
  const expectedSignature = optimizer.planSignature(plan);

  for (let iteration = 0; iteration < 25; iteration++) {
    assert.deepEqual(optimizer.evaluatePlan(plan), expectedEvaluation);
    assert.equal(optimizer.scorePlan(plan, options), expectedScore);
    assert.equal(optimizer.planSignature(plan), expectedSignature);
    assert.equal(optimizer.comparePlans(plan, plan, options), 0);
  }
});


// ---------------------------------------------------------------------------
// Task 3.4: complete deterministic search.

function task34ChoicePlan(code, choices) {
  return choicePlan(code, choices);
}


test("task 3.2: exact search preserves the comparator-selected stable tie", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  // The greedy seed deliberately takes the last candidate. Both choices have
  // the same no-preference objective, so exact search must still visit the
  // equal-cost branch and let the stable plan comparator select CHOICE1.
  const plans = [task34ChoicePlan("TIE-SEARCH", [
    [{ day: 1, start: 9 * HOUR, end: 10 * HOUR }],
    [{ day: 2, start: 9 * HOUR, end: 10 * HOUR }],
  ])];
  const options = { campus: 0, lunch: 0, early: 0, late: 0 };
  const result = optimizer.findBestPlan(plans, options);

  assert.equal(result.status, "OPTIMAL");
  assert.equal(result.complete, true);
  assert.equal(result.optimal, true);
  assert.equal(result.plan[0].pick[0].sec.name, "CHOICE1");
  assert.equal(result.signature, optimizer.planSignature(result.plan));
  assert.equal(
    optimizer.comparePlans(result.plan, {
      code: "TIE-SEARCH",
      pick: [{
        sec: { name: "CHOICE1" }, ms: [
          { day: 1, start: 9 * HOUR, end: 10 * HOUR },
        ]
      }],
    }, options),
    0,
    "the result must be the stable comparator minimum",
  );
});


test("task 3.4: exact search agrees with the independent exhaustive minimum", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const plans = [task34ChoicePlan("SEARCH-A", [
    [{ day: 1, start: 9 * HOUR, end: 10 * HOUR }],
    [{ day: 1, start: 12 * HOUR, end: 13 * HOUR }],
    [{ day: 2, start: 9 * HOUR, end: 10 * HOUR }],
  ]),
  task34ChoicePlan("SEARCH-B", [
    [{ day: 1, start: 10 * HOUR, end: 11 * HOUR }],
    [{ day: 1, start: 13 * HOUR, end: 14 * HOUR }],
    [{ day: 2, start: 10 * HOUR, end: 11 * HOUR }],
  ]),
  task34ChoicePlan("SEARCH-C", [
    [{ day: 1, start: 11 * HOUR, end: 12 * HOUR }],
    [{ day: 1, start: 14 * HOUR, end: 15 * HOUR }],
    [{ day: 3, start: 9 * HOUR, end: 10 * HOUR }],
  ]),
  ];
  const optionSets = [
    { campus: 1, lunch: 0, early: 0, late: 0 },
    { campus: 0, lunch: 1, early: 0, late: 0 },
    { campus: 0, lunch: 0, early: 1, late: 0 },
    { campus: 0, lunch: 0, early: 0, late: 1 },
    { campus: 1, lunch: 1, early: 1, late: 1 },
    { campus: 0, lunch: 0, early: 0, late: 0 },
  ];

  for (const opts of optionSets) {
    const oracle = referenceMinimum(plans, opts);
    const first = optimizer.findBestPlan(plans, opts);
    const second = optimizer.findBestPlan(plans, opts);

    assert.equal(first.status, "OPTIMAL");
    assert.equal(first.complete, true);
    assert.equal(first.optimal, true);
    assert.ok(first.nodesVisited > 0);
    assert.ok(first.plan);
    assert.equal(optimizer.isClashFree(first.plan), true);
    assert.equal(
      compareReference(evaluateReference(first.plan), oracle.evaluation, opts),
      0,
      `exact result missed the independent minimum for ${JSON.stringify(opts)}`,
    );
    assert.deepEqual(first.evaluation, optimizer.evaluatePlan(first.plan));
    assert.deepEqual(first.objective, optimizer.objectiveKey(first.evaluation, opts));
    assert.equal(first.signature, optimizer.planSignature(first.plan));
    assert.equal(second.complete, true);
    assert.equal(second.status, first.status);
    assert.equal(second.signature, first.signature,
      "repeated exact searches must choose the same stable tie");
    assert.deepEqual(second.evaluation, first.evaluation);
  }
});


test("task 3.4: exact search returns complete no-solution for all unsatisfiable inputs", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const overlappingCourses = [
    task34ChoicePlan("UNSAT-A", [[{
      day: 1, start: 9 * HOUR, end: 10 * HOUR,
    }]]),
    task34ChoicePlan("UNSAT-B", [[{
      day: 1, start: 9 * HOUR, end: 10 * HOUR,
    }]]),
  ];
  const crossCourse = optimizer.findBestPlan(overlappingCourses, { campus: 1 });
  assert.deepEqual(
    { plan: crossCourse.plan, status: crossCourse.status, complete: crossCourse.complete },
    { plan: null, status: "NO_SOLUTION", complete: true },
  );
  assert.equal(crossCourse.optimal, true);
  assert.equal(crossCourse.diagnostics.reason, "NO_FEASIBLE_PLAN");
  assert.ok(crossCourse.nodesVisited > 0);

  const sameCourse = [{
    code: "UNSAT-LOCK",
    name: "UNSAT-LOCK",
    locked: [
      {
        tm: "PRA", sec: { name: "PRA1" }, ms: [
          { day: 2, start: 9 * HOUR, end: 10 * HOUR },
        ]
      },
      {
        tm: "TUT", sec: { name: "TUT1" }, ms: [
          { day: 2, start: 9 * HOUR, end: 10 * HOUR },
        ]
      },
    ],
    poolTypes: [],
    combos: [],
  }];
  const intraCourse = optimizer.findBestPlan(sameCourse, { campus: 1 });
  assert.deepEqual(
    { plan: intraCourse.plan, status: intraCourse.status, complete: intraCourse.complete },
    { plan: null, status: "NO_SOLUTION", complete: true },
  );
  assert.equal(intraCourse.diagnostics.reason, "INTRA_COURSE_LOCK_CLASH");
  assert.equal(intraCourse.nodesVisited, 0,
    "lock conflicts must be rejected before candidate enumeration");
});


test("task 3.4: exact path contains no random, deadline, or sampled fallback", () => {
  const source = fs.readFileSync(path.join(ROOT, "web", "optimizer.js"), "utf8");
  assert.doesNotMatch(source, /Math\.random\s*\(/);
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /solveBest\s*\(/);
});


// ---------------------------------------------------------------------------
// Task 3.5: shared-module property and dataset integration coverage.
//
// The tests below intentionally require the same optimizer.js module loaded by
// the browser.  The generated-domain oracle is independent of that module's
// search implementation; it only uses the existing test-side meeting/objective
// reference helpers above.

const TASK35_OPTION_CASES = [
  { name: "none", opts: { campus: 0, lunch: 0, early: 0, late: 0 } },
  { name: "campus", opts: { campus: 1, lunch: 0, early: 0, late: 0 } },
  { name: "lunch", opts: { campus: 0, lunch: 1, early: 0, late: 0 } },
  { name: "early", opts: { campus: 0, lunch: 0, early: 1, late: 0 } },
  { name: "late", opts: { campus: 0, lunch: 0, early: 0, late: 1 } },
  { name: "all", opts: { campus: 1, lunch: 1, early: 1, late: 1 } },
];

const TASK35_FIRST_YEAR_FILES = [
  "computer-1-fall.json", "computer-1-winter.json",
  "mechanical-1-fall.json", "mechanical-1-winter.json",
  "industrial-1-fall.json", "industrial-1-winter.json",
  "chemical-1-fall.json", "chemical-1-winter.json",
  "materials-1-fall.json", "materials-1-winter.json",
  "civil-1-fall.json", "civil-1-winter.json",
  "mineral-1-fall.json", "mineral-1-winter.json",
  "trackone-1-fall.json", "trackone-1-winter.json",
];

const TASK35_SECOND_YEAR_FILES = [
  "computer-2-fall.json", "computer-2-winter.json",
  "electrical-2-fall.json", "electrical-2-winter.json",
  "mechanical-2-fall.json", "mechanical-2-winter.json",
  "industrial-2-fall.json", "industrial-2-winter.json",
  "chemical-2-fall.json", "chemical-2-winter.json",
  "materials-2-fall.json", "materials-2-winter.json",
  "civil-2-fall.json", "civil-2-winter.json",
  "mineral-2-fall.json", "mineral-2-winter.json",
];

function task35ReferenceSearch(plans, opts) {
  const feasible = candidatePlans(plans);
  if (!feasible.length) {
    return { plan: null, evaluation: null, feasibleCount: 0 };
  }

  let best = null;
  let bestEvaluation = null;
  for (const plan of feasible) {
    const evaluation = evaluateReference(plan);
    if (!best || compareReference(evaluation, bestEvaluation, opts) < 0) {
      best = plan;
      bestEvaluation = evaluation;
    }
  }
  return { plan: best, evaluation: bestEvaluation, feasibleCount: feasible.length };
}

function task35ItemType(optimizer, item) {
  if (item && item.lec) return "LEC";
  return optimizer.componentType(
    item && (item.tm || item.teachMethod || item.type || item.sec || item),
  );
}

function task35AssertRequiredComponents(optimizer, resultPlan, inputPlans, label) {
  assert.equal(resultPlan.length, inputPlans.length,
    `${label}: result must contain one candidate per course`);
  const actualByCode = new Map(resultPlan.map(course => [String(course.code), course]));
  for (const inputCourse of inputPlans) {
    const actual = actualByCode.get(String(inputCourse.code));
    assert.ok(actual, `${label}: missing course ${inputCourse.code}`);
    const items = actual.pick || [];
    for (const requiredType of inputCourse.poolTypes || []) {
      assert.ok(
        items.some(item => task35ItemType(optimizer, item) === requiredType),
        `${label}: ${inputCourse.code} dropped active ${requiredType}`,
      );
    }
    for (const lock of inputCourse.locked || []) {
      const lockName = optimizer.sectionName(lock.sec);
      assert.ok(
        items.some(item => task35ItemType(optimizer, item) === lock.tm &&
          optimizer.sectionName(item.sec) === lockName),
        `${label}: ${inputCourse.code} dropped locked ${lock.tm} ${lockName}`,
      );
    }
  }
}

function task35AssertNoFallbackMetadata(result, label) {
  for (const key of ["deadline", "timedOut", "sampled", "random", "fallback", "iterations"]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, key),
      false,
      `${label}: result must not expose legacy ${key} metadata`,
    );
    assert.equal(
      result.diagnostics && Object.prototype.hasOwnProperty.call(result.diagnostics, key),
      false,
      `${label}: diagnostics must not expose legacy ${key} metadata`,
    );
  }
}

function task35AssertResultAgainstOracle(optimizer, result, inputPlans, opts, oracle, label) {
  assert.equal(result.complete, true, `${label}: search must prove completion`);
  assert.equal(result.optimal, true, `${label}: completed search must be optimal`);
  task35AssertNoFallbackMetadata(result, label);

  if (!oracle.plan) {
    assert.equal(result.plan, null, `${label}: unsatisfiable oracle requires no plan`);
    assert.equal(result.status, "NO_SOLUTION", `${label}: unsatisfiable status changed`);
    assert.equal(result.evaluation, null, `${label}: no-solution evaluation must be null`);
    assert.equal(result.objective, null, `${label}: no-solution objective must be null`);
    assert.equal(result.signature, null, `${label}: no-solution signature must be null`);
    return;
  }

  assert.equal(result.status, "OPTIMAL", `${label}: feasible result must be optimal`);
  assert.ok(result.plan, `${label}: feasible oracle requires a plan`);
  assert.equal(optimizer.isClashFree(result.plan), true,
    `${label}: returned plan must be clash-free`);
  assert.equal(containsLockedMeetings(result.plan, inputPlans), true,
    `${label}: active locked meetings changed`);
  task35AssertRequiredComponents(optimizer, result.plan, inputPlans, label);
  assert.deepEqual(result.evaluation, optimizer.evaluatePlan(result.plan),
    `${label}: result evaluation must use evaluatePlan`);
  assert.deepEqual(result.objective, optimizer.objectiveKey(result.evaluation, opts),
    `${label}: result objective must use objectiveKey`);
  assert.equal(result.signature, optimizer.planSignature(result.plan),
    `${label}: result signature must be stable`);
  assert.equal(Number.isFinite(result.score), true,
    `${label}: feasible result must expose a finite score`);
  assert.equal(
    compareReference(evaluateReference(result.plan), oracle.evaluation, opts),
    0,
    `${label}: exact result missed the independent minimum`,
  );
}

function task35SeededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return (limit) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % limit;
  };
}

function task35GeneratedInput(seed) {
  const next = task35SeededRandom(seed);
  const courseCount = 1 + next(4);
  const raw = [];
  const locks = [];
  const excludedCodes = new Set();
  const attendance = new Map();

  for (let courseIndex = 0; courseIndex < courseCount; courseIndex++) {
    const code = `PBT${seed}-${courseIndex}`;
    const choiceCount = 1 + next(3);
    const sections = [];
    for (let choiceIndex = 0; choiceIndex < choiceCount; choiceIndex++) {
      const meetingCount = 1 + next(3);
      const sectionMeetings = [];
      for (let meetingIndex = 0; meetingIndex < meetingCount; meetingIndex++) {
        // Meeting days are distinct within a candidate.  Candidate choices
        // deliberately reuse slots across courses so both feasible and
        // unsatisfiable cross-course products occur in the generated domain.
        const day = ((courseIndex + meetingIndex) % 5) + 1;
        const startHour = 8 + ((courseIndex * 2 + choiceIndex + meetingIndex) % 7);
        sectionMeetings.push({
          day,
          start: startHour * HOUR,
          end: (startHour + 1) * HOUR,
        });
      }
      sections.push(preservationSection(
        `TUT${choiceIndex + 1}`,
        "TUT",
        sectionMeetings,
      ));
    }
    raw.push(preservationCourse(code, sections));

    if (next(3) === 0) {
      const lockedSection = sections[0];
      locks.push({ code, tm: "TUT", sec: lockedSection.name });
      const selected = [0];
      if (lockedSection.meetingTimes.length > 1 && next(2) === 0) {
        selected.push(lockedSection.meetingTimes.length - 1);
      }
      attendance.set(`${code}|${lockedSection.name}`, new Set(selected));
    }
    if (next(4) === 0) excludedCodes.add(code);
  }

  const optimizer = sharedOptimizerIfPresent();
  const plans = optimizer.buildCoursePlans(raw, {
    locks,
    uselessTut: excludedCodes,
    tutAttend: attendance,
  });
  return { raw, plans, excludedCodes, locks, attendance };
}


// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 3.3, 3.4, 3.5, 3.6, 3.7**
test("task 3.5 property: exhaustive generated domains preserve optimality and invariants", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  let cases = 0;
  for (let seed = 1; seed <= 64; seed++) {
    const fixture = task35GeneratedInput(seed);
    assert.ok(fixture.plans.length >= 1 && fixture.plans.length <= 4);
    for (const optionCase of [
      ...TASK35_OPTION_CASES,
      { name: "campus-lunch", opts: { campus: 1, lunch: 1, early: 0, late: 0 } },
      { name: "early-late", opts: { campus: 0, lunch: 0, early: 1, late: 1 } },
    ]) {
      const oracle = task35ReferenceSearch(fixture.plans, optionCase.opts);
      const first = optimizer.findBestPlan(fixture.plans, optionCase.opts);
      const second = optimizer.findBestPlan(fixture.plans, optionCase.opts);
      const label = `seed ${seed}, options ${optionCase.name}`;
      task35AssertResultAgainstOracle(
        optimizer,
        first,
        fixture.plans,
        optionCase.opts,
        oracle,
        label,
      );
      assert.equal(second.complete, true, `${label}: repeated search must complete`);
      assert.equal(second.status, first.status, `${label}: repeated status changed`);
      assert.equal(second.signature, first.signature,
        `${label}: repeated search changed the stable tie signature`);
      assert.deepEqual(second.evaluation, first.evaluation,
        `${label}: repeated search changed the objective evaluation`);
      cases++;
    }
  }
  assert.ok(cases >= 500, `expected hundreds of generated cases, got ${cases}`);
});


// **Validates: Requirements 2.6, 2.7, 3.3, 3.4, 3.5**
test("task 3.5 property: generated same-course locks distinguish overlap from touching", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  let overlappingCases = 0;
  let touchingCases = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const day = (seed % 5) + 1;
    const start = (8 + (seed % 5)) * HOUR;
    const first = { day, start, end: start + HOUR };
    const touches = seed % 2 === 0;
    const secondStart = touches ? start + HOUR : start + HOUR / 2;
    const second = { day, start: secondStart, end: secondStart + HOUR };
    const raw = [preservationCourse(`LOCK-PBT-${seed}`, [
      preservationSection("PRA1", "PRA", [first]),
      preservationSection("TUT1", "TUT", [second]),
    ])];
    const plans = optimizer.buildCoursePlans(raw, {
      locks: [
        { code: `LOCK-PBT-${seed}`, tm: "PRA", sec: "PRA1" },
        { code: `LOCK-PBT-${seed}`, tm: "TUT", sec: "TUT1" },
      ],
    });
    const result = optimizer.findBestPlan(plans, PRESERVATION_NO_OPTIONS);
    const actualOverlap = optimizer.overlaps(first, second);
    assert.equal(actualOverlap, !touches);
    assert.equal(result.complete, true);
    if (touches) {
      touchingCases++;
      assert.equal(result.status, "OPTIMAL", `touching seed ${seed} must remain feasible`);
      assert.ok(result.plan, `touching seed ${seed} must return a plan`);
      assert.equal(optimizer.isClashFree(result.plan), true);
      assert.equal(containsLockedMeetings(result.plan, plans), true);
    } else {
      overlappingCases++;
      assert.equal(result.plan, null, `overlap seed ${seed} must be rejected`);
      assert.equal(result.status, "NO_SOLUTION");
      assert.equal(result.diagnostics.reason, "INTRA_COURSE_LOCK_CLASH");
    }
  }
  assert.ok(overlappingCases > 0);
  assert.ok(touchingCases > 0);
});

function task35CanonicalRaw(optimizer, raw) {
  return raw.map(course => ({
    code: String(course.code),
    sections: (course.sections || [])
      .map(section => optimizer.sectionSignature(section))
      .sort(),
  })).sort((left, right) => left.code.localeCompare(right.code));
}

function task35CanonicalBuilt(optimizer, plans) {
  return plans.map(course => ({
    code: String(course.code),
    poolTypes: (course.poolTypes || []).slice().sort(),
    locked: (course.locked || []).map(lock => optimizer.optionSignature(lock)).sort(),
    combos: (course.combos || []).map(combo => combo
      .map(option => optimizer.optionSignature(option))
      .sort()
      .join(";"))
      .sort(),
  })).sort((left, right) => left.code.localeCompare(right.code));
}

function task35RepresentativePlans(optimizer, fullPlans, fullResult) {
  const baseByCode = new Map(
    (fullResult.plan || []).map(course => [String(course.code), course]),
  );
  return fullPlans.map(course => {
    const base = baseByCode.get(String(course.code));
    if (!base) {
      return { ...course, combos: (course.combos || []).slice(0, 2).map(combo => combo.slice()) };
    }

    const baseSignature = optimizer.candidateSignature(base);
    const baseCombo = (base.pick || []).slice(course.locked.length);
    const combos = [baseCombo];
    const otherBaseEvents = eventList((fullResult.plan || [])
      .filter(candidate => String(candidate.code) !== String(course.code)));
    for (const combo of course.combos || []) {
      if (combos.length >= 2) break;
      const candidate = {
        code: course.code,
        name: course.name,
        pick: (course.locked || []).concat(combo),
      };
      if (optimizer.candidateSignature(candidate) === baseSignature) continue;
      if (!planIsClashFree([candidate])) continue;
      const candidateEvents = eventList([candidate]);
      if (candidateEvents.some(event => otherBaseEvents.some(other => eventOverlap(event, other))))
        continue;
      combos.push(combo.slice());
    }
    return { ...course, combos };
  });
}

function task35AssertResultShape(optimizer, result, inputPlans, opts, label) {
  assert.equal(result.complete, true, `${label}: result must be complete`);
  assert.equal(result.optimal, true, `${label}: result must be optimal`);
  task35AssertNoFallbackMetadata(result, label);
  if (!result.plan) {
    assert.equal(result.status, "NO_SOLUTION", `${label}: null result must be no-solution`);
    return;
  }
  assert.equal(result.status, "OPTIMAL", `${label}: plan result must be optimal`);
  assert.equal(optimizer.isClashFree(result.plan), true,
    `${label}: real-data plan must be clash-free`);
  task35AssertRequiredComponents(optimizer, result.plan, inputPlans, label);
  assert.deepEqual(result.evaluation, optimizer.evaluatePlan(result.plan));
  assert.deepEqual(result.objective, optimizer.objectiveKey(result.evaluation, opts));
  assert.equal(result.signature, optimizer.planSignature(result.plan));
}

const TASK35_RAW_CACHE = new Map();
const TASK35_SUMMARIES = new Map();

function task35GetRaw(fileName) {
  if (!TASK35_RAW_CACHE.has(fileName)) TASK35_RAW_CACHE.set(fileName, readJson(fileName));
  return TASK35_RAW_CACHE.get(fileName);
}

function task35RunDataset(fileName, optimizer, keepCanonical) {
  const raw = task35GetRaw(fileName);
  const fullPlans = optimizer.buildCoursePlans(raw, {});
  assert.equal(fullPlans.length, raw.length, `${fileName}: every raw course must be grouped`);
  assert.deepEqual(
    new Set(fullPlans.map(course => course.code)),
    new Set(raw.map(course => course.code)),
    `${fileName}: course codes changed during construction`,
  );

  // Full default matrices are used for the real no-preference completion
  // check.  Preference searches below use a bounded representative domain
  // extracted from that completed result because the largest Fall matrices
  // contain hundreds of thousands of candidates; the generated property suite
  // independently exhausts the full small-domain Cartesian product.
  const noPreference = TASK35_OPTION_CASES[0].opts;
  const fullResult = optimizer.findBestPlan(fullPlans, noPreference);
  task35AssertResultShape(optimizer, fullResult, fullPlans, noPreference,
    `${fileName} full default`);
  if (fullResult.plan) {
    assert.equal(optimizer.scorePlan(fullResult.plan, noPreference), 0,
      `${fileName}: no-preference result must have zero configured penalty`);
  }

  const representative = task35RepresentativePlans(optimizer, fullPlans, fullResult);
  for (const optionCase of TASK35_OPTION_CASES) {
    const first = optimizer.findBestPlan(representative, optionCase.opts);
    const second = optimizer.findBestPlan(representative, optionCase.opts);
    const label = `${fileName} representative ${optionCase.name}`;
    const oracle = task35ReferenceSearch(representative, optionCase.opts);
    task35AssertResultAgainstOracle(
      optimizer,
      first,
      representative,
      optionCase.opts,
      oracle,
      label,
    );
    assert.equal(second.complete, true, `${label}: repeated search must complete`);
    assert.equal(second.status, first.status, `${label}: repeated status changed`);
    assert.equal(second.signature, first.signature, `${label}: tie signature changed`);
    assert.deepEqual(second.evaluation, first.evaluation, `${label}: evaluation changed`);
  }

  const summary = { representative };
  if (keepCanonical) {
    summary.rawSignature = task35CanonicalRaw(optimizer, raw);
    summary.builtSignature = task35CanonicalBuilt(optimizer, fullPlans);
  }
  return summary;
}


test("task 3.5 integration: all 16 first-year datasets use complete shared searches", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const summaries = [];
  for (const fileName of TASK35_FIRST_YEAR_FILES) {
    const keepCanonical = /^computer-1-|^trackone-1-/.test(fileName);
    const summary = task35RunDataset(fileName, optimizer, keepCanonical);
    summaries.push(fileName);
    if (keepCanonical) TASK35_SUMMARIES.set(fileName, summary);
  }
  assert.equal(summaries.length, 16);
  assert.equal(new Set(summaries).size, 16);
});


test("task 3.5 integration: all supported second-year datasets use complete shared searches", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  for (const fileName of TASK35_SECOND_YEAR_FILES) {
    const raw = task35GetRaw(fileName);
    assert.ok(raw.length > 0, `${fileName}: cache must contain courses`);
    const isComputer = fileName.startsWith("computer-2-");
    const isElectrical = fileName.startsWith("electrical-2-");
    if (isComputer) {
      assert.equal(raw.some(course => course.code === "ECE295H1"), false,
        `${fileName}: Electrical track leaked in`);
      if (fileName.includes("-winter")) {
        assert.equal(raw.some(course => course.code === "ECE297H1"), true,
          `${fileName}: Computer track changed`);
      }
    } else if (isElectrical) {
      assert.equal(raw.some(course => course.code === "ECE297H1"), false,
        `${fileName}: Computer track leaked in`);
      if (fileName.includes("-winter")) {
        assert.equal(raw.some(course => course.code === "ECE295H1"), true,
          `${fileName}: Electrical track changed`);
      }
    }

    // task35RunDataset performs the generic checks for every major: all raw
    // courses must build, the exact search must complete, and any returned
    // plan must preserve active components, locks, objective identity, and
    // clash-freedom.  Civil/Mineral Fall may legitimately be complete
    // NO_SOLUTION because their current API data has no usable required
    // meeting-time candidates.
    task35RunDataset(fileName, optimizer, false);
  }
  assert.equal(TASK35_SECOND_YEAR_FILES.length, 16);
  assert.equal(new Set(TASK35_SECOND_YEAR_FILES).size, 16);
});


// **Validates: Requirements 2.7, 2.8, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
test("task 3.5 integration: Computer and Track One are equivalent at optimizer level", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  for (const semester of ["fall", "winter"]) {
    const computerFile = `computer-1-${semester}.json`;
    const trackOneFile = `trackone-1-${semester}.json`;
    const computer = TASK35_SUMMARIES.get(computerFile) ||
      task35RunDataset(computerFile, optimizer, true);
    const trackOne = TASK35_SUMMARIES.get(trackOneFile) ||
      task35RunDataset(trackOneFile, optimizer, true);
    assert.deepEqual(computer.rawSignature, trackOne.rawSignature,
      `${semester}: raw course/section signatures diverged`);
    assert.deepEqual(computer.builtSignature, trackOne.builtSignature,
      `${semester}: built optimizer signatures diverged`);

    for (const optionCase of TASK35_OPTION_CASES) {
      const first = optimizer.findBestPlan(computer.representative, optionCase.opts);
      const second = optimizer.findBestPlan(trackOne.representative, optionCase.opts);
      const label = `${semester} ${optionCase.name}`;
      assert.equal(first.complete, true, `${label}: Computer incomplete`);
      assert.equal(second.complete, true, `${label}: Track One incomplete`);
      assert.equal(first.status, second.status, `${label}: feasibility diverged`);
      assert.equal(first.status === "OPTIMAL", first.plan !== null);
      assert.equal(second.status === "OPTIMAL", second.plan !== null);
      if (first.plan && second.plan) {
        assert.equal(optimizer.isClashFree(first.plan), true, `${label}: Computer clash`);
        assert.equal(optimizer.isClashFree(second.plan), true, `${label}: Track One clash`);
        assert.deepEqual(first.evaluation, second.evaluation,
          `${label}: objective evaluation diverged`);
        assert.deepEqual(first.objective, second.objective,
          `${label}: objective key diverged`);
        assert.equal(first.signature, second.signature,
          `${label}: deterministic tie signature diverged`);
      }
      const repeated = optimizer.findBestPlan(computer.representative, optionCase.opts);
      assert.equal(repeated.complete, first.complete, `${label}: repeat completion changed`);
      assert.equal(repeated.status, first.status, `${label}: repeat feasibility changed`);
      assert.equal(repeated.signature, first.signature, `${label}: repeat signature changed`);
    }
  }
});


test("task 3.5 integration: confirmed locks and MAT188H1 rejection use shared plan construction", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = task35GetRaw("computer-1-fall.json");
  const relevant = raw.filter(course => ["APS100H1", "APS110H1", "APS111H1"].includes(course.code));
  const state = {
    locks: [
      { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
      { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
    ],
    uselessTut: new Set(["APS110H1"]),
  };
  const plans = optimizer.buildCoursePlans(relevant, state);
  assert.equal(plans.length, 3);
  assert.equal(plans.find(course => course.code === "APS110H1").poolTypes.includes("TUT"), false);
  assert.equal(plans.find(course => course.code === "APS100H1").locked.length, 1);
  assert.equal(plans.find(course => course.code === "APS111H1").locked.length, 1);
  const result = optimizer.findBestPlan(plans, campusOptions);
  const oracle = task35ReferenceSearch(plans, campusOptions);
  task35AssertResultAgainstOracle(
    optimizer,
    result,
    plans,
    campusOptions,
    oracle,
    "Computer/ECE Fall locked reproduction",
  );

  const mat = raw.find(course => course.code === "MAT188H1");
  const matPlans = optimizer.buildCoursePlans([mat], {
    locks: [
      { code: "MAT188H1", tm: "PRA", sec: "PRA0106" },
      { code: "MAT188H1", tm: "TUT", sec: "TUT0115" },
    ],
  });
  const matResult = optimizer.findBestPlan(matPlans, campusOptions);
  assert.equal(matResult.complete, true);
  assert.equal(matResult.plan, null);
  assert.equal(matResult.status, "NO_SOLUTION");
  assert.equal(matResult.diagnostics.reason, "INTRA_COURSE_LOCK_CLASH");
});


// ---------------------------------------------------------------------------
// Task 3.7: cumulative best-result identity and complete-result guards.

function task37InputKey(page, opts) {
  return vm.runInContext(
    `bestSoFarInputKey(selectedPlan(), ${JSON.stringify(opts)})`,
    page.context,
  );
}

function task37KeyPage() {
  const page = makeInlinePageHarness();
  page.installCourses([preservationCourse("KEY", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 2, start: 10 * HOUR, end: 11 * HOUR },
      { day: 4, start: 12 * HOUR, end: 13 * HOUR },
      { day: 5, start: 14 * HOUR, end: 15 * HOUR },
    ]),
  ])]);
  page.setExclusions({});
  page.setLocks([{ code: "KEY", tm: "TUT", sec: "TUT1" }]);
  preservationSetTutorialAttendance(page, "KEY", "TUT1", [0, 2]);
  return page;
}

// **Validates: Requirements 3.3, 3.4, 3.5, 3.7**
test("task 3.7: bestSoFar input identity covers every plan-affecting dimension", () => {
  const options = { campus: 0, lunch: 0, early: 0, late: 0 };
  const baselinePage = task37KeyPage();
  const baseline = task37InputKey(baselinePage, options);
  assert.equal(task37InputKey(baselinePage, options), baseline,
    "unchanged input identity must be stable");

  const lockChanged = task37KeyPage();
  lockChanged.setLocks([]);
  assert.notEqual(task37InputKey(lockChanged, options), baseline,
    "active lock changes must invalidate cumulative state");

  const attendanceChanged = task37KeyPage();
  preservationSetTutorialAttendance(attendanceChanged, "KEY", "TUT1", [0]);
  assert.notEqual(task37InputKey(attendanceChanged, options), baseline,
    "selected tutorial meeting changes must invalidate cumulative state");

  for (const exclusion of [
    { lec: ["KEY"] },
    { pra: ["KEY|PRA1"] },
    { tut: ["KEY"] },
  ]) {
    const excluded = task37KeyPage();
    excluded.setExclusions(exclusion);
    assert.notEqual(task37InputKey(excluded, options), baseline,
      `exclusion ${JSON.stringify(exclusion)} must invalidate cumulative state`);
  }

  for (const option of ["campus", "lunch", "early", "late"]) {
    const changed = { ...options, [option]: 1 };
    assert.notEqual(task37InputKey(task37KeyPage(), changed), baseline,
      `${option} preference changes must invalidate cumulative state`);
  }

  const changedData = task37KeyPage();
  changedData.installCourses([preservationCourse("KEY", [
    preservationSection("LEC1", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]),
    preservationSection("PRA1", "PRA", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
    preservationSection("TUT1", "TUT", [
      { day: 2, start: 11 * HOUR, end: 12 * HOUR },
      { day: 4, start: 12 * HOUR, end: 13 * HOUR },
      { day: 5, start: 14 * HOUR, end: 15 * HOUR },
    ]),
  ])]);
  changedData.setExclusions({});
  changedData.setLocks([{ code: "KEY", tm: "TUT", sec: "TUT1" }]);
  preservationSetTutorialAttendance(changedData, "KEY", "TUT1", [0, 2]);
  assert.notEqual(task37InputKey(changedData, options), baseline,
    "loaded course/section data changes must invalidate cumulative state");
});

// **Validates: Requirements 3.3, 3.5, 3.7**
test("task 3.7: only complete optimal clash-free results update or render bestSoFar", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const originalFindBestPlan = optimizer.findBestPlan;
  const page = makeInlinePageHarness();
  page.installCourses([preservationCourse("GUARD", [
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
  ])]);
  page.setExclusions({});
  page.setLocks([]);
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const plans = page.selectedPlans();
  const validResult = originalFindBestPlan(plans, options);
  assert.equal(validResult.complete, true);
  assert.equal(validResult.optimal, true);
  assert.equal(optimizer.isClashFree(validResult.plan), true);

  try {
    optimizer.findBestPlan = () => validResult;
    const first = preservationRunPageOptimize(page, options, [0.1]);
    assert.ok(first.plan, "a complete valid result must be retained");
    assert.notEqual(first.timetable, "", "a complete valid result must render");
    const retainedPlan = first.plan;

    optimizer.findBestPlan = () => ({ ...validResult, complete: false, optimal: false });
    const incomplete = preservationRunPageOptimize(page, options, [0.9]);
    assert.equal(incomplete.plan, retainedPlan,
      "an incomplete result must not replace a prior complete bestSoFar");
    assert.equal(incomplete.timetable, "",
      "an incomplete result must not be rendered");

    const conflictingPlan = [
      {
        code: "GUARD-A", name: "GUARD-A", pick: [{
          sec: { name: "A" }, ms: [{ day: 1, start: 9 * HOUR, end: 10 * HOUR }],
        }]
      },
      {
        code: "GUARD-B", name: "GUARD-B", pick: [{
          sec: { name: "B" }, ms: [{ day: 1, start: 9 * HOUR, end: 10 * HOUR }],
        }]
      },
    ];
    const conflictingEvaluation = optimizer.evaluatePlan(conflictingPlan);
    optimizer.findBestPlan = () => ({
      plan: conflictingPlan,
      status: "OPTIMAL",
      complete: true,
      optimal: true,
      evaluation: conflictingEvaluation,
      objective: optimizer.objectiveKey(conflictingEvaluation, options),
      score: optimizer.scorePlan(conflictingPlan, options),
      signature: optimizer.planSignature(conflictingPlan),
    });
    const conflicting = preservationRunPageOptimize(page, options, [0.5]);
    assert.equal(conflicting.plan, retainedPlan,
      "a conflicting result must not replace a prior complete bestSoFar");
    assert.equal(conflicting.timetable, "",
      "a conflicting result must not be rendered");

    optimizer.findBestPlan = () => ({
      plan: null,
      status: "NO_SOLUTION",
      complete: true,
      optimal: true,
    });
    const noSolution = preservationRunPageOptimize(page, options, [0.5]);
    assert.equal(noSolution.plan, null,
      "complete NO_SOLUTION must clear the cumulative plan");
    assert.equal(noSolution.timetable, "",
      "complete NO_SOLUTION must clear stale timetable markup");
    assert.match(noSolution.status, /Could not build a clash-free timetable/);
  } finally {
    optimizer.findBestPlan = originalFindBestPlan;
  }
});

// **Validates: Requirements 3.3, 3.5, 3.7**
test("task 3.7: changed inputs cannot retain a previously rendered plan on no-solution", () => {
  const page = makeInlinePageHarness();
  page.installCourses([
    preservationCourse("STALE-A", [preservationSection("TUTA", "TUT", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ])]),
    preservationCourse("STALE-B", [
      preservationSection("TUTB1", "TUT", [
        { day: 1, start: 9 * HOUR, end: 10 * HOUR },
      ]),
      preservationSection("TUTB2", "TUT", [
        { day: 1, start: 8 * HOUR, end: 9 * HOUR },
      ]),
    ]),
  ]);
  page.setExclusions({});
  page.setLocks([]);
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const first = preservationRunPageOptimize(page, options, [0.5]);
  assert.ok(first.plan, "initial feasible input must render a plan");
  assert.notEqual(first.timetable, "");

  page.setLocks([
    { code: "STALE-A", tm: "TUT", sec: "TUTA" },
    { code: "STALE-B", tm: "TUT", sec: "TUTB2" },
  ]);
  const noSolution = preservationRunPageOptimize(page, options, [0.5]);
  assert.equal(noSolution.plan, null,
    "changed unsatisfiable input must not reuse the old bestSoFar");
  assert.equal(noSolution.timetable, "",
    "changed unsatisfiable input must clear the old timetable");
  assert.match(noSolution.status, /Could not build a clash-free timetable/);
});


// ---------------------------------------------------------------------------
// Task 3.3: asynchronous worker boundary and cancellation.

function task33TriggerOptimize(page, opts) {
  const encoded = JSON.stringify(opts);
  vm.runInContext(`(function(options) {
    document.getElementById("optCampus").checked = !!options.campus;
    document.getElementById("optLunch").checked = !!options.lunch;
    document.getElementById("optEarly").checked = !!options.early;
    document.getElementById("optLate").checked = !!options.late;
    optimize();
  })(${encoded})`, page.context);
}

function task33SimplePage(worker = false) {
  const page = makeInlinePageHarness();
  if (worker) page.installDeterministicWorker();
  page.installCourses([preservationCourse("ASYNC", [preservationSection("TUT1", "TUT", [
    { day: 1, start: 9 * HOUR, end: 10 * HOUR },
  ])])]);
  page.setExclusions({});
  page.setLocks([]);
  return page;
}

// **Validates: Requirements 2.1, 2.3, 2.5, 2.6, 3.1, 3.6, 3.7**
test("task 3.3: worker requests are identified and superseded responses are ignored", () => {
  const page = task33SimplePage(true);
  const opts = { campus: 1, lunch: 0, early: 0, late: 0 };

  task33TriggerOptimize(page, opts);
  assert.equal(page.workerInstances.length, 1);
  const first = page.workerInstances[0];
  const firstMessage = first.messages[0];
  assert.equal(firstMessage.input.options.campus, 1);
  assert.ok(Number.isInteger(firstMessage.requestId));
  assert.ok(Number.isInteger(firstMessage.generation));

  // A second click supersedes the first before its queued response runs.
  task33TriggerOptimize(page, opts);
  assert.equal(page.workerInstances.length, 2);
  const second = page.workerInstances[1];
  const secondMessage = second.messages[0];
  assert.ok(secondMessage.requestId > firstMessage.requestId);
  assert.ok(secondMessage.generation > firstMessage.generation);
  assert.equal(first.terminated, true, "superseded worker must be terminated");

  // The deterministic adapter still delivers the first late response. Only the
  // second request may update cumulative state or render a timetable.
  page.eventLoop.flush();
  const state = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    timetable: document.getElementById("timetable").innerHTML,
  })`, page.context);
  assert.ok(state.plan, "the current request must produce a plan");
  assert.equal(state.result.requestId, undefined,
    "request correlation metadata must not leak into the solver result");
  assert.equal(state.result.complete, true);
  assert.equal(state.result.status, "OPTIMAL");
  assert.notEqual(state.timetable, "");
  assert.equal(second.terminated, true, "completed worker must be released");
});

// **Validates: Requirements 2.3, 2.5, 2.6, 3.6, 3.7**
test("task 3.3: cancellation prevents a late worker result from becoming no-solution", () => {
  const page = task33SimplePage(true);
  task33TriggerOptimize(page, { campus: 0, lunch: 0, early: 0, late: 0 });
  const worker = page.workerInstances[0];
  vm.runInContext("clearBestSoFar()", page.context);
  assert.equal(worker.terminated, true);
  page.eventLoop.flush();

  const state = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    timetable: document.getElementById("timetable").innerHTML,
    status: document.getElementById("status").textContent,
  })`, page.context);
  assert.equal(state.plan, null);
  assert.equal(state.result, null);
  assert.equal(state.timetable, "");
  assert.match(state.status, /canceled/i);
  assert.doesNotMatch(state.status, /NO_SOLUTION|Could not build/);
});

// **Validates: Requirements 2.1, 2.3, 2.5, 3.6, 3.7**
test("task 3.3: worker errors clear stale output and expose retry state", () => {
  const page = task33SimplePage(true);
  task33TriggerOptimize(page, { campus: 1, lunch: 0, early: 0, late: 0 });
  const worker = page.workerInstances[0];
  assert.equal(typeof worker.onerror, "function");
  worker.onerror({ message: "synthetic worker failure" });
  page.eventLoop.flush();

  const state = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    timetable: document.getElementById("timetable").innerHTML,
    status: document.getElementById("status").textContent,
    info: document.getElementById("optInfo").textContent,
  })`, page.context);
  assert.equal(state.plan, null);
  assert.equal(state.result, null);
  assert.equal(state.timetable, "");
  assert.match(state.status, /Optimization failed/);
  assert.match(state.status, /retry/i);
  assert.match(state.info, /synthetic worker failure/);
});

// **Validates: Requirements 2.1, 2.3, 2.5, 2.6, 3.1, 3.6, 3.7**
test("task 3.3: no-worker fallback defers a complete exact result and renders searched progress", () => {
  const page = task33SimplePage(false);
  const opts = { campus: 1, lunch: 0, early: 0, late: 0 };
  page.eventLoop.begin();
  page.eventLoop.queueControlProbe();
  task33TriggerOptimize(page, opts);
  assert.equal(page.workerInstances.length, 0);
  assert.equal(page.eventLoop.controlDuringSearch, true,
    "fallback must return to the event loop before the exact call");
  assert.equal(vm.runInContext("bestSoFar", page.context), null,
    "fallback must not expose an intermediate plan");
  assert.equal(
    vm.runInContext("document.getElementById('status').textContent", page.context),
    "Searched 0 combinations…",
    "fallback must expose the initial searched-combination status",
  );
  page.eventLoop.end();
  page.eventLoop.flush();

  const state = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    status: document.getElementById("status").textContent,
    timetable: document.getElementById("timetable").innerHTML,
  })`, page.context);
  assert.ok(state.plan);
  assert.equal(state.result.complete, true);
  assert.equal(state.result.optimal, true);
  assert.equal(state.result.status, "OPTIMAL");
  assert.ok(state.result.combinationsSearched >= 1);
  assert.match(state.status, /Searched \d+ combinations\.$/);
  assert.notEqual(state.timetable, "");
});


// ---------------------------------------------------------------------------
// Task 3.5 focused extensions: complete objective combinations, exact lock
// preservation, direct worker result guards, stale-response suppression, and
// search-path source regression checks.

// **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 3.3, 3.4, 3.5, 3.6, 3.7**
test("task 3.5 property: generated domains cover every supported objective combination", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const allObjectiveCases = Array.from({ length: 16 }, (_, mask) => ({
    name: `mask-${mask.toString(2).padStart(4, "0")}`,
    opts: {
      campus: (mask & 1) ? 1 : 0,
      lunch: (mask & 2) ? 1 : 0,
      early: (mask & 4) ? 1 : 0,
      late: (mask & 8) ? 1 : 0,
    },
  }));

  let cases = 0;
  // This second, smaller generated matrix complements the broad single and
  // selected-combination matrix above by exercising every supported flag
  // combination against the independent exhaustive oracle.
  for (let seed = 101; seed <= 116; seed++) {
    const fixture = task35GeneratedInput(seed);
    for (const optionCase of allObjectiveCases) {
      const oracle = task35ReferenceSearch(fixture.plans, optionCase.opts);
      const result = optimizer.findBestPlan(fixture.plans, optionCase.opts);
      task35AssertResultAgainstOracle(
        optimizer,
        result,
        fixture.plans,
        optionCase.opts,
        oracle,
        `seed ${seed}, ${optionCase.name}`,
      );
      cases++;
    }
  }
  assert.equal(cases, 256, "every generated seed must cover all 16 objective combinations");
});


// **Validates the exact six-course Computer Year 1 Fall lock/exclusion case.**
test("task 3.6 performance regression: locked Computer Fall search is exact and deterministic", async () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = task35GetRaw("computer-1-fall.json");
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const plans = optimizer.buildCoursePlans(raw, {
    locks: [
      { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
      { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
      { code: "MAT188H1", tm: "PRA", sec: "PRA0103" },
    ],
    uselessTut: new Set(["APS110H1"]),
  });

  assert.equal(plans.length, raw.length);
  assert.deepEqual(plans.map(course => course.code), [
    "APS100H1", "APS110H1", "APS111H1", "CIV100H1", "MAT186H1", "MAT188H1",
  ]);
  assert.equal(plans.find(course => course.code === "APS100H1").locked.length, 1);
  assert.equal(plans.find(course => course.code === "APS111H1").locked.length, 1);
  assert.equal(plans.find(course => course.code === "MAT188H1").locked.length, 1);
  assert.equal(plans.find(course => course.code === "APS110H1").poolTypes.includes("TUT"), false);

  const synchronous = optimizer.findBestPlan(plans, options);
  const repeated = optimizer.findBestPlan(plans, options);
  assert.equal(synchronous.status, "OPTIMAL");
  assert.equal(synchronous.complete, true);
  assert.equal(synchronous.optimal, true);
  assert.ok(synchronous.plan);
  assert.equal(optimizer.isClashFree(synchronous.plan), true);
  assert.equal(containsLockedMeetings(synchronous.plan, plans), true);
  task35AssertRequiredComponents(optimizer, synchronous.plan, plans,
    "locked Computer Fall performance regression");
  task35AssertNoFallbackMetadata(synchronous, "locked Computer Fall performance regression");
  assert.ok(synchronous.nodesVisited > 0);
  assert.ok(synchronous.nodesVisited <= 1978114,
    "locked Computer Fall search must stay within the established performance bound");
  assert.equal(synchronous.combinationsSearched, synchronous.nodesVisited);
  assert.equal(synchronous.diagnostics.combinationsSearched, synchronous.combinationsSearched);
  assert.deepEqual(synchronous.objective, {
    lunchDeficitMs: 0,
    combinedMs: 24 * HOUR,
    totalMs: 24 * HOUR,
  });
  assert.equal(synchronous.evaluation.activeDays, 5);
  assert.equal(synchronous.evaluation.gapsMs, 0);
  assert.equal(synchronous.signature, optimizer.planSignature(synchronous.plan));

  assert.equal(repeated.status, synchronous.status);
  assert.equal(repeated.signature, synchronous.signature,
    "repeated locked searches must preserve the stable optimum");
  assert.deepEqual(repeated.evaluation, synchronous.evaluation);
  assert.deepEqual(repeated.objective, synchronous.objective);
  assert.equal(repeated.nodesVisited, synchronous.nodesVisited);
  assert.equal(repeated.combinationsSearched, synchronous.combinationsSearched);

  const cooperative = await optimizer.findBestPlan(plans, options, {
    cooperative: true,
    schedule(callback) { callback(); },
  });
  assert.equal(cooperative.status, synchronous.status);
  assert.equal(cooperative.complete, true);
  assert.equal(cooperative.optimal, true);
  assert.equal(cooperative.signature, synchronous.signature,
    "fallback traversal must preserve the synchronous stable optimum");
  assert.deepEqual(cooperative.evaluation, synchronous.evaluation);
  assert.deepEqual(cooperative.objective, synchronous.objective);
  assert.equal(cooperative.nodesVisited, synchronous.nodesVisited);
  assert.equal(cooperative.combinationsSearched, synchronous.combinationsSearched);
});


// **Validates: Requirements 2.2, 2.3, 2.4, 2.6, 3.2, 3.3, 3.4, 3.5, 3.6**
test("task 3.5 integration: exact locks and exclusions survive the terminal result", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const raw = task35GetRaw("computer-1-fall.json");
  const relevant = raw.filter(course => ["APS100H1", "APS110H1", "APS111H1"].includes(course.code));
  const plans = optimizer.buildCoursePlans(relevant, {
    locks: [
      { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
      { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
    ],
    uselessTut: new Set(["APS110H1"]),
  });
  const result = optimizer.findBestPlan(plans, campusOptions);
  const oracle = task35ReferenceSearch(plans, campusOptions);
  task35AssertResultAgainstOracle(
    optimizer,
    result,
    plans,
    campusOptions,
    oracle,
    "locked/excluded terminal result",
  );

  assert.ok(result.plan, "the locked/excluded fixture must remain feasible");
  for (const inputCourse of plans) {
    for (const lock of inputCourse.locked) {
      const actualCourse = result.plan.find(course => String(course.code) === String(inputCourse.code));
      const actualLock = (actualCourse.pick || []).find(item =>
        task35ItemType(optimizer, item) === lock.tm &&
        optimizer.sectionName(item.sec) === optimizer.sectionName(lock.sec));
      assert.ok(actualLock,
        `${inputCourse.code}: exact active lock ${lock.tm}/${optimizer.sectionName(lock.sec)} was dropped`);
      assert.deepEqual(
        optimizer.meetings(actualLock.ms).map(optimizer.meetingSignature),
        optimizer.meetings(lock.ms).map(optimizer.meetingSignature),
        `${inputCourse.code}: active lock meeting subset was changed`,
      );
    }
  }

  const excludedCourse = result.plan.find(course => course.code === "APS110H1");
  assert.ok(excludedCourse, "APS110H1 must remain represented as a course candidate");
  assert.equal(
    (excludedCourse.pick || []).some(item => task35ItemType(optimizer, item) === "TUT"),
    false,
    "APS110H1 tutorial exclusion must not leak into the terminal timetable",
  );
  task35AssertRequiredComponents(optimizer, result.plan, plans,
    "locked/excluded terminal result");
});


// **Validates: Requirements 2.1, 2.3, 2.5, 2.6, 3.1, 3.6, 3.7**
test("task 3.5 integration: the worker adapter forwards only complete terminal results", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const workerSource = fs.readFileSync(path.join(ROOT, "web", "optimizer-worker.js"), "utf8");
  const plans = optimizer.buildCoursePlans([preservationCourse("WORKER", [
    preservationSection("TUT1", "TUT", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ]),
  ])], {});
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const request = {
    type: "optimize",
    requestId: 17,
    generation: 4,
    key: "worker-test-key",
    input: { plans, options },
  };

  function dispatch(shared, message) {
    const messages = [];
    const root = {
      TimetableOptimizer: shared,
      addEventListener(name, listener) {
        if (name === "message") this.messageListener = listener;
      },
      postMessage(value) {
        messages.push(value);
      },
    };
    const context = vm.createContext({ self: root });
    vm.runInContext(workerSource, context, {
      filename: path.join(ROOT, "web", "optimizer-worker.js"),
    });
    assert.equal(typeof root.messageListener, "function", "worker must install a message listener");
    root.messageListener({ data: message });
    return messages;
  }

  const expected = optimizer.findBestPlan(plans, options);
  const successMessages = dispatch(optimizer, request);
  const progressMessages = successMessages.filter(message => message.type === "progress");
  const terminalMessages = successMessages.filter(message => message.type === "result");
  assert.ok(progressMessages.length >= 1, "worker must forward search-state progress");
  assert.equal(terminalMessages.length, 1);
  for (let index = 1; index < progressMessages.length; index++) {
    assert.ok(
      progressMessages[index].combinationsSearched >=
      progressMessages[index - 1].combinationsSearched,
      "worker progress counts must be monotonic",
    );
  }
  for (const message of progressMessages) {
    assert.equal(message.requestId, request.requestId);
    assert.equal(message.generation, request.generation);
    assert.equal(message.key, request.key);
    assert.equal(Object.prototype.hasOwnProperty.call(message, "result"), false);
  }
  const successMessage = terminalMessages[0];
  assert.equal(successMessage.requestId, request.requestId);
  assert.equal(successMessage.generation, request.generation);
  assert.equal(successMessage.key, request.key);
  assert.deepEqual(successMessage.result, expected);
  assert.equal(
    progressMessages[progressMessages.length - 1].combinationsSearched,
    expected.combinationsSearched,
    "worker final progress must match terminal searched count",
  );
  task35AssertNoFallbackMetadata(successMessage.result, "worker success");
  assert.equal(successMessage.result.complete, true);
  assert.equal(successMessage.result.optimal, true);

  const workerPreferenceOption = task3AlignedPreferenceOption(
    "WORKER-ADA", { day: 2, start: 9 * HOUR, end: 10 * HOUR }, [task3Ada],
  );
  const workerPreferencePlans = task3PreferencePlan(
    "WORKER-PREFERENCE", [task3Ada], [workerPreferenceOption],
  );
  const workerPreferenceRequest = Object.assign({}, request, {
    requestId: 18,
    generation: 5,
    key: "worker-preference-test-key",
    input: { plans: workerPreferencePlans, options: task3None },
  });
  const preferenceMessages = dispatch(optimizer, workerPreferenceRequest);
  const preferenceTerminal = preferenceMessages.find(message => message.type === "result");
  assert.ok(preferenceTerminal, "preference worker fixture must produce a terminal result");
  const clonedPreferenceResult = cloneForWorkerBoundary(preferenceTerminal.result);
  assert.deepEqual(clonedPreferenceResult.plan[0].preferredInstructors, ["ada lovelace"]);
  assert.deepEqual(
    clonedPreferenceResult.plan[0].pick[0].lectureProvenance[0].instructors,
    ["ada lovelace"],
    "aligned lecture provenance must survive the worker clone",
  );
  assert.deepEqual(
    optimizer.evaluatePlan(clonedPreferenceResult.plan),
    preferenceTerminal.result.evaluation,
  );
  assert.deepEqual(
    optimizer.objectiveKey(clonedPreferenceResult.evaluation, task3None),
    preferenceTerminal.result.objective,
  );
  assert.equal(clonedPreferenceResult.evaluation.matchedCourseCount, 1);
  assert.equal(clonedPreferenceResult.evaluation.missedCourseCount, 0);

  const incompleteShared = {
    findBestPlan() {
      return {
        plan: expected.plan,
        status: "OPTIMAL",
        complete: false,
        optimal: false,
      };
    },
  };
  const errorMessages = dispatch(incompleteShared, request);
  assert.equal(errorMessages.length, 1);
  assert.equal(errorMessages[0].type, "error");
  assert.equal(errorMessages[0].requestId, request.requestId);
  assert.match(errorMessages[0].error.message, /incomplete result/);
  assert.equal(Object.prototype.hasOwnProperty.call(errorMessages[0], "result"), false,
    "an incomplete solver response must never cross as a result message");
});


// **Validates: Requirements 2.1, 2.3, 2.5, 2.6, 3.1, 3.6, 3.7**
test("task 3.5 page boundary: stale worker responses and changed inputs cannot render", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const page = task33SimplePage(true);
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };

  task33TriggerOptimize(page, options);
  const first = page.workerInstances[0];
  const firstMessage = first.messages[0];
  const firstResult = optimizer.findBestPlan(firstMessage.input.plans, firstMessage.input.options);

  task33TriggerOptimize(page, options);
  const second = page.workerInstances[1];
  assert.equal(first.terminated, true, "a repeated Optimize must cancel the old worker");

  // Deliver a valid result from the superseded request directly before the
  // queued adapter response. Generation, request ID, and canonical key must
  // all reject it without clearing or rendering current state.
  first.onmessage({
    data: {
      type: "result",
      requestId: firstMessage.requestId,
      generation: firstMessage.generation,
      key: firstMessage.key,
      result: firstResult,
    },
  });
  first.onerror({ message: "late superseded error" });
  assert.equal(vm.runInContext("bestSoFar", page.context), null,
    "a stale complete result must not enter cumulative state");
  assert.equal(vm.runInContext("document.getElementById('timetable').innerHTML", page.context), "",
    "a stale complete result must not render a timetable");
  assert.match(vm.runInContext("document.getElementById('status').textContent", page.context), /Searched 0 combinations/,
    "a stale worker error must not replace the current request status");

  page.eventLoop.flush();
  assert.equal(second.terminated, true, "the current worker must be released after completion");
  const completed = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    timetable: document.getElementById("timetable").innerHTML,
  })`, page.context);
  assert.ok(completed.plan, "the current worker result must still render");
  assert.equal(completed.result.complete, true);
  assert.equal(completed.result.optimal, true);
  assert.notEqual(completed.timetable, "");

  const changedPage = task33SimplePage(true);
  task33TriggerOptimize(changedPage, options);
  const pending = changedPage.workerInstances[0];
  changedPage.setLocks([{ code: "ASYNC", tm: "TUT", sec: "TUT1" }]);
  vm.runInContext("clearBestSoFar()", changedPage.context);
  assert.equal(pending.terminated, true, "a plan-affecting input change must cancel pending work");
  changedPage.eventLoop.flush();
  const canceled = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    timetable: document.getElementById("timetable").innerHTML,
    status: document.getElementById("status").textContent,
  })`, changedPage.context);
  assert.equal(canceled.plan, null);
  assert.equal(canceled.result, null);
  assert.equal(canceled.timetable, "");
  assert.match(canceled.status, /canceled/i);
});


// **Validates: Requirements 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
test("task 3.5 page boundary: cloned legal candidates pass and fabricated candidates or invalid locks fail", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const page = task33SimplePage(false);
  const plans = page.selectedPlans();
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const valid = optimizer.findBestPlan(plans, options);
  assert.equal(valid.status, "OPTIMAL");

  const accepts = (result, expectedPlans = plans) => {
    page.context.__boundaryResult = result;
    page.context.__boundaryPlans = expectedPlans;
    page.context.__boundaryOptions = options;
    return vm.runInContext(
      "isCompleteOptimalPlanResult(__boundaryResult, __boundaryOptions, __boundaryPlans)",
      page.context,
    );
  };

  const cloned = cloneForWorkerBoundary(valid);
  assert.equal(accepts(cloned), true,
    "a legitimate current solver result must remain valid after structured cloning");

  const forged = cloneForWorkerBoundary(valid);
  const forgedItem = forged.plan[0].pick[0];
  forgedItem.sec = { name: "FABRICATED", teachMethod: "TUT" };
  forgedItem.tm = "TUT";
  forgedItem.ms = [{ day: 2, start: 15 * HOUR, end: 16 * HOUR }];
  forged.evaluation = optimizer.evaluatePlan(forged.plan);
  forged.objective = optimizer.objectiveKey(forged.evaluation, options);
  forged.score = optimizer.scorePlan(forged.plan, options);
  forged.signature = optimizer.planSignature(forged.plan);
  assert.equal(accepts(forged), false,
    "a self-consistent but non-legal section/meeting candidate must be rejected");

  const invalidExpected = cloneForWorkerBoundary(plans);
  invalidExpected[0].invalidLocks = [{
    invalid: true,
    reason: "TEST_INVALID_LOCK",
    tm: "TUT",
    sectionName: "TUT1",
  }];
  assert.equal(accepts(cloned, invalidExpected), false,
    "an optimal result must be rejected when the expected input has invalid locks");
});


test("task 3.5 static scope: production search paths have no legacy sampling or timeout results", () => {
  const optimizerSource = fs.readFileSync(path.join(ROOT, "web", "optimizer.js"), "utf8");
  const workerSource = fs.readFileSync(path.join(ROOT, "web", "optimizer-worker.js"), "utf8");
  const pageSource = inlineScript();
  const searchStart = pageSource.indexOf("function selectedOptimizationOptions()");
  assert.ok(searchStart >= 0, "page search boundary must remain identifiable");
  const pageSearchSource = pageSource.slice(searchStart);
  const productionSearchSources = [
    ["shared optimizer", optimizerSource],
    ["optimizer worker", workerSource],
    ["page search boundary", pageSearchSource],
  ];

  for (const [label, source] of productionSearchSources) {
    assert.doesNotMatch(source, /Math\.random\s*\(/,
      `${label}: random sampling is forbidden in the production search path`);
    assert.doesNotMatch(source, /Date\.now\s*\(/,
      `${label}: elapsed-time deadline termination is forbidden in the production search path`);
    assert.doesNotMatch(source, /\bsolveBest\s*\(/,
      `${label}: legacy solveBest must not remain on the production search path`);
    assert.doesNotMatch(source, /\b(?:deadline|timedOut|sampled|random|fallback|iterations)\s*:/,
      `${label}: legacy timeout/sample/fallback result metadata is forbidden`);
  }

  // `setTimeout` and the named exact fallback are allowed because the page's
  // fallback is a deferred call to the same complete solver. The assertion is
  // intentionally about legacy result fields/calls, not unrelated scheduling.
  assert.match(pageSearchSource, /OPTIMIZER\.findBestPlan\s*\(/,
    "page fallback/worker path must call the shared exact solver");
  assert.match(pageSearchSource, /new WorkerConstructor\s*\(/,
    "page must retain the worker execution boundary");
  assert.match(workerSource, /findBestPlan\(input\.plans, input\.options,/,
    "worker must delegate to the shared optimizer rather than duplicate search logic");
});


// ---------------------------------------------------------------------------
// Search-state progress coverage (the UI still says combinations).

// **Validates: recursive search-state counting and progress delivery.**
test("search progress: counts visited search states and reports a terminal count", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const plans = [
    choicePlan("PROGRESS-A", [
      [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
      [{ day: 2, start: 8 * HOUR, end: 9 * HOUR }],
    ]),
    choicePlan("PROGRESS-B", [
      [{ day: 3, start: 10 * HOUR, end: 11 * HOUR }],
      [{ day: 4, start: 10 * HOUR, end: 11 * HOUR }],
    ]),
  ];
  const progress = [];
  const result = optimizer.findBestPlan(plans, { campus: 1 }, {
    onProgress(event) { progress.push(event); },
  });

  assert.equal(result.status, "OPTIMAL");
  assert.equal(result.complete, true);
  assert.ok(result.combinationsSearched >= 1);
  assert.equal(result.combinationsSearched, result.nodesVisited,
    "the compatibility-named count must equal visited search states");
  assert.equal(result.combinationsSearched, result.diagnostics.combinationsSearched);
  assert.ok(progress.length >= 2, "progress must include a first and terminal event");
  assert.equal(progress[0].combinationsSearched, 1);
  for (let index = 1; index < progress.length; index++) {
    assert.ok(
      progress[index].combinationsSearched >= progress[index - 1].combinationsSearched,
      "progress counts must be monotonic",
    );
  }
  const lastProgress = progress[progress.length - 1];
  assert.equal(lastProgress.done, true);
  assert.equal(lastProgress.combinationsSearched, result.combinationsSearched);

  const overlapping = [
    preservationCourse("PROGRESS-NO-A", [preservationSection("LEC1", "LEC", [
      { day: 1, start: 9 * HOUR, end: 10 * HOUR },
    ])]),
    preservationCourse("PROGRESS-NO-B", [preservationSection("LEC1", "LEC", [
      { day: 1, start: 9 * HOUR + HOUR / 2, end: 10 * HOUR + HOUR / 2 },
    ])]),
  ];
  const noSolutionProgress = [];
  const noSolution = optimizer.findBestPlan(
    optimizer.buildCoursePlans(overlapping, {}),
    { campus: 1 },
    { onProgress(event) { noSolutionProgress.push(event); } },
  );
  assert.equal(noSolution.status, "NO_SOLUTION");
  assert.ok(noSolution.combinationsSearched > 0);
  assert.equal(noSolution.combinationsSearched, noSolution.nodesVisited,
    "no-solution count must equal visited search states");
  assert.equal(noSolution.combinationsSearched, noSolution.diagnostics.combinationsSearched);
  assert.ok(noSolutionProgress.length >= 2,
    "no-solution progress must include a first and terminal event");
  assert.equal(noSolutionProgress[0].combinationsSearched, 1);
  const noSolutionLastProgress = noSolutionProgress[noSolutionProgress.length - 1];
  assert.equal(noSolutionLastProgress.done, true);
  assert.equal(noSolutionLastProgress.combinationsSearched, noSolution.combinationsSearched);
});

// **Validates: page progress rendering and final Worker count propagation.**
test("search progress: page displays live and final searched-combination text", () => {
  const page = task33SimplePage(true);
  const opts = { campus: 1, lunch: 0, early: 0, late: 0 };
  task33TriggerOptimize(page, opts);

  const initialStatus = vm.runInContext(
    "document.getElementById('status').textContent",
    page.context,
  );
  assert.equal(initialStatus, "Searched 0 combinations…");
  assert.equal(vm.runInContext("bestSoFar", page.context), null,
    "progress must not render an intermediate plan");

  page.eventLoop.flush();
  const state = vm.runInContext(`({
    plan: bestSoFar,
    result: bestSoFarResult,
    status: document.getElementById("status").textContent,
    timetable: document.getElementById("timetable").innerHTML,
  })`, page.context);
  assert.ok(state.plan);
  assert.ok(state.result.combinationsSearched >= 1);
  assert.match(state.status, /Built a timetable from/);
  assert.match(state.status, /Searched \d+ combinations\.$/);
  assert.notEqual(state.timetable, "");
});


// **Validates: cooperative fallback terminal equivalence.**
test("search progress: cooperative exact execution matches synchronous results", async () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const plans = [
    choicePlan("COOPERATIVE-A", [
      [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
      [{ day: 2, start: 8 * HOUR, end: 9 * HOUR }],
    ]),
    choicePlan("COOPERATIVE-B", [
      [{ day: 3, start: 10 * HOUR, end: 11 * HOUR }],
      [{ day: 4, start: 10 * HOUR, end: 11 * HOUR }],
    ]),
  ];
  const options = { campus: 1, lunch: 0, early: 0, late: 0 };
  const synchronous = optimizer.findBestPlan(plans, options);
  const progress = [];
  const cooperative = await optimizer.findBestPlan(plans, options, {
    cooperative: true,
    onProgress(event) { progress.push(event); },
    schedule(callback) { callback(); },
  });

  assert.equal(cooperative.status, synchronous.status);
  assert.equal(cooperative.complete, true);
  assert.equal(cooperative.optimal, true);
  assert.equal(cooperative.signature, synchronous.signature);
  assert.deepEqual(cooperative.evaluation, synchronous.evaluation);
  assert.deepEqual(cooperative.objective, synchronous.objective);
  assert.equal(cooperative.combinationsSearched, synchronous.combinationsSearched);
  assert.equal(progress[progress.length - 1].done, true);
  assert.equal(
    progress[progress.length - 1].combinationsSearched,
    cooperative.combinationsSearched,
  );
});
// ---------------------------------------------------------------------------
// Task 3 instructor-preference objective coverage.

function task3PreferenceOption(name, meetingValues, instructorRecords) {
  const meetings = (Array.isArray(meetingValues) ? meetingValues : [meetingValues])
    .map(meeting => ({ day: meeting.day, start: meeting.start, end: meeting.end }));
  const sourceSection = {
    name,
    teachMethod: "LEC",
    meetingTimes: meetings,
    instructors: instructorRecords || [],
  };
  return {
    lec: true,
    sec: { name: "LEC*" },
    ms: meetings,
    secs: meetings.map(() => name),
    lectureProvenance: meetings.map(meeting => ({
      meeting,
      sourceSection,
      sectionName: name,
    })),
  };
}

function task3PreferencePlan(code, preferredInstructors, options) {
  return [{
    code,
    name: code,
    preferredInstructors,
    locked: [],
    poolTypes: ["LEC"],
    combos: (options || []).map(option => [option]),
  }];
}

const task3Ada = { firstName: "Ada", lastName: "Lovelace" };
const task3Grace = { firstName: "Grace", lastName: "Hopper" };
const task3None = { campus: 0, lunch: 0, early: 0, late: 0 };

function task3AlignedPreferenceOption(name, meetingValues, instructorRecords) {
  const option = task3PreferenceOption(name, meetingValues, instructorRecords);
  const identities = (instructorRecords || []).map(record => {
    if (!record || typeof record !== "object") return "";
    const first = String(record.firstName || "").trim().replace(/\s+/g, " ").toLowerCase();
    const last = String(record.lastName || "").trim().replace(/\s+/g, " ").toLowerCase();
    return first && last ? `${first} ${last}` : "";
  }).filter(Boolean);
  option.lectureProvenance = option.lectureProvenance.map(entry => ({
    ...entry,
    instructors: identities.slice(),
  }));
  return option;
}

function task3OracleIdentity(value) {
  if (typeof value === "string")
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (!value || typeof value !== "object") return "";
  const first = String(value.firstName || "").trim().replace(/\s+/g, " ").toLowerCase();
  const last = String(value.lastName || "").trim().replace(/\s+/g, " ").toLowerCase();
  return first && last ? `${first} ${last}` : "";
}

function task3OraclePreferenceOutcome(course) {
  const rawPreferred = Array.isArray(course && course.preferredInstructors)
    ? course.preferredInstructors : [course && course.preferredInstructors];
  const preferred = new Set(rawPreferred.map(task3OracleIdentity).filter(Boolean));
  if (!preferred.size) return { active: false, matched: false, missed: 0 };

  let hasKnownInstructor = false;
  let matched = false;
  let missed = false;
  for (const item of (course && course.pick) || []) {
    if (!item || !item.lec) continue;
    for (const entry of Array.isArray(item.lectureProvenance)
      ? item.lectureProvenance : []) {
      const rawInstructors = Array.isArray(entry.instructors)
        ? entry.instructors
        : (entry.sourceSection && Array.isArray(entry.sourceSection.instructors)
          ? entry.sourceSection.instructors : []);
      const identities = rawInstructors.map(task3OracleIdentity).filter(Boolean);
      if (!identities.length) continue;
      hasKnownInstructor = true;
      if (identities.some(identity => preferred.has(identity))) matched = true;
      else missed = true;
    }
  }
  return {
    active: true,
    matched: matched && !missed,
    missed: hasKnownInstructor && missed ? 1 : 0,
  };
}

function task3OracleEvaluate(plan) {
  const schedule = evaluateReference(plan);
  let preferredCourseCount = 0;
  let matchedCourseCount = 0;
  let missedCourseCount = 0;
  for (const course of plan) {
    const outcome = task3OraclePreferenceOutcome(course);
    if (!outcome.active) continue;
    preferredCourseCount++;
    if (outcome.matched) matchedCourseCount++;
    missedCourseCount += outcome.missed;
  }
  return Object.assign({}, schedule, {
    preferredCourseCount,
    matchedCourseCount,
    missedCourseCount,
  });
}

function task3OracleCompare(left, right, opts, leftSignature, rightSignature) {
  if (opts.lunch && left.lunchDeficitMs !== right.lunchDeficitMs)
    return left.lunchDeficitMs < right.lunchDeficitMs ? -1 : 1;
  const leftSchedule = (opts.campus ? left.campusMs : 0) +
    (opts.early ? left.sumEndMs : 0) - (opts.late ? left.sumStartMs : 0);
  const rightSchedule = (opts.campus ? right.campusMs : 0) +
    (opts.early ? right.sumEndMs : 0) - (opts.late ? right.sumStartMs : 0);
  if (leftSchedule !== rightSchedule) return leftSchedule < rightSchedule ? -1 : 1;
  if (left.missedCourseCount !== right.missedCourseCount)
    return left.missedCourseCount < right.missedCourseCount ? -1 : 1;
  return leftSignature === rightSignature ? 0 : leftSignature < rightSignature ? -1 : 1;
}

function task3PreferenceOracle(plans, opts, optimizer) {
  const choices = plans.map(course => {
    const combos = course.poolTypes && course.poolTypes.length ? course.combos : [[]];
    return (combos || []).map(combo => ({
      code: course.code,
      name: course.name,
      preferredInstructors: course.preferredInstructors,
      pick: [...(course.locked || []), ...(Array.isArray(combo) ? combo : [])],
    })).filter(candidate => planIsClashFree([candidate]));
  });
  const chosen = [];
  let best = null;
  let feasibleCount = 0;

  function visit(index) {
    if (index === choices.length) {
      feasibleCount++;
      const plan = chosen.map(candidate => ({ ...candidate, pick: candidate.pick.slice() }));
      const evaluation = task3OracleEvaluate(plan);
      const signature = optimizer.planSignature(plan);
      if (!best || task3OracleCompare(
        evaluation, best.evaluation, opts, signature, best.signature,
      ) < 0) best = { plan, evaluation, signature };
      return;
    }
    for (const candidate of choices[index]) {
      const existing = eventList(chosen);
      if (eventList([candidate]).some(event =>
        existing.some(other => eventOverlap(event, other)))) continue;
      chosen.push(candidate);
      visit(index + 1);
      chosen.pop();
    }
  }

  visit(0);
  if (!best) throw new Error("HARNESS FAILURE: preference oracle found no feasible plan");
  return { ...best, feasibleCount };
}


test("Task 3: no preference deduplicates same-time lectures by events and keeps the stable minimum", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const sameTime = { day: 4, start: 9 * HOUR, end: 10 * HOUR };
  const first = preservationSection("LEC-A", "LEC", [sameTime]);
  first.instructors = [task3Ada];
  const second = preservationSection("LEC-Z", "LEC", [sameTime]);
  second.instructors = [task3Grace];
  const plans = optimizer.buildCoursePlans([{
    code: "EVENT-ONLY",
    name: "EVENT-ONLY",
    sections: [first, second],
  }], {});
  const result = optimizer.findBestPlan(plans, task3None);
  assert.equal(result.status, "OPTIMAL");
  assert.equal(result.plan[0].pick[0].lectureProvenance[0].sectionName, "LEC-A",
    "the lexicographically smallest full candidate must survive event-only deduplication");
  const legalSignatures = plans[0].combos.map(combo => optimizer.candidateSignature({
    code: plans[0].code,
    pick: combo,
  })).sort();
  assert.equal(optimizer.candidateSignature(result.plan[0]), legalSignatures[0]);
  assert.equal(result.signature, optimizer.planSignature(result.plan));
});


test("Task 3: instructor preference oracle remains exact across all objective flags", async () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const prefPlans = [
    task3PreferencePlan("ORACLE-A", [task3Ada], [
      task3AlignedPreferenceOption("A-MISS", { day: 1, start: 9 * HOUR, end: 10 * HOUR }, [task3Grace]),
      task3AlignedPreferenceOption("A-MATCH", { day: 1, start: 9 * HOUR, end: 10 * HOUR }, [task3Ada]),
      task3AlignedPreferenceOption("A-UNKNOWN", { day: 1, start: 11 * HOUR, end: 13 * HOUR }, [
        { displayName: "Unknown Instructor" },
      ]),
    ])[0],
    task3PreferencePlan("ORACLE-B", [task3Grace], [
      task3AlignedPreferenceOption("B-MISS", { day: 2, start: 9 * HOUR, end: 10 * HOUR }, [task3Ada]),
      task3AlignedPreferenceOption("B-MATCH", { day: 2, start: 9 * HOUR, end: 10 * HOUR }, [task3Grace]),
      task3AlignedPreferenceOption("B-UNKNOWN", { day: 2, start: 11 * HOUR, end: 13 * HOUR }, [
        { displayName: "Unknown Instructor" },
      ]),
    ])[0],
  ];
  const matched = task3OraclePreferenceOutcome({
    preferredInstructors: [task3Ada],
    pick: [prefPlans[0].combos[1][0]],
  });
  const missed = task3OraclePreferenceOutcome({
    preferredInstructors: [task3Ada],
    pick: [prefPlans[0].combos[0][0]],
  });
  const unknown = task3OraclePreferenceOutcome({
    preferredInstructors: [task3Ada],
    pick: [prefPlans[0].combos[2][0]],
  });
  assert.equal(matched.matched, true);
  assert.equal(missed.missed, 1);
  assert.equal(unknown.missed, 0);

  const signatures = new Set();
  for (let mask = 0; mask < 16; mask++) {
    const opts = {
      campus: (mask & 1) ? 1 : 0,
      lunch: (mask & 2) ? 1 : 0,
      early: (mask & 4) ? 1 : 0,
      late: (mask & 8) ? 1 : 0,
    };
    const oracle = task3PreferenceOracle(prefPlans, opts, optimizer);
    const synchronous = optimizer.findBestPlan(prefPlans, opts);
    const repeated = optimizer.findBestPlan(prefPlans, opts);
    assert.equal(synchronous.status, "OPTIMAL", `mask ${mask}: search must complete`);
    assert.equal(synchronous.signature, oracle.signature,
      `mask ${mask}: preference oracle stable signature mismatch`);
    assert.deepEqual(synchronous.evaluation, optimizer.evaluatePlan(synchronous.plan));
    assert.equal(synchronous.evaluation.preferredCourseCount, oracle.evaluation.preferredCourseCount);
    assert.equal(synchronous.evaluation.matchedCourseCount, oracle.evaluation.matchedCourseCount);
    assert.equal(synchronous.evaluation.missedCourseCount, oracle.evaluation.missedCourseCount);
    assert.deepEqual(synchronous.objective, optimizer.objectiveKey(synchronous.evaluation, opts));
    assert.equal(repeated.signature, synchronous.signature, `mask ${mask}: repeated signature changed`);

    const cooperative = await optimizer.findBestPlan(prefPlans, opts, {
      cooperative: true,
      schedule(callback) { callback(); },
    });
    assert.equal(cooperative.status, synchronous.status, `mask ${mask}: traversal status differs`);
    assert.equal(cooperative.signature, synchronous.signature, `mask ${mask}: traversal signature differs`);
    assert.deepEqual(cooperative.evaluation, synchronous.evaluation);
    assert.deepEqual(cooperative.objective, synchronous.objective);
    assert.equal(cooperative.combinationsSearched, synchronous.combinationsSearched,
      `mask ${mask}: traversal search count differs`);
    signatures.add(synchronous.signature);
  }
  assert.ok(signatures.size >= 1);
});


test("Task 3: instructor preference helper is canonical, one-course, and neutral when unknown", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const sameTime = { day: 2, start: 9 * HOUR, end: 10 * HOUR };
  const plans = task3PreferencePlan("PREF", [task3Ada], [
    task3PreferenceOption("LEC-GRACE", sameTime, [task3Grace]),
    task3PreferenceOption("LEC-ADA", sameTime, [task3Ada]),
  ]);
  const result = optimizer.findBestPlan(plans, task3None);
  assert.equal(result.status, "OPTIMAL");
  assert.equal(result.plan[0].preferredInstructors[0], "ada lovelace",
    "candidate result must retain normalized preferredInstructors");
  assert.equal(result.plan[0].pick[0].lectureProvenance[0].instructors[0], "ada lovelace",
    "the identical-time preferred lecture must win on the instructor tier");
  assert.deepEqual(optimizer.evaluateInstructorPreferences(result.plan), {
    preferredCourseCount: 1,
    matchedCourseCount: 1,
    missedCourseCount: 0,
  });
  assert.deepEqual(result.evaluation, optimizer.evaluatePlan(result.plan));
  assert.deepEqual(result.objective, optimizer.objectiveKey(result.evaluation, task3None));
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(result.objective, "missedCourseCount"),
    true,
    "active preference objectives must expose missedCourseCount",
  );
  assert.equal(result.evaluation.preferredCourseCount, 1);
  assert.equal(result.evaluation.matchedCourseCount, 1);
  assert.equal(result.evaluation.missedCourseCount, 0);

  const unknownOption = task3PreferenceOption("LEC-UNKNOWN", sameTime, [
    { displayName: "Unknown Instructor" },
  ]);
  const unknownPlan = task3PreferencePlan("UNKNOWN", [task3Ada], [unknownOption]);
  const unknownResult = optimizer.findBestPlan(unknownPlan, task3None);
  assert.deepEqual(optimizer.evaluateInstructorPreferences(unknownResult.plan), {
    preferredCourseCount: 1,
    matchedCourseCount: 0,
    missedCourseCount: 0,
  }, "active preference plus unknown source data must remain neutral");

  const noLecturePlan = [{
    code: "NO-LECTURE",
    preferredInstructors: [task3Ada],
    pick: [{ tm: "TUT", sec: { name: "TUT1" }, ms: [sameTime] }],
  }];
  assert.deepEqual(optimizer.evaluateInstructorPreferences(noLecturePlan), {
    preferredCourseCount: 1,
    matchedCourseCount: 0,
    missedCourseCount: 0,
  }, "excluded or absent lecture items must remain neutral");

  const checkedNamesForward = optimizer.findBestPlan(
    task3PreferencePlan("NAMES", [task3Ada, task3Grace], [
      task3PreferenceOption("LEC-ADA", sameTime, [task3Ada]),
      task3PreferenceOption("LEC-GRACE", sameTime, [task3Grace]),
    ]), task3None,
  );
  const checkedNamesReverse = optimizer.findBestPlan(
    task3PreferencePlan("NAMES", [task3Grace, task3Ada], [
      task3PreferenceOption("LEC-ADA", sameTime, [task3Ada]),
      task3PreferenceOption("LEC-GRACE", sameTime, [task3Grace]),
    ]), task3None,
  );
  assert.deepEqual(checkedNamesForward.evaluation, checkedNamesReverse.evaluation,
    "multiple checked names must be set-like and order-independent");
  assert.equal(checkedNamesForward.signature, checkedNamesReverse.signature);

  const noPreference = optimizer.findBestPlan(
    task3PreferencePlan("NO-PREFERENCE", [], [
      task3PreferenceOption("LEC-ADA", sameTime, [task3Ada]),
      task3PreferenceOption("LEC-GRACE", sameTime, [task3Grace]),
    ]), task3None,
  );
  assert.equal(noPreference.evaluation.preferredCourseCount, 0);
  assert.equal(noPreference.evaluation.matchedCourseCount, 0);
  assert.equal(noPreference.evaluation.missedCourseCount, 0);
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(noPreference.objective, "missedCourseCount"),
    false,
    "no-preference objectives must retain their historical shape",
  );

});


test("Task 3: campus, early, and late schedule tiers outrank instructor misses", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");

  const cases = [
    {
      name: "campus",
      options: { campus: 1, lunch: 0, early: 0, late: 0 },
      preferred: [
        { day: 1, start: 8 * HOUR, end: 9 * HOUR },
        { day: 2, start: 8 * HOUR, end: 9 * HOUR },
      ],
      other: [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
    },
    {
      name: "early",
      options: { campus: 0, lunch: 0, early: 1, late: 0 },
      preferred: [{ day: 1, start: 8 * HOUR, end: 12 * HOUR }],
      other: [{ day: 1, start: 8 * HOUR, end: 10 * HOUR }],
    },
    {
      name: "late",
      options: { campus: 0, lunch: 0, early: 0, late: 1 },
      preferred: [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
      other: [{ day: 1, start: 10 * HOUR, end: 11 * HOUR }],
    },
  ];

  for (const fixture of cases) {
    const result = optimizer.findBestPlan(
      task3PreferencePlan(`PRIORITY-${fixture.name}`, [task3Ada], [
        task3PreferenceOption("LEC-PREFERRED", fixture.preferred, [task3Ada]),
        task3PreferenceOption("LEC-OTHER", fixture.other, [task3Grace]),
      ]),
      fixture.options,
    );
    assert.equal(result.status, "OPTIMAL", `${fixture.name}: search must complete`);
    assert.equal(result.plan[0].pick[0].lectureProvenance[0].instructors[0], "grace hopper",
      `${fixture.name}: the better existing schedule objective must beat the preference`);
    assert.equal(result.evaluation.missedCourseCount, 1,
      `${fixture.name}: selected non-preferred known instructor must count one miss`);
    assert.equal(result.evaluation.matchedCourseCount, 0);
    assert.deepEqual(result.evaluation, optimizer.evaluatePlan(result.plan));
    assert.deepEqual(result.objective, optimizer.objectiveKey(result.evaluation, fixture.options));
  }
});


// ---------------------------------------------------------------------------
// "Make lecture instructors high priority" (strictInstructors option).
//
// When unchecked (default, options.strictInstructors falsy or absent), the
// tests above prove nothing changed: instructor preference remains the
// lowest-priority tier and a better campus/early/late/lunch outcome still
// wins. When checked, a course with an active preference may ONLY produce
// candidates that keep that preference; the generated timetable MUST use the
// preferred instructor for that course, even at a worse schedule cost, and
// falls through to the existing NO_SOLUTION contract if that is impossible.

test("Task 3 strict mode: preferred instructor overrides campus, early, and late tiers", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const cases = [
    {
      name: "campus",
      options: { campus: 1, lunch: 0, early: 0, late: 0, strictInstructors: 1 },
      preferred: [
        { day: 1, start: 8 * HOUR, end: 9 * HOUR },
        { day: 2, start: 8 * HOUR, end: 9 * HOUR },
      ],
      other: [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
    },
    {
      name: "early",
      options: { campus: 0, lunch: 0, early: 1, late: 0, strictInstructors: 1 },
      preferred: [{ day: 1, start: 8 * HOUR, end: 12 * HOUR }],
      other: [{ day: 1, start: 8 * HOUR, end: 10 * HOUR }],
    },
    {
      name: "late",
      options: { campus: 0, lunch: 0, early: 0, late: 1, strictInstructors: 1 },
      preferred: [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }],
      other: [{ day: 1, start: 10 * HOUR, end: 11 * HOUR }],
    },
  ];
  for (const fixture of cases) {
    const plans = task3PreferencePlan(`STRICT-${fixture.name}`, [task3Ada], [
      task3PreferenceOption("LEC-PREFERRED", fixture.preferred, [task3Ada]),
      task3PreferenceOption("LEC-OTHER", fixture.other, [task3Grace]),
    ]);
    const result = optimizer.findBestPlan(plans, fixture.options);
    assert.equal(result.status, "OPTIMAL", `${fixture.name}: strict search must complete`);
    assert.equal(result.plan[0].pick[0].lectureProvenance[0].instructors[0], "ada lovelace",
      `${fixture.name}: strict mode must select the preferred instructor regardless of schedule cost`);
    assert.equal(result.evaluation.missedCourseCount, 0,
      `${fixture.name}: strict mode must not miss the active preference`);
    assert.equal(result.evaluation.matchedCourseCount, 1);
    assert.deepEqual(result.evaluation, optimizer.evaluatePlan(result.plan));
    assert.deepEqual(result.objective, optimizer.objectiveKey(result.evaluation, fixture.options));

    // Repeat without strict mode using the identical fixture: this reproduces
    // the schedule-wins baseline, proving the flag alone caused the change.
    const relaxedOptions = Object.assign({}, fixture.options, { strictInstructors: 0 });
    const relaxed = optimizer.findBestPlan(plans, relaxedOptions);
    assert.equal(relaxed.plan[0].pick[0].lectureProvenance[0].instructors[0], "grace hopper",
      `${fixture.name}: disabling strict mode must restore the original schedule-first behavior`);
  }
});

test("Task 3 strict mode: preferred instructor overrides the lunch tier", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  // The preferred lecture spans the entire lunch window; the alternative
  // leaves a full free hour. Without strict mode, lunch (a dominant tier when
  // enabled) selects the non-preferred section.
  const plans = task3PreferencePlan("STRICT-lunch", [task3Ada], [
    task3PreferenceOption("LEC-PREFERRED",
      { day: 1, start: 11 * HOUR, end: 13 * HOUR }, [task3Ada]),
    task3PreferenceOption("LEC-OTHER",
      { day: 1, start: 8 * HOUR, end: 9 * HOUR }, [task3Grace]),
  ]);
  const lunchOptions = { campus: 0, lunch: 1, early: 0, late: 0 };

  const relaxed = optimizer.findBestPlan(plans, lunchOptions);
  assert.equal(relaxed.plan[0].pick[0].lectureProvenance[0].instructors[0], "grace hopper",
    "lunch must outrank the preference when strict mode is off");
  assert.equal(relaxed.evaluation.missedCourseCount, 1);

  const strict = optimizer.findBestPlan(plans, Object.assign({}, lunchOptions, {
    strictInstructors: 1,
  }));
  assert.equal(strict.status, "OPTIMAL");
  assert.equal(strict.plan[0].pick[0].lectureProvenance[0].instructors[0], "ada lovelace",
    "strict mode must select the preferred instructor even at the cost of the lunch gap");
  assert.equal(strict.evaluation.missedCourseCount, 0);
  assert.equal(strict.evaluation.lunchDeficitMs, HOUR,
    "strict mode is expected to accept the lost lunch hour to keep the preference");
});

test("Task 3 strict mode: courses without an active preference are unaffected", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const sameTime = { day: 2, start: 9 * HOUR, end: 10 * HOUR };
  const plans = task3PreferencePlan("STRICT-NO-PREF", [], [
    task3PreferenceOption("LEC-ADA", sameTime, [task3Ada]),
    task3PreferenceOption("LEC-GRACE", sameTime, [task3Grace]),
  ]);
  const strictNone = optimizer.findBestPlan(plans, Object.assign({}, task3None, {
    strictInstructors: 1,
  }));
  const relaxedNone = optimizer.findBestPlan(plans, task3None);
  assert.equal(strictNone.status, "OPTIMAL");
  assert.equal(strictNone.evaluation.preferredCourseCount, 0);
  assert.equal(strictNone.evaluation.matchedCourseCount, 0);
  assert.equal(strictNone.evaluation.missedCourseCount, 0);
  assert.equal(strictNone.signature, relaxedNone.signature,
    "enabling strict mode must not change a course with no active preference");
});

test("Task 3 strict mode: an unsatisfiable preference produces the complete NO_SOLUTION contract", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  // Both of Ada's lecture choices clash with the only Grace-free slot removed
  // below, so no candidate can keep the preference: strict mode must exhaust
  // the course rather than silently falling back to a non-preferred section.
  const plans = task3PreferencePlan("STRICT-IMPOSSIBLE", [task3Ada], [
    task3PreferenceOption("LEC-GRACE-ONLY",
      { day: 1, start: 9 * HOUR, end: 10 * HOUR }, [task3Grace]),
  ]);
  const strict = optimizer.findBestPlan(plans, Object.assign({}, task3None, {
    strictInstructors: 1,
  }));
  assert.deepEqual({
    plan: strict.plan,
    status: strict.status,
    complete: strict.complete,
    optimal: strict.optimal,
    evaluation: strict.evaluation,
    objective: strict.objective,
    score: strict.score,
    signature: strict.signature,
  }, {
    plan: null,
    status: "NO_SOLUTION",
    complete: true,
    optimal: true,
    evaluation: null,
    objective: null,
    score: null,
    signature: null,
  }, "strict mode must preserve the existing complete no-solution contract when the preference cannot be kept");
  assert.equal(strict.diagnostics.reason, "NO_FEASIBLE_CANDIDATE");
  assert.equal(strict.diagnostics.courseCode, "STRICT-IMPOSSIBLE");

  // The same fixture without strict mode must still return the existing
  // schedule-optimal (non-preferred) plan rather than a no-solution result.
  const relaxed = optimizer.findBestPlan(plans, task3None);
  assert.equal(relaxed.status, "OPTIMAL");
  assert.equal(relaxed.evaluation.missedCourseCount, 1);
});

test("Task 3 strict mode: multiple preferred courses must each keep their own instructor", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const coursePlansA = task3PreferencePlan("STRICT-MULTI-A", [task3Ada], [
    task3PreferenceOption("LEC-A-PREFERRED", { day: 1, start: 9 * HOUR, end: 10 * HOUR }, [task3Ada]),
    task3PreferenceOption("LEC-A-OTHER", { day: 1, start: 9 * HOUR, end: 10 * HOUR }, [task3Grace]),
  ]);
  const coursePlansB = task3PreferencePlan("STRICT-MULTI-B", [task3Grace], [
    task3PreferenceOption("LEC-B-PREFERRED", { day: 2, start: 9 * HOUR, end: 10 * HOUR }, [task3Grace]),
    task3PreferenceOption("LEC-B-OTHER", { day: 2, start: 9 * HOUR, end: 10 * HOUR }, [task3Ada]),
  ]);
  const plans = coursePlansA.concat(coursePlansB);
  const result = optimizer.findBestPlan(plans, Object.assign({}, task3None, {
    strictInstructors: 1,
  }));
  assert.equal(result.status, "OPTIMAL");
  const byCode = new Map(result.plan.map(course => [course.code, course]));
  assert.equal(
    byCode.get("STRICT-MULTI-A").pick[0].lectureProvenance[0].instructors[0],
    "ada lovelace",
  );
  assert.equal(
    byCode.get("STRICT-MULTI-B").pick[0].lectureProvenance[0].instructors[0],
    "grace hopper",
  );
  assert.equal(result.evaluation.missedCourseCount, 0);
  assert.equal(result.evaluation.matchedCourseCount, 2);
});

test("Task 3 strict mode: repeated searches remain deterministic", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const plans = task3PreferencePlan("STRICT-DETERMINISM", [task3Ada], [
    task3PreferenceOption("LEC-PREFERRED",
      [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }, { day: 2, start: 8 * HOUR, end: 9 * HOUR }],
      [task3Ada]),
    task3PreferenceOption("LEC-OTHER",
      [{ day: 1, start: 8 * HOUR, end: 9 * HOUR }], [task3Grace]),
  ]);
  const options = { campus: 1, lunch: 0, early: 0, late: 0, strictInstructors: 1 };
  const first = optimizer.findBestPlan(plans, options);
  const second = optimizer.findBestPlan(plans, options);
  assert.equal(first.status, "OPTIMAL");
  assert.equal(second.signature, first.signature,
    "repeated strict searches must select the same stable plan");
  assert.deepEqual(second.evaluation, first.evaluation);
  assert.deepEqual(second.objective, first.objective);
});

// **Validates: the page checkbox wires strictInstructors into every seam that**
// **already carries campus/lunch/early/late: selectedOptimizationOptions,**
// **bestSoFarInputKey cache invalidation, and the worker/render boundary.**
test("Task 3 strict mode: page checkbox reaches selectedOptimizationOptions, cache key, and render", () => {
  const optimizer = sharedOptimizerIfPresent();
  assert.ok(optimizer, "shared optimizer module must be available");
  const preferenceCourse = preservationCourse("STRICT-PAGE", [
    Object.assign(preservationSection("LEC-PREFERRED", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]), { instructors: [{ firstName: "Ada", lastName: "Lovelace" }] }),
    Object.assign(preservationSection("LEC-OTHER", "LEC", [
      { day: 1, start: 8 * HOUR, end: 9 * HOUR },
    ]), { instructors: [{ firstName: "Grace", lastName: "Hopper" }] }),
  ]);
  const page = makeInlinePageHarness().installDeterministicWorker();
  page.installCourses([preferenceCourse]);
  page.renderCourses();
  const adaBox = task4InstructorBoxes(page).find(box => box.dataset.instructor === "ada lovelace");
  assert.ok(adaBox, "the preference control must be rendered");
  adaBox.checked = true;
  page.elements.get("courseList").onchange({ target: adaBox });

  const optionsOff = vm.runInContext("selectedOptimizationOptions()", page.context);
  assert.equal(optionsOff.strictInstructors, 0,
    "the strict checkbox must default to unchecked and report 0");

  vm.runInContext(
    "document.getElementById('optStrictInstructors').checked = true;",
    page.context,
  );
  const optionsOn = vm.runInContext("selectedOptimizationOptions()", page.context);
  assert.equal(optionsOn.strictInstructors, 1,
    "checking the new checkbox must report strictInstructors: 1");

  const plans = page.selectedPlans();
  const keyOff = vm.runInContext(
    `bestSoFarInputKey(selectedPlan(), ${JSON.stringify(optionsOff)})`,
    page.context,
  );
  const keyOn = vm.runInContext(
    `bestSoFarInputKey(selectedPlan(), ${JSON.stringify(optionsOn)})`,
    page.context,
  );
  assert.notEqual(keyOn, keyOff,
    "toggling strict mode must invalidate any cumulative cached result");

  const displayed = preservationRunPageOptimize(page, optionsOn, [0.5]);
  assert.equal(displayed.plan[0].pick.find(item => item.lec)
    .lectureProvenance[0].instructors[0], "ada lovelace",
    "the page must render the strictly preferred instructor once the checkbox is on");
  assert.notEqual(displayed.timetable, "");

  const directResult = optimizer.findBestPlan(plans, optionsOn);
  assert.equal(directResult.evaluation.missedCourseCount, 0);
});
