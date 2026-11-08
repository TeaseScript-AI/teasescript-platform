import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The wrapper's own part: Git's list of Markdown files, the exit status and its message. remark-validate-links' own
// suite covers how it reads links.

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

test("the Markdown Git tracks or does not ignore is checked, and a broken link fails the run", () => {
  const root = checkout({
    "README.md": "# Title\n\n[part](docs/a.md#part) and [gone](gone.md)\n",
    "docs/a.md": "# A\n\n## Part\n\n[back](../README.md#title)\n",
    "gone.md": "# Gone\n",
    ".github/notes.md": "[missing](../docs/a.md#missing)\n",
  });
  try {
    // a tracked file deleted from the working tree, an ignored file and an untracked one
    rmSync(join(root, "gone.md"));
    write(root, {
      "ignored/x.md": "[nowhere](nowhere.md)\n",
      "new.md": "[nope](docs/a.md#nope)\n",
    });
    const result = run(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const lines = result.stderr.split("\n");
    // remark names each file it reports on, alone on a line: these three, not the ignored one or the deleted one
    const reported = lines.filter((line) => /^[\w.][\w./-]*\.md$/u.test(line)).sort();
    assert.deepEqual(reported, [".github/notes.md", "README.md", "new.md"], result.stderr);
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
      "doc-links: every relative link and heading anchor in 2 Markdown files resolves\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
