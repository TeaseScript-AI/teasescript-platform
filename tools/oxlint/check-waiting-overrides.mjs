import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The waiting lists of `.oxlintrc.json` (docs/LINTING.md "Waiting lists"): an `overrides` entry whose rules are all
// off. Each path a waiting entry lists has a finding that oxlint reports without that entry and not with it; a path for
// which oxlint reports no such finding is refused, as is a path that is not a linted file.
//
// The check lets oxlint resolve its own configuration. For each waiting entry it runs oxlint (`--type-aware`, as
// `run.mjs` does) over the entry's files twice: with the configuration, and with a copy that leaves the entry out,
// written beside it (`overrides` paths resolve from the configuration's folder) under a name unique to the run and
// removed at the end, also on SIGINT, SIGTERM and SIGHUP. A finding of the second run that the first lacks keeps its
// file listed.
//
// "Off" is a severity oxlint's schema (`AllowWarnDeny`, `node_modules/oxlint/configuration_schema.json`) says turns a
// rule off: "allow", "off" or 0, alone or first in an array. A severity the schema does not have is refused, in any
// entry.

/** The severities oxlint's `AllowWarnDeny` has, and those of them that turn a rule off. */
const SEVERITIES = new Set(["allow", "off", "warn", "error", "deny", 0, 1, 2]);
const OFF = new Set(["allow", "off", 0]);
const severityOf = (setting) => (Array.isArray(setting) ? setting[0] : setting);

/** Each string value of `text` (strict JSON) with its path of keys and indexes, and its offset. */
function stringsOf(text) {
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
    if (text[at] === '"') return void found.push({ path, start: string().start });
    while (at < text.length && !/[\s,}\]]/u.test(text[at])) at += 1;
  };
  value([]);
  return found;
}

/** Each diagnostic of oxlint's JSON output, as one string: its file, code, place and message. */
function diagnosticsOf(result) {
  let diagnostics;
  try {
    ({ diagnostics } = JSON.parse(result.stdout));
  } catch {
    throw new Error(
      `check-waiting-overrides: oxlint printed no findings to read (exit ${result.status}):\n${result.stdout}${result.stderr}`,
    );
  }
  return diagnostics.map(
    ({ filename, code, message, labels }) =>
      `${filename}\n${code}\n${labels?.[0]?.span?.offset ?? ""}\n${message}`,
  );
}

/**
 * The findings of the waiting lists in the configuration `configFile` (relative to `root`, its text `configText`):
 * each `{ fileName, line, column, message }`. `linted` is the set of files `npm run lint` lints, relative to `root`;
 * `executable` is oxlint's.
 */
export function checkWaitingOverrides(root, configFile, configText, linted, executable) {
  const config = JSON.parse(configText);
  const strings = stringsOf(configText);
  const findings = [];
  /** A finding at the string whose path is `path` (the entry itself when no such string is found). */
  const report = (path, message) => {
    const at = strings.find((each) => each.path.join("\n") === path.join("\n"))?.start ?? 0;
    const before = configText.slice(0, at);
    findings.push({
      fileName: configFile,
      line: before.split("\n").length,
      column: at - before.lastIndexOf("\n"),
      message,
    });
  };

  const overrides = config.overrides ?? [];
  for (const [index, entry] of overrides.entries())
    for (const [rule, setting] of Object.entries(entry.rules ?? {}))
      if (!SEVERITIES.has(severityOf(setting)))
        report(
          ["overrides", index, "files", 0],
          `the overrides entry's rule '${rule}' has the severity ${JSON.stringify(severityOf(setting))}, which oxlint's AllowWarnDeny does not have: write "off" (or "allow" or 0) to turn it off, or "error"`,
        );
  // oxlint does not run on a configuration whose severity it cannot parse
  if (findings.length > 0) return findings;
  const waiting = overrides
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        Object.keys(entry.rules ?? {}).length > 0 &&
        Object.values(entry.rules).every((setting) => OFF.has(severityOf(setting))),
    );

  const probe = `.oxlintrc.probe-${process.pid}-${randomBytes(4).toString("hex")}.json`;
  const remove = () => rmSync(join(root, probe), { force: true });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const onSignal = () => {
      remove();
      process.kill(process.pid, signal);
    };
    process.once(signal, onSignal);
    return [signal, onSignal];
  });
  const lint = (file, files) =>
    diagnosticsOf(
      spawnSync(
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
        { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
      ),
    );
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
      const kept = new Set(lint(configFile, files));
      const needed = new Set(
        lint(probe, files)
          .filter((diagnostic) => !kept.has(diagnostic))
          .map((diagnostic) => diagnostic.split("\n")[0]),
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
    remove();
    for (const [signal, onSignal] of signals) process.off(signal, onSignal);
  }
  return findings.sort((one, other) => one.line - other.line || one.column - other.column);
}
