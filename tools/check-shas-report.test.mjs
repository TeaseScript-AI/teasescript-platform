// check-shas's tests of the rest of its report: unfilled placeholders, closing clauses that name several issues, paths
// into the scratch area, its last line, and --append, which writes that line into the file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { closingClausesOf, scratchPathsOf } from "./check-shas.mjs";
import { tool, repository, check } from "./check-shas-test-support.mjs";

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
  "a closing clause that names several issues after one keyword fails",
  { timeout: 30_000 },
  () => {
    const { directory } = repository();
    try {
      const { status, out } = check("Closes #1970, #1965, #1956 (by the ruled reading)\n", [
        directory,
      ]);
      assert.equal(status, 1, out);
      assert.match(
        out,
        /closing +line 1: "Closes #1970, #1965, #1956" names several issues after one keyword; as closing syntax it closes only #1970\. Give each issue meant to close its own keyword \(Closes #1, Closes #2\); otherwise end the clause after the first reference \(a new sentence for the rest\), or split a quoted example so that no keyword stands before the list$/mu,
      );
      // (the final's colour: digits that run on into a word character are no reference)
      const colour = check("Fixes #2147" + ", #123abc now normalizes identically.\n", [directory]);
      assert.equal(colour.status, 0, colour.out);
      assert.match(
        out.trim().split("\n").at(-1),
        /0 placeholders, 1 multi-issue closing clauses, 0 scratch paths$/u,
      );
      // (a comma and a conjunction together, across a line break)
      const listed = check("text\nCloses #12,\nand #13\n", [directory]);
      assert.equal(listed.status, 1, listed.out);
      assert.match(listed.out, /line 2: "Closes #12,\nand #13" .* closes only #12\. /u);
      // (a cost witness: a comma and 60,000 spaces before no reference, which an overlapping separator walked quadratically)
      const spaces = check(`Closes #12,${" ".repeat(60_000)}x`, [directory]);
      assert.equal(spaces.status, 0, spaces.out);
      for (const [text, closes] of [
        ["fixes: #1 and #2", ["#1"]],
        ["Closes #12, and #13", ["#12"]],
        ["closes: https://github.com/o/r/issues/1, #2", ["https://github.com/o/r/issues/1"]],
        ["Closes #1, https://github.com/o/r/issues/2", ["#1"]],
        // (code is read like any text: a quoted clause fails, whatever code or delimiters surround it)
        ["``a`b`` Closes #12, #13 `tail`", ["#12"]],
        ["    ```\n\nCloses #12, #13\n\n    ```\n", ["#12"]],
        ["``Closes #1, #2``", ["#1"]],
        ["~~~\nCloses #1, #2\n~~~\n", ["#1"]],
        ["\\` Closes #12, #13 `tail`", ["#12"]],
        ["literal `\n# Heading\nCloses #12, #13 `tail`", ["#12"]],
        ["literal `\r\n\r\nCloses #12, #13\r\n\r\n`tail`", ["#12"]],
        ["```bad`info\n\nCloses #12, #13\n\n```\n", ["#12"]],
        // (a cost witness: a 60,000-backtick line, which the earlier code stripping walked superlinearly)
        [`${"`".repeat(60_000)}\nCloses #12, #13\n`, ["#12"]],
        ["Closes #1 `x` #2", []],
        ["Resolved o/r#3 & #4", ["o/r#3"]],
        ["closed #5,#6", ["#5"]],
        ["Closes #1, closes #2", []],
        ["Closes #1\nRefs #2, #3", []],
        ["Closes #1. #2 follows", []],
        ["the comment `Closes #1, #2` closed only #1", ["#1"]],
        ["```\nCloses #1, #2\n```\n", ["#1"]],
        // (each keyword and reference form, so that a pattern missing one fails its row)
        ["close #1, #2", ["#1"]],
        ["Fixed #1, #2", ["#1"]],
        ["FIX #1, #2", ["#1"]],
        ["resolve #1, #2", ["#1"]],
        ["resolves #1 & #2", ["#1"]],
        ["Closes o/r#1, #2", ["o/r#1"]],
        ["encloses #1, #2", []],
      ])
        assert.deepEqual(
          closingClausesOf(text).map((found) => found.closes),
          closes,
          JSON.stringify(text),
        );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("closingClausesOf, over generated clauses: a reference ends where its number ends", () => {
  const keywords = [
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ];
  const spellings = [
    (k) => k,
    (k) => k[0].toUpperCase() + k.slice(1),
    (k) => `${k.toUpperCase()}:`,
  ];
  const forms = [(n) => `#${n}`, (n) => `o/r#${n}`, (n) => `https://github.com/o/r/issues/${n}`];
  const separators = [", ", " and ", ", and ", " & "];
  // What stands directly after a reference's digits, and whether the reference still ends there: a word character
  // (a letter of any script, a connector, a combining mark, a digit of any script) runs the number on, so there is no
  // reference.
  // (`null` is the end of the text after the second reference, and nothing but the separator after the first)
  const after = [
    [null, true],
    [" ", true],
    [".", true],
    [")", true],
    ["-", true],
    ["\n", true],
    ["abc", false],
    ["é", false],
    ["_x", false],
    ["\u203f", false],
    ["\u0301", false],
    ["١", false],
  ];
  let cases = 0;
  for (const keyword of keywords)
    for (const spell of spellings)
      for (const form of forms)
        for (const separator of separators)
          for (const [first, firstEnds] of after)
            for (const [second, secondEnds] of after) {
              // (a first reference stays in a list only when the separator follows it, so after it stands nothing
              // or a word character; any other character ends the clause before the list)
              if (firstEnds && first !== null) continue;
              const text =
                `${spell(keyword)} ${form(12)}${first ?? ""}${separator}${form(13)}` +
                (second === null ? "" : `${second} rest`);
              const expected = firstEnds && secondEnds ? [form(12)] : [];
              assert.deepEqual(
                closingClausesOf(text).map((found) => found.closes),
                expected,
                JSON.stringify(text),
              );
              cases += 1;
            }
  assert.equal(cases, 9 * 3 * 3 * 4 * 7 * 12);
});

test(
  "a path into the scratch area is named with its line and counted, and fails nothing",
  { timeout: 60_000 },
  () => {
    const { directory } = repository();
    try {
      const { status, out } = check(
        "Report\nEvidence /tmp/agent-work/lane3/cross64.tsv, retained at ~/work/evidence/lane3/cross64.tsv.\n",
        [directory],
      );
      assert.equal(status, 0, out);
      assert.match(
        out,
        /^scratch +line 2: \/tmp\/agent-work\/lane3\/cross64\.tsv +under \/tmp\/agent-work, deleted after inactivity: if a reader needs the file, move it to retained evidence and cite that copy$/mu,
      );
      assert.match(
        out.trim().split("\n").at(-1),
        /0 placeholders, 0 multi-issue closing clauses, 1 scratch paths$/u,
      );
      // The count beside a failure: a scratch path changes no exit status either way.
      assert.equal(check("<sha> in /tmp/agent-work/a/b\n", [directory]).status, 1);
      for (const [text, count] of [
        ["|/tmp/agent-work/a|/tmp/agent-work/b|", 2],
        [
          "The scratch area is /tmp/agent-work/. Or /tmp/agent-work/... or /tmp/agent-work/<task>/",
          0,
        ],
      ]) {
        const result = check(`${text}\n`, [directory]);
        assert.equal(result.status, 0, `${text}: ${result.out}`);
        assert.match(
          result.out.trim().split("\n").at(-1),
          new RegExp(` ${count} scratch paths$`, "u"),
          text,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "scratchPathsOf, over generated descendants, containers and endings",
  { timeout: 30_000 },
  () => {
    const before = ["/tmp/", "../"];
    const area = ["agent-work"];
    const inside = ["a", "@lane/r.out", "+run/r.out", "épreuve/r.out", "./a/b.txt", "a/../b"];
    const outside = ["", ".", "./", "..", "../a", "<task>/", "./."];
    const containers = [
      (p) => p,
      (p) => `\`${p}\``,
      (p) => `(${p})`,
      (p) => `[r](${p})`,
      (p) => `| ${p} |`,
      (p) => `'${p}'`,
      (p) => `"${p}"`,
    ];
    const endings = ["", ".", ",", ";", ":", "!", "?", "..."];
    let cases = 0;
    for (const head of before)
      for (const name of area)
        for (const [tails, named] of [
          [inside, true],
          [outside, false],
        ])
          for (const tail of tails)
            for (const contain of containers)
              for (const end of endings) {
                const path = `${head}${name}/${tail}`;
                const text = `see ${contain(path)}${end} next`;
                // (a path's own last characters that are sentence punctuation are no part of what it names)
                const expected = named ? [path.replace(/[.,;:!?]+$/u, "")] : [];
                assert.deepEqual(
                  scratchPathsOf(text).map((found) => found.path),
                  expected,
                  text,
                );
                cases += 1;
              }
    assert.equal(cases, 2 * 13 * 7 * 8);
    for (const [text, paths] of [
      ["/tmp/agent-work/a and /tmp/agent-work/a", ["/tmp/agent-work/a"]],
      ["/tmp/agent-workshop/a bin/prepare-agent-workspace.sh", []],
      ["~/work/evidence/friction/a.out", []],
      // (the area's name is what is seen, wherever the folder is: a folder of that name elsewhere counts too)
      ["/home/x/tmp/agent-work/a", ["/home/x/tmp/agent-work/a"]],
    ])
      assert.deepEqual(
        scratchPathsOf(text).map((found) => found.path),
        paths,
        text,
      );
    // Each path once, with the line it first stands on.
    assert.deepEqual(
      scratchPathsOf("a\r\nb /tmp/agent-work/x\n\n/tmp/agent-work/y /tmp/agent-work/x"),
      [
        { path: "/tmp/agent-work/x", line: 2 },
        { path: "/tmp/agent-work/y", line: 4 },
      ],
    );
    // Cost: punctuation inside or at the end of a long path is read once. A regex trimming the end took quadratic time,
    // about 400 s here; linear takes milliseconds. The child is killed at 20 s, as a test's timeout stops no loop.
    const cost = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { scratchPathsOf } from ${JSON.stringify(tool)};
const dots = ".".repeat(2 ** 19);
const found = [
  scratchPathsOf("/tmp/agent-work/a" + dots + "x").length,
  scratchPathsOf("/tmp/agent-work/" + dots).length,
  scratchPathsOf("/tmp/agent-work" + "/.".repeat(2 ** 18) + "/a").length,
];
process.stdout.write(found.join(" "));`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(cost.signal, null, "killed at 20 s");
    assert.equal(cost.stdout, "1 0 1", cost.stderr);
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
          "0 tokens: 0 resolved, 0 trees, 0 blobs, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 0 placeholders, 0 multi-issue closing clauses, 0 scratch paths",
        ],
        [
          `at ${shas[0].slice(0, 9)}, <sha>`,
          "1 tokens: 1 resolved, 0 trees, 0 blobs, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 1 placeholders, 0 multi-issue closing clauses, 0 scratch paths",
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

test(
  "--append writes the run's last line as the file's own last line, replacing its earlier one",
  { timeout: 30_000 },
  () => {
    const { directory, shas } = repository();
    const report = join(directory, "report.md");
    const run = (...extra) =>
      spawnSync(process.execPath, [tool, "--repo", directory, "--append", ...extra, report], {
        encoding: "utf8",
      });
    try {
      writeFileSync(report, `READY at ${shas[0].slice(0, 9)}.\n`);
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      const line = first.stdout.trim().split("\n").at(-1);
      assert.match(line, /^check-shas: 1 tokens: 1 resolved, /u);
      assert.equal(readFileSync(report, "utf8"), `READY at ${shas[0].slice(0, 9)}.\n\n${line}\n`);
      // A second run, after an edit, checks the text without its own line and replaces it.
      writeFileSync(
        report,
        readFileSync(report, "utf8").replace("READY at", "READY, <sha> fixed, at"),
      );
      const second = run();
      assert.equal(second.status, 1, second.stdout);
      const written = readFileSync(report, "utf8");
      assert.equal(written.match(/^check-shas: /gmu).length, 1, written);
      assert.match(
        written.trim().split("\n").at(-1),
        /1 tokens: 1 resolved, .*; 1 placeholders, 0 multi-issue closing clauses, 0 scratch paths$/u,
      );
      // It needs a file to write.
      const piped = spawnSync(process.execPath, [tool, "--repo", directory, "--append"], {
        input: "x",
        encoding: "utf8",
      });
      assert.equal(piped.status, 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "--append replaces only a whole last line of its own, in place, and says what a failed write left",
  { timeout: 60_000 },
  () => {
    const { directory, shas } = repository();
    const report = join(directory, "report.md");
    const run = (file = report) =>
      spawnSync(process.execPath, [tool, "--repo", directory, "--append", file], {
        encoding: "utf8",
        timeout: 20_000,
      });
    const own = (placeholders) =>
      `check-shas: 1 tokens: 1 resolved, 0 trees, 0 blobs, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); ${placeholders} placeholders, 0 multi-issue closing clauses, 0 scratch paths`;
    try {
      // A quoted or partial line is the report's text: kept, and checked.
      for (const [ending, placeholders] of [
        ["Quoted check-shas: 0 tokens: <sha>", 1],
        [`> ${own(0)}`, 0],
        [`\`${own(0)}\``, 0],
        ["check-shas: 0 tokens:\n<sha>", 1],
        [`${own(0)} and more`, 0],
      ]) {
        const text = `READY at ${shas[0].slice(0, 9)}.\n\n${ending}\n`;
        writeFileSync(report, text);
        const result = run();
        assert.equal(result.status, placeholders > 0 ? 1 : 0, `${ending}: ${result.stdout}`);
        assert.equal(readFileSync(report, "utf8"), `${text}\n${own(placeholders)}\n`, ending);
      }
      // An own line that is not last is text, kept and checked; the new line goes after the text.
      const inner = `READY at ${shas[0].slice(0, 9)}.\n${own(0)}\nmore\n`;
      writeFileSync(report, inner);
      assert.equal(run().status, 0);
      assert.equal(readFileSync(report, "utf8"), `${inner}\n${own(0)}\n`);
      // A last line in the form from before blobs were counted is its own too, and replaced.
      writeFileSync(
        report,
        `READY at ${shas[0].slice(0, 9)}.\n\n${own(0).replace("0 blobs, ", "")}\n`,
      );
      assert.equal(run().status, 0);
      assert.equal(readFileSync(report, "utf8"), `READY at ${shas[0].slice(0, 9)}.\n\n${own(0)}\n`);
      // A symbolic and a hard link: the file is written in place, through both; its mode stays its own.
      const target = join(directory, "target.md");
      writeFileSync(target, `READY at ${shas[0].slice(0, 9)}.\n`);
      chmodSync(target, 0o640);
      symlinkSync(target, join(directory, "link.md"));
      linkSync(target, join(directory, "hard.md"));
      assert.equal(run(join(directory, "link.md")).status, 0);
      assert.ok(lstatSync(join(directory, "link.md")).isSymbolicLink());
      const written = `READY at ${shas[0].slice(0, 9)}.\n\n${own(0)}\n`;
      assert.equal(readFileSync(target, "utf8"), written);
      assert.equal(readFileSync(join(directory, "hard.md"), "utf8"), written);
      assert.equal(statSync(target).mode & 0o777, 0o640);
      // A file that cannot be opened for writing, or that is not UTF-8 text: exit 2, the file as it was.
      const kept = `READY at ${shas[0].slice(0, 9)}.`;
      const before = `${kept}\n\n${own(1)}\n \n`;
      writeFileSync(report, before);
      chmodSync(report, 0o444);
      const readOnly = run();
      chmodSync(report, 0o644);
      assert.equal(readOnly.status, 2, readOnly.stderr);
      assert.match(readOnly.stderr, /cannot write .* \(EACCES\); it is as it was$/mu);
      assert.equal(readFileSync(report, "utf8"), before);
      const notText = Buffer.concat([
        Buffer.from("READY "),
        Buffer.from([0xff]),
        Buffer.from(" x\n"),
      ]);
      writeFileSync(report, notText);
      const refused = run();
      assert.equal(refused.status, 2, refused.stderr);
      assert.match(refused.stderr, /is not UTF-8 text; it is as it was$/mu);
      assert.ok(readFileSync(report).equals(notText));
      // UTF-8 text beyond ASCII (a byte order mark, two- and four-byte characters, CRLF line ends): written, its bytes
      // kept, and on a rerun its line replaced.
      const wide = `\uFEFFREADY é 😀 at ${shas[0].slice(0, 9)}.\r\nü\r\n`;
      writeFileSync(report, wide);
      for (const pass of ["first", "rerun"]) {
        const result = run();
        assert.equal(result.status, 0, `${pass}: ${result.stderr}`);
        assert.ok(
          readFileSync(report).equals(
            Buffer.from(`\uFEFFREADY é 😀 at ${shas[0].slice(0, 9)}.\r\nü\n\n${own(0)}\n`),
          ),
          pass,
        );
      }
      // Each step that writes, failing or writing short, by a preload that replaces node:fs's function: a failed cut
      // leaves the file as it was; a failed write or close leaves its text, maybe with all or part of the line, and says
      // to remove a partial one; a failed close does not hide a failed cut; a short write is continued.
      // (the descriptor `--append` opens, `r+`; the real close runs before the injected error)
      const closing =
        'const open = fs.openSync; let opened; fs.openSync = (...a) => { const d = open(...a); if (a[1] === "r+") opened = d; return d; }; const real = fs.closeSync;';
      const failing = (step) =>
        `fs.${step} = () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };`;
      for (const [label, patch, status, after, message] of [
        ["a failed cut", failing("ftruncateSync"), 2, before, /\(EIO\); it is as it was$/mu],
        [
          "a failed write",
          failing("writeSync"),
          2,
          kept,
          /last line \(EIO\); its text is as it was, and all or part of the line may stand after it: remove a partial line by hand$/mu,
        ],
        [
          "a partial write",
          'const real = fs.writeSync; let n = 0; fs.writeSync = (d, b, o, l, p) => { if (n++ > 0) throw Object.assign(new Error("injected"), { code: "EIO" }); return real(d, b, o, 5, p); };',
          2,
          `${kept}\n\nche`,
          /remove a partial line by hand$/mu,
        ],
        [
          "a failed close after a complete write",
          `${closing} fs.closeSync = (d) => { real(d); if (d === opened) throw Object.assign(new Error("injected"), { code: "EIO" }); };`,
          2,
          `${kept}\n\n${own(0)}\n`,
          /last line \(EIO\); its text is as it was, and all or part of the line may stand after it/mu,
        ],
        [
          "a failed cut, then a failed close: the cut is named",
          `${closing} ${failing("ftruncateSync").replace("EIO", "ENOSPC")} fs.closeSync = (d) => { real(d); if (d === opened) throw Object.assign(new Error("injected"), { code: "EIO" }); };`,
          2,
          before,
          /\(ENOSPC\); it is as it was$/mu,
        ],
        [
          "a short write",
          "const real = fs.writeSync; let n = 0; fs.writeSync = (d, b, o, l, p) => real(d, b, o, n++ === 0 ? 5 : l, p);",
          0,
          `${kept}\n\n${own(0)}\n`,
          /^check-shas: /mu,
        ],
        // Another writer between the read and the cut, growing or shortening the file: it is left as that writer left
        // it, neither cut nor padded.
        // (writing into the file, or renaming a new file onto its name, as an editor's save does)
        ...[
          ["grows", `${before}Another writer added this paragraph.\n`, "fs.writeFileSync(f, c)"],
          ["shortens", "Short", "fs.writeFileSync(f, c)"],
          [
            "changes, keeping its length,",
            before.replace("READY", "DRAFT"),
            "fs.writeFileSync(f, c)",
          ],
          [
            "replaces",
            before.replace("READY", "DRAFT"),
            'fs.writeFileSync(f + ".new", c); fs.renameSync(f + ".new", f)',
          ],
        ].map(([how, changed, write]) => [
          `another writer ${how} the file`,
          `const real = fs.readSync; let starts = 0; fs.readSync = (d, b, o, l, p) => { if (p === 0 && ++starts === 2) { const f = process.argv.at(-1); const c = ${JSON.stringify(changed)}; ${write}; } return real(d, b, o, l, p); };`,
          2,
          changed,
          /cannot write .*: it changed while it was checked, and is left so: run again$/mu,
        ]),
        // Two files whose inodes differ only beyond a JavaScript number's precision (as OverlayFS gives), the name's and
        // the descriptor's, stubbed: refused as another file.
        [
          "a replaced file whose identity differs beyond a number's precision",
          "const stat = fs.statSync; const fstat = fs.fstatSync; const high = 2n ** 63n; const as = (found, ino) => { if (found) found.ino = typeof found.ino === 'bigint' ? ino : Number(ino); return found; }; fs.statSync = (path, options) => path === process.argv.at(-1) ? as(stat(path, options), high + 1n) : stat(path, options); fs.fstatSync = (d, options) => as(fstat(d, options), high + 2n);",
          2,
          before,
          /cannot write .*: it changed while it was checked, and is left so: run again$/mu,
        ],
      ]) {
        writeFileSync(report, before);
        const preload = `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; ${patch} syncBuiltinESMExports();`;
        const result = spawnSync(
          process.execPath,
          [
            "--import",
            `data:text/javascript,${encodeURIComponent(preload)}`,
            tool,
            "--repo",
            directory,
            "--append",
            report,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        assert.equal(result.status, status, `${label}: ${result.stderr}`);
        assert.match(result.stdout + result.stderr, message, label);
        assert.equal(readFileSync(report, "utf8"), after, label);
      }
      // A folder, an unreadable file and a FIFO no one writes: refused before any read, in one line, exit 2; a folder
      // read without --append too.
      const fifo = join(directory, "no-writer.fifo");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      const unreadable = join(directory, "unreadable.md");
      writeFileSync(unreadable, before);
      chmodSync(unreadable, 0o000);
      for (const [label, args, message] of [
        ["a folder", ["--append", directory], /cannot write .* \(EISDIR\); it is as it was$/u],
        [
          "an unreadable file",
          ["--append", unreadable],
          /cannot write .* \(EACCES\); it is as it was$/u,
        ],
        ["a FIFO", ["--append", fifo], /cannot write .*: it is no regular file; it is as it was$/u],
        ["a folder without --append", [directory], /cannot read .* \(EISDIR\)$/u],
      ]) {
        const result = spawnSync(process.execPath, [tool, "--repo", directory, ...args], {
          encoding: "utf8",
          timeout: 10_000,
        });
        assert.equal(result.status, 2, `${label}: ${result.signal} ${result.stderr}`);
        assert.match(result.stderr, /^check-shas: [^\n]*\n$/u, label);
        assert.match(result.stderr.trim(), message, label);
      }
      chmodSync(unreadable, 0o600);
      assert.equal(readFileSync(unreadable, "utf8"), before);
      // Cost: a long run of white space is read once (an unanchored regex over it took quadratic time). The child is
      // killed at 20 s, as a test's timeout stops no loop.
      writeFileSync(report, `Report\n${" ".repeat(2 ** 20)}X\n${" ".repeat(2 ** 20)}\n`);
      const long = run();
      assert.equal(long.signal, null, "killed at 20 s");
      assert.equal(long.status, 0, long.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
