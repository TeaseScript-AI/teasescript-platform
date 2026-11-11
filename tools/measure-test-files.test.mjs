import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// The tool and the helpers it imports, run in a checkout of their own, with `npm` and `gh` faked on the `PATH`.
const TOOLS = [
  "measure-test-files.mjs",
  "test-shards.mjs",
  "test-files-at-once.mjs",
  "costly-test-files.mjs",
];

// The suite: a top-level file and one of the same name in a folder, a type-core file in a folder, a folder whose name
// starts like a type-core file's, and a fixture, which is no test.
const SUITE = ["a", "sub/a", "sub/type-core-z", "type-core-dir/plain", "fixtures/f"];

/** A checkout with the suite's sources and compiled files, the tools, and fakes of `npm` and `gh`; its path. */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), "measure-test-files-"));
  // (a setup that fails removes the checkout, as the test's own cleanup has not started yet)
  try {
    fill(root);
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Fills `root` as `checkout` describes. */
function fill(root) {
  const write = (path, text, mode) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
    if (mode) chmodSync(join(root, path), mode);
  };
  for (const tool of TOOLS) {
    mkdirSync(join(root, "tools"), { recursive: true });
    copyFileSync(new URL(`./${tool}`, import.meta.url), join(root, "tools", tool));
  }
  write("package.json", '{ "type": "module" }\n');
  for (const name of SUITE) {
    write(`tests/${name}.test.ts`, "");
    write(
      `dist/tests/${name}.test.js`,
      'import { test } from "node:test";\ntest("t", () => {});\n',
    );
  }
  // `npm run build` and `npm run check:pretest` pass at once: the files are compiled already.
  write("bin/npm", "#!/bin/sh\nexit 0\n", 0o755);
  // `gh` answers the three requests the tool makes from `gh.json` (each run's pre-test step seconds and test jobs' file
  // seconds), in the real shapes, and fails any other.
  write(
    "bin/gh",
    `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const runs = JSON.parse(readFileSync(${JSON.stringify(join(root, "gh.json"))}, "utf8"));
const args = process.argv.slice(2);
const where = /^repos\\/\\{owner\\}\\/\\{repo\\}\\/actions\\/runs\\/(\\d+)(\\/jobs)?$/.exec(args[1] ?? "");
const start = Date.parse("2026-11-01T00:00:00Z");
// (a run's \`conclusion\` defaults to success; \`failed\` is a test job that failed, \`unstarted\` one that never started)
const steps = (run, n) => n === run.unstarted ? [] : [
  ...(n === run.jobs.length - 1
    ? [{ name: "Check source before the tests", conclusion: "success",
         started_at: new Date(start).toISOString(),
         completed_at: new Date(start + run.pretest * 1000).toISOString() }]
    : []),
  { name: "Build and run tests, shard " + (n + 1) + " of " + run.jobs.length,
    conclusion: n === run.failed ? "failure" : "success" },
];
if (args.join(" ") === "run download " + args[2] + " --pattern test-file-seconds-* --dir " + args[6] && runs[args[2]])
  runs[args[2]].jobs.forEach((seconds, n) => {
    const folder = args[6] + "/test-file-seconds-" + n;
    mkdirSync(folder, { recursive: true });
    writeFileSync(folder + "/test-file-seconds.json", JSON.stringify({ filesAtOnce: 3, seconds }));
  });
else if (args[0] === "api" && where && runs[where[1]] && args.length === 2 && !where[2])
  process.stdout.write(JSON.stringify({ head_sha: where[1].repeat(40).slice(0, 40), conclusion: runs[where[1]].conclusion ?? "success" }));
else if (args[0] === "api" && where && runs[where[1]] && where[2]) {
  const jobs = runs[where[1]].jobs.map((_, n) => ({ steps: steps(runs[where[1]], n) }));
  const query = args.slice(2).join(" ");
  if (query !== "" && query !== "-q .jobs") process.exit(1);
  process.stdout.write(JSON.stringify(query === "" ? { total_count: jobs.length, jobs } : jobs));
} else {
  process.stderr.write("gh fake: unknown request: " + args.join(" ") + "\\n");
  process.exit(1);
}
`,
    0o755,
  );
  for (const args of [
    ["init", "-q"],
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    ],
  ]) {
    const git = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(git.status, 0, `git ${args.join(" ")}: ${git.stderr}`);
  }
}

/** The tool run with `args` in `root`: its exit status, its output, and the module it wrote. */
function measure(root, args) {
  const result = spawnSync(process.execPath, ["tools/measure-test-files.mjs", "--write", ...args], {
    cwd: root,
    encoding: "utf8",
    // (without the runner's `NODE_TEST_CONTEXT`, as the tool's own `run()` would otherwise skip every file)
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"),
      ),
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      // (one file at once, whatever the machine)
      SX_MEM_MIB: "4000",
      // (the tool's temporary folders and compile cache inside the checkout, which the test removes)
      TMPDIR: root,
      NODE_COMPILE_CACHE: join(root, "cache"),
    },
  });
  return {
    status: result.status,
    out: result.stdout + result.stderr,
    module: readFileSync(join(root, "tools/costly-test-files.mjs"), "utf8"),
  };
}

/** The `costlyTestSeconds` entries of a written module. */
const costly = (module) =>
  /export const costlyTestSeconds = \{\n([^}]*)\};/u
    .exec(module)?.[1]
    .trim()
    .split("\n")
    .map((line) => line.trim());

test(
  "a local measurement names each file by its path under dist/tests/ and lists type-core files by their own name",
  { timeout: 60_000 },
  () => {
    const root = checkout();
    try {
      const { status, out, module } = measure(root, []);
      assert.equal(status, 0, out);
      assert.match(out, /measure-test-files: 4 files, /u);
      // (the local runs take well under the listing's 10 s, so only the type-core file is listed)
      // (by name only: a local run's seconds depend on the machine's load)
      assert.deepEqual(
        costly(module).map((line) => line.split(":")[0]),
        [`"sub/type-core-z.test.js"`],
      );
      assert.match(module, /every other test file in the same runs, their mean \(3 files\)/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "--from-ci takes each file's median over the runs, folders' files included, counts a run by its test jobs, and refuses a file no run measured",
  { timeout: 60_000 },
  () => {
    const root = checkout();
    // Three runs of two test jobs each, the last job's pre-test step 100, 120 and 140 s.
    const runs = (missing) =>
      Object.fromEntries(
        [
          // (run 11 lacks `sub/a.test.js`, so its median is that of an even count, 30 and 14)
          [11, 100, [null, 1, 2, 3]],
          [12, 120, [30, 2, 2, 4]],
          [13, 140, [14, 3, 2, 5]],
        ].map(([id, pretest, [subA, a, typeCore, plain]]) => [
          id,
          {
            pretest,
            jobs: [
              { ...(subA === null ? {} : { "sub/a.test.js": subA }), "a.test.js": a },
              Object.fromEntries(
                [
                  ["sub/type-core-z.test.js", typeCore],
                  ["type-core-dir/plain.test.js", plain],
                ].filter(([file]) => file !== missing),
              ),
            ],
          },
        ]),
      );
    try {
      writeFileSync(join(root, "gh.json"), JSON.stringify(runs(null)));
      const { status, out, module } = measure(root, ["--from-ci", "11", "12", "13"]);
      assert.equal(status, 0, out);
      assert.match(module, /--write --from-ci 11 12 13/u);
      // (listed: the file of 10 s or more and the type-core file; the others' mean is that of 2 and 4)
      assert.deepEqual(costly(module), [`"sub/a.test.js": 22,`, `"sub/type-core-z.test.js": 2,`]);
      assert.match(module, /their mean \(2 files\)\. \*\/\nexport const otherTestSeconds = 3\.0;/u);
      assert.match(module, /export const pretestSeconds = 120;/u);
      assert.match(module, /export const testFilesAtOnce = 3;/u);

      writeFileSync(join(root, "gh.json"), JSON.stringify(runs("type-core-dir/plain.test.js")));
      const before = readFileSync(join(root, "tools/costly-test-files.mjs"), "utf8");
      const refused = measure(root, ["--from-ci", "11", "12", "13"]);
      assert.equal(refused.status, 1, refused.out);
      assert.match(refused.out, /no CI run measured type-core-dir\/plain\.test\.js/u);
      assert.equal(refused.module, before);

      // A run counts by its test jobs, whatever its own conclusion, and is refused when one failed or never started.
      const counted = runs(null);
      counted[12].conclusion = "cancelled";
      writeFileSync(join(root, "gh.json"), JSON.stringify(counted));
      const cancelled = measure(root, ["--from-ci", "11", "12", "13"]);
      assert.equal(cancelled.status, 0, cancelled.out);
      assert.match(cancelled.out, /run 12 ended cancelled, but its 2 test steps passed: counted/u);
      assert.deepEqual(costly(cancelled.module), costly(module));
      for (const [field, value] of [
        ["failed", 1],
        ["unstarted", 0],
      ]) {
        const broken = runs(null);
        Object.assign(broken[13], { conclusion: "failure", [field]: value });
        writeFileSync(join(root, "gh.json"), JSON.stringify(broken));
        const one = measure(root, ["--from-ci", "11", "12", "13"]);
        assert.equal(one.status, 1, `${field}: ${one.out}`);
        assert.match(one.out, /run 13's test steps did not all pass \(run failure\)/u, field);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
