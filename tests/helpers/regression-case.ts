import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { test, type TestContext } from "node:test";

/*
 * A regression case: a test that witnesses a fix, declared with the failure it gives without that fix
 * (`docs/TESTING.md` "Regression-test rule"). CI runs the cases a pull request declares against its base, through
 * `tools/repository-checks/regression-cases.mjs`, and each must fail there with that failure.
 *
 * Outside that tool the case is plain `test(name, fn)`. The tool sets `REGRESSION_CASES`, which this module reads once:
 * `list:<file>` registers each case alone (`only`) and, in place of running it, appends its declaration to the file;
 * `base` registers each case alone and runs it.
 */

/** What a case declares: the pull request whose fix it witnesses, and the failure it gives without that fix. */
export interface RegressionDeclaration {
  /** The number of the pull request whose fix this case witnesses. */
  readonly pr: number;
  /**
   * The failure at the base: it must match the whole first line of the message of the error the case throws there, as
   * `/Missing expected rejection \(ForeignSessionError\)\./` does `assert.rejects`'s. Name what the fix adds by string
   * (`{ name: "ForeignSessionError" }`), not by import, or the file does not load at the base.
   */
  readonly atBase: RegExp;
}

const mode = process.env.REGRESSION_CASES ?? "";

/** Registers `fn` as the test `name`, a regression case of `declared` (above). */
export function regressionCase(
  name: string,
  declared: RegressionDeclaration,
  fn: (context: TestContext) => void | Promise<void>,
): void {
  if (mode === "") test(name, fn);
  else if (mode.startsWith("list:")) {
    const out = mode.slice("list:".length);
    test(name, { only: true }, (context) => {
      appendFileSync(
        out,
        `${JSON.stringify({
          file: relative(process.cwd(), context.filePath ?? ""),
          name: context.fullName,
          pr: declared.pr,
          atBase: { source: declared.atBase.source, flags: declared.atBase.flags },
        })}\n`,
      );
    });
  } else if (mode === "base") test(name, { only: true }, fn);
  else throw new Error(`REGRESSION_CASES is '${mode}', which is neither 'list:<file>' nor 'base'`);
}
