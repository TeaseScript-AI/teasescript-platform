// Part C: a session of republish-a.tease stopped at its fourth wait, continued by the program of republish-b.tease
// (the Tease published again), in the replay way and the resumable way; prints what each continuation shows.
import fs from "node:fs";
import { compileSource } from "../../dist/src/index.js";
import { createEmittedSession, createResumableSession } from "./driver.mjs";
const FRESH = { seed: 7, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
const planOf = (name) => compileSource(fs.readFileSync(new URL(`./probes/${name}`, import.meta.url), "utf8")).plan;
const [a, b] = [planOf("republish-a.tease"), planOf("republish-b.tease")];
const said = (events) => events.filter((e) => e.kind === "say" || e.kind === "runtimeFailure").map((e) => e.content?.blocks?.[0]?.lines?.[0]?.text ?? `${e.kind}: ${e.failure?.message ?? e.message ?? ""}`.slice(0, 160));
function play(session, waits, out) {
  out.push(...said(session.run().events));
  for (let n = 0; n < waits && session.state.status === "waiting"; n += 1) {
    out.push(...said(session.observeTime(session.state.foregroundAction.deadlineMs).events));
    out.push(...said(session.run().events));
  }
  return out;
}
const result = {};
for (const way of ["replay", "resumable"]) {
  const create = way === "replay" ? createEmittedSession : createResumableSession;
  const first = create(a, FRESH);
  const before = play(first, 3, []);
  const second = create(b, FRESH);
  if (way === "replay") second.operations = first.operations;
  else second.load(first.save);
  let after;
  try {
    after = play(second, 10, []);
  } catch (error) {
    after = [`thrown: ${String(error?.message ?? error).slice(0, 160)}`];
  }
  result[way] = { before, after, status: second.state.status, failure: second.state.failure?.message?.slice(0, 160) ?? null };
}
console.log(JSON.stringify(result, null, 1));
