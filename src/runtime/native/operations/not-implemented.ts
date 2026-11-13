/**
 * Thrown where the native engine meets an operation, value kind or plan form it does not implement. It is no runtime
 * fault of the script: a test that runs such a script natively fails with it, naming what is missing.
 */
export class NativeNotImplementedError extends Error {
  public constructor(what: string) {
    super(`The native engine does not implement ${what}.`);
    this.name = "NativeNotImplementedError";
  }
}
