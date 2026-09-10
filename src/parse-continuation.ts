// Each grammar routine suspends at a child parse. The driver resumes only the
// top continuation, so source nesting grows this heap stack, not the native stack.
export type ParseTask<T> = Generator<ParseTask<unknown>, T, unknown>;

export function* parseChild<T>(task: ParseTask<T>): ParseTask<T> {
  // EVIDENCE: invariant: runParse resumes a parent with exactly its yielded child's return value.
  return (yield task) as T;
}

export function runParse<T>(root: ParseTask<T>): T {
  const pending: ParseTask<unknown>[] = [root];
  let value: unknown;
  while (pending.length > 0) {
    const step = pending.at(-1)!.next(value);
    if (step.done) {
      pending.pop();
      value = step.value;
    } else {
      pending.push(step.value);
      value = undefined;
    }
  }
  // EVIDENCE: invariant: the last completed continuation is root, whose return type is T.
  return value as T;
}
