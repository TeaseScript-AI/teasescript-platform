// The kit's strict reader of records (orchestrator 2's ruling after Sol code r6): every derivation reads the raw records
// a row kept only through `strictRecord`. A read of a missing value (`undefined` or `null`) throws `MissingEvidence`;
// a value that may truly be absent (a frame not yet drawn, a reply not yet arrived) is read with `nullable`, by name;
// and `span` is the only subtraction over timestamps: both ends present and in order, else it throws. `deriveSample`
// (`validate.mjs`) is the one place a row's records are wrapped, and its one `try` turns either error into that
// sample's problem, which fails its cell.

/** A required value a record does not hold. */
export class MissingEvidence extends Error {
  constructor(field) {
    super(`missing evidence: ${field}`);
    this.name = "MissingEvidence";
    this.field = field;
  }
}

/** A cached classification a record carries that its primary evidence contradicts. */
export class ContradictoryEvidence extends Error {
  constructor(what) {
    super(`contradictory evidence: ${what}`);
    this.name = "ContradictoryEvidence";
  }
}

/** An interval whose end lies before its start. */
export class ReversedInterval extends Error {
  constructor(what, from, to) {
    super(`reversed interval: ${what} runs from ${from} to ${to}`);
    this.name = "ReversedInterval";
  }
}

const RAW = Symbol("raw record");
const PATH = Symbol("record path");

/**
 * `value` read strictly: an object or array whose every property read returns the value wrapped the same way, or
 * throws `MissingEvidence` (with the field's path) when it is `undefined` or `null`. Functions (an array's methods)
 * pass through, so `records.find(…)` hands its callback wrapped elements. A primitive is returned as it is.
 */
export function strictRecord(value, path = "record") {
  if (value === null || typeof value !== "object" || value[RAW] !== undefined) return value;
  return new Proxy(value, {
    get(target, key) {
      if (key === RAW) return target;
      if (key === PATH) return path;
      const found = target[key];
      if (typeof key === "symbol" || typeof found === "function") return found;
      const field = `${path}.${String(key)}`;
      if (found === undefined || found === null) throw new MissingEvidence(field);
      return strictRecord(found, field);
    },
  });
}

/**
 * The fields that may truly be absent, each with why; `nullable` reads no other. A classification or a required field is
 * never on it, so a missing one cannot pass as an absence.
 */
export const NULLABLE = Object.freeze({
  frame: "a record's animation-frame callback has not run yet",
  shownFrame: "a row not yet drawn with a positive opacity",
  start: "no start button is shown",
  composer: "the page shows no composer",
  control: "no foreground controls root is shown",
  ready: "the engine Worker has not posted its ready",
  end: "a transaction still open, or a turn the driver saw settle",
  outcome: "a transaction still open",
  scope: "a put whose stored record names no scope",
  observedMs: "a plans put carries no scene time",
  failed: "a request that did not fail",
  usedBytes: "a Worker whose heap read failed",
  id: "a bridge message outside a request (the Worker's ready)",
  op: "a bridge message outside a request",
  replyAt: "a request whose reply has not arrived",
  size: "a reply that is not captureKeep's",
  longTasks: "a browser that does not report long tasks",
  longTasksUnavailable: "a browser that reports long tasks gives no reason",
  storedMs: "the store held no snapshot",
  sentAt: "a turn the driver could not send",
  reason: "a turn that did not fail",
});

/**
 * `record[key]` when it may truly be absent, `key` one of `NULLABLE`'s: `null` for `undefined` or `null`, else the value
 * read strictly. On a raw record (a scenario's live call) it reads the plain value the same way. Another key throws.
 */
export function nullable(record, key) {
  if (!Object.hasOwn(NULLABLE, key))
    throw new Error(`'${String(key)}' is no field that may be absent (NULLABLE)`);
  const raw = record[RAW] ?? record;
  const found = raw[key];
  if (found === undefined || found === null) return null;
  return strictRecord(found, `${record[PATH] ?? "record"}.${String(key)}`);
}

/**
 * The time from `from` to `to`, the only subtraction over timestamps the derivations make: both must be finite numbers
 * (`MissingEvidence` otherwise) and `from <= to` (`ReversedInterval` otherwise). `what` names the interval.
 */
export function span(from, to, what = "an interval") {
  if (!Number.isFinite(from)) throw new MissingEvidence(`${what}: its start`);
  if (!Number.isFinite(to)) throw new MissingEvidence(`${what}: its end`);
  if (from > to) throw new ReversedInterval(what, from, to);
  return to - from;
}

/**
 * The difference `to − from` between two realms' clocks (a page's epoch time and its Worker's), not an interval on one
 * clock: both must be finite (`MissingEvidence` otherwise), but its sign is no ordering, since Firefox and WebKit coarsen
 * each clock to 1 ms. Only the bridge's delivery latency uses it, which stays in the `unvalidated` cells (#2122).
 */
export function crossClock(from, to, what = "a cross-clock difference") {
  if (!Number.isFinite(from)) throw new MissingEvidence(`${what}: its start`);
  if (!Number.isFinite(to)) throw new MissingEvidence(`${what}: its end`);
  return to - from;
}

/** Whether `error` is one of the reader's: missing evidence, a reversed interval or a contradicted cache. */
export const isEvidenceError = (error) =>
  error instanceof MissingEvidence ||
  error instanceof ReversedInterval ||
  error instanceof ContradictoryEvidence;
