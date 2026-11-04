import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const tool = resolve("tests/families/mutant-proof.mjs");

// (git's global and system config and attributes left out, here and in the proof: a runner's own, such as git-lfs's
// filter, would put every repository outside the proof's domain; the queue's workers carry none)
const home = mkdtempSync(join(tmpdir(), "mutant-proof-home-"));
writeFileSync(join(home, "gitconfig"), "");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  XDG_CONFIG_HOME: home,
};
test.after(() => rmSync(home, { recursive: true, force: true }));

/** A git command in `cwd`, which must succeed. */
function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout;
}

const newline = "line\nname.ts";
const tabbed = "kept.ts\textra.ts";
const magic = ":(exclude)never";
/** A path and a link target whose bytes are no UTF-8 (`\xff`, `\xfe`). */
const raw = (cwd: string, name: string) =>
  Buffer.concat([Buffer.from(`${cwd}/`), Buffer.from(name, "latin1")]);
/** A file whose last line ends in CRLF, eight lines from its first. */
const mixed = `export const v = 1;\n${"// context\n".repeat(8)}// CRLF far from the hunk\r\n`;

interface Case {
  /** The mutation, made in the head's checkout; the patch is its whole change. */
  readonly change: (cwd: string) => void;
  /** Run before the head's commit (its tracked files). */
  readonly head?: (cwd: string) => void;
  /** Run after the head's commit, before the change (config, hooks, `.git/info/attributes`). */
  readonly setup?: (cwd: string) => void;
  /** Run in place of the queue's `git apply` of the patch. */
  readonly instead?: (cwd: string) => void;
  /** Run after the patch is applied. */
  readonly after?: (cwd: string) => void;
}

/**
 * A head (files, paths with a newline, a tab, bytes that are no UTF-8, one like pathspec magic, symlinks, an executable,
 * a file of mixed line endings, an ignored `dist/`), the case's patch against it, that patch applied as the queue
 * applies it (`git apply --whitespace=nowarn`), the proof's status and output, and the worktrees registered after it.
 */
function proved(c: Case) {
  const cwd = mkdtempSync(join(tmpdir(), "mutant-proof-"));
  const patch = `${cwd}.diff`;
  try {
    git(cwd, "init", "-q");
    for (const [path, text] of [
      [".gitignore", "dist/\n"],
      ["kept.ts", "a\n"],
      ["two.ts", "b\n"],
      [newline, "x\n"],
      [tabbed, "before\n"],
      [":literal.ts", "l\n"],
      ["exec.ts", "e\n"],
      ["mixed.ts", mixed],
    ])
      writeFileSync(join(cwd, path!), text!);
    writeFileSync(raw(cwd, "raw-\xff.ts"), "r\n");
    symlinkSync("kept.ts", join(cwd, magic));
    symlinkSync(Buffer.from("target-\xff", "latin1"), join(cwd, "link"));
    c.head?.(cwd);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "head");
    c.setup?.(cwd);
    c.change(cwd);
    git(cwd, "add", "-A", "-f");
    // (the patch as bytes: a path or link target that is no UTF-8 must reach it unchanged)
    const diff = spawnSync("git", ["diff", "--binary", "--cached", "-M", "HEAD"], { cwd, env });
    assert.equal(diff.status, 0, String(diff.stderr));
    writeFileSync(patch, diff.stdout);
    git(cwd, "reset", "-q", "--hard");
    git(cwd, "clean", "-qfdx");
    if (c.instead !== undefined) c.instead(cwd);
    else git(cwd, "apply", "--whitespace=nowarn", patch);
    c.after?.(cwd);
    const ran = spawnSync(process.execPath, [tool, cwd, patch], { encoding: "utf8", env });
    const worktrees = git(cwd, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length;
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr, worktrees };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(patch, { force: true });
  }
}

const write = (path: string, text: string | Buffer) => (cwd: string) =>
  writeFileSync(join(cwd, path), text);

/** Codex's shapes on #1680 and #1686 and the ordinary ones: each a patch the queue applies. */
const SHAPES: readonly (readonly [string, Case])[] = [
  ["one file", { change: write("kept.ts", "a2\n") }],
  [
    "two files",
    {
      change: (cwd) => {
        write("kept.ts", "a2\n")(cwd);
        write("two.ts", "b2\n")(cwd);
      },
    },
  ],
  ["a newline in a path", { change: write(newline, "y\n") }],
  ["a tab in a path", { change: write(tabbed, "after\n") }],
  ["a path like pathspec magic", { change: write(":literal.ts", "l2\n") }],
  [
    "a path and a link target of bytes that are no UTF-8",
    {
      change: (cwd) => {
        writeFileSync(raw(cwd, "raw-\xff.ts"), "r2\n");
        unlinkSync(join(cwd, "link"));
        symlinkSync(Buffer.from("target-\xfe", "latin1"), join(cwd, "link"));
      },
    },
  ],
  [
    "a symlink named like pathspec magic, retargeted",
    {
      change: (cwd) => {
        write("kept.ts", "a2\n")(cwd);
        unlinkSync(join(cwd, magic));
        symlinkSync("two.ts", join(cwd, magic));
      },
    },
  ],
  [
    "an ignored path added",
    {
      change: (cwd) => {
        write("kept.ts", "a2\n")(cwd);
        mkdirSync(join(cwd, "dist"));
        write("dist/extra.js", "d\n")(cwd);
      },
    },
  ],
  [
    "a helper the patch ignores",
    {
      change: (cwd) => {
        write("helper.ts", "h\n")(cwd);
        write(".gitignore", "dist/\nhelper.ts\n")(cwd);
        write("kept.ts", 'a\nimport "./helper"\n')(cwd);
      },
    },
  ],
  ["a removed file", { change: (cwd) => unlinkSync(join(cwd, "two.ts")) }],
  [
    "a renamed file",
    { change: (cwd) => spawnSync("git", ["mv", "two.ts", "moved.ts"], { cwd, env }) },
  ],
  ["a mode change", { change: (cwd) => chmodSync(join(cwd, "exec.ts"), 0o755) }],
  ["a binary change", { change: write("two.ts", Buffer.from([0, 1, 2, 0])) }],
  // (core.autocrlf is git's own conversion, in config: the replay converts alike, Codex r2-r3 on #1686)
  [
    "core.autocrlf=1",
    {
      setup: (cwd) => git(cwd, "config", "core.autocrlf", "1"),
      change: write("mixed.ts", mixed.replace("v = 1", "v = 2")),
    },
  ],
];

test("a mutant's proof accepts every patch the queue applied as written, and leaves no worktree behind (#1684)", () => {
  for (const [name, c] of SHAPES) {
    const ran = proved(c);
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    assert.equal(ran.worktrees, 1, name);
    // EVIDENCE: mutant-proof.mjs prints this object as its one line of output; its fields are asserted below.
    const proof = JSON.parse(ran.stdout) as {
      domain: string;
      patch: string;
      paths: { path: string; kind: string }[];
      outside: string[];
    };
    assert.match(proof.domain, /no user code in the conversion path/, name);
    assert.match(proof.patch, /^[0-9a-f]{64}$/, name);
    assert.ok(proof.paths.length > 0, name);
    assert.deepEqual(proof.outside, [], name);
  }
});

test("a mutant's proof refuses a checkout the patch did not make at any path it touches, naming it (#1684)", () => {
  for (const [name, c, path] of [
    [
      "another change",
      { change: write("kept.ts", "a2\n"), instead: write("kept.ts", "something else\n") },
      "kept.ts",
    ],
    [
      "an edit after the apply",
      { change: write("kept.ts", "a2\n"), after: write("kept.ts", "a2\nedited after\n") },
      "kept.ts",
    ],
    [
      "a tab path's patch unapplied",
      { change: write(tabbed, "after\n"), instead: () => {} },
      tabbed,
    ],
    [
      // (Codex r4 on #1686: paths and link targets compared as bytes, never decoded)
      "a path and a link target of bytes that are no UTF-8, unapplied",
      {
        change: (cwd: string) => {
          writeFileSync(raw(cwd, "raw-\xff.ts"), "r2\n");
          unlinkSync(join(cwd, "link"));
          symlinkSync(Buffer.from("target-\xfe", "latin1"), join(cwd, "link"));
        },
        instead: () => {},
      },
      "link",
    ],
    [
      "an ignored path the checkout lacks",
      {
        change: (cwd: string) => {
          mkdirSync(join(cwd, "dist"));
          write("dist/extra.js", "d\n")(cwd);
          write("kept.ts", "a2\n")(cwd);
        },
        after: (cwd: string) => rmSync(join(cwd, "dist"), { recursive: true }),
      },
      "dist/extra.js",
    ],
    [
      "a removal not made",
      { change: (cwd: string) => unlinkSync(join(cwd, "two.ts")), instead: () => {} },
      "two.ts",
    ],
    [
      "a mode change not made",
      {
        change: (cwd: string) => chmodSync(join(cwd, "exec.ts"), 0o755),
        after: (cwd: string) => chmodSync(join(cwd, "exec.ts"), 0o644),
      },
      "exec.ts",
    ],
  ] as const) {
    const ran = proved(c);
    assert.equal(ran.status, 1, `${name}: ${ran.stderr}`);
    assert.ok(ran.stderr.includes(JSON.stringify(path)), `${name}: ${ran.stderr}`);
    assert.equal(ran.worktrees, 1, name);
  }
});

test("a mutant's proof refuses a repository with user code in the conversion path, by presence alone (#1684)", () => {
  // (Codex r1-r4 on #1686: attributes, filters and hooks are code a replay cannot prove alike; the queue's checkouts
  // carry none of them)
  const ident = write("kept.ts", 'export const v = "$Id$";\n');
  for (const [name, c, found] of [
    [
      "a tracked .gitattributes",
      { head: write(".gitattributes", "*.ts ident\n"), change: ident },
      /".gitattributes"/,
    ],
    [
      ".git/info/attributes",
      { setup: write(".git/info/attributes", "*.ts text=auto\n"), change: ident },
      /\.git\/info\/attributes/,
    ],
    [
      "core.attributesFile",
      {
        setup: (cwd: string) => git(cwd, "config", "core.attributesFile", "/nonexistent"),
        change: ident,
      },
      /core\.attributesFile/,
    ],
    [
      "filter config without attributes",
      {
        setup: (cwd: string) => git(cwd, "config", "filter.zero.clean", "sed s/1/0/g"),
        change: ident,
      },
      /filter config/,
    ],
    [
      "an executable hook",
      {
        setup: (cwd: string) => {
          writeFileSync(join(cwd, ".git", "hooks", "post-checkout"), "#!/bin/sh\nexit 19\n", {
            mode: 0o755,
          });
        },
        change: ident,
      },
      /the hook "post-checkout"/,
    ],
    [
      "core.fileMode=false",
      { setup: (cwd: string) => git(cwd, "config", "core.fileMode", "off"), change: ident },
      /core\.fileMode=false/,
    ],
    [
      "a gitlink",
      {
        head: (cwd: string) => {
          git(cwd, "add", "-A");
          git(cwd, "commit", "-qm", "base");
          const head = git(cwd, "rev-parse", "HEAD").trim();
          mkdirSync(join(cwd, "sub"));
          git(cwd, "update-index", "--add", "--cacheinfo", `160000,${head},sub`);
        },
        change: ident,
      },
      /the gitlink "sub"/,
    ],
  ] as const) {
    const ran = proved(c);
    assert.deepEqual([ran.status, ran.stdout], [2, ""], `${name}: ${ran.stderr}`);
    assert.match(ran.stderr, /outside the proof's domain/, name);
    assert.match(ran.stderr, found, name);
    assert.equal(ran.worktrees, 1, name);
  }
  // (the default global attributes file, `$XDG_CONFIG_HOME/git/attributes`, present while the proof runs)
  mkdirSync(join(home, "git"), { recursive: true });
  writeFileSync(join(home, "git", "attributes"), "");
  try {
    const global = proved({ change: ident });
    assert.deepEqual([global.status, global.stdout], [2, ""], global.stderr);
    assert.match(global.stderr, /outside the proof's domain[^\n]*git\/attributes/);
  } finally {
    rmSync(join(home, "git"), { recursive: true, force: true });
  }
});

test("a mutant's proof reports a change outside the patch's paths and refuses a patch the head does not take (#1684)", () => {
  const outside = proved({ change: write("kept.ts", "a2\n"), after: write("two.ts", "b2\n") });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stderr, /outside the patch's paths, not part of the proof: "two.ts"/);
  assert.deepEqual(JSON.parse(outside.stdout).outside, ["two.ts"]);
  const empty = proved({ change: () => {}, instead: () => {} });
  assert.equal(empty.status, 2, empty.stderr);
  assert.equal(empty.worktrees, 1);
});
