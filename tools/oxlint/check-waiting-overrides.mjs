import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// An `overrides` entry of `.oxlintrc.json` whose rules are all `off` is a waiting list (docs/LINTING.md "Waiting
// lists"): its files' findings of those rules wait for a cleanup. Each listed file must still have a finding of one of
// the rules it turns off, so the list only shrinks. The check runs oxlint once, `--type-aware` as `run.mjs` does, with
// every rule any waiting list turns off on (with the options the configuration gives it, else as `error`), over every
// listed file, and reports each listed file none of its entry's rules finds anything in. A listed path that is not a
// linted file, a glob included, is reported too: a waiting list names files, never patterns.

const severity = (setting) => (Array.isArray(setting) ? setting[0] : setting);
const isOff = (setting) => severity(setting) === "off" || severity(setting) === 0;

/** The code oxlint reports a configured rule's findings under: `x/y` as `x(y)`, a bare name as `eslint(y)`. */
const codeOf = (rule) => (rule.includes("/") ? rule.replace("/", "(") + ")" : `eslint(${rule})`);

/** The rules an entry turns off, by name up to three, else by count. */
const waitsFor = (rules) =>
  rules.length <= 3
    ? rules.join(", ").replace(/, ([^,]*)$/u, " and $1")
    : `the ${rules.length} rules its overrides entry turns off`;

/** `findings` in the configuration's order. */
const inOrder = (findings) =>
  findings.sort((one, other) => one.line - other.line || one.column - other.column);

/** The 1-based line and column of `file`'s name in the `index`-th overrides entry of the configuration's text. */
function positionOf(configText, index, file) {
  let from = configText.indexOf('"overrides"');
  for (let entry = 0; entry <= index; entry += 1) from = configText.indexOf('"files"', from + 1);
  const at = configText.indexOf(JSON.stringify(file), from);
  const before = configText.slice(0, at);
  return { line: before.split("\n").length, column: at - before.lastIndexOf("\n") };
}

/**
 * The findings of the waiting lists in `configText` (the text of `.oxlintrc.json` at `root`): each `{ fileName, line,
 * column, message }`. `linted` is the set of files `npm run lint` lints, relative to `root`; `executable` is oxlint's.
 */
export function checkWaitingOverrides(root, configText, linted, executable) {
  const config = JSON.parse(configText);
  const waiting = (config.overrides ?? [])
    .map((entry, index) => ({ ...entry, index }))
    .filter(
      ({ rules }) => Object.keys(rules ?? {}).length > 0 && Object.values(rules).every(isOff),
    );
  const findings = [];
  const report = (index, file, message) =>
    findings.push({ fileName: ".oxlintrc.json", ...positionOf(configText, index, file), message });

  const rules = {};
  const files = new Set();
  for (const { index, files: listed, rules: off } of waiting) {
    for (const rule of Object.keys(off)) {
      const setting = config.rules?.[rule];
      rules[rule] = Array.isArray(setting) && !isOff(setting) ? setting : "error";
    }
    for (const file of listed)
      if (linted.has(file)) files.add(file);
      else
        report(
          index,
          file,
          `'${file}' is in an overrides entry that only turns rules off, but no linted file has that path: a waiting list names files, never patterns`,
        );
  }
  if (files.size === 0) return inOrder(findings);

  // the rules alone, with the plugins that define them; every category off
  const folder = mkdtempSync(join(tmpdir(), "waiting-overrides-"));
  try {
    const probe = join(folder, "oxlintrc.json");
    writeFileSync(
      probe,
      JSON.stringify({
        ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
        ...(config.jsPlugins === undefined
          ? {}
          : {
              jsPlugins: config.jsPlugins.map((plugin) => ({
                ...plugin,
                specifier: isAbsolute(plugin.specifier)
                  ? plugin.specifier
                  : resolve(root, plugin.specifier),
              })),
            }),
        categories: { correctness: "off" },
        rules,
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        executable,
        "--config",
        probe,
        "--disable-nested-config",
        "--type-aware",
        "-f",
        "json",
        ...files,
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    let diagnostics;
    try {
      ({ diagnostics } = JSON.parse(result.stdout));
    } catch {
      throw new Error(
        `check-waiting-overrides: oxlint printed no findings to read (exit ${result.status}):\n${result.stdout}${result.stderr}`,
      );
    }
    const found = new Set(diagnostics.map(({ filename, code }) => `${filename}\n${code}`));
    for (const { index, files: listed, rules: off } of waiting) {
      const codes = Object.keys(off).map(codeOf);
      for (const file of listed)
        if (files.has(file) && !codes.some((code) => found.has(`${file}\n${code}`)))
          report(
            index,
            file,
            `'${file}' waits for ${waitsFor(Object.keys(off))}, but none of them finds anything in it: remove it from that overrides entry`,
          );
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return inOrder(findings);
}
