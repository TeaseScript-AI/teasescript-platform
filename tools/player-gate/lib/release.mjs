// What a `drive.mjs` run owns, released once, in order, each release even when an earlier one fails: on the Pixel the
// site data of every origin the run served, cleared while the browser connection still works; the browser; each
// `adb reverse`; each gate host. A signal, a cannot-run condition and a normal end all go through it.

/**
 * Returns `release()`, which releases `run`'s parts and resolves with the failures (`{ step, error }`), the same promise
 * on every call. `run`'s fields are read when it runs: `opened` (with `clearOrigins` on the Pixel), `origins`,
 * `reverses` (with `removeReverse(port)`) and `hosts`.
 */
export function releaser(run) {
  let released = null;
  return () =>
    (released ??= (async () => {
      const failures = [];
      const attempt = async (step, release) => {
        try {
          await release();
        } catch (error) {
          failures.push({ step, error: String(error?.message ?? error) });
        }
      };
      if (run.opened?.clearOrigins !== undefined && run.origins.length > 0)
        await attempt("origins", () => run.opened.clearOrigins(run.origins));
      if (run.opened !== null) await attempt("browser", () => run.opened.close());
      for (const port of run.reverses)
        await attempt(`reverse ${port}`, () => run.removeReverse(port));
      for (const host of run.hosts) await attempt("host", () => host.close());
      return failures;
    })());
}
