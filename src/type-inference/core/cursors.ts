/*
 * G3's path cursors (TABLE r4.164's stage 1, after the positioned frontier): a key or a path that a structure keeps or a
 * demand is named by on a decided path is its cursor, its place and its path's id on the pass's path trie
 * (`Contract.pathStep`), each made one step from its parent's; never its text, which a long path made again at every
 * prefix. Each representation is changed in one place; `withTextKeys` keeps every one of them the text it was, the
 * oracle the tests compare the cursors with (the answers are the same either way).
 */

let cursored = true;

/** Whether keys and paths are kept as cursors (false only inside `withTextKeys`). */
export function cursors(): boolean {
  return cursored;
}

/** For the tests and the evidence: every key and path kept as its text, as before the cursors. */
export function withTextKeys<T>(callback: () => T): T {
  const before = cursored;
  cursored = false;
  try {
    return callback();
  } finally {
    cursored = before;
  }
}
