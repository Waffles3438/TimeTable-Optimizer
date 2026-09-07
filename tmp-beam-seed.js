"use strict";
const fs = require("node:fs");
const o = require("./web/optimizer.js");
const raw = JSON.parse(fs.readFileSync("web/data/computer-1-fall.json", "utf8"));
const plans = o.buildCoursePlans(raw, {
  locks: [
    { code: "APS100H1", tm: "TUT", sec: "TUT0106" },
    { code: "APS111H1", tm: "TUT", sec: "TUT0106" },
    { code: "MAT188H1", tm: "PRA", sec: "PRA0103" },
  ],
  uselessTut: new Set(["APS110H1"]),
});
function candidateFor(course, combo) {
  return { code: course.code, name: course.name, pick: [...(course.locked || []), ...combo] };
}
const entries = plans.map(course => {
  const combos = course.poolTypes.length ? course.combos : [[]];
  const unique = new Map();
  for (const rawCombo of combos || []) {
    const combo = Array.isArray(rawCombo) ? rawCombo : [];
    const candidate = candidateFor(course, combo);
    if (!o.isClashFree([candidate])) continue;
    const key = o.candidateSignature(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return { course, candidates: Array.from(unique.values()).sort((a, b) =>
    o.candidateSignature(a).localeCompare(o.candidateSignature(b))) };
});
function compareScores(a, b) {
  return a.e.lunchDeficitMs - b.e.lunchDeficitMs ||
    a.e.campusMs - b.e.campusMs ||
    a.e.activeDays - b.e.activeDays ||
    a.e.gapsMs - b.e.gapsMs ||
    o.planSignature(a.plan).localeCompare(o.planSignature(b.plan));
}
function run(order, width) {
  let beam = [{ plan: [], e: o.evaluatePlan([]) }];
  for (const entry of order) {
    const next = [];
    for (const state of beam) {
      for (const candidate of entry.candidates) {
        const plan = [...state.plan, candidate];
        if (!o.isClashFree(plan)) continue;
        const e = o.evaluatePlan(plan);
        if (e.lunchDeficitMs !== 0) continue;
        next.push({ plan, e });
      }
    }
    next.sort(compareScores);
    beam = next.slice(0, width);
    console.log(JSON.stringify({entry: entry.course.code, width, feasible: next.length, kept: beam.length,
      best: beam[0] && {campus: beam[0].e.campusMs, days: beam[0].e.activeDays, gaps: beam[0].e.gapsMs}}));
    if (!beam.length) return null;
  }
  return beam[0];
}
const orders = [
  entries.slice().sort((a, b) => b.candidates.length - a.candidates.length),
  entries.slice().sort((a, b) => a.candidates.length - b.candidates.length),
  entries.slice().sort((a, b) => a.course.code.localeCompare(b.course.code)),
  ["MAT188H1", "APS100H1", "APS111H1", "APS110H1", "CIV100H1", "MAT186H1"].map(code =>
    entries.find(entry => entry.course.code === code)),
];
for (const [index, order] of orders.entries()) {
  console.log(JSON.stringify({order: index, courses: order.map(entry => entry.course.code)}));
  for (const width of [32, 128, 512]) {
    const start = Date.now();
    const result = run(order, width);
    console.log(JSON.stringify({order: index, width, ms: Date.now() - start,
      result: result && {campus: result.e.campusMs, days: result.e.activeDays, gaps: result.e.gapsMs,
        signature: o.planSignature(result.plan)}}));
  }
}
