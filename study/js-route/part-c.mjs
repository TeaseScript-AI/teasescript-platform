// Part C's measurements (research code of the study): for each Tease, both ways of continuing, driven wait by wait at
// each wait's deadline: the time of each drive against the number of waits passed, the save's size, and whether the
// result equals today's uninterrupted run.
//   node study/js-route/part-c.mjs FILE.tease...   (prints one JSON line per file and way)
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { compileSource, createFreshRuntimeSession } from "../../dist/src/index.js";
import { createEmittedSession, createGeneratorSession, createResumableSession } from "./driver.mjs";

const FRESH = { seed: 20260713, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
const MARKS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

function drive(session, state) {
  const times = [];
  const events = [];
  let t0 = performance.now();
  events.push(...session.run({ instructionBudget: 2e9 }).events);
  times.push(performance.now() - t0);
  for (let n = 0; n < 5000; n += 1) {
    const s = state();
    const action = s.foregroundAction;
    if (s.status !== "waiting" || action === null || action.deadlineMs === undefined) break;
    t0 = performance.now();
    events.push(...session.observeTime(action.deadlineMs).events);
    events.push(...session.run({ instructionBudget: 2e9 }).events);
    times.push(performance.now() - t0);
  }
  const s = state();
  return { times, said: events.filter((e) => e.kind === "say").map((e) => JSON.stringify(e.content)), status: s.status, rng: s.rng.state, failure: s.failure };
}

for (const file of process.argv.slice(2)) {
  const plan = compileSource(fs.readFileSync(file, "utf8")).plan;
  const today = createFreshRuntimeSession(plan, FRESH);
  const expected = drive(today, () => today.exportSnapshot());
  const ways = (process.env.WAYS ?? "replay,generators,resumable").split(",");
  for (const way of ways) {
    const session = way === "replay" ? createEmittedSession(plan, FRESH) : way === "generators" ? createGeneratorSession(plan, FRESH) : createResumableSession(plan, FRESH);
    let largestSave = 0;
    if (way === "resumable") {
      const run = session.run.bind(session);
      session.run = (o) => { const r = run(o); largestSave = Math.max(largestSave, session.save?.length ?? 0); return r; };
    }
    const actual = drive(session, () => session.state);
    const same = JSON.stringify([expected.said, expected.status, expected.rng]) === JSON.stringify([actual.said, actual.status, actual.rng]);
    const at = Object.fromEntries(MARKS.filter((m) => m < actual.times.length).map((m) => [m, Math.round(actual.times[m] * 1000) / 1000]));
    const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 10) / 10;
    console.log(JSON.stringify({ file: path.basename(file), way, same, waits: actual.times.length - 1, totalMs: sum(actual.times), todayTotalMs: sum(expected.times), driveMsAtWait: at, lastDriveMs: Math.round((actual.times.at(-1) ?? 0) * 1000) / 1000, maxDriveMs: Math.round(Math.max(...actual.times) * 1000) / 1000, largestSave, failure: actual.failure?.message?.slice(0, 120) ?? null }));
  }
}
