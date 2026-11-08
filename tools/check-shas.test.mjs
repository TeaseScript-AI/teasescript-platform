import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { excuse } from "./check-shas.mjs";

const tool = fileURLToPath(new URL("./check-shas.mjs", import.meta.url));

/** A repository with `count` empty commits, made at once by `git fast-import`; its directory and their SHAs. */
function repository(count = 1) {
  const directory = mkdtempSync(join(tmpdir(), "check-shas-"));
  spawnSync("git", ["init", "-q", directory]);
  let stream = "";
  for (let n = 0; n < count; n += 1)
    stream += `commit refs/heads/main\ncommitter t <t@t> ${1_700_000_000 + n} +0000\ndata 1\n${n % 10}\n\n`;
  spawnSync("git", ["-C", directory, "fast-import", "--quiet"], { input: stream });
  const shas = spawnSync("git", ["-C", directory, "rev-list", "main"], { encoding: "utf8" })
    .stdout.trim()
    .split("\n");
  return { directory, shas };
}

/** The tool's exit status and output for `text`, read from standard input, in `repositories`. */
function check(text, repositories) {
  const result = spawnSync(
    process.execPath,
    [tool, ...repositories.flatMap((r) => ["--repo", r])],
    { input: text, encoding: "utf8" },
  );
  return { status: result.status, out: result.stdout + result.stderr };
}

test(
  "a SHA that resolves passes, with its full SHA and repository named",
  { timeout: 30_000 },
  () => {
    const { directory, shas } = repository();
    try {
      const { status, out } = check(`head ${shas[0].slice(0, 9)}, full ${shas[0]}`, [directory]);
      assert.equal(status, 0, out);
      assert.match(
        out,
        new RegExp(`resolved +${shas[0].slice(0, 9)} +${shas[0]} in ${directory}`, "u"),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a SHA that resolves nowhere fails, and the message says to fetch it",
  { timeout: 30_000 },
  () => {
    const { directory } = repository();
    try {
      const { status, out } = check("merged as 0123abc4567", [directory]);
      assert.equal(status, 1);
      assert.match(out, /unresolved +0123abc4567 .*fetch it/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a short SHA several commits share is ambiguous", { timeout: 60_000 }, () => {
  // (60,000 commits, so two of them share their first 7 hex characters)
  const { directory, shas } = repository(60_000);
  try {
    const seen = new Map();
    const shared = shas
      .map((sha) => sha.slice(0, 7))
      .find((prefix) => seen.has(prefix) || !seen.set(prefix, 1));
    assert.ok(shared, "two commits share a 7-character prefix");
    const { status, out } = check(`at ${shared}`, [directory]);
    assert.equal(status, 1);
    assert.match(out, new RegExp(`ambiguous +${shared} +2 commits`, "u"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "ids, job ids, hex words and paths that resolve nowhere are skipped; each still resolves when it can",
  { timeout: 30_000 },
  () => {
    const { directory, shas } = repository();
    try {
      // One case of each rule, as reports write them, none of them a commit here.
      const text = [
        "CI run 42406642863, comment 6707330977",
        "queue jobs 1107175450d1b5 and 1107180443a175",
        "a defaced cafebabe",
        "results in ~/jobs/results/clarity-a/11071351201ab1/out/ and /tmp/x/0c1d2e3f4a5b/",
        "see https://example.com/files/a1b2c3d4e5f6/report",
      ].join("\n");
      const { status, out } = check(text, [directory]);
      assert.equal(status, 0, out);
      assert.match(
        out,
        /9 tokens: 0 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 9 skipped/u,
      );
      // A commit URL is checked; a path that holds a real SHA still reports it.
      const url = check("https://github.com/o/r/commit/0123abc4567", [directory]);
      assert.equal(url.status, 1, url.out);
      assert.match(check(`tree/${shas[0]}`, [directory]).out, /resolved/u);
      for (const [token, text, why] of [
        ["42406642863", "run 42406642863", "only digits, an id"],
        ["1107175450d1b5", "job 1107175450d1b5", "a queue job id"],
        ["11071804431175", "job 11071804431175", "only digits, an id"],
        ["1107180443a175", "job 1107180443a175", "a queue job id"],
        ["11071804a1175f", "job 11071804a1175f", null],
        [
          "0123456789abcdef0123456789abcdef01234567",
          "/evidence/0123456789abcdef0123456789abcdef01234567/",
          null,
        ],
        ["defaced", "a defaced wall", "a word"],
        ["4322b2e0e668", "the runner's sha256 4322b2e0e668", "a file's sha256"],
        ["7ce49d8d3ba1", "(sha256: 7ce49d8d3ba1)", "a file's sha256"],
        ["7ce49d8d3ba1", "SHA256=7ce49d8d3ba1", "a file's sha256"],
        ["7ce49d8d3ba1", "the sha256 of 7ce49d8d3ba1", null],
        ["a1b2c3d4e5f6", "https://example.com/a1b2c3d4e5f6", "inside a URL or a path"],
        ["0c1d2e3f4a5b", "/tmp/x/0c1d2e3f4a5b/", "inside a URL or a path"],
        ["0123abc4567", "https://github.com/o/r/commit/0123abc4567", null],
        ["0123abc4567", "merged as 0123abc4567", null],
      ])
        assert.equal(excuse(token, text, text.indexOf(token)), why, text);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("an unfilled placeholder fails", { timeout: 30_000 }, () => {
  const { directory } = repository();
  try {
    for (const placeholder of ["<sha>", "<SHA>", "<head>", "<full SHA>", "<base sha>", "XXXXXXX"]) {
      const { status, out } = check(`PR head ${placeholder}, checks green`, [directory]);
      assert.equal(status, 1, placeholder);
      assert.match(out, /placeholder/u, placeholder);
    }
    // A fenced block shows a command's form, not a value.
    assert.equal(check("```sh\nsx-job submit --checkout <sha>\n```\n", [directory]).status, 0);
    // (also inside a list item, indented)
    assert.equal(check("- run\n\n  ```\n  git log <sha>\n  ```\n", [directory]).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "each --repo is asked, and a token resolves in the one that has it",
  { timeout: 30_000 },
  () => {
    const [first, second] = [repository(), repository(2)];
    try {
      const { status, out } = check(`${first.shas[0]} and ${second.shas[0]}`, [
        first.directory,
        second.directory,
      ]);
      assert.equal(status, 0, out);
      assert.match(out, new RegExp(`${first.shas[0]} in ${first.directory}`, "u"));
      assert.match(out, new RegExp(`${second.shas[0]} in ${second.directory}`, "u"));
      assert.equal(check("x", ["/nonexistent"]).status, 2);
    } finally {
      for (const { directory } of [first, second])
        rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "every completed run ends with its count line, also for empty input",
  { timeout: 30_000 },
  () => {
    const { directory, shas } = repository();
    try {
      for (const [text, line] of [
        [
          "",
          "0 tokens: 0 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 0 placeholders",
        ],
        [
          `at ${shas[0].slice(0, 9)}, <sha>`,
          "1 tokens: 1 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 1 placeholders",
        ],
      ]) {
        const { out } = check(text, [directory]);
        assert.equal(out.trim().split("\n").at(-1), `check-shas: ${line}`, JSON.stringify(text));
      }
      assert.equal(check("", [directory]).status, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

/** A repository whose `main` is pushed to a bare `origin`, and one commit after it that is not: their SHAs. */
function withRemote() {
  const { directory, shas } = repository(1);
  const origin = mkdtempSync(join(tmpdir(), "check-shas-origin-"));
  const git = (...args) => spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "--bare", origin]);
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
  git("fetch", "-q", "origin");
  const tree = git("rev-parse", "main^{tree}").stdout.trim();
  const local = spawnSync(
    "git",
    [
      "-C",
      directory,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit-tree",
      tree,
      "-p",
      "main",
      "-m",
      "local",
    ],
    { encoding: "utf8" },
  ).stdout.trim();
  git("update-ref", "refs/heads/main", local);
  return { directory, origin, pushed: shas[0], local };
}

test(
  "a commit a remote-tracking ref contains resolves; one only this clone has fails as local only",
  { timeout: 30_000 },
  () => {
    const { directory, origin, pushed, local } = withRemote();
    try {
      const on = check(`at ${pushed.slice(0, 9)}`, [directory]);
      assert.equal(on.status, 0, on.out);
      assert.match(on.out, /resolved +\w+ +\w+ in /u);
      assert.doesNotMatch(on.out, /no remote refs/u);
      const off = check(`at ${local.slice(0, 9)}`, [directory]);
      assert.equal(off.status, 1, off.out);
      assert.match(
        off.out,
        new RegExp(
          `local only +${local.slice(0, 9)} +${local} in .*: push it, or cite one on origin; for exact pre-rebase heads, push one archive ref whose parents are the cited heads`,
          "u",
        ),
      );
      assert.match(
        off.out.trim().split("\n").at(-1),
        /1 tokens: 0 resolved, 0 trees, 0 ambiguous, 0 unresolved, 1 local only, 0 skipped/u,
      );
    } finally {
      for (const path of [directory, origin]) rmSync(path, { recursive: true, force: true });
    }
  },
);

test(
  "a repository without remote-tracking refs is named once, and its commits resolve as before",
  { timeout: 30_000 },
  () => {
    const { directory, shas } = repository(2);
    try {
      const { status, out } = check(`${shas[0]} and ${shas[1]}`, [directory]);
      assert.equal(status, 0, out);
      assert.equal(out.match(/no remote refs in .*: reachability not checked/gu)?.length, 1, out);
      assert.match(out, /2 tokens: 2 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a tree hash resolves as a tree, without the remote check; a commit is never taken for its tree",
  { timeout: 30_000 },
  () => {
    const { directory, origin, pushed } = withRemote();
    try {
      const tree = spawnSync("git", ["-C", directory, "rev-parse", `${pushed}^{tree}`], {
        encoding: "utf8",
      }).stdout.trim();
      const { status, out } = check(
        `baseline tree ${tree.slice(0, 9)}, head ${pushed.slice(0, 9)}`,
        [directory],
      );
      assert.equal(status, 0, out);
      assert.match(
        out,
        new RegExp(
          `tree +${tree.slice(0, 9)} +${tree} in .*: a tree, not checked on a remote`,
          "u",
        ),
      );
      assert.match(out, new RegExp(`resolved +${pushed.slice(0, 9)} +${pushed}`, "u"));
      assert.match(out.trim().split("\n").at(-1), /2 tokens: 1 resolved, 1 trees,/u);
    } finally {
      for (const path of [directory, origin]) rmSync(path, { recursive: true, force: true });
    }
  },
);
