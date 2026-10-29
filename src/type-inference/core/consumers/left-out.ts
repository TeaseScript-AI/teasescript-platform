import type { CoreDiagnostic, Obligation } from "../result.js";

// The records a run leaves out, for the tests (`withoutRecords`), and the warnings and checks they would have made.

/** The records a test leaves out (`withoutRecords`): warnings, and checks no warning owns. */
export interface Omission {
  readonly diagnostic: (diagnostic: CoreDiagnostic) => boolean;
  readonly check: (check: Obligation) => boolean;
}

let leftOut: Omission | null = null;

/**
 * Test-only: runs `callback` with what `omit` names left out: the marks a stop makes, with what their consumer forms only
 * with them, and the warnings and checks every discharge inside it plans (`consumer.ts`). The stop oracle's measure of a
 * record's content (`tests/helpers/type-core-stop-oracle.ts`, TABLE r4.108, r4.110).
 */
export function withoutRecords<T>(omit: Omission, callback: () => T): T {
  if (leftOut !== null) throw new Error("Records are already left out.");
  leftOut = omit;
  try {
    return callback();
  } finally {
    leftOut = null;
  }
}

/** Whether `withoutRecords` leaves a warning out of the discharge. */
export function leftOutWarning(diagnostic: CoreDiagnostic): boolean {
  return leftOut?.diagnostic(diagnostic) === true;
}

/** Whether `withoutRecords` leaves a check no warning owns out of the discharge. */
export function leftOutCheck(check: Obligation): boolean {
  return leftOut?.check(check) === true;
}
