import { isFrozenTemporalContext } from "../temporal.js";

/** JSON-safe engine data: the shape of runtime state and of everything an operation returns. */
type PlainValue = string | number | boolean | null | undefined | PlainValue[] | PlainRecord;
type PlainRecord = { [key: string]: PlainValue };

/**
 * Copies JSON-safe engine data without recursion, keeping each record's property order, in work proportional to the
 * data. `publish` freezes every copy; `fork` makes a state copy for another session, which shares the deeply frozen
 * temporal contexts; `export` makes a copy that shares nothing.
 */
export function copyPlainData<T>(value: T, use: "publish" | "fork" | "export"): T {
  const publish = use === "publish";
  const work: Array<readonly [PlainValue[], PlainValue[]] | readonly [PlainRecord, PlainRecord]> =
    [];
  const enter = (nested: PlainValue): PlainValue => {
    if (typeof nested !== "object" || nested === null) return nested;
    if (use === "fork" && isFrozenTemporalContext(nested)) return nested;
    if (Array.isArray(nested)) {
      const copy = new Array<PlainValue>(nested.length);
      work.push([nested, copy]);
      return copy;
    }
    const copy: PlainRecord = Object.getPrototypeOf(nested) === null ? Object.create(null) : {};
    work.push([nested, copy]);
    return copy;
  };
  // EVIDENCE: invariant: engine state and operation output are JSON-safe plain data.
  const root = enter(value as PlainValue);
  for (let step = work.pop(); step !== undefined; step = work.pop()) {
    if (Array.isArray(step[0]) && Array.isArray(step[1])) {
      const [source, copy] = step;
      for (let index = 0; index < source.length; index += 1) copy[index] = enter(source[index]);
    } else if (!Array.isArray(step[0]) && !Array.isArray(step[1])) {
      const [source, copy] = step;
      for (const key of Object.keys(source)) copy[key] = enter(source[key]);
    }
    if (publish) Object.freeze(step[1]);
  }
  // EVIDENCE: invariant: the copy has the same JSON-safe structure as `value`.
  return root as T;
}
