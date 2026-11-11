import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitIsolated } from "./fixture-git.mjs";

const tool = fileURLToPath(new URL("./archive-replaced-heads.mjs", import.meta.url));
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

/**
 * A bare `origin` and a clone of it whose `pre-push` hook runs the tool, as the agents' clone installs it, and logs
 * each run. Git reads no host configuration, template or hook. The hook's `git` writes `race`'s `<ref> <value>` into
 * origin right after the hook lists origin's archives, once, as another clone could between that check and the write.
 */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "archive-replaced-heads-"));
  const [origin, clone, log, race, shim, templates] = [
    "origin.git",
    "clone",
    "hook.log",
    "race",
    "shim",
    "templates",
  ].map((name) => join(root, name));
  mkdirSync(shim);
  mkdirSync(templates);
  const env = { ...gitIsolated(process.env), HOME: root, GIT_TEMPLATE_DIR: templates };
  const run =
    (directory) =>
    (...args) =>
      spawnSync("git", args, { cwd: directory, env, encoding: "utf8", timeout: 20_000 });
  spawnSync("git", ["init", "--bare", origin], { env });
  spawnSync("git", ["init", clone], { env });
  const git = run(clone);
  git("remote", "add", "origin", origin);
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\n"${realGit}" "$@"; status=$?\n` +
      `if [ "$1" = ls-remote ] && [ -f "${race}" ]; then "${realGit}" --git-dir="${origin}" update-ref $(cat "${race}"); rm "${race}"; fi\n` +
      "exit $status\n",
  );
  chmodSync(join(shim, "git"), 0o755);
  const hook = join(clone, ".git/hooks/pre-push");
  mkdirSync(join(clone, ".git/hooks"), { recursive: true });
  writeFileSync(
    hook,
    // (each run, and each line git gives it, logged)
    `#!/bin/sh\necho run >> "${log}"\ninput=$(cat)\n[ -n "$input" ] && printf '%s\\n' "$input" | sed 's/^/line /' >> "${log}"\n` +
      `printf '%s\\n' "$input" | PATH="${shim}:$PATH" exec "${process.execPath}" "${tool}" "$@"\n`,
  );
  chmodSync(hook, 0o755);
  writeFileSync(log, "");
  const emptyTree = spawnSync("git", ["mktree"], {
    cwd: clone,
    env,
    input: "",
    encoding: "utf8",
  }).stdout.trim();
  return {
    root,
    env,
    git,
    remote: run(origin),
    race: (ref, value) => writeFileSync(race, `${ref} ${value}`),
    raced: () => !existsSync(race),
    runs: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((entry) => entry === "run").length,
    /** The lines git has given the hook so far. */
    lines: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter((entry) => entry.startsWith("line "))
        .map((entry) => entry.slice(5)),
    /** A new commit in the clone, after `parent` if given. */
    commit: (message, parent) =>
      spawnSync("git", ["commit-tree", emptyTree, ...(parent ? ["-p", parent] : [])], {
        cwd: clone,
        env,
        input: `${message}\n`,
        encoding: "utf8",
      }).stdout.trim(),
    /** A new annotated tag object on `commit`. */
    tag: (name, commit) =>
      spawnSync("git", ["mktag"], {
        cwd: clone,
        env,
        input: `object ${commit}\ntype commit\ntag ${name}\ntagger t <t@t> 0 +0000\n\n${name}\n`,
        encoding: "utf8",
      }).stdout.trim(),
  };
}

const KINDS = ["branch", "tag", "annotated tag", "archive ref"];
const OPS = ["create", "fast-forward", "rewrite", "delete"];
const STATES = ["absent", "identical", "differing", "identical meanwhile", "differing meanwhile"];

/** What the claim says one line of a push does: "passed", "archived" or "refused". */
function expected({ kind, op, state }) {
  if (kind === "archive ref") return op === "create" ? "passed" : "refused";
  // (only a commit moving to a descendant contains its old value; an annotated tag's old value is its tag object)
  const replaced =
    op === "rewrite" || op === "delete" || (kind === "annotated tag" && op === "fast-forward");
  if (!replaced) return "passed";
  return state.startsWith("differing") ? "refused" : "archived";
}

/**
 * The objects and refspecs for one generated line, `n` naming it: `setup` lists the refspecs that put origin in the
 * line's starting state (creations only), `push` the line's own refspec.
 */
function line(repo, n, { kind, op, state }) {
  // (an archive that differs holds `root`, an ancestor of the old value, so a plain write would fast-forward over it)
  const root = repo.commit(`${n} root`);
  const base = repo.commit(`${n} base`, root);
  const next = repo.commit(`${n} next`, base);
  const other = repo.commit(`${n} other`);
  const value = (commit, label) =>
    kind === "annotated tag" ? repo.tag(`t${n}-${label}`, commit) : commit;
  const old = value(base, "base");
  const name =
    kind === "branch"
      ? `refs/heads/b${n}`
      : kind === "archive ref"
        ? `refs/archive/${old}`
        : `refs/tags/t${n}`;
  const now = {
    create: old,
    "fast-forward": value(next, "next"),
    rewrite: value(other, "other"),
    delete: "",
  }[op];
  const archive = `refs/archive/${old}`;
  const setup = [`${root}:refs/heads/r${n}`];
  if (op !== "create") setup.push(`${old}:${name}`);
  if (state === "identical") setup.push(`${old}:${archive}`);
  if (state === "differing") setup.push(`${root}:${archive}`);
  const meanwhile = state.endsWith("meanwhile")
    ? state.startsWith("identical")
      ? old
      : root
    : null;
  return {
    kind,
    op,
    state,
    name,
    old,
    now,
    root,
    archive,
    setup,
    meanwhile,
    push: `+${now}:${name}`,
  };
}

/** Pushes `lines` in one push through the hook; asserts each line's outcome against the claim. */
function pushAndCheck(repo, lines, label) {
  const value = (git, ref) => git("rev-parse", "--verify", "--quiet", ref).stdout.trim();
  const before = lines.map((l) => ({
    name: value(repo.remote, l.name),
    archive: value(repo.remote, l.archive),
  }));
  const meanwhile = lines.find((l) => l.meanwhile);
  if (meanwhile) repo.race(meanwhile.archive, meanwhile.meanwhile);
  const runs = repo.runs();
  const result = repo.git("push", "origin", ...lines.map((l) => l.push));
  assert.equal(repo.runs(), runs + 1, `${label}: one hook run`);
  const outcomes = lines.map(expected);
  const refused = outcomes.includes("refused");
  assert.equal(result.status === 0, !refused, `${label}: ${result.stderr}`);
  if (meanwhile && !lines.some((l) => l.kind === "archive ref"))
    assert.ok(repo.raced(), `${label}: the archive appeared between the check and the write`);
  lines.forEach((l, i) => {
    const at = `${label}, ${l.kind} ${l.op} (${l.state})`;
    if (refused) {
      assert.equal(value(repo.remote, l.name), before[i].name, `${at}: the ref stays`);
      if (!l.meanwhile)
        assert.equal(value(repo.remote, l.archive), before[i].archive, `${at}: the archive stays`);
    } else {
      assert.equal(value(repo.remote, l.name), l.now, `${at}: the ref moves`);
      // (an archive ref's line is its own archive: the ref's check above covers it)
      if (l.kind === "archive ref") return;
      const archived = outcomes[i] === "archived";
      assert.equal(value(repo.remote, l.archive), archived ? l.old : before[i].archive, at);
      assert.equal(
        value(repo.git, l.archive),
        archived ? l.old : "",
        `${at}: this clone's archive`,
      );
      if (archived)
        assert.ok(result.stderr.includes(`${l.name} was ${l.old}: archived as ${l.archive}`), at);
    }
  });
  if (lines.length === 1 && refused) {
    const [l] = lines;
    const reason =
      l.kind === "archive ref"
        ? `${l.name} would be deleted or rewritten`
        : l.state === "differing"
          ? `${l.archive} holds ${l.root}`
          : "cannot archive the replaced values";
    assert.ok(result.stderr.includes(reason), `${label}: ${result.stderr}`);
  }
}

test(
  "every line kind, operation and archive state, alone and in pairs, does what the claim says",
  { timeout: 240_000 },
  () => {
    const repo = setup();
    try {
      const singles = [];
      for (const kind of KINDS)
        for (const op of OPS)
          for (const state of STATES)
            if (state === "absent" || expected({ kind, op, state: "absent" }) === "archived")
              singles.push({ kind, op, state });
      const pairCases = [
        ["branch", "fast-forward"],
        ["branch", "rewrite"],
        ["tag", "delete"],
        ["annotated tag", "rewrite"],
        ["archive ref", "create"],
        ["archive ref", "delete"],
      ].map(([kind, op]) => ({ kind, op, state: "absent" }));
      const pairs = pairCases.flatMap((a, i) => pairCases.slice(i + 1).map((b) => [a, b]));
      let n = 0;
      const batches = [...singles.map((c) => [c]), ...pairs].map((cases) =>
        cases.map((c) => line(repo, n++, c)),
      );
      // (every starting state in one push of creations, which the hook passes)
      const prepared = repo.git("push", "origin", ...batches.flat().flatMap((l) => l.setup));
      assert.equal(prepared.status, 0, prepared.stderr);
      for (const lines of batches)
        pushAndCheck(repo, lines, lines.map((l) => `${l.kind} ${l.op} (${l.state})`).join(" + "));

      // Two branches sharing a replaced head archive it once.
      const base = repo.commit("shared base");
      const other = repo.commit("shared other");
      repo.git("push", "origin", `${base}:refs/heads/s1`, `${base}:refs/heads/s2`);
      const both = repo.git("push", "origin", `+${other}:refs/heads/s1`, `+${other}:refs/heads/s2`);
      assert.equal(both.status, 0, both.stderr);
      assert.equal(
        repo.remote("for-each-ref", "--format=%(objectname)", `refs/archive/${base}`).stdout.trim(),
        base,
      );
      assert.equal(both.stderr.match(/archived as/gu).length, 2);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
);

test(
  "the pruning table: an archive this clone holds stays, unless a push refspec or mirror is configured; one it lacks is the named limit",
  { timeout: 180_000 },
  () => {
    const heads = ["remote.origin.push", "+refs/heads/*:refs/heads/*"];
    const tags = ["remote.origin.push", "refs/tags/*:refs/archive/*"];
    const mirror = ["remote.origin.mirror", "true"];
    // { push arguments, the remote's configuration, whether this clone holds the archive, what happens to it on origin,
    // whether the push replaces main, so the hook writes another archive during that same push }
    const table = [
      { args: ["--mirror", "origin"], held: true, outcome: "kept", replaces: true },
      {
        args: ["--prune", "origin", "+refs/*:refs/*"],
        held: true,
        outcome: "kept",
        replaces: true,
      },
      { args: ["--prune", "origin", "refs/archive/*:refs/archive/*"], held: true, outcome: "kept" },
      // (git lists a `--prune` deletion to the hook, which refuses it)
      { args: ["--prune", "origin", "+refs/*:refs/*"], outcome: "refused", replaces: true },
      { args: ["--prune", "origin", "refs/archive/*:refs/archive/*"], outcome: "refused" },
      {
        args: ["--prune", "origin"],
        config: [heads, tags],
        held: true,
        outcome: "refused",
        replaces: true,
      },
      // (the limit: a mirror push deletes, listing it to no hook, an archive no ref of this clone maps onto: one it
      // lacks, or any when a push refspec or mirror is configured for the remote)
      { args: ["--mirror", "origin"], outcome: "deleted", replaces: true },
      {
        args: ["--mirror", "origin"],
        config: [heads],
        held: true,
        outcome: "deleted",
        replaces: true,
      },
      {
        args: ["--mirror", "origin"],
        config: [heads, tags],
        held: true,
        outcome: "deleted",
        replaces: true,
      },
      { args: ["--mirror", "origin"], config: [tags], held: true, outcome: "deleted" },
      {
        args: ["origin"],
        config: [mirror, heads, tags],
        held: true,
        outcome: "deleted",
        replaces: true,
      },
    ];
    for (const { args, config = [], held = false, outcome, replaces = false } of table) {
      const repo = setup();
      const label = `${args.join(" ")}${config.map(([key, value]) => `, ${key}=${value}`).join("")}, ${held ? "held" : "not held"} here`;
      try {
        const head = repo.commit("head");
        const cited = repo.commit("cited");
        repo.git("push", "origin", `${head}:refs/heads/main`, `${cited}:refs/archive/${cited}`);
        if (held) repo.git("update-ref", `refs/archive/${cited}`, cited);
        repo.git("update-ref", "refs/heads/main", repo.commit("replacement"));
        for (const [key, value] of config) repo.git("config", "--add", key, value);
        const given = repo.lines().length;
        const result = repo.git("push", ...args);
        assert.equal(result.status === 0, outcome !== "refused", `${label}: ${result.stderr}`);
        const archives = repo.remote("for-each-ref", "--format=%(refname)", "refs/archive").stdout;
        assert.equal(archives.includes(cited), outcome !== "deleted", label);
        assert.equal(
          archives.includes(head),
          replaces && outcome !== "refused",
          `${label}: main's archive`,
        );
        // What git gave the hook about the archive: its deletion when refused, nothing when deleted.
        const about = repo
          .lines()
          .slice(given)
          .filter((line) => line.includes(`refs/archive/${cited}`));
        if (outcome === "refused") assert.ok(about.length > 0, `${label}: the deletion listed`);
        if (outcome === "deleted")
          assert.deepEqual(about, [], `${label}: no line about the archive`);
      } finally {
        rmSync(repo.root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "a rewrite is archived whatever this clone's replacement refs or graft file say of its history",
  { timeout: 60_000 },
  () => {
    const repo = setup();
    try {
      for (const form of ["a replacement ref", "a graft file"]) {
        // B and C share their parent, so C does not contain B; this clone's history says it does.
        const parent = repo.commit(`${form} parent`);
        const b = repo.commit(`${form} B`, parent);
        const c = repo.commit(`${form} C`, parent);
        const branch = `refs/heads/${form.replaceAll(" ", "-")}`;
        repo.git("push", "origin", `${b}:${branch}`);
        if (form === "a replacement ref")
          repo.git("update-ref", `refs/replace/${c}`, repo.commit(`${form} C on B`, b));
        else {
          mkdirSync(join(repo.root, "clone/.git/info"), { recursive: true });
          writeFileSync(join(repo.root, "clone/.git/info/grafts"), `${c} ${b}\n`);
        }
        assert.equal(
          repo.git("merge-base", "--is-ancestor", b, c).status,
          0,
          `${form}: the clone's view`,
        );
        const pushed = repo.git("push", "origin", `+${c}:${branch}`);
        assert.equal(pushed.status, 0, `${form}: ${pushed.stderr}`);
        assert.equal(repo.remote("rev-parse", branch).stdout.trim(), c, form);
        assert.equal(
          repo.remote("rev-parse", `refs/archive/${b}`).stdout.trim(),
          b,
          `${form}: archived`,
        );
        assert.equal(
          repo.git("rev-parse", `refs/archive/${b}`).stdout.trim(),
          b,
          `${form}: kept here`,
        );
        rmSync(join(repo.root, "clone/.git/info/grafts"), { force: true });
      }
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
);

test(
  "a value that cannot be archived refuses the whole push, and the ref stays",
  { timeout: 60_000 },
  () => {
    const repo = setup();
    try {
      const old = repo.commit("old");
      repo.git("push", "origin", `${old}:refs/heads/main`);
      // The remote refuses every archive ref.
      const receive = join(repo.root, "origin.git/hooks/pre-receive");
      mkdirSync(join(repo.root, "origin.git/hooks"), { recursive: true });
      writeFileSync(
        receive,
        "#!/bin/sh\nwhile read old new ref; do case $ref in refs/archive/*) exit 1;; esac; done\n",
      );
      chmodSync(receive, 0o755);
      const refused = repo.git("push", "origin", `+${repo.commit("new")}:refs/heads/main`);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /cannot archive the replaced values .*; push refused/u);
      assert.equal(repo.remote("rev-parse", "main").stdout.trim(), old);
      rmSync(receive);

      // A value this clone lacks (pushed from elsewhere) is refused before any push.
      const other = spawnSync("git", ["commit-tree", `${old}^{tree}`], {
        cwd: join(repo.root, "origin.git"),
        env: repo.env,
        input: "elsewhere\n",
        encoding: "utf8",
      }).stdout.trim();
      repo.remote("update-ref", "refs/heads/main", other);
      const lacking = repo.git("push", "origin", `+${old}:refs/heads/main`);
      assert.notEqual(lacking.status, 0);
      assert.ok(
        lacking.stderr.includes(
          `refs/heads/main is ${other} there, which this clone lacks: fetch it`,
        ),
      );
      assert.equal(repo.remote("rev-parse", "main").stdout.trim(), other);
      assert.equal(repo.remote("for-each-ref", "refs/archive").stdout, "");

      // Archived on the remote but not kept here (a file where this clone's archive folder goes): refused, saying
      // what to repair; once repaired, the push goes through.
      repo.git("fetch", "origin", "main");
      const blocked = join(repo.root, "clone/.git/refs/archive");
      writeFileSync(blocked, "");
      const newer = repo.commit("newer");
      const unkept = repo.git("push", "origin", `+${newer}:refs/heads/main`);
      assert.notEqual(unkept.status, 0);
      assert.ok(
        unkept.stderr.includes(`cannot keep refs/archive/${other} in this clone (`),
        unkept.stderr,
      );
      assert.match(
        unkept.stderr,
        /\); the remote archive is retained: repair this clone's refs\/archive path or its permissions, then push again; push refused$/mu,
      );
      assert.equal(repo.remote("rev-parse", "main").stdout.trim(), other);
      assert.equal(repo.remote("rev-parse", `refs/archive/${other}`).stdout.trim(), other);
      rmSync(blocked);
      const repaired = repo.git("push", "origin", `+${newer}:refs/heads/main`);
      assert.equal(repaired.status, 0, repaired.stderr);
      assert.equal(repo.git("rev-parse", `refs/archive/${other}`).stdout.trim(), other);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  },
);

test("an alias and a worktree push through the hook as usual", { timeout: 60_000 }, () => {
  const repo = setup();
  try {
    const head = repo.commit("head");
    repo.git("update-ref", "refs/heads/main", head);
    repo.git("config", "alias.pub", "push origin");
    assert.equal(repo.git("pub", `${head}:refs/heads/main`).status, 0);
    repo.git("worktree", "add", "--detach", join(repo.root, "wt"), head);
    const fromWorktree = spawnSync(
      "git",
      ["push", "origin", `+${repo.commit("next", head)}:refs/heads/wt`],
      { cwd: join(repo.root, "wt"), env: repo.env, encoding: "utf8" },
    );
    assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
    assert.equal(repo.runs(), 2);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
