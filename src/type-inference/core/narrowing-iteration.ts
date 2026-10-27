import { sortCost } from "./definitions.js";
import type { WorkCounter, WorkLedger } from "./budget.js";

/*
 * The one way stage 3b's narrowing modules walk anything (TABLE §13.3: "List construction, filtering and every visit
 * are charged"): every item taken, every step of a search and every element a copy or a test visits charges one unit
 * of a named counter as it happens, so a walk cannot go uncharged. `tools/oxlint/check-charged-iteration.mjs` rejects
 * any other loop, array walk or copy in `narrowing.ts`, `narrowing-events.ts`, `narrowing-routes.ts` and
 * `narrowing-statements.ts`: there the ledger is complete by construction. Calls into the rest of the core charge their
 * own work, or are charged at the call with a comment naming the counter.
 */

/** Each item, one unit of `counter` charged as it is taken. */
export function* each<T>(work: WorkLedger, counter: WorkCounter, items: Iterable<T>): Generator<T> {
  for (const item of items) {
    work.charge(counter);
    yield item;
  }
}

/** The steps of a walk of unknown length (a search, a climb, a worklist): one while `more()` holds, each charged. */
export function* steps(
  work: WorkLedger,
  counter: WorkCounter,
  more: () => boolean,
): Generator<void> {
  while (more()) {
    work.charge(counter);
    yield;
  }
}

/** Whether some item passes `test`, each item tested charged. */
export function some<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  test: (item: T) => boolean,
): boolean {
  for (const item of items) {
    work.charge(counter);
    if (test(item)) return true;
  }
  return false;
}

/** Whether every item passes `test`, each item tested charged. */
export function every<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  test: (item: T) => boolean,
): boolean {
  return !some(work, counter, items, (item) => !test(item));
}

/** Whether `items` holds `value`, each item compared charged. */
export function holds<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  value: T,
): boolean {
  return some(work, counter, items, (item) => item === value);
}

/** The items mapped, in order, each charged. */
export function mapped<T, U>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  map: (item: T, index: number) => U,
): U[] {
  const made: U[] = [];
  let index = 0;
  for (const item of items) {
    work.charge(counter);
    made.push(map(item, index));
    index += 1;
  }
  return made;
}

/** The items each maps to, in order, every item and every mapped item charged. */
export function flatMapped<T, U>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  map: (item: T, index: number) => Iterable<U>,
): U[] {
  const made: U[] = [];
  let index = 0;
  for (const item of items) {
    work.charge(counter);
    for (const inner of map(item, index)) {
      work.charge(counter);
      made.push(inner);
    }
    index += 1;
  }
  return made;
}

/** The items that pass `test`, in order, each tested charged. */
export function passing<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: Iterable<T>,
  test: (item: T) => boolean,
): T[] {
  const made: T[] = [];
  for (const item of items) {
    work.charge(counter);
    if (test(item)) made.push(item);
  }
  return made;
}

/** A copy of the items, in order, each charged. */
export function copied<T>(work: WorkLedger, counter: WorkCounter, items: Iterable<T>): T[] {
  return mapped(work, counter, items, (item) => item);
}

/** The items sorted in place by `compare`, the comparisons of a sort of their number charged. */
export function sorted<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: T[],
  compare: (a: T, b: T) => number,
): T[] {
  work.charge(counter, sortCost(items.length));
  return items.sort(compare);
}
