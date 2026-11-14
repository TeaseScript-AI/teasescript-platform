// Part F's two probes (research code of the study).
// Stops: today's engine executes one instruction at a time; the debug program (generator form, `stops`) ends its drive
// at every statement. Both must stop at the same statements in the same order and end the same.
// Rewind: at every wait of a play, today's snapshot and the program's restore point are kept; rewinding to each, then
// answering otherwise there, must go on as today's engine restored from its snapshot does. Restore points: the
// resumable form's save, and replay's recorded operations cut at that wait.
//   node study/js-route/debug-probe.mjs FILE.tease   (prints one JSON line per probe)
import fs from "node:fs";
import path from "node:path";
import { compileSource, createFreshRuntimeSession, createRuntimeSession } from "../../dist/src/index.js";
import { createEmittedSession, createGeneratorSession, createResumableSession } from "./driver.mjs";
import { STOP_EXCLUDED } from "./emit.mjs";

const FRESH = { seed: 20260713, wallClockMs: Date.UTC(2026, 6, 13, 9, 0, 0) };
const PLACE = new Set(["ownerCallFrameId", "scopeDepth", "loopDepth", "rootScopeId"]);
const view = (state, result) =>
  JSON.parse(
    JSON.stringify({ events: result.events, status: state.status, failure: state.failure, foreground: state.foregroundAction, rng: state.rng }),
    (key, value) => (PLACE.has(key) ? undefined : value),
  );

/** The host's next operation at a wait; `answers` picks the choice index and the typed text. */
function nextOperation(state, answers) {
  const action = state.foregroundAction;
  if (state.status !== "waiting" || action === null) return null;
  if (action.kind === "chatPacingGate" || action.kind === "delay") return { kind: "time", nowMs: action.deadlineMs };
  if (action.kind !== "interaction") return null;
  const base = { actionId: action.actionId, actionKind: "interaction", interactionKind: action.interactionKind };
  if (action.interactionKind === "choice") return { kind: "complete", request: { ...base, payload: { kind: "selectedOption", optionIndex: answers.choice } } };
  if (action.interactionKind === "number" || action.interactionKind === "text")
    return { kind: "complete", request: { ...base, payload: { kind: "submittedText", submittedText: answers.text } } };
  return null;
}
const apply = (session, operation) =>
  operation.kind === "time" ? session.observeTime(operation.nowMs) : session.completeAction(operation.request);

/** Plays to the end: run, then at each wait the host's operation and a run. `atWait` sees each wait first. */
function play(session, state, answers, atWait = () => {}) {
  const out = [view(state(), session.run())];
  for (let n = 0; n < 500; n += 1) {
    const operation = nextOperation(state(), answers);
    if (operation === null) break;
    atWait(n);
    out.push(view(state(), apply(session, operation)));
    out.push(view(state(), session.run()));
  }
  return out;
}
const said = (outs) => outs.flatMap((o) => o.events.filter((e) => e.kind === "say").map((e) => JSON.stringify(e.content)));

const A = { choice: 0, text: "1" };
const B = { choice: 1, text: "7" };

for (const file of process.argv.slice(2)) {
  const plan = compileSource(fs.readFileSync(file, "utf8")).plan;
  const name = path.basename(file);

  // Stops.
  const today = createFreshRuntimeSession(plan, FRESH);
  const todayStops = [];
  const todayEvents = [];
  for (let n = 0; n < 1e5; n += 1) {
    const s = today.exportSnapshot();
    if (s.status === "halted" || s.status === "failed") break;
    if (s.status === "waiting") {
      const operation = nextOperation(s, A);
      if (operation === null) break;
      todayEvents.push(...apply(today, operation).events);
      continue;
    }
    if (!STOP_EXCLUDED.has(plan.instructions[s.nextInstruction].kind)) todayStops.push(s.nextInstruction);
    todayEvents.push(...today.executeInstruction().events);
  }
  const debug = createGeneratorSession(plan, FRESH, { stops: true, stopping: true });
  const debugEvents = [];
  let drives = 0;
  for (let n = 0; n < 1e5; n += 1) {
    const s = debug.state;
    if (s.status === "halted" || s.status === "failed") break;
    if (s.status === "waiting") {
      const operation = nextOperation(s, A);
      if (operation === null) break;
      debugEvents.push(...apply(debug, operation).events);
    }
    debugEvents.push(...debug.run().events);
    drives += 1;
  }
  const firstStopDifference = todayStops.findIndex((pc, i) => debug.stops[i] !== pc);
  console.log(JSON.stringify({
    file: name, probe: "stops",
    sameStops: JSON.stringify(todayStops) === JSON.stringify(debug.stops),
    stops: todayStops.length, debugStops: debug.stops.length, drives, missedStops: debug.missedStops,
    firstStopDifference: firstStopDifference < 0 ? null : { at: firstStopDifference, today: todayStops[firstStopDifference], debug: debug.stops[firstStopDifference] },
    sameEnd: JSON.stringify([said([{ events: todayEvents }]), today.exportSnapshot().status, today.exportSnapshot().rng])
      === JSON.stringify([said([{ events: debugEvents }]), debug.state.status, debug.state.rng]),
  }));

  // Rewind.
  const reference = createFreshRuntimeSession(plan, FRESH);
  const snapshots = [];
  play(reference, () => reference.exportSnapshot(), A, () => snapshots.push(reference.exportSnapshot()));
  const resumable = createResumableSession(plan, FRESH);
  const saves = [];
  play(resumable, () => resumable.state, A, () => saves.push(resumable.save));
  const replay = createEmittedSession(plan, FRESH);
  play(replay, () => replay.state, A);
  const recorded = replay.operations;
  const points = [];
  for (let k = 0; k < snapshots.length; k += 1) {
    const back = createRuntimeSession(plan, snapshots[k]);
    const again = createRuntimeSession(plan, snapshots[k]);
    const expected = play(back, () => back.exportSnapshot(), B);
    const fromSave = createResumableSession(plan, FRESH);
    fromSave.load(saves[k]);
    const viaSave = play(fromSave, () => fromSave.state, B);
    const fromReplay = createEmittedSession(plan, FRESH);
    fromReplay.operations = recorded.slice(0, k);
    fromReplay.run();
    const viaReplay = play(fromReplay, () => fromReplay.state, B);
    // The first run of a restored session gives no events (it waits); a replay's first run rebuilds the past and gives
    // its events, so only the operations after it are compared.
    points.push({
      wait: k,
      resumable: JSON.stringify(expected) === JSON.stringify(viaSave),
      replay: JSON.stringify(expected.slice(1)) === JSON.stringify(viaReplay.slice(1)),
      saveBytes: saves[k]?.length ?? 0,
      branched: JSON.stringify(said(expected)) !== JSON.stringify(said(play(again, () => again.exportSnapshot(), A))),
    });
  }
  console.log(JSON.stringify({ file: name, probe: "rewind", points: points.length, resumableSame: points.filter((p) => p.resumable).length,
    replaySame: points.filter((p) => p.replay).length, branched: points.filter((p) => p.branched).length, largestSave: Math.max(0, ...points.map((p) => p.saveBytes)),
    detail: points.map((p) => `${p.wait}:${p.resumable ? "R" : "r"}${p.replay ? "P" : "p"}`).join(" ") }));
}
