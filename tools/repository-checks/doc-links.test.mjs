import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isolateGit } from "../fixture-git.mjs";

isolateGit();

// The wrapper's own part: Git's file list as the files remark reads, no configuration or ignore file of remark's, the
// exit status and its messages. remark-validate-links' own suite covers how it reads links.

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const tool = fileURLToPath(new URL("./doc-links.mjs", import.meta.url));

/** Writes `files` (path to text) under `root`. */
function write(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/**
 * A Git checkout holding `files`, committed, with the repository's `node_modules`, so that a remark configuration in it
 * would resolve the same plugins the wrapper uses; its folder and its `git`.
 */
function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), "doc-links-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  write(root, { ".gitignore": "node_modules\nignored/\nb.md\n", ...files });
  symlinkSync(join(repositoryRoot, "node_modules"), join(root, "node_modules"));
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "docs");
  return { root, git };
}

const run = (root) => spawnSync(process.execPath, [tool], { cwd: root, encoding: "utf8" });
/** The files remark names in its report, each alone on a line. */
const reported = (stderr) =>
  stderr
    .split("\n")
    .filter((line) => /^[^ ]\S*\.md$/u.test(line))
    .sort();
const BROKEN = "[bad](missing.md)\n";
/**
 * A remark configuration that would change the run: the validator off, and a plugin that is not installed, which fails
 * every file it applies to.
 */
const CONFIGURED = {
  plugins: [["remark-validate-links", false], "remark-plugin-that-is-not-installed"],
};

test("remark reads exactly Git's regular Markdown files, with no configuration or ignore file of its own", () => {
  const { root, git } = checkout({
    "README.md": "# Title\n\n[part](docs/a.md#part) and [gone](gone.md)\n",
    "docs/a.md": "# A\n\n## Part\n\n[back](../README.md#title)\n",
    "gone.md": "# Gone\n",
    ".github/notes.md": "[missing](../docs/a.md#missing)\n",
    // a root configuration that would change the run, nested ones, and an ignore file: none is read
    "package.json": JSON.stringify({ type: "module", remarkConfig: CONFIGURED }),
    "nested/.remarkrc": JSON.stringify(CONFIGURED),
    "nested/x.md": BROKEN,
    "pkg/package.json": JSON.stringify({ remarkConfig: CONFIGURED }),
    "pkg/y.md": BROKEN,
    ".remarkignore": "skipped.md\n",
    "skipped.md": BROKEN,
    // names an option parser or a glob would read otherwise: each is one file
    "--version=.md": BROKEN,
    "[ab].md": BROKEN,
    "star*.md": BROKEN,
    // a name starting with U+FEFF, which a decoder drops by default
    "\ufeffbom.md": BROKEN,
  });
  try {
    // what Git does not list, or lists as no regular file: an ignored `b.md`, which a glob of `[ab].md` would match, a
    // symlinked folder and a symlinked file, a tracked file deleted from the working tree
    write(root, { "b.md": BROKEN, "ignored/inside.md": BROKEN, "a.md": "# A\n" });
    symlinkSync("ignored", join(root, "linked-folder.md"));
    symlinkSync("ignored/inside.md", join(root, "linked-file.md"));
    git("add", "a.md", "linked-folder.md", "linked-file.md");
    rmSync(join(root, "gone.md"));
    // an untracked file that Git does not ignore
    write(root, { "new.md": "[nope](docs/a.md#nope)\n" });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.deepEqual(
      reported(result.stderr),
      [
        "--version=.md",
        ".github/notes.md",
        "README.md",
        "[ab].md",
        "nested/x.md",
        "new.md",
        "pkg/y.md",
        "skipped.md",
        "star*.md",
        "\ufeffbom.md",
      ].sort(),
      result.stderr,
    );
    assert.match(result.stderr, /Cannot find file `gone\.md`/u);
    // each of the seven files with a link to `missing.md` is read and checked, none refused as ignored
    assert.equal(result.stderr.match(/Cannot find file `missing\.md`/gu)?.length, 7, result.stderr);
    assert.equal(
      result.stderr.trim().split("\n").at(-1),
      "doc-links: remark reports the problems above: fix each link, or the file or heading it names",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file Git lists three times, while a merge conflicts, is read and counted once", () => {
  const { root, git } = checkout({ "c.md": "# C\n\none\n" });
  try {
    git("checkout", "-q", "-b", "other");
    write(root, { "c.md": "# C\n\ntwo\n" });
    git("commit", "-q", "-am", "two");
    git("checkout", "-q", "-");
    write(root, { "c.md": "# C\n\nthree\n" });
    git("commit", "-q", "-am", "three");
    spawnSync("git", ["merge", "-q", "other"], { cwd: root });
    assert.equal(git("ls-files", "--cached", "c.md").trim().split("\n").length, 3);
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.stdout,
      "doc-links: remark reports no unresolved relative link or heading anchor in 1 Markdown files\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run whose links all resolve passes and names how many files it read, past 1 MB of Git's list", () => {
  // names long enough that Git's NUL-separated list passes 1 MB: 4,400 × 249 bytes
  const many = Object.fromEntries(
    Array.from({ length: 4400 }, (_, index) => [
      `${"n".repeat(240)}${String(index).padStart(5, "0")}.md`,
      "",
    ]),
  );
  const { root } = checkout({
    "README.md": "# Title\n\n[part](docs/a.md#part)\n",
    "docs/a.md": "# A\n\n## Part\n\n[back](../README.md#title)\n",
    ...many,
  });
  try {
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(
      result.stdout,
      "doc-links: remark reports no unresolved relative link or heading anchor in 4402 Markdown files\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a name that is not UTF-8, no Markdown at all, and no Git checkout each end the run as the header says", () => {
  const { root } = checkout({});
  const outside = mkdtempSync(join(tmpdir(), "doc-links-outside-"));
  try {
    const empty = run(root);
    assert.deepEqual([empty.status, empty.stdout], [0, "doc-links: no Markdown files\n"]);
    writeFileSync(Buffer.from(join(root, "bad\xff.md"), "latin1"), BROKEN);
    const refused = run(root);
    assert.equal(refused.status, 2);
    assert.equal(
      refused.stderr,
      "doc-links: Git lists a Markdown file whose name is not UTF-8 (bytes 626164ff2e6d64): rename it\n",
    );
    const noGit = spawnSync(process.execPath, [tool], {
      cwd: outside,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(outside) },
    });
    assert.equal(noGit.status, 2);
    assert.match(noGit.stderr, /^doc-links: cannot list the Markdown files with Git: /mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
