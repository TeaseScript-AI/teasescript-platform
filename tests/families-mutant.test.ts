import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
const magic = ":(exclude)never";
const tabbed = "kept.ts\textra.ts";

/**
 * A head (files, a symlink named like pathspec magic, a path with a tab, an ignored `dist/`, `attributes` as its
 * `.gitattributes`), the patch `change` makes against it, that patch applied as the queue applies it (or `instead`,
 * another change), `after` then, and the proof's status and output.
 */
function proved(
  change: (cwd: string) => void,
  instead?: (cwd: string) => void,
  after?: (cwd: string) => void,
  attributes?: string,
) {
  const cwd = mkdtempSync(join(tmpdir(), "mutant-proof-"));
  try {
    git(cwd, "init", "-q");
    for (const [path, text] of [
      [".gitignore", "dist/\n"],
      ["kept.ts", "a\n"],
      ["two.ts", "b\n"],
      [newline, "x\n"],
      [":literal.ts", "l\n"],
      ["exec.ts", "e\n"],
      [tabbed, "before\n"],
      ...(attributes === undefined ? [] : [[".gitattributes", attributes]]),
    ])
      writeFileSync(join(cwd, path!), text!);
    symlinkSync("kept.ts", join(cwd, magic));
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", "head");
    change(cwd);
    git(cwd, "add", "-A", "-f");
    const patch = join(cwd, "..", `${cwd.split("/").at(-1)}.diff`);
    writeFileSync(patch, git(cwd, "diff", "--binary", "--cached", "-M", "HEAD"));
    git(cwd, "reset", "-q", "--hard");
    git(cwd, "clean", "-qfdx");
    if (instead === undefined) {
      if (spawnSync("git", ["apply", "--whitespace=nowarn", patch], { cwd }).status !== 0)
        return { status: -1, stdout: "", stderr: "the queue would not apply it" };
    } else instead(cwd);
    after?.(cwd);
    const ran = spawnSync(process.execPath, [tool, cwd, patch], { encoding: "utf8" });
    rmSync(patch, { force: true });
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a mutant's proof accepts a patch of files' text applied as written, with each path's exact blobs (#1684)", () => {
  for (const [name, change] of [
    ["one file", (cwd: string) => writeFileSync(join(cwd, "kept.ts"), "a2\n")],
    [
      "two files",
      (cwd: string) => {
        writeFileSync(join(cwd, "kept.ts"), "a2\n");
        writeFileSync(join(cwd, "two.ts"), "b2\n");
      },
    ],
    ["a newline in its path", (cwd: string) => writeFileSync(join(cwd, newline), "y\n")],
    [
      "a path like pathspec magic",
      (cwd: string) => writeFileSync(join(cwd, ":literal.ts"), "l2\n"),
    ],
    ["a tab in its path", (cwd: string) => writeFileSync(join(cwd, tabbed), "after\n")],
  ] as const) {
    const ran = proved(change);
    assert.equal(ran.status, 0, `${name}: ${ran.stderr}`);
    // EVIDENCE: mutant-proof.mjs prints this object as its one line of output; each field is asserted below.
    const proof = JSON.parse(ran.stdout) as {
      patch: string;
      paths: {
        path: string;
        head: string;
        expected: string;
        expectedFile: string;
        checkoutFile: string;
      }[];
    };
    assert.match(proof.patch, /^[0-9a-f]{64}$/, name);
    assert.ok(proof.paths.length > 0, name);
    for (const each of proof.paths) {
      assert.equal(each.checkoutFile, each.expectedFile, `${name}: ${each.path}`);
      assert.notEqual(each.head, each.expected, `${name}: ${each.path}`);
    }
    if (name === "a tab in its path")
      assert.deepEqual(
        proof.paths.map((each) => each.path),
        [tabbed],
      );
  }
});

test("a mutant's proof refuses any other patch, Codex r4's three shapes on #1680 among them, and a checkout the patch did not make (#1684)", () => {
  for (const [name, change, status, why] of [
    // (Codex r4: an ignored path a patch adds; a patch that ignores its own new helper; a symlink named like pathspec
    // magic beside a changed file)
    [
      "an ignored path added",
      (cwd: string) => {
        writeFileSync(join(cwd, "kept.ts"), "a2\n");
        spawnSync("mkdir", ["-p", join(cwd, "dist")]);
        writeFileSync(join(cwd, "dist", "extra.js"), "d\n");
      },
      2,
      /creates, deletes/,
    ],
    [
      "a helper the patch ignores",
      (cwd: string) => {
        writeFileSync(join(cwd, "helper.ts"), "h\n");
        writeFileSync(join(cwd, ".gitignore"), "dist/\nhelper.ts\n");
        writeFileSync(join(cwd, "kept.ts"), 'a\nimport "./helper"\n');
      },
      2,
      /creates, deletes/,
    ],
    [
      "a symlink named like pathspec magic",
      (cwd: string) => {
        writeFileSync(join(cwd, "kept.ts"), "a2\n");
        unlinkSync(join(cwd, magic));
        symlinkSync("two.ts", join(cwd, magic));
      },
      2,
      /no regular file at the head/,
    ],
    ["a removed file", (cwd: string) => unlinkSync(join(cwd, "two.ts")), 2, /creates, deletes/],
    [
      "a renamed file",
      (cwd: string) => spawnSync("git", ["mv", "two.ts", "moved.ts"], { cwd }),
      2,
      /creates, deletes/,
    ],
    [
      "a mode change",
      (cwd: string) => spawnSync("chmod", ["+x", join(cwd, "exec.ts")]),
      2,
      /creates, deletes/,
    ],
    [
      "a binary change",
      (cwd: string) => writeFileSync(join(cwd, "two.ts"), Buffer.from([0, 1, 2, 0])),
      2,
      /binary/,
    ],
  ] as const) {
    const ran = proved(change);
    assert.deepEqual([ran.status, ran.stdout], [status, ""], `${name}: ${ran.stderr}`);
    assert.match(ran.stderr, why, name);
  }
  // (a checkout other than the head with the patch: its file is compared with the patch applied to the head)
  const other = proved(
    (cwd) => writeFileSync(join(cwd, "kept.ts"), "a2\n"),
    (cwd) => writeFileSync(join(cwd, "kept.ts"), "something else\n"),
  );
  assert.equal(other.status, 1, other.stderr);
  assert.match(other.stderr, /not the head with the patch applied at "kept.ts"/);
  // (a sound patch applied as the queue applies it, its file edited after the apply: a result no apply of it gives)
  const edited = proved(
    (cwd) => writeFileSync(join(cwd, "kept.ts"), "a2\n"),
    undefined,
    (cwd) => writeFileSync(join(cwd, "kept.ts"), "a2\nedited after the apply\n"),
  );
  assert.equal(edited.status, 1, edited.stderr);
  assert.match(edited.stderr, /not the head with the patch applied at "kept.ts"/);
  // (Codex r1 on #1686: a path with a tab, its patch left unapplied)
  const unapplied = proved(
    (cwd) => writeFileSync(join(cwd, tabbed), "after\n"),
    () => {},
  );
  assert.equal(unapplied.status, 1, unapplied.stderr);
  assert.ok(unapplied.stderr.includes(JSON.stringify(tabbed)), unapplied.stderr);
  // (Codex r1 and r2 on #1686: any conversion between a file's bytes and its blob, from a tracked `.gitattributes`,
  // `.git/info/attributes` or `core.autocrlf`, is refused: `git apply` converts its preimage, a checkout its output,
  // and neither is proved alike, so an expansion replaced after the apply, or a line ending restored, could pass)
  const ident = (cwd: string) => writeFileSync(join(cwd, "kept.ts"), 'export const v = "$Id$";\n');
  const tracked = proved(ident, undefined, undefined, "*.ts ident\n");
  assert.deepEqual([tracked.status, tracked.stdout], [2, ""], tracked.stderr);
  assert.match(tracked.stderr, /'ident: set'; a mutant's files must convert in no way/);
  const info = proved(
    (cwd) => {
      writeFileSync(join(cwd, ".git", "info", "attributes"), "*.ts text=auto\n");
      writeFileSync(join(cwd, "kept.ts"), "a2\n");
    },
    undefined,
    (cwd) => writeFileSync(join(cwd, ".git", "info", "attributes"), "*.ts text=auto\n"),
  );
  assert.deepEqual([info.status, info.stdout], [2, ""], info.stderr);
  assert.match(info.stderr, /'text: auto'/);
  const autocrlf = proved(
    (cwd) => writeFileSync(join(cwd, "kept.ts"), "a2\n"),
    undefined,
    (cwd) => git(cwd, "config", "core.autocrlf", "true"),
  );
  assert.deepEqual([autocrlf.status, autocrlf.stdout], [2, ""], autocrlf.stderr);
  assert.match(autocrlf.stderr, /core.autocrlf is true/);
  // (a patch of an existing `.gitattributes` changes how the other files convert: refused)
  const attributes = proved(
    (cwd) => {
      writeFileSync(join(cwd, ".gitattributes"), "*.ts ident\n");
      writeFileSync(join(cwd, "kept.ts"), "a2\n");
    },
    undefined,
    undefined,
    "\n",
  );
  assert.deepEqual([attributes.status, attributes.stdout], [2, ""], attributes.stderr);
  assert.match(attributes.stderr, /changes how files convert/);
});
