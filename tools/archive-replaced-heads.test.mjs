import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tool = fileURLToPath(new URL("./archive-replaced-heads.mjs", import.meta.url));

/**
 * A bare `origin` and a clone of it whose `pre-push` hook runs the tool, as the agents' clone installs it, and logs
 * each run; `git` in the clone, `remote` on origin, and the log's lines.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "archive-replaced-heads-"));
  const [origin, clone, log] = ["origin.git", "clone", "hook.log"].map((name) => join(root, name));
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", clone]);
  const run =
    (directory) =>
    (...args) =>
      spawnSync(
        "git",
        [
          "-C",
          directory,
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { encoding: "utf8", timeout: 20_000 },
      );
  const git = run(clone);
  git("remote", "add", "origin", origin);
  // (this clone's own hooks, whatever a global `core.hooksPath` says)
  git("config", "core.hooksPath", join(clone, ".git/hooks"));
  const hook = join(clone, ".git/hooks/pre-push");
  writeFileSync(
    hook,
    `#!/bin/sh\necho run >> "${log}"\nexec "${process.execPath}" "${tool}" "$@"\n`,
  );
  chmodSync(hook, 0o755);
  writeFileSync(log, "");
  return {
    root,
    git,
    remote: run(origin),
    runs: () => readFileSync(log, "utf8").split("\n").filter(Boolean).length,
    commit: (message) => {
      git("commit", "-q", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD").stdout.trim();
    },
  };
}

test(
  "a force-push and a deletion archive the replaced head first; a fast-forward and a new branch archive nothing",
  { timeout: 60_000 },
  () => {
    const { root, git, remote, runs, commit } = setup();
    const archived = () =>
      remote("for-each-ref", "--format=%(refname) %(objectname)", "refs/archive").stdout.trim();
    try {
      const first = commit("first");
      assert.equal(git("push", "-q", "origin", "main").status, 0, "a new branch");
      const second = commit("second");
      assert.equal(git("push", "-q", "origin", "main").status, 0, "a fast-forward");
      assert.equal(archived(), "");

      git("reset", "-q", "--hard", first);
      const rewritten = commit("rewritten");
      const forced = git("push", "-q", "--force", "origin", "main");
      assert.equal(forced.status, 0, forced.stderr);
      assert.match(
        forced.stderr,
        new RegExp(`refs/heads/main was ${second}: archived as refs/archive/${second}`, "u"),
      );
      assert.equal(archived(), `refs/archive/${second} ${second}`);
      assert.equal(remote("rev-parse", "main").stdout.trim(), rewritten);

      git("push", "-q", "origin", "main:side");
      const deleted = git("push", "-q", "origin", ":side");
      assert.equal(deleted.status, 0, deleted.stderr);
      assert.match(archived(), new RegExp(`refs/archive/${rewritten} ${rewritten}`, "u"));
      // One hook run per outer push: the archive pushes ran no hook.
      assert.equal(runs(), 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "a head that cannot be archived refuses the whole push, and the branch stays",
  { timeout: 60_000 },
  () => {
    const { root, git, remote, commit } = setup();
    try {
      const first = commit("first");
      git("push", "-q", "origin", "main");
      const second = commit("second");
      git("push", "-q", "origin", "main");
      // The remote refuses every archive ref.
      writeFileSync(
        join(root, "origin.git/hooks/pre-receive"),
        "#!/bin/sh\nwhile read old new ref; do case $ref in refs/archive/*) exit 1;; esac; done\n",
      );
      chmodSync(join(root, "origin.git/hooks/pre-receive"), 0o755);
      git("reset", "-q", "--hard", first);
      commit("rewritten");
      const refused = git("push", "-q", "--force", "origin", "main");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /cannot archive the replaced heads .*; push refused/u);
      assert.equal(remote("rev-parse", "main").stdout.trim(), second);

      // A head this clone lacks (pushed from elsewhere) is refused before any push.
      rmSync(join(root, "origin.git/hooks/pre-receive"));
      const other = spawnSync(
        "git",
        [
          "-C",
          join(root, "origin.git"),
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit-tree",
          `${second}^{tree}`,
          "-p",
          second,
          "-m",
          "elsewhere",
        ],
        { encoding: "utf8" },
      ).stdout.trim();
      remote("update-ref", "refs/heads/main", other);
      const lacking = git("push", "-q", "--force", "origin", "main");
      assert.notEqual(lacking.status, 0);
      assert.match(
        lacking.stderr,
        new RegExp(`refs/heads/main is ${other} there, which this clone lacks: fetch it`, "u"),
      );
      assert.equal(remote("rev-parse", "main").stdout.trim(), other);
      assert.equal(remote("for-each-ref", "refs/archive").stdout, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
