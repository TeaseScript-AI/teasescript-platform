import type { Work } from "../solver.js";

/**
 * A semantic read the inheritance scans make (#1072): a value's items, a contract's kinds, a receiver's decision.
 * Outside a solver run it is answered by `now`, its synchronous run; inside an inherited proof's run by `work`, yielded
 * to the solver, so the proof depends on what it read. One computation, two drivers.
 */
export interface Read {
  readonly now: () => ReadAnswer;
  readonly work: () => Work<ReadAnswer>;
}

/** A read's answer as its driver passes it on: the reader's own type, which `read` gives back to it. */
export type ReadAnswer = NonNullable<unknown> | null | undefined;

/** A computation that makes semantic reads (`Read`) and is resumed with each answer. */
export type Reads<T> = Generator<Read, T, ReadAnswer>;

/** One read: `now`'s answer outside a run, `work`'s inside an inherited proof. */
export function* read<T>(now: () => T, work: () => Work<T>): Reads<T> {
  // EVIDENCE: invariant: the driver resumes a read with its own `now`'s or `work`'s answer, a `T`.
  return (yield { now, work }) as T;
}

/** Whether a scan's yielded step is a read, not a key it waits on (a key is a number or a string). */
export function isRead(step: unknown): step is Read {
  return typeof step === "object" && step !== null;
}

/** A computation's result outside a solver run: each read answered by its synchronous run, in order. */
export function readNow<T>(steps: Reads<T>): T {
  let step = steps.next();
  while (step.done !== true) step = steps.next(step.value.now());
  return step.value;
}
