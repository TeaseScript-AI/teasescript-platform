/*
 * #1072 step 1b (R21): `tools/test-output-filter.mjs` imports this into every test process. In a test file of
 * `tests/type-core/` it installs the retained-state instrument for the whole process, so those suites run frozen;
 * anywhere else, the production shard's files in `tests/type-core-production/` included, it does nothing.
 *
 * A survey (`RETAINED_SURVEY=<folder>`, never in CI): the instrument notes each refusal of a shape or an owner's field
 * and goes on, a write to frozen data is noted where its error's stack is first read, and each process writes what it
 * noted into the folder at its exit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { installRetainedRecorder } from "../../src/type-inference/core/retained/retained.js";
import { RetainedInstrument } from "./retained-instrument.js";

const file = process.argv[1] ?? "";
if (/[\\/]tests[\\/]type-core[\\/][^\\/]+\.test\.js$/u.test(file)) {
  const survey = process.env["RETAINED_SURVEY"];
  const instrument = new RetainedInstrument({
    note: survey !== undefined,
    trace:
      survey === undefined
        ? undefined
        : (report): void => {
            const owners = [...report.owners].sort((a, b) => b[1] - a[1]).slice(0, 8);
            process.stderr.write(
              `retained trace: ${report.switches} switches, owners ${JSON.stringify(owners)}, opened ${JSON.stringify([...report.opened])}\n`,
            );
          },
  });
  installRetainedRecorder(instrument);
  if (survey !== undefined) {
    const frozen = new Map<string, number>();
    const seen = new WeakSet<object>();
    const FROZEN =
      /object is not extensible|read only property|Cannot delete property|Cannot define property/u;
    Error.prepareStackTrace = (error: Error, frames: NodeJS.CallSite[]): string => {
      if (!seen.has(error) && error instanceof TypeError && FROZEN.test(error.message)) {
        seen.add(error);
        const sites = frames
          .map((frame) => `${frame.getFileName() ?? "?"}:${frame.getLineNumber() ?? "?"}`)
          .filter((site) => !site.includes("retained-instrument") && !site.startsWith("node:"))
          .map((site) => site.replace(/^.*\/(src|dist|tests)\//u, "$1/"))
          .slice(0, 3)
          .join(" < ");
        const key = `${error.message.replace(/\d+/gu, "N").slice(0, 140)} @ ${sites}`;
        frozen.set(key, (frozen.get(key) ?? 0) + 1);
      }
      return `${Error.prototype.toString.call(error)}\n${frames.map((frame) => `    at ${frame.getFunctionName() ?? "<anonymous>"} (${frame.getFileName() ?? "?"}:${frame.getLineNumber() ?? "?"})`).join("\n")}`;
    };
    process.on("exit", () => {
      mkdirSync(survey, { recursive: true });
      const report = instrument.report();
      writeFileSync(
        join(survey, `${basename(file, ".js")}-${process.pid}.json`),
        `${JSON.stringify({ file: basename(file), switches: report.switches, sealed: report.sealed, noted: Object.fromEntries(report.noted), frozen: Object.fromEntries(frozen), valueMarks: Object.fromEntries(report.valueMarks), owners: Object.fromEntries(report.owners), opened: Object.fromEntries(report.opened) }, null, 1)}\n`,
      );
    });
  }
}
