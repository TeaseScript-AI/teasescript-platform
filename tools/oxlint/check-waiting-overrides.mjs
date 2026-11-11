import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The waiting lists of `.oxlintrc.json` (docs/LINTING.md "Waiting lists"): an `overrides` entry whose rules are all
// off. Each path a waiting entry lists has a finding that oxlint reports without that entry and not with it; a path for
// which oxlint reports no such finding is refused, as is a path that is not a linted file.
//
// The check lets oxlint resolve its own configuration. For each waiting entry it runs oxlint (`--type-aware`, as
// `run.mjs` does) over the entry's files twice: with the configuration, and with a copy that leaves the entry out,
// written beside it (`overrides` paths resolve from the configuration's folder). A finding is oxlint's whole JSON
// diagnostic, compared as a structure (its file, code, severity, message, and every label's place and length): one of
// the second run that the first lacks keeps its file listed. So a finding of a rule that stays on, whose message or
// place changes when the entry goes, keeps the entry too.
//
// The copy is `.oxlintrc.probe-<pid>-<random>.json`, a name oxlint never reads by itself, gitignored, and removed when
// the check ends: it returns, it throws, or a SIGINT, SIGTERM or SIGHUP stops it, which also stops the oxlint it runs,
// and then the check's process by that signal. A SIGKILL leaves the probe; the next run removes each probe whose owner
// process is no longer alive.
//
// "Off" is a severity oxlint's schema (`AllowWarnDeny`, `node_modules/oxlint/configuration_schema.json`) says turns a
// rule off: "allow", "off" or 0, alone or first in an array. A severity the schema does not have, in the root `rules`
// or an entry's, is refused before oxlint runs, at the severity itself (the last of a repeated key, which is the one
// that counts). The check reads one configuration file: one that `extends` another is refused.

/** The severities oxlint's `AllowWarnDeny` has, and those of them that turn a rule off. */
const SEVERITIES = new Set(["allow", "off", "warn", "error", "deny", 0, 1, 2]);
const OFF = new Set(["allow", "off", 0]);
const severityOf = (setting) => (Array.isArray(setting) ? setting[0] : setting);

/** Whether an `overrides` entry is a waiting list: it has rules, and each is off. */
export const isWaitingEntry = (entry) =>
  Object.keys(entry.rules ?? {}).length > 0 &&
  Object.values(entry.rules).every((setting) => OFF.has(severityOf(setting)));

/** Each value of `text` (strict JSON), objects and arrays included, with its path of keys and indexes, and its offset. */
function positionsOf(text) {
  const found = [];
  let at = 0;
  const space = () => {
    while (/\s/u.test(text[at] ?? "")) at += 1;
  };
  const string = () => {
    const start = at;
    at += 1;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    at += 1;
    return { start, value: JSON.parse(text.slice(start, at)) };
  };
  const value = (path) => {
    space();
    found.push({ path, start: at });
    if (text[at] === "{") {
      at += 1;
      space();
      if (text[at] === "}") return void (at += 1);
      for (;;) {
        space();
        const { value: key } = string();
        space();
        at += 1;
        value([...path, key]);
        space();
        if (text[at++] === "}") return;
      }
    }
    if (text[at] === "[") {
      at += 1;
      space();
      if (text[at] === "]") return void (at += 1);
      for (let index = 0; ; index += 1) {
        value([...path, index]);
        space();
        if (text[at++] === "]") return;
      }
    }
    if (text[at] === '"') return void string();
    while (at < text.length && !/[\s,}\]]/u.test(text[at])) at += 1;
  };
  value([]);
  return found;
}

/** `value` with its objects' keys in order, so that two equal structures print alike. */
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;

/** Each diagnostic of oxlint's JSON output: `{ file, key }`, `key` the whole diagnostic as a canonical string. */
function diagnosticsOf(result) {
  let diagnostics;
  try {
    ({ diagnostics } = JSON.parse(result.stdout));
  } catch {
    throw new Error(
      `check-waiting-overrides: oxlint printed no findings to read (exit ${result.status}):\n${result.stdout}${result.stderr}`,
    );
  }
  return diagnostics.map((diagnostic) => ({
    file: diagnostic.filename,
    key: JSON.stringify(canonical(diagnostic)),
  }));
}

/** Removes each probe in `root` whose owner process is no longer alive: what an interrupted run left. */
function sweepProbes(root) {
  for (const name of readdirSync(root)) {
    const owner = /^\.oxlintrc\.probe-(\d+)-[0-9a-f]{8}\.json$/u.exec(name);
    if (owner === null) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if (error.code === "ESRCH") rmSync(join(root, name), { force: true });
    }
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * The findings of the waiting lists in the configuration `configFile` (relative to `root`, its text `configText`):
 * each `{ fileName, line, column, message }`. `linted` is the set of files `npm run lint` lints, relative to `root`;
 * `executable` is oxlint's.
 */
export async function checkWaitingOverrides(root, configFile, configText, linted, executable) {
  const config = JSON.parse(configText);
  const positions = positionsOf(configText);
  const findings = [];
  /** A finding at the value whose path is `path`: its last occurrence, the one `JSON.parse` keeps for a repeated key. */
  const report = (path, message) => {
    const at = positions.findLast(
      (each) => JSON.stringify(each.path) === JSON.stringify(path),
    ).start;
    const before = configText.slice(0, at);
    findings.push({
      fileName: configFile,
      line: before.split("\n").length,
      column: at - before.lastIndexOf("\n"),
      message,
    });
  };

  // the check reads this one file's rule sets, so a configuration that extends another is refused
  if (config.extends !== undefined) {
    report(
      ["extends"],
      "the configuration extends another, whose rules the waiting check does not read: write its rules into this file",
    );
    return findings;
  }
  const overrides = config.overrides ?? [];
  const ruleSets = [
    { path: ["rules"], rules: config.rules, where: "the configuration's" },
    ...overrides.map((entry, index) => ({
      path: ["overrides", index, "rules"],
      rules: entry.rules,
      where: "the overrides entry's",
    })),
  ];
  for (const { path, rules, where } of ruleSets)
    for (const [rule, setting] of Object.entries(rules ?? {}))
      if (!SEVERITIES.has(severityOf(setting)))
        report(
          Array.isArray(setting) && setting.length > 0 ? [...path, rule, 0] : [...path, rule],
          `${where} rule '${rule}' has the severity ${JSON.stringify(severityOf(setting))}, which oxlint's AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"`,
        );
  // oxlint does not run on a configuration whose severity it cannot parse
  if (findings.length > 0) return findings;
  const waiting = overrides
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isWaitingEntry(entry));

  sweepProbes(root);
  const probe = `.oxlintrc.probe-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  let running = null;
  const lint = (file, files) =>
    new Promise((resolve, reject) => {
      running = spawn(
        process.execPath,
        [
          executable,
          "--config",
          file,
          "--disable-nested-config",
          "--type-aware",
          "-f",
          "json",
          ...files,
        ],
        { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = { stdout: "", stderr: "" };
      for (const stream of ["stdout", "stderr"])
        running[stream].setEncoding("utf8").on("data", (chunk) => (output[stream] += chunk));
      running.on("error", reject);
      running.on("close", (status) => {
        running = null;
        try {
          resolve(diagnosticsOf({ ...output, status }));
        } catch (error) {
          reject(error);
        }
      });
    });
  // the probe goes with the run it serves; the signal then ends this process as it would have without the handler
  const stop = (signal) => {
    rmSync(join(root, probe), { force: true });
    running?.kill(signal);
    for (const each of SIGNALS) process.off(each, stop);
    process.kill(process.pid, signal);
  };
  for (const signal of SIGNALS) process.on(signal, stop);
  try {
    for (const { entry, index } of waiting) {
      const files = [];
      for (const [position, file] of entry.files.entries())
        if (linted.has(file)) files.push(file);
        else
          report(
            ["overrides", index, "files", position],
            `'${file}' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns`,
          );
      if (files.length === 0) continue;
      writeFileSync(
        join(root, probe),
        JSON.stringify({ ...config, overrides: overrides.filter((_, at) => at !== index) }),
      );
      const kept = new Set((await lint(configFile, files)).map(({ key }) => key));
      const needed = new Set(
        (await lint(probe, files)).filter(({ key }) => !kept.has(key)).map(({ file }) => file),
      );
      const rules = Object.keys(entry.rules);
      for (const [position, file] of entry.files.entries())
        if (files.includes(file) && !needed.has(file))
          report(
            ["overrides", index, "files", position],
            `'${file}' waits for ${rules.length <= 3 ? rules.join(", ") : `the ${rules.length} rules its overrides entry turns off`}, but oxlint reports nothing more in it without that entry: remove it from the entry`,
          );
    }
  } finally {
    for (const signal of SIGNALS) process.off(signal, stop);
    rmSync(join(root, probe), { force: true });
  }
  return findings.sort((one, other) => one.line - other.line || one.column - other.column);
}
