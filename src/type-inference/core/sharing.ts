/*
 * For the tests (TABLE r4.72): while `withoutSharing` runs, the coarse core shares no answer between equivalent
 * values: no alias class or chain of copies (S6-CARRIERS §4.1), no level of a key's prefix entries by structure (§4.6),
 * no stop of a store's walk for another of the same snapshot (§3.1, the decider's and the named data's), no literal
 * entry for the reads of one key (TABLE §8), and none of S6c's: no option of a choice, add of a run, computed value of
 * a literal or prefix entry for another of its class (`Contract.classOf`, TABLE r4.85), nor a class of computed-key
 * loads' answer for every path below their root (#1203). Every value is then answered by itself, at each path; the
 * published records and the lowered plan must be byte-identical either way, which the differential test asserts.
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
