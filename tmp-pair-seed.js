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
function meetingsOf(item) {
  return (item && (item.ms || item.meetingTimes || [])) || [];
}
function keyOf(candidate) {
  return candidate.pick.map(item => `${typeOf(item)}:${meetingsOf(item).map(m =>
    `${m.day}:${m.start}:${m.end}`).sort().join(",")}`).sort().join("|");
}
const entries = plans.map(course => {
  const combos = course.poolTypes.length ? course.combos : [[]];
  const unique = new Map();
  for (const combo of combos || []) {
    const candidate = {
      code: course.code, name: course.name,
      pick: [...(course.locked || []), ...(combo || [])]
    };
    if (!o.isClashFree([candidate])) continue;
    const key = keyOf(candidate);
    const previous = unique.get(key);
    if (!previous || o.planSignature(candidate) < o.planSignature(previous))
      unique.set(key, candidate);
  }
  return {
    course, candidates: Array.from(unique.values()).sort((a, b) =>
      o.planSignature(a).localeCompare(o.planSignature(b)))
  };
});
const targets = {
  APS100H1: "APS100H1[LEC:LEC*:LEC0103:4:57600000:61200000;TUT:TUT0106::1:36000000:39600000]",
  APS110H1: "APS110H1[LEC:LEC*:LEC0104,LEC0104,LEC0104:2:54000000:57600000,3:54000000:57600000,5:54000000:57600000]",
  APS111H1: "APS111H1[LEC:LEC*:LEC0103,LEC0103,LEC0103:1:57600000:61200000,3:57600000:61200000,5:57600000:61200000;TUT:TUT0106::2:46800000:54000000]",
  CIV100H1: "CIV100H1[LEC:LEC*:LEC0107,LEC0108,LEC0108:2:43200000:46800000,3:43200000:46800000,5:50400000:54000000;TUT:TUT0121::3:32400000:39600000]",
  MAT186H1: "MAT186H1[LEC:LEC*:LEC0109,LEC0107,LEC0107:1:61200000:64800000,3:61200000:64800000,4:61200000:64800000;TUT:TUT0121::1:50400000:54000000]",
  MAT188H1: "MAT188H1[LEC:LEC*:LEC0108,LEC0109,LEC0108:1:54000000:57600000,3:50400000:54000000,4:54000000:57600000;PRA:PRA0103::1:39600000:43200000;TUT:TUT0120::5:32400000:36000000]",
};
let base = entries.map(entry => {
  const candidate = entry.candidates.find(c => o.planSignature(c) === targets[entry.course.code]);
  if (!candidate) throw new Error(`base candidate missing: ${entry.course.code}`);
  return candidate;
});
function better(left, right) {
  return left.e.lunchDeficitMs < right.e.lunchDeficitMs ||
    (left.e.lunchDeficitMs === right.e.lunchDeficitMs && left.e.campusMs < right.e.campusMs);
}
console.log(JSON.stringify({
  counts: entries.map(e => [e.course.code, e.candidates.length]),
  base: o.evaluatePlan(base)
}));
let best = { plan: base, e: o.evaluatePlan(base) };
for (let pass = 0; pass < 2; pass++) {
  let changed = false;
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const leftCode = entries[i].course.code;
      const rightCode = entries[j].course.code;
      const fixed = best.plan.filter(plan =>
        plan.code !== leftCode && plan.code !== rightCode);
      const first = entries[i].candidates.filter(c => o.isClashFree([...fixed, c]) &&
        o.evaluatePlan([...fixed, c]).lunchDeficitMs === 0);
      const second = entries[j].candidates.filter(c => o.isClashFree([...fixed, c]) &&
        o.evaluatePlan([...fixed, c]).lunchDeficitMs === 0);
      console.log(JSON.stringify({ pass, pair: [entries[i].course.code, entries[j].course.code], first: first.length, second: second.length }));
      let found = null;
      for (const left of first) {
        for (const right of second) {
          const plan = [...fixed, left, right];
          if (!o.isClashFree(plan)) continue;
          const e = o.evaluatePlan(plan);
          if (e.lunchDeficitMs !== 0) continue;
          if (better({ e }, best)) { found = { plan, e }; break; }
        }
        if (found) break;
      }
      if (found) {
        best = found;
        changed = true;
        console.log(JSON.stringify({ improved: true, pass, pair: [entries[i].course.code, entries[j].course.code], e: best.e, signature: o.planSignature(best.plan) }));
      }
    }
  }
  if (!changed) break;
}
console.log(JSON.stringify({ final: best.e, signature: o.planSignature(best.plan) }));
