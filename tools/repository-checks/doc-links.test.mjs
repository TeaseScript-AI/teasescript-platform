import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The wrapper's own part: Git's file list, remark's configuration and arguments, the exit status and its messages.
// remark-validate-links' own suite covers how it reads links.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./doc-links.mjs", import.meta.url));
const { remarkConfig } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));

/** Writes `files` (path to text) under `root`. */
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A checkout holding `files`, committed, with the repository's `remarkConfig` and `node_modules`; its folder. */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  write(root, {
    ".gitignore": "node_modules\nignored/\n",
    "package.json": JSON.stringify({ type: "module", remarkConfig }),
    ...files,
  });
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "docs");
  return root;
}

const run = (root) => spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });

test("the Markdown Git tracks or does not ignore is checked, with the root configuration only, and a broken link fails the run", () => {
  const root = checkout({
    "README.md": "# Title\n\n[part](docs/a.md#part) and [gone](gone.md)\n",
    "docs/a.md": "# A\n\n## Part\n\n[back](../README.md#title)\n",
    "gone.md": "# Gone\n",
    ".github/notes.md": "[missing](../docs/a.md#missing)\n",
    // configurations that would drop the validator for their folder, and an ignore file remark would obey
    "nested/.remarkrc": '{"plugins":[]}',
    "nested/x.md": "[bad](missing.md)\n",
    "pkg/package.json": '{"remarkConfig":{"plugins":[]}}',
    "pkg/y.md": "[bad](missing.md)\n",
    ".remarkignore": "skipped.md\n",
    "skipped.md": "[bad](missing.md)\n",
    // a name remark-cli would read as an option
    "--version=.md": "[bad](missing.md)\n",
  });
  try {
    // a tracked symlink named `*.md` to a folder Git ignores: remark would read the folder's files
    write(root, { "ignored/inside.md": "[bad](missing.md)\n" });
    symlinkSync("ignored", join(root, "linked.md"));
    execFileSync("git", ["add", "linked.md"], { cwd: root });
    // a tracked file deleted from the working tree, an ignored file and an untracked one
    rmSync(join(root, "gone.md"));
    write(root, {
      "ignored/x.md": "[nowhere](nowhere.md)\n",
      "new.md": "[nope](docs/a.md#nope)\n",
    });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const lines = result.stderr.split("\n");
    // remark names each file it reports on, alone on a line: not the ignored ones, the deleted one or the symlink's
    const reported = lines.filter((line) => /^\S+\.md$/u.test(line)).sort();
    assert.deepEqual(
      reported,
      [
        "--version=.md",
        ".github/notes.md",
        "README.md",
        "nested/x.md",
        "new.md",
        "pkg/y.md",
        "skipped.md",
      ],
      result.stderr,
    );
    assert.match(result.stderr, /Cannot find file `gone\.md`/u);
    assert.equal(
      lines.findLast((line) => line !== ""),
      "doc-links: remark reports the problems above (exit 1): fix each link, or the file or heading it names",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose links all resolve passes and names how many files it read", () => {
  const root = checkout({
    "README.md": "# Title\n\n[part](docs/a.md#part)\n",
    "docs/a.md": "# A\n\n## Part\n\n[back](../README.md#title)\n",
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.stdout,
      "doc-links: remark reports no unresolved relative link or heading anchor in 2 Markdown files\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A checkout with a stand-in `remark` that records how it was started and ends as `REMARK_ENDS` says. */
function launcher(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-launch-"));
  write(root, {
    ".gitignore": "node_modules\nstarted.json\n",
    "node_modules/.bin/remark": `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync("started.json", JSON.stringify({ argv: process.argv.slice(2), node: process.execPath, path: process.env.PATH }));
const ends = process.env.REMARK_ENDS ?? "0";
if (ends.startsWith("SIG")) process.kill(process.pid, ends);
else process.exit(Number(ends));
`,
    ...files,
  });
  chmodSync(join(root, "node_modules/.bin/remark"), 0o755);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "docs");
  return root;
}

const gitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const launch = (root, ends = "0") =>
  spawnSync(process.execPath, [tool], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, REMARK_ENDS: ends },
  });

test("remark is started with the pinned options, on this Node, and its end decides the status", () => {
  const root = launcher({ "a.md": "# A\n", "b/c.md": "# C\n" });
  try {
    const passed = launch(root);
    assert.equal(passed.status, 0, passed.stderr);
    assert.equal(
      passed.stdout,
      "doc-links: remark reports no unresolved relative link or heading anchor in 2 Markdown files\n",
    );
    const started = JSON.parse(readFileSync(join(root, "started.json"), "utf8"));
    assert.deepEqual(started.argv, [
      "--frail",
      "--quiet",
      "--no-stdout",
      "--no-color",
      "--rc-path",
      "package.json",
      "--no-ignore",
      "--",
      "a.md",
      "b/c.md",
    ]);
    assert.equal(started.node, process.execPath);
    assert.deepEqual(started.path.split(delimiter).slice(0, 2), [
      join(root, "node_modules/.bin"),
      dirname(process.execPath),
    ]);

    const failed = launch(root, "3");
    assert.equal(failed.status, 1);
    assert.equal(
      failed.stderr,
      "doc-links: remark reports the problems above (exit 3): fix each link, or the file or heading it names\n",
    );
    const killed = launch(root, "SIGTERM");
    assert.equal(killed.status, 2);
    assert.equal(killed.stderr, "doc-links: remark-cli did not run: SIGTERM\n");
    rmSync(join(root, "node_modules/.bin/remark"));
    const missing = spawnSync(process.execPath, [tool], {
      cwd: root,
      encoding: "utf8",
      // this Node and Git, and no other `remark`
      env: { ...process.env, PATH: [dirname(process.execPath), dirname(gitPath)].join(delimiter) },
    });
    assert.equal(missing.status, 2);
    assert.equal(missing.stderr, "doc-links: remark-cli did not run: spawnSync remark ENOENT\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("with no Markdown remark is not started, and outside a Git checkout the run cannot list its files", () => {
  const root = launcher({});
  const outside = mkdtempSync(join(tmpdir(), "doc-links-outside-"));
  try {
    const empty = launch(root);
    assert.deepEqual([empty.status, empty.stdout], [0, "doc-links: no Markdown files\n"]);
    assert.equal(existsSync(join(root, "started.json")), false);
    const noGit = spawnSync(process.execPath, [tool], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) },
    });
    assert.equal(noGit.status, 2);
    assert.match(noGit.stderr, /^doc-links: cannot list the Markdown files with Git: /u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
