// The report's derivation: every field of a sample derived again from the raw records the row kept, with the same
// functions the scenarios measure with (`lib/measure.mjs`, `scenarios/keep.mjs`, `scenarios/taps.mjs`), never read
// from the row's own summaries (`reviews/l5-gate/field-inventory.md`). A record that is missing, empty where it must
// hold events, or that does not give its field is a problem, and a sample with a problem is incomplete.
import {
  firstSave,
  playable,
  requestsOf,
  turnTimes,
  workerSideOf,
  workerStart,
} from "./lib/measure.mjs";
import { keepOutcome } from "./scenarios/keep.mjs";
import { tapCounts } from "./scenarios/taps.mjs";

const list = Array.isArray;
/** A page's probe records, as `readGate` returns them. */
const probeRecords = (gate) =>
  gate !== null &&
  typeof gate === "object" &&
  ["states", "inputs", "changes", "rows", "rowChanges", "transactions", "workers", "gaps"].every(
    (name) => list(gate[name]),
  );
const onCdp = (cell) => cell.engine === "chromium" || cell.engine === "pixel";

/** The fields of a session sample, derived from its probe records, its turn records, heap readings and requests. */
function session(result, cell, problems) {
  const need = (holds, what) => {
    if (!holds) problems.push(what);
  };
  const cold = result.probe?.cold;
  const repeat = result.probe?.repeat;
  need(probeRecords(cold) && probeRecords(repeat), "the probe's records of both pages");
  const coldPlayable = probeRecords(cold)
    ? playable(cold, "Start")
    : { ok: false, reason: "no records" };
  const repeatPlayable = probeRecords(repeat)
    ? playable(repeat, "Continue")
    : { ok: false, reason: "no records" };
  need(coldPlayable.ok, `cold playable: ${coldPlayable.reason}`);
  need(repeatPlayable.ok, `repeat playable: ${repeatPlayable.reason}`);
  const save = coldPlayable.ok ? firstSave(cold, coldPlayable.inputMs) : null;
  need(
    save?.ok === true,
    `first save: ${save?.reason ?? save?.outcome ?? "no playable cold page"}`,
  );
  const worker = probeRecords(cold) ? workerStart(cold) : null;
  if (cell.backend === "worker") need(worker?.readyMs != null, "the engine Worker reaching ready");
  const turns = (result.turns ?? []).map((turn) =>
    typeof turn.sentAt !== "number" || turn.before === undefined || !probeRecords(repeat)
      ? { ok: false, reason: turn.reason ?? "no records of the turn" }
      : turnTimes(repeat, turn.sentAt, turn.before, turn.end ?? null),
  );
  need(turns.length > 0, "a turn");
  turns.forEach((turn, index) => need(turn.ok, `turn ${index}: ${turn.reason}`));
  return {
    cold: coldPlayable,
    repeat: repeatPlayable,
    firstSave: save,
    worker,
    turns,
    memory: list(result.memory) ? result.memory : [],
    bytes: result.bytes,
  };
}

/** The instrumented cohort's diagnostics, derived from the raw bridge logs and the injected Worker logs. */
function diagnostics(result, cell, sample, problems) {
  const logs = result.diagnostics?.bridgeLogs;
  if (!(list(logs?.cold) && list(logs?.repeat))) {
    problems.push("the instrumented port's logs of both pages");
    return null;
  }
  const cold = requestsOf(logs.cold);
  const repeat = requestsOf(logs.repeat);
  if (!cold.some((request) => request.op === "start" && request.replyAt !== null))
    problems.push("a start request with its reply in the cold log");
  let workerSide = null;
  if (onCdp(cell) && cell.backend === "worker") {
    const workerLogs = result.diagnostics?.workerLogs;
    const origins = result.diagnostics?.timeOrigins;
    if (
      list(workerLogs?.cold) &&
      list(workerLogs?.repeat) &&
      Number.isFinite(origins?.cold) &&
      Number.isFinite(origins?.repeat)
    )
      workerSide = {
        cold: workerSideOf(workerLogs.cold, cold, origins.cold),
        repeat: workerSideOf(workerLogs.repeat, repeat, origins.repeat),
      };
    else problems.push("the engine Worker's injected logs with both pages' clock origins");
  }
  return {
    cold,
    repeat,
    workerSide,
    turns: sample.turns.map((turn) =>
      turn.ok && turn.settledMs !== null
        ? repeat.filter(
            (request) =>
              request.postAt >= turn.submissionMs &&
              request.postAt <= turn.submissionMs + turn.settledMs,
          )
        : null,
    ),
    gaps: { cold: result.probe?.cold?.gaps, repeat: result.probe?.repeat?.gaps },
  };
}

/** Each scenario's derivation: `(result, cell, problems) => sample`, the sample the report's numbers read. */
const DERIVE = {
  session,
  sessionInstrumented: (result, cell, problems) => {
    const sample = session(result, cell, problems);
    return {
      ...sample,
      bytes: undefined,
      diagnostics: diagnostics(result, cell, sample, problems),
    };
  },
  aa: (result, cell, problems) => {
    const cold = probeRecords(result.probe)
      ? playable(result.probe, "Start")
      : { ok: false, reason: "no records" };
    if (!cold.ok) problems.push(`cold playable: ${cold.reason}`);
    return { arm: result.arm, cold };
  },
  bridge: (result, cell, problems) => {
    if (!list(result.requests)) problems.push("the request records");
    let workerSide = null;
    if (cell.backend === "worker") {
      if (list(result.workerLog) && Number.isFinite(result.timeOrigin))
        workerSide = workerSideOf(result.workerLog, result.requests ?? [], result.timeOrigin);
      else problems.push("the Worker's log with the page's clock origin");
    }
    return {
      requests: result.requests,
      at: result.at,
      inputUnits: result.inputUnits,
      inputBytes: result.inputBytes,
      workerSide,
    };
  },
  taps: (result, cell, problems) => {
    const counts = tapCounts(result);
    if (counts === null) problems.push("the send ledger, the deliveries and the window");
    if (!list(result.cdpErrors)) problems.push("the CDP error records");
    else if (result.cdpErrors.length > 0)
      problems.push(`${result.cdpErrors.length} CDP send errors`);
    if (counts !== null && counts.outside > 0)
      problems.push(`${counts.outside} taps off their grid point`);
    return { ...counts, clock: result.clock };
  },
  demo: (result, cell, problems) => {
    if (!list(result.errors)) problems.push("the error records");
    return { errors: result.errors };
  },
  delayedSmoke: (result) => result,
};
DERIVE.bridgeTaps = DERIVE.taps;
for (const trial of ["keepHandler", "keepCompletion", "keepDurable"])
  DERIVE[trial] = (result, cell, problems) => {
    const derived = keepOutcome(trial, result);
    if (derived === null) problems.push("the trial's records");
    else if (derived.outcome !== result.outcome)
      problems.push(
        `the recorded outcome '${result.outcome}' is not its records' '${derived.outcome}'`,
      );
    return { outcome: derived?.outcome, hiddenToCommitMs: derived?.hiddenToCommitMs ?? null };
  };

/** `result`'s sample for `cell`, derived from its records, and what kept it from being derived. */
export function deriveSample(cell, result) {
  const problems = [];
  const sample = DERIVE[cell.scenario](result ?? {}, cell, problems);
  return { sample, problems };
}
