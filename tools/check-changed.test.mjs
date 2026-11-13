import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import {
  PLAYER_BROWSER_SMOKE,
  PROJECTS,
  UNKNOWN_TO_COSTLY,
  checksOf,
  projectsFor,
  removeTemporaryWorktree,
  unknownToCostly,
} from "./check-changed.mjs";
import { BOUND_SECONDS, bounded, runSync, slowReader, waitFor } from "./runner-test-support.mjs";
import { environment, leftovers, repository, tool } from "./check-changed-test-support.mjs";

// A representative changed path for each project, and the projects it alone claims; every path but documentation also
// needs `oxlint-rules`, whose `test:lint` runs for every such change (#2431).
const REPRESENTATIVES = {
  typescript: ["src/compiler.ts", ["typescript"]],
  "player-vue": ["player/vue/src/shell/PlayerApp.vue", ["player-vue"]],
  "oxlint-rules": ["tools/oxlint/run.mjs", ["oxlint-rules"]],
  tools: ["tools/test-shards.mjs", ["tools"]],
  "repository checks": ["tools/repository-checks/regression-cases.mjs", ["tools"]],
  families: [
    "tests/families/copies/copy-admission/named-and-nested-composite-admission.mjs",
    ["families"],
  ],
  fixtures: ["tests/fixtures/type-core/cells.jsonl", ["typescript"]],
  documentation: ["docs/TESTING.md", []],
  // root configuration files, each needing the projects whose checks read it
  "root tsconfig": ["tsconfig.json", ["typescript", "oxlint-rules", "design-lint"]],
  "Player tsconfig": ["player/vue/tsconfig.json", ["player-vue", "design-lint"]],
  "knip config": ["knip.json", ["tools"]],
  formatting: [".prettierrc.json", ["formatting"]],
  "Prettier ignore file": [".prettierignore", ["formatting"]],
  "design-lint": ["eslint.design.config.mjs", ["design-lint"]],
  // (which test:lint reads: turning a rule off there fails its rule tests, Sol's final on #2434)
  "oxlint config": [".oxlintrc.json", []],
  // (which test:lint runs its rule tests through, #2402)
  "test:lint's output filter": ["tools/test-output-filter.mjs", ["tools"]],
  unknown: [".github/workflows/ci.yml", Object.keys(PROJECTS)],
  "package manifest": ["package.json", Object.keys(PROJECTS)],
};

test("each changed path needs its project's checks and, but for documentation, test:lint's; an unknown path every project's", () => {
  // Every project has a representative, so a new project cannot go unchecked here.
  for (const name of Object.keys(PROJECTS))
    assert.ok(name in REPRESENTATIVES, `${name} has a representative`);
  const kinds = Object.entries(REPRESENTATIVES).map(([kind, [path, claimed]]) => [
    kind,
    [path, kind === "documentation" ? claimed : [...new Set([...claimed, "oxlint-rules"])]],
  ]);
  for (const [kind, [path, expected]] of kinds)
    assert.deepEqual([...projectsFor([path])].sort(), [...expected].sort(), kind);
  // Each pair of kinds needs the union of what each needs alone.
  for (const [first, [firstPath, firstExpected]] of kinds)
    for (const [second, [secondPath, secondExpected]] of kinds)
      assert.deepEqual(
        [...projectsFor([firstPath, secondPath])].sort(),
        [...new Set([...firstExpected, ...secondExpected])].sort(),
        `${first} with ${second}`,
      );
  assert.deepEqual([...projectsFor([])], []);
  // `player/` outside `player/vue/` belongs to the TypeScript project, and `player/vue/` only to the Player's.
  assert.deepEqual(
    [...projectsFor(["player/runtime/runtime-adapter.ts"])],
    ["typescript", "oxlint-rules"],
  );
  assert.deepEqual(
    [...projectsFor(["player/vue/src/session/usePlayerSession.ts"])],
    ["player-vue", "oxlint-rules"],
  );
  // documentation alone needs nothing, and beside a path that needs test:lint changes nothing
  assert.deepEqual([...projectsFor(["docs/TESTING.md", "README.md"])], []);
  // A check that several projects name runs once: `lint:design` is the Player's and the design lint's.
  const everyCheck = checksOf(projectsFor([".github/workflows/ci.yml"]));
  assert.deepEqual(everyCheck, [
    ...new Set(Object.values(PROJECTS).flatMap(({ checks }) => checks)),
  ]);
  assert.equal(everyCheck.filter((check) => check === "lint:design").length, 1);
});

test("--merged checks the merge in a temporary worktree and removes it", () => {
  const { directory, worktrees } = repository();
  const before = leftovers();
  try {
    const result = runSync(process.execPath, [tool, "--merged", "--base", "main"], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.match(result.stdout, /the merge of HEAD \(\w+\) into main/u, result.stderr);
    assert.match(result.stdout, /1 changed files/u);
    assert.equal(worktrees(), 1, "only the repository's own worktree is left");
    assert.deepEqual(leftovers(), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("--merged names a conflict, exits 2 and leaves no worktree", () => {
  const { directory, worktrees } = repository({ conflict: true });
  try {
    const result = runSync(process.execPath, [tool, "--merged", "--base", "main"], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /does not merge into main .*a\.mjs/u);
    assert.doesNotMatch(result.stdout, /PASS|FAIL/u);
    assert.equal(worktrees(), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a signal during --merged stops the checks and removes the worktree; more during that cleanup change nothing (#2106)", async (t) => {
  // (a git whose worktree removal marks its start and waits for the test's release, so the signals land during it)
  const slowGit = mkdtempSync(join(tmpdir(), "check-changed-slow-git-"));
  const git = runSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    join(slowGit, "git"),
    `#!/bin/sh\ncase "$*" in *"worktree remove"*) : > "${slowGit}/removing"; i=0; ` +
      `while [ ! -e "${slowGit}/release" ]; do i=$((i + 1)); [ "$i" -gt ${BOUND_SECONDS * 50} ] && exit 1; ` +
      `sleep 0.02; done;; esac\nexec ${git} "$@"\n`,
  );
  chmodSync(join(slowGit, "git"), 0o755);
  try {
    for (const more of [false, true]) {
      const { directory, worktrees } = repository({ slowOxlint: true });
      rmSync(join(slowGit, "removing"), { force: true });
      rmSync(join(slowGit, "release"), { force: true });
      try {
        const child = spawn(process.execPath, [tool, "--merged", "--base", "main"], {
          cwd: directory,
          env: { ...environment, PATH: `${slowGit}:${environment.PATH}` },
          stdio: ["ignore", "pipe", "pipe"],
        });
        t.after(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        const closed = new Promise((done) => child.on("close", done));
        // (the worktree exists once the merge line is out)
        await waitFor("the merge's worktree", () => output.includes("the merge of HEAD"), child);
        child.kill("SIGTERM");
        await waitFor(
          "the worktree's removal to start",
          () => existsSync(join(slowGit, "removing")),
          child,
        );
        // (three more while the removal waits: a process that stopped handling them would die of one)
        if (more)
          for (let index = 0; index < 3; index += 1) {
            child.kill("SIGTERM");
            await new Promise((wait) => setTimeout(wait, 20));
          }
        writeFileSync(join(slowGit, "release"), "");
        assert.equal(await bounded(closed, "check-changed to end"), 143, output);
        // (its last line still says what ran: oxlint, which waits, was stopped, so it did not run: #2106)
        const last = output.trimEnd().split("\n").at(-1);
        assert.match(
          last,
          /^check-changed: ran: [^;]*; failed: [^;]*; not run: (?:[^;]+, )?oxlint, (?:[^;]+, )?the compiled test suite \(CI runs it\)$/u,
          `${more ? "more signals" : "one signal"}: ${output}`,
        );
        assert.equal(output.split(last).length, 2, output);
        assert.doesNotMatch(last.split("; not run:")[0], /oxlint/u);
        assert.equal(worktrees(), 1);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(slowGit, { recursive: true, force: true });
  }
});

test("only a registered temporary worktree of check-changed is ever removed", () => {
  const { directory } = repository();
  const elsewhere = mkdtempSync(join(tmpdir(), "not-check-changed-"));
  const unregistered = mkdtempSync(join(tmpdir(), "check-changed-merged-"));
  try {
    for (const path of [elsewhere, unregistered, `${unregistered}/../${basename(elsewhere)}`]) {
      assert.match(removeTemporaryWorktree(path, directory), /is not a/u, path);
      assert.ok(existsSync(path), `${path} was left`);
    }
  } finally {
    for (const path of [directory, elsewhere, unregistered])
      rmSync(path, { recursive: true, force: true });
  }
});

test("a change to the type core prints the pin-suite mapper's list, plain and merged, a deletion and a move out of it too, and another change does not run it", () => {
  for (const merged of [false, true])
    for (const core of ["added", "deleted", "renamed", false]) {
      const { directory } = repository({ core });
      try {
        const result = runSync(
          process.execPath,
          [tool, ...(merged ? ["--merged"] : []), "--base", "main"],
          { cwd: directory, encoding: "utf8", env: environment },
        );
        const base = runSync("git", ["merge-base", "HEAD", "main"], {
          cwd: directory,
          encoding: "utf8",
        }).stdout.trim();
        const at = `${merged ? "merged" : "plain"}, ${core || "no core change"}`;
        if (core) {
          assert.match(
            result.stdout,
            /^PASS {2}pin suites +\d+\.\ds$/mu,
            `${at}: ${result.stderr}`,
          );
          assert.match(
            result.stdout,
            new RegExp(`--- pin suites ---\\nlisted for --base ${base}\\n`, "u"),
            at,
          );
        } else assert.doesNotMatch(result.stdout, /pin suites/u, at);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
});

test("a deleted path and both sides of a move select their projects as a changed one does, plain and merged; documentation still none (#2431)", () => {
  // (each change alone, on a commit holding every path it deletes or moves)
  const kept = [
    "tools/test-file-counts.mjs",
    "src/a.ts",
    "player/vue/b.ts",
    "docs/c.md",
    "docs/é.md",
    'docs/a"quote.md',
  ];
  const changes = {
    "a deleted tool": [["rm", "-q", "tools/test-file-counts.mjs"], "oxlint-rules, tools"],
    "a deleted source": [["rm", "-q", "src/a.ts"], "typescript, oxlint-rules"],
    "a move out of the Player": [
      ["mv", "player/vue/b.ts", "src/b.ts"],
      "typescript, player-vue, oxlint-rules",
    ],
    "deleted documentation": [["rm", "-q", "docs/c.md"], "none"],
    // (named as they are: Git's other output quotes them, `"docs/\303\251.md"`, which is no documentation path)
    "deleted documentation with a non-ASCII name": [["rm", "-q", "docs/é.md"], "none"],
    "deleted documentation with a quote in its name": [["rm", "-q", 'docs/a"quote.md'], "none"],
  };
  for (const merged of [false, true])
    for (const [name, [change, projects]] of Object.entries(changes)) {
      const { directory } = repository({ passing: true });
      const git = (...args) => runSync("git", args, { cwd: directory, encoding: "utf8" });
      try {
        for (const path of kept) {
          mkdirSync(dirname(join(directory, path)), { recursive: true });
          writeFileSync(join(directory, path), "export {};\n");
        }
        git("add", ".");
        git("commit", "-q", "-m", "the paths the change deletes or moves");
        git("branch", "-q", "base");
        git(...change);
        git("commit", "-q", "-m", name);
        const result = runSync(
          process.execPath,
          [tool, ...(merged ? ["--merged"] : []), "--base", "base"],
          { cwd: directory, encoding: "utf8", env: environment },
        );
        assert.match(
          result.stdout,
          new RegExp(
            `^check-changed: ${change[0] === "mv" ? 2 : 1} changed files since base \\([0-9a-f]{9}\\); projects: ${projects}$`,
            "mu",
          ),
          `${merged ? "merged" : "plain"}, ${name}: ${result.stdout}${result.stderr}`,
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
});

test("an untracked path is read as it is named: a quoted or non-ASCII name selects as its path does (#2431)", () => {
  const cases = { 'docs/a"quote é.md': "none", 'tools/a"quote é.mjs': "oxlint-rules, tools" };
  for (const [path, projects] of Object.entries(cases)) {
    const { directory } = repository({ passing: true });
    try {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), "export {};\n");
      const result = runSync(process.execPath, [tool, "--base", "HEAD"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.match(
        result.stdout,
        new RegExp(
          `^check-changed: 1 changed files since HEAD \\([0-9a-f]{9}\\); projects: ${projects}$`,
          "mu",
        ),
        `${path}: ${result.stdout}${result.stderr}`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("the pin-suite mapper's verdict alone decides a run whose other checks pass, its output printed", () => {
  for (const fails of [false, true]) {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: fails ? 'console.error("no merge-base"); process.exitCode = 2;\n' : "",
    });
    try {
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert.deepEqual(
        result.stdout.match(/^FAIL {2}\S.*$/gmu)?.map((line) => line.split(/ {2,}/u)[1]) ?? [],
        fails ? ["pin suites"] : [],
      );
      // (its stdout and stderr arrive in either order)
      if (fails) assert.match(result.stdout, /--- pin suites ---\n[^]*no merge-base\n/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a changed type-core test file that costly-test-files does not list prints one line, and fails nothing (#2088)", () => {
  assert.equal(
    UNKNOWN_TO_COSTLY,
    "unknown to costly-test-files: run in full; the entry lands from CI at merge",
  );
  // (only a type-core test file the table lacks is unknown: the table lists every one, and another file only at 10 s
  // or more)
  assert.deepEqual(
    unknownToCostly([
      "tests/type-core-unlisted.test.ts",
      "tests/type-core/type-core-written-decider.test.ts",
      "tests/unlisted-other.test.ts",
      "tests/helpers/type-core-unlisted.ts",
      "src/type-inference/core/type-core-unlisted.test.ts",
    ]),
    ["tests/type-core-unlisted.test.ts"],
  );
  for (const file of [
    "tests/type-core-unlisted.test.ts",
    "tests/type-core/type-core-written-decider.test.ts",
  ]) {
    const { directory } = repository({ passing: true });
    try {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), "\n");
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const lines = result.stdout.split("\n").filter((line) => line.includes(UNKNOWN_TO_COSTLY));
      assert.deepEqual(
        lines,
        file.includes("unlisted") ? [`${file}: ${UNKNOWN_TO_COSTLY}`] : [],
        result.stdout + result.stderr,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("its last line names what ran, what failed, and what it did not run: the checks no changed path needs and the compiled suite (#2106)", () => {
  for (const fails of [false, true]) {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: fails ? "process.exitCode = 1;\n" : "",
    });
    try {
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      assert.equal(
        result.stdout.trimEnd().split("\n").at(-1),
        "check-changed: ran: diff --check, merge commits, format, oxlint, knip, doc links, imports, pin suites, tsc, test:lint; " +
          `failed: ${fails ? "pin suites" : "none"}; ` +
          "not run: test:families, typecheck:player, lint:design, test:verification, format:check, " +
          "test:lint:design, the compiled test suite (CI runs it)",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("a change under player/ or tests/fixtures/packages/ adds the browser smoke to what its last line did not run, and its verdict stays (#2484)", () => {
  const lastLine = (changed) => {
    const { directory } = repository({ passing: true, changed });
    try {
      const result = runSync(process.execPath, [tool, "--base", "main"], {
        cwd: directory,
        encoding: "utf8",
        env: environment,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return result.stdout.trimEnd().split("\n").at(-1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const elsewhere = lastLine("src/compiler.ts");
  assert.ok(!elsewhere.includes("browser smoke"), elsewhere);
  for (const changed of ["player/runtime-adapter.ts", "tests/fixtures/packages/garden/helper.ts"])
    assert.equal(lastLine(changed), `${elsewhere}, ${PLAYER_BROWSER_SMOKE}`, changed);
});

test(
  "a signal while the last line waits for a slow reader changes neither the verdict nor the last line, which comes once (#2106)",
  { skip: process.platform === "win32" },
  async (t) => {
    const { directory } = repository({
      core: "added",
      passing: true,
      mapper: "process.exitCode = 1;\n",
    });
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    // (the FIFO's and the preload's own files are no change)
    writeFileSync(
      join(directory, ".git", "info", "exclude"),
      "stdout.fifo\nmark-last-line.mjs\nlast-line\n",
    );
    const result = await slowReader(t, {
      cwd: directory,
      args: [tool, "--base", "main"],
      env: environment,
      signalsBefore: false,
    });
    const last =
      "check-changed: ran: diff --check, merge commits, format, oxlint, knip, doc links, imports, pin suites, tsc, test:lint; " +
      "failed: pin suites; not run: test:families, typecheck:player, lint:design, test:verification, " +
      "format:check, test:lint:design, the compiled test suite (CI runs it)";
    const at = result.stdout + result.stderr;
    assert.deepEqual([result.code, result.signal], [1, null], at);
    assert.ok(result.stdout.endsWith(`\n${last}\n`), at);
    assert.equal(result.stdout.split(last).length, 2, at);
  },
);
