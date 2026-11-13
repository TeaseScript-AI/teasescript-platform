import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { SourceMap } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run } from "node:test";
import { pathToFileURL } from "node:url";

import { ts } from "ts-morph";

// Runs the regression cases a pull request declares (`tests/helpers/regression-case.ts`) against its base, and reports
// how each ends there against the failure it declares (CI, on pull requests, after a test job's build). The report is
// evidence, not a gate: CI's step never fails the job.
//
//   node tools/repository-checks/regression-cases.mjs --base <base commit> --pr <number>
//
// In the head's checkout, after its `npm run build:typescript`:
// 1. The changed test files are those `git diff --diff-filter=d <base>...HEAD` names under `tests/` as `*.test.ts`; if
//    none mentions `regressionCase`, it ends.
// 2. Their compiled files run in list mode: the helper registers no test, and records each `regressionCase` call with
//    its call site in the compiled file (line and column, from the caller's stack frame) and its occurrence there. A
//    list run that fails (a file that does not load, a suite that throws, a declaration that cannot be read) is
//    reported, quoting its error.
// 3. Every `regressionCase(…)` call site in a compiled file, as TypeScript parses it, should have a recorded
//    declaration, and every declaration a call site: a call inside a test's body, or in a suite that never runs, is
//    reported, named by its source line. A declaration must have a whole `pr` of 1 or more, and an `atBase` whose flags
//    are `i`, `u` or `v` at most.
// 4. A case of `--pr` is selected. A case of another pull request is one merged into the base (a commit subject ending
//    `(#N)` in `git log <base>`): it is not selected, so it is registered without `only` and does not run. Any other
//    number is reported.
// 5. A detached worktree of the base gets the head's `tests/` in place of its own and the head's `node_modules`. It is
//    compiled with `tsc` (which emits despite type errors, as a test naming what the fix adds has one at the base), and
//    its Player test bundles, which `tests/helpers/player-modules.ts` loads, are built from
//    `player/vue/vite.test-modules.config.ts` with the head's stamping plugin (`player/vue/test-modules-sources.ts`,
//    copied into the base before it is compiled, as the head's loader imports it), also at a base from before it. Its
//    compiled files run in base mode, the selected ids alone (`only`); the helper records when each starts and how it
//    ends, and a case its runner cancelled as not finished.
// 6. `verdict` judges each selected case: a witness when it threw an error whose message's first line (cut at the first
//    CR LF, LF, CR, U+2028 or U+2029) `atBase` matches whole. Anything else is not: it passed, failed for another
//    reason, did not finish (it started and did not end, or was cancelled), or did not run (it did not start: its file
//    or a hook failed).
//
// What the report does not establish, so it is not enforced: that an id names the same declaration at the base (the
// base's own compilation can move a call site, and a loop can register its rows in another order); that every way of
// calling `regressionCase` registers or is found (an alias called inside a test is neither); and that the selected
// cases run alone (another `only` test in the file runs too). A case that loads a module the head adds to the bundles'
// list fails at the base with `Cannot find module`, reported as another reason than `atBase` names; and the base is
// compiled and bundled with the head's `node_modules`.
//
// Its scratch folder, with the base worktree, is `<tmp>/regression-cases-<pid>-<random>`. It installs no signal
// handler: interrupted, it stops by the signal; the next run removes what an interrupted run left, each such folder
// whose owner process is no longer alive.
//
// Exit status: 0 when every selected case is a witness, 1 when one is not or a declaration is refused (for a local run;
// CI does not fail on it), 2 when it cannot run (a missing option, source maps on, a base it cannot check out, compile
// or bundle).

const root = process.cwd();

/** The Player test bundles' source stamp (`player/vue/test-modules-sources.ts`), which the base gets from the head. */
const STAMP = "player/vue/test-modules-sources.ts";

/** Why a run cannot go on: exit 2. */
class CannotRun extends Error {}

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The compiled file of a test source: `tests/x.test.ts` as `dist/tests/x.test.js`. */
const compiledOf = (source) => `dist/${source.replace(/\.ts$/u, ".js")}`;

/** The admitted flags of `atBase`: none of them changes what a whole first line means. */
const FLAGS = /^[iuv]*$/u;

/**
 * Each selected case's verdict from the helper's records at the base: `{ ...case, verdict, detail }`, `verdict` one of
 * `witness`, `passed`, `other failure`, `did not finish` and `did not run`. `records` maps an id to `{ started, passed,
 * failed }` (`failed` the error's first line); `loadErrors` maps a file to the first line of the error it failed with.
 */
export function verdict(cases, records, loadErrors) {
  return cases.map((each) => {
    const record = records.get(each.id) ?? {};
    if (!record.started)
      return {
        ...each,
        verdict: "did not run",
        detail: loadErrors.get(each.file) ?? "it did not start: a hook failed before it",
      };
    if (record.passed) return { ...each, verdict: "passed", detail: "" };
    if (record.failed === undefined) return { ...each, verdict: "did not finish", detail: "" };
    const pattern = new RegExp(`^(?:${each.atBase.source})$`, each.atBase.flags);
    return pattern.test(record.failed)
      ? { ...each, verdict: "witness", detail: record.failed }
      : { ...each, verdict: "other failure", detail: record.failed };
  });
}

/** The explanation of each verdict but `witness`, in the line a case that is not one gets. */
const EXPLAINED = {
  passed: "passed at the base, so it does not witness the defect",
  "other failure":
    "failed at the base for another reason than `atBase` names; its error's first line",
  "did not finish": "started at the base and did not end",
  "did not run": "did not run at the base",
};

/**
 * The `regressionCase` call sites of a compiled file's `text`: `file:line:column` of each callee's name, as a stack
 * frame names the call (1-based).
 */
export function callSitesOf(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      if (ts.isIdentifier(callee) && callee.text === "regressionCase") {
        const at = source.getLineAndCharacterOfPosition(callee.getStart(source));
        sites.push(`${file}:${at.line + 1}:${at.character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

/** A compiled `file:line:column` as its source's `file:line`, through the compiled file's source map, for messages. */
function sourceLineOf(site) {
  const [, file, line, column] = /^(.*):(\d+):(\d+)$/u.exec(site);
  try {
    const map = new SourceMap(JSON.parse(readFileSync(join(root, `${file}.map`), "utf8")));
    const entry = map.findEntry(Number(line) - 1, Number(column) - 1);
    return `${relative(root, resolve(root, dirname(file), entry.originalSource))}:${entry.originalLine + 1}`;
  } catch {
    return site;
  }
}

/**
 * Runs the compiled `files` at `cwd` with `node:test`, `only` tests alone, one file per run so that a failure is its
 * file's: `{ loadErrors, failures }`, each a map from a file to a first error line. `loadErrors` holds a file that
 * failed to load; `failures` its first failing test or suite too.
 */
async function failuresOf(cwd, files) {
  const loadErrors = new Map();
  const failures = new Map();
  for (const file of files) {
    const stream = run({ cwd, files: [resolve(cwd, file)], only: true });
    let stderr = "";
    stream.on("test:stderr", (event) => {
      stderr += event.message;
    });
    stream.on("test:fail", (event) => {
      const error = event.details?.error;
      const line = String(error?.cause?.message ?? error?.message ?? "").split("\n")[0];
      // a file that fails to load is reported as a failed test named by its path; its error is on its stderr
      if (event.nesting === 0 && resolve(cwd, event.name) === resolve(cwd, file))
        loadErrors.set(file, /^\w*Error\b.*$/mu.exec(stderr)?.[0] ?? line);
      if (!failures.has(file))
        failures.set(file, loadErrors.get(file) ?? `'${event.name}': ${line}`);
    });
    // the stream is read to its end, which comes once the file's process has exited
    for await (const _event of stream);
  }
  return { loadErrors, failures };
}

/** The records a helper run appended to `file`, one JSON object per line. */
const recordsIn = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];

const SCRATCH = /^regression-cases-(\d+)-[0-9a-f]{8}$/u;

/** Removes each scratch folder whose owner process is no longer alive, with its base worktree: what an interrupted run left. */
function sweepScratch() {
  for (const name of readdirSync(tmpdir())) {
    const owner = SCRATCH.exec(name);
    if (owner === null) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if (error.code !== "ESRCH") continue;
      const folder = join(tmpdir(), name);
      spawnSync("git", ["worktree", "remove", "--force", join(folder, "base")], { cwd: root });
      rmSync(folder, { recursive: true, force: true });
    }
  }
  spawnSync("git", ["worktree", "prune"], { cwd: root });
}

async function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const base = option("--base");
  const pr = Number(option("--pr"));
  if (base === undefined || !Number.isInteger(pr) || pr < 1)
    throw new CannotRun(
      "usage: node tools/repository-checks/regression-cases.mjs --base <commit> --pr <number>",
    );

  const changed = git(
    "diff",
    "--name-only",
    "--diff-filter=d",
    `${base}...HEAD`,
    "--",
    ":(glob)tests/**/*.test.ts",
  )
    .split("\n")
    .filter(
      (file) => file !== "" && readFileSync(join(root, file), "utf8").includes("regressionCase"),
    );
  sweepScratch();
  if (changed.length === 0) {
    console.log("regression-cases: no changed test file declares a regression case");
    return 0;
  }

  // a stack frame names the compiled file's positions only without source maps
  if (process.sourceMapsEnabled)
    throw new CannotRun(
      "regression-cases: source maps are on, so stack frames name the sources, not the compiled call sites: run it without --enable-source-maps",
    );
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? "").replace(
    /--enable-source-maps\b/gu,
    "",
  );
  const scratch = join(
    tmpdir(),
    `regression-cases-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  mkdirSync(scratch);
  const worktree = join(scratch, "base");
  try {
    // the head's declarations, by call site
    const listed = join(scratch, "declared.jsonl");
    process.env.REGRESSION_CASES = JSON.stringify({ mode: "list", records: listed });
    const compiled = changed.map(compiledOf);
    const sourceOf = new Map(changed.map((source) => [compiledOf(source), source]));
    const problems = [];
    for (const [file, line] of (await failuresOf(root, compiled)).failures)
      problems.push(
        `${sourceOf.get(file)}: its declarations cannot be listed, as its run at the head failed: ${line}`,
      );
    const declared = recordsIn(listed).map((each) => ({
      ...each,
      site: each.id.replace(/#\d+$/u, ""),
      file: each.id.replace(/:\d+:\d+#\d+$/u, ""),
    }));
    const registered = new Set(declared.map(({ site }) => site));
    const sites = new Set(
      compiled.flatMap((file) => callSitesOf(file, readFileSync(join(root, file), "utf8"))),
    );
    for (const site of sites)
      if (!registered.has(site))
        problems.push(
          `${sourceLineOf(site)}: this regressionCase call did not register at the head: declare it at a file's top level or in a describe that runs, not inside a test or a skipped suite`,
        );
    for (const each of declared) {
      const where = `${sourceLineOf(each.site)}: '${each.name}'`;
      if (!sites.has(each.site))
        problems.push(
          `${where} registered from a call the tool cannot find: call regressionCase by that name`,
        );
      if (!Number.isInteger(each.pr) || each.pr < 1)
        problems.push(
          `${where} declares the pull request ${JSON.stringify(each.pr)}: give the number of the one whose fix it witnesses`,
        );
      if (each.atBase === null || typeof each.atBase.source !== "string")
        problems.push(`${where} declares no regular expression as \`atBase\`: give one`);
      else if (!FLAGS.test(each.atBase.flags))
        problems.push(
          `${where} declares \`atBase\` with the flags '${each.atBase.flags}': only 'i', 'u' and 'v' keep it one whole line, so drop the others`,
        );
    }
    const merged = new Set(
      [...git("log", "--format=%s", base).matchAll(/\(#(\d+)\)$/gmu)].map((match) =>
        Number(match[1]),
      ),
    );
    const own = declared.filter((each) => each.pr === pr);
    const historical = new Set();
    for (const each of declared)
      if (each.pr !== pr && Number.isInteger(each.pr)) {
        if (merged.has(each.pr)) historical.add(each.pr);
        else
          problems.push(
            `${sourceLineOf(each.site)}: '${each.name}' names #${each.pr}, which is neither this pull request (#${pr}) nor one merged into the base: name the pull request whose fix it witnesses`,
          );
      }
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) {
      console.log(
        `regression-cases: ${problems.length} declarations refused; nothing runs at the base`,
      );
      return 1;
    }
    const skipped =
      historical.size > 0
        ? `; historical cases of ${[...historical].map((n) => `#${n}`).join(", ")} not run`
        : "";
    if (own.length === 0) {
      console.log(`regression-cases: ${declared.length} declared cases, none of #${pr}${skipped}`);
      return 0;
    }

    // the base, with the head's tests
    git("worktree", "add", "--quiet", "--detach", worktree, base);
    rmSync(join(worktree, "tests"), { recursive: true, force: true });
    cpSync(join(root, "tests"), join(worktree, "tests"), { recursive: true });
    // and the head's source stamp, which the head's Player test loader imports and the bundles' build adds
    cpSync(join(root, STAMP), join(worktree, STAMP));
    if (!existsSync(join(worktree, "node_modules")))
      symlinkSync(resolve(root, "node_modules"), join(worktree, "node_modules"));
    const build = spawnSync(
      process.execPath,
      [join(root, "node_modules/@typescript/native/bin/tsc"), "-p", "tsconfig.json"],
      { cwd: worktree, encoding: "utf8" },
    );
    if (build.signal !== null || ![0, 1, 2].includes(build.status))
      throw new CannotRun(
        `compiling the base failed (${build.signal ?? `exit ${build.status}`}):\n${build.stderr}`,
      );
    // As `vite build --config` builds them, with the head's stamping plugin added as inline configuration: it writes
    // `sources.json` last, so the head's loader finds a stamp of what was built also at a base from before the plugin.
    const bundles = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const { build } = await import("vite");
const { testModulesSources } = await import(${JSON.stringify(pathToFileURL(join(worktree, STAMP)).href)});
await build({ configFile: "player/vue/vite.test-modules.config.ts", plugins: [testModulesSources()] });`,
      ],
      { cwd: worktree, encoding: "utf8" },
    );
    if (bundles.status !== 0)
      throw new CannotRun(
        `building the base's Player test bundles failed (${bundles.signal ?? `exit ${bundles.status}`}):\n${bundles.stdout}${bundles.stderr}`,
      );
    const recorded = join(scratch, "base.jsonl");
    process.env.REGRESSION_CASES = JSON.stringify({
      mode: "base",
      records: recorded,
      selected: own.map(({ id }) => id),
    });
    const { loadErrors } = await failuresOf(worktree, [...new Set(own.map(({ file }) => file))]);
    const records = new Map();
    for (const { id, ...entry } of recordsIn(recorded))
      records.set(id, { ...records.get(id), ...entry });
    const judged = verdict(own, records, loadErrors);
    const failing = judged.filter(({ verdict: each }) => each !== "witness");
    for (const each of failing)
      console.error(
        `${sourceLineOf(each.site)}: '${each.name}' (#${each.pr}) ${EXPLAINED[each.verdict]}${each.detail ? `: ${each.detail}` : ""}`,
      );
    console.log(
      `regression-cases: ${judged.length - failing.length} of ${judged.length} cases of #${pr} fail at ${base.slice(0, 12)} as they declare${skipped}`,
    );
    return failing.length > 0 ? 1 : 0;
  } finally {
    delete process.env.REGRESSION_CASES;
    spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main)
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof CannotRun ? error.message : (error?.stack ?? String(error)));
      process.exitCode = 2;
    },
  );
