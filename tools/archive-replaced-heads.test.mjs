import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test(
  "branches that share a replaced head archive it once; a pruning push keeps every archive this clone holds",
  { timeout: 120_000 },
  () => {
    const { root, git, remote, commit } = setup();
    const archived = () =>
      remote("for-each-ref", "--format=%(refname) %(objectname)", "refs/archive").stdout.trim();
    try {
      const first = commit("first");
      const shared = commit("shared");
      git("push", "-q", "origin", "main:main", "main:side");
      git("reset", "-q", "--hard", first);
      const rewritten = commit("rewritten");
      const both = git("push", "-q", "--force", "origin", "main:main", "main:side");
      assert.equal(both.status, 0, both.stderr);
      assert.equal(archived(), `refs/archive/${shared} ${shared}`);
      assert.equal(remote("rev-parse", "side").stdout.trim(), rewritten);
      // The archive is a ref in this clone too.
      assert.equal(git("rev-parse", `refs/archive/${shared}`).stdout.trim(), shared);

      // Pruning pushes, in any spelling and from git under any name, delete no archive this clone holds; one that
      // also replaces a head archives it in the same push.
      const linked = join(root, "custom-git");
      symlinkSync(
        spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim(),
        linked,
      );
      for (const invoker of ["git", linked])
        for (const spelling of [
          "--mirror origin",
          "--mi origin",
          "--mirror -o --no-mirror origin",
          "--force --prune origin refs/*:refs/*",
          "--prune origin refs/archive/*:refs/archive/*",
        ]) {
          const before = git("rev-parse", "main").stdout.trim();
          git("reset", "-q", "--hard", first);
          const head = commit(`${invoker} ${spelling}`);
          const pruning = spawnSync(
            invoker,
            ["-C", join(root, "clone"), "push", "-q", ...spelling.split(" ")],
            { encoding: "utf8", timeout: 20_000 },
          );
          const label = `${invoker} ${spelling}`;
          // (push options need a remote that accepts them; the archives are what this asserts)
          if (!spelling.includes("-o"))
            assert.equal(pruning.status, 0, `${label}: ${pruning.stderr}`);
          for (const kept of [shared, before])
            if (git("rev-parse", "--verify", "--quiet", `refs/archive/${kept}`).status === 0)
              assert.match(archived(), new RegExp(`refs/archive/${kept} ${kept}`, "u"), label);
          if (
            pruning.status === 0 &&
            spelling.includes("refs/*") === false &&
            !spelling.includes("archive")
          )
            assert.equal(remote("rev-parse", "main").stdout.trim(), head, label);
        }
      // An explicit deletion of an archive is listed to the hook, and refused.
      const explicit = git("push", "-q", "origin", `:refs/archive/${shared}`);
      assert.notEqual(explicit.status, 0);
      assert.match(
        explicit.stderr,
        new RegExp(`refs/archive/${shared} would be deleted or moved, and archives are kept`, "u"),
      );
      assert.match(archived(), new RegExp(`refs/archive/${shared} ${shared}`, "u"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "an archive ref that holds another commit refuses the push; an alias or a worktree pushes as usual",
  { timeout: 60_000 },
  () => {
    const { root, git, remote, commit, runs } = setup();
    try {
      const first = commit("first");
      const head = commit("head");
      git("push", "-q", "origin", "main");
      // (an archive named for `head` but made at `first`, as by hand)
      git("push", "-q", "origin", `${first}:refs/archive/${head}`);
      git("reset", "-q", "--hard", first);
      commit("rewritten");
      const refused = git("push", "-q", "--force", "origin", "main");
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, new RegExp(`refs/archive/${head} holds another commit`, "u"));
      assert.equal(remote("rev-parse", `refs/archive/${head}`).stdout.trim(), first);
      assert.equal(remote("rev-parse", "main").stdout.trim(), head);

      // Ordinary pushes through an alias and from a worktree run the hook and pass.
      const before = runs();
      git("config", "alias.pub", "push -q origin");
      const side = commit("side");
      assert.equal(git("pub", `${side}:refs/heads/side`).status, 0);
      git("worktree", "add", "-q", "--detach", join(root, "wt"), side);
      const fromWorktree = spawnSync(
        "git",
        [
          "-C",
          join(root, "wt"),
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "push",
          "-q",
          "origin",
          "HEAD:refs/heads/wt",
        ],
        { encoding: "utf8" },
      );
      assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
      assert.equal(runs(), before + 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
