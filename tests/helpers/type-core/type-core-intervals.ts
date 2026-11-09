import { phaseEnds } from "../type-core-held-host.js";

/*
 * C-R2's epoch-aware stop enumeration (Astra's round 1 review of #1526 phase C, Sol's round 2 §4): the settled stop
 * intervals of a case, by an independent census of every allowance below its total, against the bisection the held
 * host's stops are taken from (`phaseEnds`, `heldStops`), so no settled interval of an earlier epoch, or one the
 * bisection skips past an unsettled gap, goes unenumerated.
 */

/** A stop's identity in the shared trace: whether admission had settled, its pass's epoch, its phase. */
export interface StopRecord {
  readonly settled: boolean;
  readonly epoch: number;
  readonly phase: string | null;
}

/** A run of consecutive allowances whose stops have one record. */
export interface StopInterval extends StopRecord {
  readonly low: number;
  readonly high: number;
}

/**
 * Every allowance from 1 below `total`, its stop's record read once: the runs of consecutive allowances with one
 * record, every island kept, a transition back to admission and a later epoch included.
 */
export function stopCensus(
  total: number,
  recordAt: (allowance: number) => StopRecord,
): StopInterval[] {
  const out: StopInterval[] = [];
  for (let allowance = 1; allowance < total; allowance += 1) {
    const record = recordAt(allowance);
    const last = out.at(-1);
    if (
      last !== undefined &&
      last.settled === record.settled &&
      last.epoch === record.epoch &&
      last.phase === record.phase
    )
      out[out.length - 1] = { ...last, high: allowance };
    else out.push({ ...record, low: allowance, high: allowance });
  }
  return out;
}

/** The census's settled intervals, lowest first: what an enumeration of the settled stops must cover, each one. */
export function settledIntervals(
  census: readonly StopInterval[],
): {
  readonly phase: string;
  readonly epoch: number;
  readonly low: number;
  readonly high: number;
}[] {
  return census
    .filter((interval) => interval.settled && interval.phase !== null)
    .map(({ phase, epoch, low, high }) => ({ phase: phase!, epoch, low, high }));
}

/**
 * The settled intervals the bisection finds (`phaseEnds` over the same records), lowest first, with the epoch of
 * each interval's lowest stop: equal to the census's exactly where the bisection enumerates every settled stop.
 */
export function bisectedIntervals(
  total: number,
  recordAt: (allowance: number) => StopRecord,
): {
  readonly phase: string;
  readonly epoch: number;
  readonly low: number;
  readonly high: number;
}[] {
  const ends = phaseEnds(total, (allowance) => {
    const record = recordAt(allowance);
    return record.settled ? record.phase : null;
  });
  return [...ends]
    .map(([phase, [low, high]]) => ({ phase, epoch: recordAt(low).epoch, low, high }))
    .sort((a, b) => a.low - b.low);
}
