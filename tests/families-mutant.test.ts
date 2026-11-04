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

/** A git command in `cwd`, which must succeed. */
function git(cwd: string, ...args: string[]): string {
  const ran = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  assert.equal(ran.status, 0, `git ${args.join(" ")}: ${ran.stderr}`);
  return ran.stdout;
}

const newline = "line\nname.ts";
const tabbed = "kept.ts\textra.ts";
const magic = ":(exclude)never";
/** A file whose last line ends in CRLF, eight lines from its first. */
const mixed = `export const v = 1;\n${"// context\n".repeat(8)}// CRLF far from the hunk\r\n`;

interface Case {
  /** The mutation, made in the head's checkout; the patch is its whole change. */
  readonly change: (cwd: string) => void;
  /** The head's `.gitattributes`, where it has one. */
  readonly attributes?: string;
  /** Run after the head's commit, before the change (config, `.git/info/attributes`). */
  readonly setup?: (cwd: string) => void;
  /** Run in place of the queue's `git apply` of the patch. */
  readonly instead?: (cwd: string) => void;
  /** Run after the patch is applied. */
  readonly after?: (cwd: string) => void;
}

/**
 * A head (files, a path with a newline, one with a tab, one like pathspec magic, a symlink named like it, an
 * executable, a file of mixed line endings, an ignored `dist/`), the case's patch against it, that patch applied as
 * the queue applies it (`git apply --whitespace=nowarn`), and the proof's status and output.
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
      ...(c.attributes === undefined ? [] : [[".gitattributes", c.attributes]]),
    ])
      writeFileSync(join(cwd, path!), text!);
    symlinkSync("kept.ts", join(cwd, magic));
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "head");
    c.setup?.(cwd);
    c.change(cwd);
    git(cwd, "add", "-A", "-f");
    writeFileSync(patch, git(cwd, "diff", "--binary", "--cached", "-M", "HEAD"));
    git(cwd, "reset", "-q", "--hard");
    git(cwd, "clean", "-qfdx");
    if (c.instead !== undefined) c.instead(cwd);
    else git(cwd, "apply", "--whitespace=nowarn", patch);
    c.after?.(cwd);
    const ran = spawnSync(process.execPath, [tool, cwd, patch], { encoding: "utf8" });
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
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
  ["a renamed file", { change: (cwd) => spawnSync("git", ["mv", "two.ts", "moved.ts"], { cwd }) }],
  ["a mode change", { change: (cwd) => chmodSync(join(cwd, "exec.ts"), 0o755) }],
  ["a binary change", { change: write("two.ts", Buffer.from([0, 1, 2, 0])) }],
  // (conversions: both sides convert alike, Codex r1-r3 on #1686)
  ["ident", { attributes: "*.ts ident\n", change: write("kept.ts", 'export const v = "$Id$";\n') }],
  [
    "text=auto in .git/info/attributes",
    {
      setup: write(".git/info/attributes", "*.ts text=auto\n"),
      change: write("mixed.ts", mixed.replace("v = 1", "v = 2")),
    },
  ],
  [
    "core.autocrlf=1",
    {
      setup: (cwd) => git(cwd, "config", "core.autocrlf", "1"),
      change: write("mixed.ts", mixed.replace("v = 1", "v = 2")),
    },
  ],
  [
    "a filter driver named 'unspecified'",
    {
      attributes: "*.ts filter=unspecified\n",
      setup: (cwd) => {
        git(cwd, "config", "filter.unspecified.clean", "sed s/SMUDGED/CANONICAL/g");
        git(cwd, "config", "filter.unspecified.smudge", "sed s/CANONICAL/SMUDGED/g");
      },
      change: write("kept.ts", 'export const v = "CANONICAL";\n'),
    },
  ],
];

test("a mutant's proof accepts every patch the queue applied as written, its conversions alike on both sides (#1684)", () => {
  for (const [name, c] of SHAPES) {
    const ran = proved(c);
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    // EVIDENCE: mutant-proof.mjs prints this object as its one line of output; its fields are asserted below.
    const proof = JSON.parse(ran.stdout) as {
      patch: string;
      paths: { path: string; kind: string }[];
      outside: string[];
    };
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
    [
      // (the head with the literal hunk, its far CRLF kept, against the queue's normalized file: Codex r2 on #1686)
      "text=auto's normalization undone",
      {
        setup: write(".git/info/attributes", "*.ts text=auto\n"),
        change: write("mixed.ts", mixed.replace("v = 1", "v = 2")),
        after: write("mixed.ts", mixed.replace("v = 1", "v = 2")),
      },
      "mixed.ts",
    ],
  ] as const) {
    const ran = proved(c);
    assert.equal(ran.status, 1, `${name}: ${ran.stderr}`);
    assert.ok(ran.stderr.includes(JSON.stringify(path)), `${name}: ${ran.stderr}`);
  }
});

test("a mutant's proof reports a change outside the patch's paths and refuses a patch the head does not take (#1684)", () => {
  const outside = proved({ change: write("kept.ts", "a2\n"), after: write("two.ts", "b2\n") });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stderr, /outside the patch's paths, not part of the proof: "two.ts"/);
  assert.deepEqual(JSON.parse(outside.stdout).outside, ["two.ts"]);
  const empty = proved({ change: () => {}, instead: () => {} });
  assert.equal(empty.status, 2, empty.stderr);
  // (a filter driver the worker lacks, required: the fresh application fails, as the queue's would)
  const missing = proved({
    attributes: "*.ts filter=absent\n",
    change: write("kept.ts", "a2\n"),
    instead: (cwd) => git(cwd, "config", "filter.absent.required", "true"),
  });
  assert.equal(missing.status, 2, missing.stderr);
});
