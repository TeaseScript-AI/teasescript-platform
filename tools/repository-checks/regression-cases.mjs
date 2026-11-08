import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "node:test";
import { fileURLToPath } from "node:url";

// Runs the regression cases a pull request declares (`tests/helpers/regression-case.ts`) against its base, and refuses
// each that does not fail there with the failure it declares (CI, on pull requests, after a test job's build):
//
//   node tools/repository-checks/regression-cases.mjs --base <base commit> --pr <number>
//
// In the head's checkout, after its `npm run build:typescript`:
// 1. The changed test files are those `git diff --diff-filter=d <base>...HEAD` names under `tests/` as `*.test.ts`; if
//    none mentions `regressionCase`, it ends.
// 2. The head's compiled files run with `REGRESSION_CASES=list:…`, which registers each case alone and records its
//    declaration without running it. A declaration must have a whole `pr` of 1 or more, an `atBase` without the `g` or
//    `y` flag, and a name its file has once.
// 3. A case of `--pr` is checked. A case of another pull request is one merged into the base (a commit subject ending
//    `(#N)` in `git log <base>`) and is skipped; any other number is refused.
// 4. A detached worktree of the base gets the head's `tests/` in place of its own and the head's `node_modules`. It is
//    compiled with `tsc` (which emits despite type errors, as a test naming what the fix adds has one at the base), and
//    its Player test bundles, which `tests/helpers/player-modules.ts` loads, are built with
//    `vite build --config player/vue/vite.test-modules.config.ts`. Its compiled files run with `REGRESSION_CASES=base`,
//    each case alone; `node:test`'s own events give each outcome.
// 5. `verdict` judges each case: a witness when it failed in its own code with an error whose message's first line
//    `atBase` matches whole. Anything else is not: it passed, failed for another reason, did not finish (cancelled,
//    timed out, a hook failed), or did not run (no event, as when its file does not load at the base).
//
// Bounded: a case that loads a module the head adds to the bundles' list fails at the base with `Cannot find module`,
// reported as another reason than `atBase` names; and the base is compiled and bundled with the head's `node_modules`.
//
// Exit status: 0 when every checked case is a witness, 1 when one is not or a declaration is refused, 2 when it cannot
// run (a missing option, a base it cannot check out, compile or bundle).

const root = process.cwd();

/** What to undo when the run ends, also on a signal: the base worktree and the scratch folder. */
const cleanups = [];
const cleanUp = () => {
  for (const step of cleanups.splice(0).reverse()) step();
};

/** Why a run cannot go on: exit 2. */
class CannotRun extends Error {}

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The compiled file of a test source: `tests/x.test.ts` as `dist/tests/x.test.js`. */
const compiledOf = (source) => `dist/${source.replace(/\.ts$/u, ".js")}`;

/**
 * Each case's verdict from the base's outcomes: `{ ...case, verdict, detail }`, `verdict` one of `witness`, `passed`,
 * `other failure`, `did not finish` and `did not run`. `outcomes` maps a case's key (`file` and `name`) to
 * `{ passed }` or `{ failureType, line }`; `loadErrors` maps a file to the first line of the error it failed to load
 * with.
 */
export function verdict(cases, outcomes, loadErrors) {
  return cases.map((each) => {
    const outcome = outcomes.get(`${each.file}\n${each.name}`);
    if (outcome === undefined)
      return {
        ...each,
        verdict: "did not run",
        detail: loadErrors.get(each.file) ?? "no outcome for it at the base",
      };
    if (outcome.passed) return { ...each, verdict: "passed", detail: "" };
    if (outcome.failureType !== "testCodeFailure")
      return { ...each, verdict: "did not finish", detail: outcome.failureType };
    const pattern = new RegExp(`^(?:${each.atBase.source})$`, each.atBase.flags);
    return pattern.test(outcome.line)
      ? { ...each, verdict: "witness", detail: outcome.line }
      : { ...each, verdict: "other failure", detail: outcome.line };
  });
}

/** The explanation of each verdict but `witness`, in the line a case that is not one gets. */
const EXPLAINED = {
  passed: "passed at the base, so it does not witness the defect",
  "other failure":
    "failed at the base for another reason than `atBase` names; its error's first line",
  "did not finish": "did not finish at the base",
  "did not run": "did not run at the base",
};

/**
 * Runs the compiled `files` at `cwd` with `node:test`, each `regressionCase` alone (`only`), and collects each test's
 * outcome by its file (as given, relative to `cwd`) and full name, and each file's load error.
 */
async function outcomesOf(cwd, files) {
  const outcomes = new Map();
  const loadErrors = new Map();
  // one run per file: an event names the file where \`test()\` was called, which for a case is the helper's
  for (const file of files) {
    const stream = run({ cwd, files: [resolve(cwd, file)], only: true });
    const stack = [];
    const nameOf = (event) => {
      stack.length = event.nesting;
      stack.push(event.name);
      return stack.join(" > ");
    };
    let stderr = "";
    stream.on("test:stderr", (event) => {
      stderr += event.message;
    });
    stream.on("test:start", nameOf);
    stream.on("test:pass", (event) => outcomes.set(`${file}\n${nameOf(event)}`, { passed: true }));
    stream.on("test:fail", (event) => {
      const error = event.details?.error;
      const line = String(error?.cause?.message ?? error?.message ?? "").split("\n")[0];
      // a file that fails to load is reported as a failed test named by its path; its error is on its stderr
      if (event.nesting === 0 && resolve(cwd, event.name) === resolve(cwd, file))
        loadErrors.set(file, /^\w*Error\b.*$/mu.exec(stderr)?.[0] ?? line);
      outcomes.set(`${file}\n${nameOf(event)}`, {
        passed: false,
        failureType: error?.failureType ?? "unknown",
        line,
      });
    });
    // the stream is read to its end, which comes once the file's process has exited
    for await (const _event of stream);
  }
  return { outcomes, loadErrors };
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
  if (changed.length === 0) {
    console.log("regression-cases: no changed test file declares a regression case");
    return 0;
  }

  // the head's declarations
  const scratch = mkdtempSync(join(tmpdir(), "regression-cases-"));
  cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
  try {
    const listFile = join(scratch, "cases.jsonl");
    appendFileSync(listFile, "");
    process.env.REGRESSION_CASES = `list:${listFile}`;
    const sourceOf = new Map(changed.map((source) => [compiledOf(source), source]));
    await outcomesOf(root, [...sourceOf.keys()]);
    const declared = readFileSync(listFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    const problems = [];
    const seen = new Set();
    for (const each of declared) {
      const where = `${sourceOf.get(each.file) ?? each.file}: '${each.name}'`;
      if (!Number.isInteger(each.pr) || each.pr < 1)
        problems.push(
          `${where} declares the pull request ${each.pr}: give the number of the one whose fix it witnesses`,
        );
      if (/[gy]/u.test(each.atBase.flags))
        problems.push(
          `${where} declares \`atBase\` with the flag 'g' or 'y', which keep state between matches: drop it`,
        );
      const key = `${each.file}\n${each.name}`;
      if (seen.has(key))
        problems.push(`${where} is declared twice in its file: give each case its own name`);
      seen.add(key);
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
            `${sourceOf.get(each.file) ?? each.file}: '${each.name}' names #${each.pr}, which is neither this pull request (#${pr}) nor one merged into the base: name the pull request whose fix it witnesses`,
          );
      }
    for (const problem of problems) console.error(problem);
    const skipped =
      historical.size > 0
        ? `; historical cases of ${[...historical].map((n) => `#${n}`).join(", ")} skipped`
        : "";
    if (own.length === 0) {
      console.log(`regression-cases: ${declared.length} declared cases, none of #${pr}${skipped}`);
      return problems.length > 0 ? 1 : 0;
    }

    // the base, with the head's tests
    const worktree = join(scratch, "base");
    git("worktree", "add", "--quiet", "--detach", worktree, base);
    cleanups.push(() =>
      spawnSync("git", ["worktree", "remove", "--force", worktree], { cwd: root }),
    );
    rmSync(join(worktree, "tests"), { recursive: true, force: true });
    cpSync(join(root, "tests"), join(worktree, "tests"), { recursive: true });
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
    const bundles = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "player/vue/vite.test-modules.config.ts",
      ],
      { cwd: worktree, encoding: "utf8" },
    );
    if (bundles.status !== 0)
      throw new CannotRun(
        `building the base's Player test bundles failed (${bundles.signal ?? `exit ${bundles.status}`}):\n${bundles.stdout}${bundles.stderr}`,
      );
    process.env.REGRESSION_CASES = "base";
    const files = [...new Set(own.map(({ file }) => file))];
    const { outcomes, loadErrors } = await outcomesOf(worktree, files);
    const judged = verdict(own, outcomes, loadErrors);
    const failing = judged.filter(({ verdict: each }) => each !== "witness");
    for (const each of failing)
      console.error(
        `${sourceOf.get(each.file) ?? each.file}: '${each.name}' (#${each.pr}) ${EXPLAINED[each.verdict]}${each.detail ? `: ${each.detail}` : ""}`,
      );
    console.log(
      `regression-cases: ${judged.length - failing.length} of ${judged.length} cases of #${pr} fail at ${base.slice(0, 12)} as they declare${skipped}`,
    );
    return failing.length > 0 || problems.length > 0 ? 1 : 0;
  } finally {
    delete process.env.REGRESSION_CASES;
    cleanUp();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ])
    process.once(signal, () => {
      cleanUp();
      process.exit(code);
    });
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof CannotRun ? error.message : (error?.stack ?? String(error)));
      process.exitCode = 2;
    },
  );
}
