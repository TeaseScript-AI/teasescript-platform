import { sortCost } from "./definitions.js";
import type { WorkCounter, WorkLedger } from "./budget.js";

/*
 * The one way stage 3b's narrowing modules walk anything ("List construction, filtering and every visit
 * are charged"): every item taken, every step of a search and every element a copy or a test visits charges one unit
 * of a named counter as it happens, and every function body of `narrowing/`'s `narrowings.ts`, `laminar.ts`,
 * `events.ts`, `routes.ts`, `route-tests.ts` and `statement-tree.ts` charges a unit on entry (an arrow handed
 * straight to these functions is charged by them). `tools/oxlint/check-charged-iteration.mjs` guards the ordinary forms
 * of any other repetition there (loops, array walks, a body whose first statement does not charge, and any call into
 * the rest of the core or the library that its list does not give a reason for); the forms it does not see are named in
 * its header. The code as written has no uncharged walk (S10 part 1's review); the lint keeps it so for those forms.
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
  compare?: (a: T, b: T) => number,
): T[] {
  work.charge(counter, sortCost(items.length));
  return items.sort(compare);
}

/** A positional view, including PathSteps: each element taken charged. */
export function* indexed<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: { readonly length: number; at(index: number): T | undefined },
  from = 0,
): Generator<T> {
  for (let i = from; i < items.length; i += 1) {
    work.charge(counter);
    yield items.at(i)!;
  }
}
/** Each source and every element copied charged before use. */
export function concatenated<T>(
  work: WorkLedger,
  counter: WorkCounter,
  sources: Iterable<Iterable<T>>,
): T[] {
  const result: T[] = [];
  for (const source of each(work, counter, sources))
    for (const item of each(work, counter, source)) result.push(item);
  return result;
}
/** A suffix copied through the same element charge, never a native slice. */
export function sliced<T>(
  work: WorkLedger,
  counter: WorkCounter,
  items: readonly T[],
  from: number,
): T[] {
  const result: T[] = [];
  for (let i = from; i < items.length; i += 1) {
    work.charge(counter);
    result.push(items[i]!);
  }
  return result;
}
/** The variable signature parts: every copied and joined part charged. */
export function joined(
  work: WorkLedger,
  counter: WorkCounter,
  parts: readonly string[],
  separator: string,
): string {
  work.charge(counter, parts.length);
  return parts.join(separator);
}
