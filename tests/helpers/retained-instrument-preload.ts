/*
 * #1072 step 1b (R21, R28): `tools/test-output-filter.mjs` imports this into every test process. In a test file of
 * `tests/type-core/` or `tests/type-core-stop/` (or a folder one down in either) it installs the retained-state instrument for the whole process, so that suite runs frozen: in CI
 * only the files of the frozen subset (`tests/helpers/retained-subset.ts`), with `RETAINED_FREEZE=all` every one (the
 * whole survey, a queue job, docs/TESTING.md). Anywhere else, the production shard's files included, it does nothing.
 *
 * A survey (`RETAINED_SURVEY=<folder>`, never in CI) freezes every file: the instrument notes each refusal of a shape
 * and goes on, a write to frozen data is noted where its error's stack is first read, and each process writes what it
 * noted into the folder at its exit. A measurement (`RETAINED_MEASURE=<folder>`) freezes every file too and writes what
 * each made, owner and function by its site, for the subset's cover.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { FROZEN_IN_CI } from "./retained-subset.js";

// (the preload's own, taken before any test replaces it: a test may count every call of the global one)
const stringify = JSON.stringify;
const file = process.argv[1] ?? "";
const survey = process.env["RETAINED_SURVEY"];
const measure = process.env["RETAINED_MEASURE"];
const all =
  process.env["RETAINED_FREEZE"] === "all" || survey !== undefined || measure !== undefined;
// (a test file of `tests/type-core/` or `tests/type-core-stop/`, or of a folder one down in either, as the suite reads
// its files two folders down, `tools/test-shards.mjs`)
const name = /[\\/]tests[\\/]type-core(?:-stop)?[\\/](?:[^\\/]+[\\/])?([^\\/]+\.test)\.js$/u.exec(
  file,
)?.[1];
if (name !== undefined && (all || FROZEN_IN_CI.has(name))) {
  // (imported here, not above: the instrument loads much of the type core, which every other test process, and each
  // process a test spawns, would load for nothing)
  const { installRetainedRecorder } =
    await import("../../src/type-inference/core/retained/retained.js");
  const { RetainedInstrument } = await import("./retained-instrument.js");
  const instrument = new RetainedInstrument({
    note: survey !== undefined,
    measure: measure !== undefined,
    trace:
      survey === undefined
        ? undefined
        : (report): void => {
            const owners = [...report.owners].sort((a, b) => b[1] - a[1]).slice(0, 8);
            process.stderr.write(
              `retained trace: ${report.switches} switches, owners ${stringify(owners)}, opened ${stringify([...report.opened])}\n`,
            );
          },
  });
  installRetainedRecorder(instrument);
  // (a typed array no freeze holds, written after its run ended: caught at the exit, which fails the file; a survey
  // counts it as a frozen write)
  if (survey === undefined)
    process.on("exit", () => {
      const changed = instrument.changedTyped();
      if (changed.length === 0) return;
      process.stderr.write(
        `retained state: a typed array written after its run ended, at ${changed.join(", ")}\n`,
      );
      process.exitCode = 1;
    });
  if (measure !== undefined)
    process.on("exit", () => {
      mkdirSync(measure, { recursive: true });
      writeFileSync(
        join(measure, `${name}-${process.pid}.json`),
        `${stringify({ file: name, exercised: [...instrument.report().exercised].sort() }, null, 1)}\n`,
      );
    });
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
      // (each frame as V8 prints it, `Array.map` included, so a test that reads its own stack reads it as unsurveyed)
      return `${Error.prototype.toString.call(error)}\n${frames
        // oxlint-disable-next-line typescript/no-base-to-string -- EVIDENCE: invariant: V8's call site has its own `toString`, the frame of a printed stack; `NodeJS.CallSite` does not declare it.
        .map((frame) => `    at ${frame.toString()}`)
        .join("\n")}`;
    };
    process.on("exit", () => {
      mkdirSync(survey, { recursive: true });
      const report = instrument.report();
      for (const path of instrument.changedTyped()) {
        const key = `a typed array written after its run ended @ ${path}`;
        frozen.set(key, (frozen.get(key) ?? 0) + 1);
      }
      writeFileSync(
        join(survey, `${basename(file, ".js")}-${process.pid}.json`),
        `${stringify({ file: basename(file), switches: report.switches, sealed: report.sealed, noted: Object.fromEntries(report.noted), frozen: Object.fromEntries(frozen), valueMarks: Object.fromEntries(report.valueMarks), owners: Object.fromEntries(report.owners), opened: Object.fromEntries(report.opened) }, null, 1)}\n`,
      );
    });
  }
}
