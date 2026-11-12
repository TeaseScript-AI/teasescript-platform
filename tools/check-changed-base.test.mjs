// check-changed's merge commits and base line: `strayMerges`, `merge commits` in every run, and the base it takes.
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CannotRun, branchedFrom, strayMerges } from "./check-changed.mjs";
import { runSync } from "./runner-test-support.mjs";
import { environment, repository, tool } from "./check-changed-test-support.mjs";

/**
 * One repository for the merge-commit tests: from one base, `runtime-v2`, `other` (another lane's branch) and `main`
 * each grow a commit, then `main` and `runtime-v2` grow another, with `origin/main` and `origin/runtime-v2` at their
 * tips. `lane(base, merges)` makes `lane` anew off `base`'s commit before that last growth, with a commit of its own and
 * then a merge of `merges` (none for null), and returns its SHA; merging main or runtime-v2 is so a merge commit.
 * `queueMerge(base)` checks out `lane` merged with `base` as the queue's `--merged-with` makes it (`git merge --no-ff`,
 * which makes no commit when the lane already holds the base).
 */
function mergeGraph() {
  const { directory } = repository({ passing: true });
  const git = (...args) => {
    const result = runSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (branch, file) => {
    git("switch", "-q", branch);
    writeFileSync(join(directory, file), `${branch}\n`);
    git("add", file);
    git("commit", "-q", "-m", `${branch} grows`);
  };
  git("branch", "runtime-v2", "main");
  git("branch", "other", "main");
  commit("runtime-v2", "runtime-v2.md");
  commit("other", "other.md");
  commit("main", "main.md");
  commit("main", "main-later.md");
  commit("runtime-v2", "runtime-v2-later.md");
  git("update-ref", "refs/remotes/origin/main", "main");
  git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
  const lane = (base, merges) => {
    git("switch", "-q", "-C", "lane", `${base.replace(/^origin\//u, "")}~1`);
    writeFileSync(join(directory, "lane.md"), "lane\n");
    git("add", "lane.md");
    git("commit", "-q", "-m", "lane grows");
    if (merges !== null) git("merge", "-q", "--no-edit", merges);
    return git("rev-parse", "lane");
  };
  const queueMerge = (base) => {
    git("switch", "-q", "--detach", "lane");
    git("merge", "-q", "--no-ff", "--no-edit", base);
  };
  return { directory, git, commit, lane, queueMerge };
}

/** `fn()` run with the working folder at `directory`, as `strayMerges` reads git there. */
function inside(directory, fn) {
  const before = process.cwd();
  process.chdir(directory);
  try {
    return fn();
  } finally {
    process.chdir(before);
  }
}

test("strayMerges fails a merge commit unless it merges main or runtime-v2 into the other, and says what git cannot place (#2106)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  try {
    for (const [base, merges, failure, tweak] of [
      // [the branch's base, what its merge commit merges, the reason it fails, or null when it passes]
      ["main", "main", "which the base already holds: rebase onto main instead"],
      [
        "main",
        "other",
        "which neither origin/main nor origin/runtime-v2 holds: rebase onto main instead, or, if it has landed on " +
          "one of them since your last fetch, fetch main, origin/main, origin/runtime-v2 and run again",
      ],
      ["main", "runtime-v2", null],
      ["runtime-v2", "main", null],
      ["runtime-v2", "runtime-v2", "which the base already holds: rebase onto runtime-v2 instead"],
      ["main", null, null],
      // a ref the clone lacks: unproven, so it fails, with the advice to fetch, and a parent the other ref holds passes
      [
        "main",
        "runtime-v2",
        "which git cannot place (origin/runtime-v2: fatal: Not a valid object name origin/runtime-v2): fetch main, " +
          "origin/main, origin/runtime-v2 and run again",
        "origin/runtime-v2",
      ],
      ["runtime-v2", "main", null, "origin/runtime-v2"],
      // a stale origin/main, which lacks the main commit merged: the advice names the fetch beside the rebase
      [
        "runtime-v2",
        "main",
        "which neither origin/main nor origin/runtime-v2 holds: rebase onto runtime-v2 instead, or, if it has " +
          "landed on one of them since your last fetch, fetch runtime-v2, origin/main, origin/runtime-v2 and run again",
        "stale",
      ],
      // a shallow clone, whose "no" proves nothing: unproven, with the advice to deepen it (Sol r2)
      [
        "origin/main",
        "runtime-v2",
        "which git cannot place (origin/main: the clone is shallow): deepen the clone (git fetch --unshallow) and " +
          "run again",
        "shallow",
      ],
    ]) {
      const head = graph.lane(base, merges);
      let cwd = directory;
      if (tweak === "origin/runtime-v2") git("update-ref", "-d", "refs/remotes/origin/runtime-v2");
      if (tweak === "stale") git("update-ref", "refs/remotes/origin/main", "main~1");
      if (tweak === "shallow") {
        // (a branch deeper than the clone, so the clone lacks history, while main's and the lane's are whole)
        git("branch", "-f", "deep", "main");
        for (const step of [1, 2, 3, 4]) graph.commit("deep", `deep-${step}.md`);
        git("switch", "-q", "lane");
        cwd = `${directory}-shallow`;
        git("clone", "-q", "--depth=3", "--no-single-branch", `file://${directory}`, cwd);
      }
      try {
        const stray = inside(cwd, () =>
          strayMerges(git("-C", cwd, "merge-base", "HEAD", base), head, base, base),
        );
        const at = `a branch of ${base} merging ${merges}${tweak ? `, ${tweak}` : ""}`;
        assert.deepEqual(
          stray,
          failure === null
            ? []
            : [
                `${head.slice(0, 9)} Merge branch '${merges}' into lane: merges ` +
                  `${git("rev-parse", "--short=9", "lane^2")}, ${failure}`,
              ],
          at,
        );
      } finally {
        if (tweak === "shallow") rmSync(cwd, { recursive: true, force: true });
        git("update-ref", "refs/remotes/origin/main", "main");
        git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("`merge commits` runs in every run, plain, merged and in a merged checkout, judging the head's merge commits and not the queue's own merge, and the other checks still run (#2106)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  const check = (...args) =>
    runSync(process.execPath, [tool, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
  /** `check(...args)`'s run, asserted: its status, every check in it, and `merge commits`' lines (none when it passes). */
  const verdict = (at, args, status, lines = []) => {
    const result = check(...args);
    assert.equal(result.status, status, `${at}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(
      result.stdout.match(/^(?:PASS|FAIL) {2}\S.*$/gmu).map((line) => line.split(/ {2,}/u)[1]),
      ["diff --check", "merge commits", "oxlint", "knip", "doc links", "imports"],
      at,
    );
    if (lines.length > 0)
      assert.ok(
        result.stdout.includes(
          `--- merge commits ---\n${lines.map((line) => `${line}\n`).join("")}`,
        ),
        `${at}: ${result.stdout}`,
      );
    else assert.match(result.stdout, /^PASS {2}merge commits /mu, at);
  };
  // The queue's merged checkout, named first when HEAD merges exactly the base's commit outside `--merged-checkout`;
  // still a failure, as it may be the builder's own merge of its base
  const queueHint = (first, baseName) =>
    `the base's commit itself, as the queue's merged checkout does: if this is one, run it as ` +
    `--merged-checkout ${first} --base ${baseName}; if you merged the base into your branch yourself, rebase ` +
    `onto ${baseName} instead`;
  const mergeLine = (commit, merges, why) =>
    `${git("rev-parse", "--short=9", commit)} Merge branch '${merges}' into lane: merges ` +
    `${git("rev-parse", "--short=9", `${commit}^2`)}, ${why}`;
  try {
    // plain and --merged: the lane's merge of its own base's tip fails, with the queue's case named first; a merge of
    // the other long-lived line passes
    for (const mode of [[], ["--merged"]]) {
      const own = graph.lane("main", "main");
      verdict(`${mode} own base`, [...mode, "--base", "main"], 1, [
        mergeLine("lane", "main", queueHint(git("rev-parse", `${own}^1`), "main")),
      ]);
      graph.lane("main", "runtime-v2");
      verdict(`${mode} runtime-v2 into a lane of main`, [...mode, "--base", "main"], 0);
    }
    // --merged-checkout, HEAD as the queue makes it. Behind its base, the queue made a merge commit: not judged
    const behind = graph.lane("main", null);
    graph.queueMerge("main");
    verdict("merged checkout behind its base", ["--merged-checkout", behind, "--base", "main"], 0);
    // by shape alone, as `--base HEAD^2` reads it, that merge is the base merged into the branch: it fails, naming
    // the queue's case first
    const runner = git("rev-parse", "--short=9", "HEAD");
    const byShape = check("--base", "HEAD^2");
    assert.equal(byShape.status, 1, byShape.stdout);
    assert.ok(
      byShape.stdout.includes(
        `${runner} Merge branch 'main' into HEAD: merges ${git("rev-parse", "--short=9", "HEAD^2")}, ` +
          `${queueHint(behind, "HEAD^2")}\n`,
      ),
      byShape.stdout,
    );
    // a commit that is not the merge's first parent, or both forms at once, cannot run
    const wrong = check("--merged-checkout", `${behind}~1`, "--base", "main");
    assert.equal(wrong.status, 2, `${wrong.stdout}${wrong.stderr}`);
    assert.match(
      wrong.stderr,
      new RegExp(
        `--merged-checkout ${behind}~1 \\(\\w{9}\\): HEAD \\(${runner}\\) is neither `,
        "u",
      ),
    );
    assert.equal(check("--merged", "--merged-checkout", behind).status, 2);
    // a stray merge on the branch's side is still judged, and so is the lane's own merge of its base, when the queue
    // merges nothing, without the queue's case
    const stray = graph.lane("main", "other");
    graph.queueMerge("main");
    verdict(
      "merged checkout, another lane merged",
      ["--merged-checkout", stray, "--base", "main"],
      1,
      [
        mergeLine(
          stray,
          "other",
          "which neither origin/main nor origin/runtime-v2 holds: rebase onto main instead, or, if it has landed on " +
            "one of them since your last fetch, fetch main, origin/main, origin/runtime-v2 and run again",
        ),
      ],
    );
    const own = graph.lane("main", "main");
    graph.queueMerge("main");
    verdict(
      "merged checkout, its own base merged",
      ["--merged-checkout", own, "--base", "main"],
      1,
      [mergeLine(own, "main", "which the base already holds: rebase onto main instead")],
    );
    // main merged into a lane of runtime-v2, checked as the queue merges it with runtime-v2
    const rt2 = graph.lane("runtime-v2", "main");
    graph.queueMerge("runtime-v2");
    verdict(
      "merged checkout, main into a lane of runtime-v2",
      ["--merged-checkout", rt2, "--base", "runtime-v2"],
      0,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("without --base or a pull request, the base is the long-lived line HEAD's own line leaves, named, or exit 2 when unproven (#2409)", () => {
  const graph = mergeGraph();
  const { directory, git } = graph;
  const base = (ref, at, back) => ({
    ref,
    line:
      `check-changed: no --base and no pull request: base ${ref}, whose own line HEAD's leaves at ` +
      `${git("rev-parse", "--short=9", at)}, ${back} commits back`,
  });
  const fails = (at, message, cwd = directory) =>
    assert.throws(
      () => inside(cwd, branchedFrom),
      (error) => error instanceof CannotRun && error.message === message,
      at,
    );
  try {
    graph.lane("runtime-v2", null);
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/runtime-v2", "runtime-v2~1", 1),
      "runtime-v2",
    );
    graph.lane("main", null);
    assert.deepEqual(inside(directory, branchedFrom), base("origin/main", "main~1", 1), "main");
    // off the commit both lines hold, from before they split: main
    graph.lane("main~1", null);
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/main", "main~2", 1),
      "before the split",
    );
    // a lane of main merging runtime-v2, and one of runtime-v2 merging main: each its own line's, though the other's
    // tip is nearer by commits (Sol r1)
    graph.lane("main", "runtime-v2");
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/main", "main~1", 2),
      "main merging runtime-v2",
    );
    git("switch", "-q", "runtime-v2");
    git("merge", "-q", "--no-edit", "main~1");
    git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
    for (const step of [1, 2, 3, 4, 5]) graph.commit("main", `main-${step}.md`);
    git("update-ref", "refs/remotes/origin/main", "main");
    git("switch", "-q", "-C", "lane", "runtime-v2");
    graph.commit("lane", "lane.md");
    git("merge", "-q", "--no-edit", "main");
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/runtime-v2", "runtime-v2", 2),
      "runtime-v2, holding an older main, merging a newer main",
    );
    // a lane of the branch that merges main for runtime-v2, which lands with a merge commit, as #2408: its head is in
    // runtime-v2's history, but not on its own line, which HEAD's line meets at runtime-v2's tip before the landing
    // (Sol r2)
    git("switch", "-q", "-C", "merge-main", "runtime-v2");
    git("merge", "-q", "--no-edit", "main");
    const before = git("rev-parse", "runtime-v2");
    git("switch", "-q", "runtime-v2");
    git("merge", "-q", "--no-ff", "--no-edit", "merge-main");
    git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
    git("switch", "-q", "-C", "lane", "merge-main");
    graph.commit("lane", "lane.md");
    assert.deepEqual(
      inside(directory, branchedFrom),
      base("origin/runtime-v2", before, 2),
      "a lane of runtime-v2's merge branch",
    );
    // unproven: a missing ref, a shallow clone, and a HEAD whose line meets neither
    git("update-ref", "-d", "refs/remotes/origin/runtime-v2");
    fails(
      "no origin/runtime-v2",
      "no --base and no pull request, and no origin/runtime-v2 to tell the base by: fetch origin/main and " +
        "origin/runtime-v2, or name the base with --base",
    );
    git("update-ref", "refs/remotes/origin/runtime-v2", "runtime-v2");
    const shallow = `${directory}-shallow`;
    git("clone", "-q", "--depth=2", "--no-single-branch", `file://${directory}`, shallow);
    try {
      fails(
        "shallow",
        "no --base and no pull request, and the clone is shallow: deepen it (git fetch --unshallow), or name the " +
          "base with --base",
        shallow,
      );
    } finally {
      rmSync(shallow, { recursive: true, force: true });
    }
    git("switch", "-q", "--orphan", "unrelated");
    writeFileSync(join(directory, "unrelated.md"), "unrelated\n");
    git("add", "unrelated.md");
    git("commit", "-q", "-m", "unrelated");
    fails(
      "unrelated",
      "no --base and no pull request, and HEAD's line meets neither origin/main nor origin/runtime-v2's: name the " +
        "base with --base",
    );
    // --merged-checkout needs --base: the queue's merge of a lane of runtime-v2 with main, its second parent main
    const lane = graph.lane("runtime-v2", null);
    git("switch", "-q", "--detach", "lane");
    git("merge", "-q", "--no-ff", "--no-edit", "origin/main");
    assert.equal(git("rev-parse", "HEAD^2"), git("rev-parse", "origin/main"));
    const merged = runSync(process.execPath, [tool, "--merged-checkout", lane], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(merged.status, 2, `${merged.stdout}${merged.stderr}`);
    assert.match(merged.stderr, /usage: .* --merged-checkout <commit> --base <ref>/u);
    // the run itself: a lane of runtime-v2 checked against runtime-v2, its one commit the change
    graph.lane("runtime-v2", null);
    const result = runSync(process.execPath, [tool], {
      cwd: directory,
      encoding: "utf8",
      env: environment,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.ok(
      result.stdout.startsWith(`${base("origin/runtime-v2", "runtime-v2~1", 1).line}\n`),
      result.stdout,
    );
    assert.match(
      result.stdout,
      /^check-changed: 1 changed files since origin\/runtime-v2 /mu,
      result.stdout,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
