/**
 * Thrown where the native engine meets an operation, value kind or plan form it does not implement. It is no runtime
 * fault of the script: a test that runs such a script natively fails with it, naming what is missing.
 */
/**
 * What a native operation returns for a callee or property it does not do natively, so that its caller falls back to
 * today's evaluator. A marker, not an exception: building and catching an error at every such call cost most of the
 * heavy Teases' drives.
 */
export const NOT_NATIVE: unique symbol = Symbol("not native");

export class NativeNotImplementedError extends Error {
  public constructor(what: string) {
    super(`The native engine does not implement ${what}.`);
    this.name = "NativeNotImplementedError";
  }
}
