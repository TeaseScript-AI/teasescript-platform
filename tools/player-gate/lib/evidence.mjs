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
    get(target, key, receiver) {
      if (key === RAW) return target;
      if (key === PATH) return path;
      const found = Reflect.get(target, key, receiver);
      if (typeof key === "symbol" || typeof found === "function") return found;
      const field = `${path}.${String(key)}`;
      if (found === undefined || found === null) throw new MissingEvidence(field);
      return strictRecord(found, field);
    },
  });
}

/**
 * `record[key]` when it may truly be absent: `null` for `undefined` or `null`, else the value read strictly. On a raw
 * record (a scenario's live call) it reads the plain value the same way.
 */
export function nullable(record, key) {
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

/** Whether `error` is one of the reader's: missing evidence or a reversed interval. */
export const isEvidenceError = (error) =>
  error instanceof MissingEvidence || error instanceof ReversedInterval;
