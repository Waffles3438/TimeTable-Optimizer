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
function typeOf(item) {
  if (item && item.lec) return "LEC";
  return String(item && (item.tm || item.teachMethod || item.type ||
    (item.sec && (item.sec.teachMethod || item.sec.type || item.sec.tm)) || ""));
}
function meetingsOf(item) { return (item && (item.ms || item.meetingTimes || [])) || []; }
function keyOf(candidate) {
  return candidate.pick.map(item => `${typeOf(item)}:${meetingsOf(item).map(m =>
    `${m.day}:${m.start}:${m.end}`).sort().join(",")}`).sort().join("|");
}
const entries = plans.map(course => {
  const combos = course.poolTypes.length ? course.combos : [[]];
  const unique = new Map();
  for (const combo of combos || []) {
    const candidate = { code: course.code, name: course.name,
      pick: [...(course.locked || []), ...(combo || [])] };
    if (!o.isClashFree([candidate])) continue;
    const key = keyOf(candidate);
    const previous = unique.get(key);
    if (!previous || o.planSignature(candidate) < o.planSignature(previous))
      unique.set(key, candidate);
  }
  return { course, candidates: Array.from(unique.values()).sort((a, b) =>
    o.planSignature(a).localeCompare(o.planSignature(b))) };
});
const targets = {
  APS100H1: "APS100H1[LEC:LEC*:LEC0103:4:57600000:61200000;TUT:TUT0106::1:36000000:39600000]",
  APS110H1: "APS110H1[LEC:LEC*:LEC0104,LEC0104,LEC0104:2:54000000:57600000,3:54000000:57600000,5:54000000:57600000]",
  APS111H1: "APS111H1[LEC:LEC*:LEC0103,LEC0103,LEC0103:1:57600000:61200000,3:57600000:61200000,5:57600000:61200000;TUT:TUT0106::2:46800000:54000000]",
  CIV100H1: "CIV100H1[LEC:LEC*:LEC0104,LEC0106,LEC0101:2:57600000:61200000,3:46800000:50400000,5:61200000:64800000;TUT:TUT0113::5:46800000:54000000]",
  MAT186H1: "MAT186H1[LEC:LEC*:LEC0109,LEC0107,LEC0107:1:61200000:64800000,3:61200000:64800000,4:61200000:64800000;TUT:TUT0121::1:50400000:54000000]",
  MAT188H1: "MAT188H1[LEC:LEC*:LEC0108,LEC0109,LEC0102:1:54000000:57600000,3:50400000:54000000,5:43200000:46800000;PRA:PRA0103::1:39600000:43200000;TUT:TUT0118::1:46800000:50400000]",
};
const base = entries.map(entry => {
  const candidate = entry.candidates.find(c => o.planSignature(c) === targets[entry.course.code]);
  if (!candidate) throw new Error(`base candidate missing: ${entry.course.code}`);
  return candidate;
});
let best = { plan: base, e: o.evaluatePlan(base) };
console.log(JSON.stringify({counts:entries.map(e=>[e.course.code,e.candidates.length]),base:best.e}));
const wanted = [
  ["APS100H1", "CIV100H1", "MAT186H1"],
  ["APS100H1", "CIV100H1", "MAT188H1"],
  ["APS110H1", "CIV100H1", "MAT188H1"],
  ["APS111H1", "CIV100H1", "MAT188H1"],
  ["CIV100H1", "MAT186H1", "MAT188H1"],
  ["APS110H1", "MAT186H1", "MAT188H1"],
  ["APS111H1", "MAT186H1", "MAT188H1"],
];
for (const codes of wanted) {
  const selected = entries.filter(e => codes.includes(e.course.code));
  const fixed = best.plan.filter(plan => !codes.includes(String(plan.code)));
  const lists = selected.map(entry => {
    const list = entry.candidates.filter(candidate => {
      const plan = [...fixed, candidate];
      return o.isClashFree(plan) && o.evaluatePlan(plan).lunchDeficitMs === 0;
    });
    list.sort((a, b) => {
      const ea = o.evaluatePlan([...fixed, a]);
      const eb = o.evaluatePlan([...fixed, b]);
      return ea.campusMs - eb.campusMs || o.planSignature(a).localeCompare(o.planSignature(b));
    });
    return list;
  });
  console.log(JSON.stringify({codes,counts:lists.map(x=>x.length)}));
  let checks = 0;
  let found = null;
  for (const a of lists[0]) {
    const partialA = [...fixed, a];
    const ea = o.evaluatePlan(partialA);
    if (ea.activeDays > 5) continue;
    for (const b of lists[1]) {
      const partialB = [...partialA, b];
      if (!o.isClashFree(partialB)) continue;
      const eb = o.evaluatePlan(partialB);
      if (eb.activeDays > 5) continue;
      for (const c of lists[2]) {
        if (++checks > 2000000) break;
        const plan = [...partialB, c];
        if (!o.isClashFree(plan)) continue;
        const e = o.evaluatePlan(plan);
        if (e.lunchDeficitMs === 0 && e.campusMs < best.e.campusMs) {
          found = {plan, e};
          break;
        }
      }
      if (found || checks > 2000000) break;
    }
    if (found || checks > 2000000) break;
  }
  if (found) {
    best = found;
    console.log(JSON.stringify({improved:true,codes,checks,best:best.e,signature:o.planSignature(best.plan)}));
  } else {
    console.log(JSON.stringify({improved:false,codes,checks}));
  }
}
console.log(JSON.stringify({final:best.e,signature:o.planSignature(best.plan)}));
