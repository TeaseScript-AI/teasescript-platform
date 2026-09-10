// Compile-time continuations only. No task survives compilation or enters runtime state.
export type CompileTask<T> = Generator<CompileTask<unknown>, T, unknown>;

export function* compileChild<T>(task: CompileTask<T>): CompileTask<T> {
  // EVIDENCE: invariant: the driver resumes a parent with its child's result.
  return (yield task) as T;
}

export function runCompileTask<T>(root: CompileTask<T>): T {
  const pending: CompileTask<unknown>[] = [root];
  let value: unknown;
  let failed = false;
  while (pending.length > 0) {
    try {
      const task = pending.at(-1)!;
      const step = failed ? task.throw(value) : task.next(value);
      failed = false;
      if (step.done) {
        pending.pop();
        value = step.value;
      } else {
        pending.push(step.value);
        value = undefined;
      }
    } catch (error) {
      // Propagate through suspended parents so their catch/finally blocks retain
      // the ordinary call semantics, including contextual speaker restoration.
      pending.pop();
      value = error;
      failed = true;
    }
  }
  if (failed) throw value;
  // EVIDENCE: invariant: the final completed task is the typed root task.
  return value as T;
}
