import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

/*
 * A regression case: a test that witnesses a fix, declared with the failure it gives without that fix
 * (`docs/TESTING.md` "Regression-test rule"). CI runs the cases a pull request declares against its base, through
 * `tools/repository-checks/regression-cases.mjs`, and reports how each ends there; it does not fail on the report.
 *
 * Outside that tool the case is plain `test(name, fn)`. The tool sets `REGRESSION_CASES`, which this module reads once,
 * to a JSON object:
 * - `{ mode: "list", records }` registers no test: each call appends its declaration to the file `records`;
 * - `{ mode: "base", records, selected }` registers each case whose id `selected` lists alone (`only`), and appends to
 *   `records` when it starts and how it ends, unless its runner ended it first; every other case is registered without
 *   `only`, so the run skips it.
 * A case's id is its call site in the compiled file (`file:line:column` of the call's `regressionCase`, as the caller's
 * stack frame names it) and its occurrence there: `dist/tests/x.test.js:12:1#1`.
 */

/** What a case declares: the pull request whose fix it witnesses, and the failure it gives without that fix. */
export interface RegressionDeclaration {
  /** The number of the pull request whose fix this case witnesses. */
  readonly pr: number;
  /**
   * The failure at the base: it must match the whole first line of the message of the error the case throws there, as
   * `/Missing expected rejection \(ForeignSessionError\)\./` does `assert.rejects`'s. The tool anchors it, so it has no
   * `^` or `$`, and admits the flags `i`, `u` and `v` only. A generic first line, as `assert.deepStrictEqual`'s, needs
   * the assertion's own message naming the witness. Name what the fix adds by string (`{ name: "ForeignSessionError" }`),
   * not by import, or the file does not load at the base.
   */
  readonly atBase: RegExp;
}

/** The tool's mode, read once. */
interface Mode {
  readonly mode: "list" | "base";
  readonly records: string;
  readonly selected: readonly string[];
}

/** The mode `REGRESSION_CASES` holds: none when it is unset or empty, else its JSON object, checked. */
function modeOf(text: string): Mode | null {
  if (text === "") return null;
  const value: unknown = JSON.parse(text);
  const refuse = (): never => {
    throw new Error(
      `REGRESSION_CASES is not a mode of tools/repository-checks/regression-cases.mjs: ${text}`,
    );
  };
  if (typeof value !== "object" || value === null || !("mode" in value) || !("records" in value))
    return refuse();
  const { mode, records } = value;
  const selected = "selected" in value ? value.selected : [];
  if (
    (mode !== "list" && mode !== "base") ||
    typeof records !== "string" ||
    !Array.isArray(selected) ||
    !selected.every((id): id is string => typeof id === "string")
  )
    return refuse();
  return { mode, records, selected };
}
const mode = modeOf(process.env.REGRESSION_CASES ?? "");

/** What the helper records about a case: its declaration in list mode; its start and its end in base mode. */
type Entry =
  | {
      readonly name: string;
      readonly pr: number;
      readonly atBase: { readonly source: string; readonly flags: string } | null;
    }
  | { readonly started: true }
  | { readonly passed: true }
  | { readonly failed: string };

const helper = fileURLToPath(import.meta.url);
const occurrences = new Map<string, number>();

/** The caller's call site: the compiled file, relative to the working folder, and the line and column of the call. */
function callSite(): string {
  for (const line of (new Error().stack ?? "").split("\n").slice(1)) {
    const [, location, row, column] =
      /(?:^at |\()((?:file:\/\/)?\/[^()]*?):(\d+):(\d+)\)?$/u.exec(line.trim()) ?? [];
    if (location === undefined || row === undefined || column === undefined) continue;
    const file = location.startsWith("file://") ? fileURLToPath(location) : location;
    if (file !== helper) return `${relative(process.cwd(), file)}:${row}:${column}`;
  }
  throw new Error("regressionCase: no caller's frame in the stack");
}

/** The first line of `message`, cut at the first CR LF, LF, CR, U+2028 or U+2029. */
const firstLine = (message: string): string => message.split(/\r\n|\n|\r|\u2028|\u2029/u)[0] ?? "";

/** Registers `fn` as the test `name`, a regression case of `declared` (above). */
export function regressionCase(
  name: string,
  declared: RegressionDeclaration,
  fn: (context: TestContext) => void | Promise<void>,
): void {
  if (mode === null) return void test(name, fn);
  const site = callSite();
  const occurrence = (occurrences.get(site) ?? 0) + 1;
  occurrences.set(site, occurrence);
  const id = `${site}#${occurrence}`;
  const record = (entry: Entry): void =>
    appendFileSync(mode.records, `${JSON.stringify({ id, ...entry })}\n`);
  if (mode.mode === "list") {
    const { atBase } = declared;
    record({
      name,
      pr: declared.pr,
      atBase: atBase instanceof RegExp ? { source: atBase.source, flags: atBase.flags } : null,
    });
    return;
  }
  if (!mode.selected.includes(id)) return void test(name, fn);
  test(name, { only: true }, async (context) => {
    record({ started: true });
    try {
      await fn(context);
    } catch (error) {
      // a case its runner already ended (timed out, cancelled) did not finish, whatever it settles with
      if (!context.signal.aborted)
        record({ failed: firstLine(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
    if (!context.signal.aborted) record({ passed: true });
  });
}
