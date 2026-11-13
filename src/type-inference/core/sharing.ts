/*
 * For the tests: while `withoutSharing` runs, `sharing()` is false, and each of its readers answers a value by itself
 * instead of taking an equivalent value's answer: in `admission/` (classes, scans, literal cells, walks, regions, the
 * written decider), in `contract/` (levels, the literal index, `others.ts`), `exact-path.ts` and
 * `indexes/plus-index.ts` (#1203). The published records and the lowered plan must be the same either way; the type
 * core's oracles compare a program with the sharing on and off (`tests/helpers/type-core-oracles-modes.ts`).
 */

let shared = true;

/** Whether answers may be shared between equivalent values (false only inside `withoutSharing`). */
export function sharing(): boolean {
  return shared;
}

export function withoutSharing<T>(callback: () => T): T {
  const before = shared;
  shared = false;
  try {
    return callback();
  } finally {
    shared = before;
  }
}
