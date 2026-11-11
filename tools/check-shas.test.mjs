import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { closingClausesOf, excuse, scratchPathsOf } from "./check-shas.mjs";

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
  "ids, job ids, hex words, float digits and paths that resolve nowhere are skipped; each still resolves when it can",
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
        "Number.MAX_VALUE is 1.7976931348623157e+308",
      ].join("\n");
      const { status, out } = check(text, [directory]);
      assert.equal(status, 0, out);
      assert.match(
        out,
        /10 tokens: 0 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 10 skipped/u,
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
        ["7976931348623157e", "MAX_VALUE 1.7976931348623157e+308", "a float's digits"],
        ["02214076e23", "about 6.02214076e23", "a float's digits"],
        ["7976931348623157e", "1.7976931348623157e is cut", null],
        ["7976931348623157e", "v7976931348623157e+308", null],
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

test(
  "a float's digits are skipped only when no word character touches the number: printable ASCII, tab, newline and each Unicode category, on both sides",
  { timeout: 30_000 },
  () => {
    const { directory } = repository();
    try {
      // Every printable ASCII character, tab and newline, and one of each Unicode general category (a lone surrogate, category Cs, cannot be
      // written as UTF-8 text). Pc and Nd beyond ASCII, and an astral letter, are named too.
      const characters = [
        ...Array.from({ length: 95 }, (_, n) => String.fromCharCode(32 + n)),
        "\t",
        "\n",
        ..."AaǅʰĀ版\u0301\u0903\u20dd\u0663\u216b\u00b2\u203f\u2010“”‘’·±€ˆ©\u00a0\u2028\u2029\u0085\u200b\ue000\u0378",
        "\u{1d463}",
      ];
      const word = /^[\p{L}\p{M}\p{N}\p{Pc}]/u;
      // The claim, applied independently: the integer part is the ASCII digits (and a sign) before the `.`; the number
      // stands alone when the character before them is neither a word character nor a `.`, and the one after the
      // exponent's digits is no word character.
      const cases = [];
      for (const [n, character] of characters.entries()) {
        const exponent = 100 + n;
        const left = `${character}1.2100e${exponent}`;
        const before = left.slice(0, left.indexOf("1.2100e")).replace(/[+-]?\d*$/u, "");
        const leftChar = [...before].at(-1) ?? "";
        cases.push({
          text: left,
          token: `2100e${exponent}`,
          skipped: leftChar !== "." && !word.test(leftChar),
        });
        const mantissa = 2_100_000 + n;
        const right = `1.${mantissa}e+${exponent}${character}`;
        const after = right.slice(right.indexOf("+") + 1).replace(/^\d+/u, "");
        cases.push({
          text: right,
          token: `${mantissa}e`,
          skipped: !word.test([...after][0] ?? " "),
        });
      }
      // (each on its own line, so that no case's text reaches another's; every token differs, so each is reported)
      const { out } = check(cases.map((found) => `\n${found.text}\n`).join(""), [directory]);
      for (const found of cases)
        assert.equal(
          !new RegExp(`unresolved +${found.token} `, "u").test(out),
          found.skipped,
          JSON.stringify(found.text),
        );
      assert.ok(cases.length > 2 * 120, `${cases.length} cases`);
      // The issue's two numbers, in backticks and in curly quotes, and the forms earlier rounds named.
      for (const [text, skipped] of [
        ["`1.7976931348623157e+308`", true],
        ["“6.02214076e23”", true],
        ["tagged v1.210e785", false],
        ["tagged β1.210e785", false],
        ["tagged \u{1d463}1.210e785", false],
        ["version 1.2.210e785", false],
        ["1.1234567e+8oops", false],
      ]) {
        const { out } = check(text, [directory]);
        assert.equal(/^unresolved /mu.test(out), !skipped, text);
      }
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
          "0 tokens: 0 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 0 placeholders, 0 multi-issue closing clauses, 0 scratch paths",
        ],
        [
          `at ${shas[0].slice(0, 9)}, <sha>`,
          "1 tokens: 1 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); 1 placeholders, 0 multi-issue closing clauses, 0 scratch paths",
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
      `check-shas: 1 tokens: 1 resolved, 0 trees, 0 ambiguous, 0 unresolved, 0 local only, 0 skipped (ids, words, paths, sha256s); ${placeholders} placeholders, 0 multi-issue closing clauses, 0 scratch paths`;
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
  "a commit on origin only under refs/archive/* or in a refs/pull/<n>/head resolves at that ref",
  { timeout: 30_000 },
  () => {
    const { directory, origin, local } = withRemote();
    const git = (...args) =>
      spawnSync("git", ["-C", directory, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        encoding: "utf8",
      }).stdout.trim();
    try {
      // A pre-rebase head archived under its item, and a squash-merged pull request whose earlier head is cited too;
      // the default fetch mirrors neither.
      git("push", "-q", "origin", `${local}:refs/archive/item/${local}`);
      const tree = git("rev-parse", "main^{tree}");
      const earlier = git("commit-tree", tree, "-p", "origin/main", "-m", "pr 1");
      const prHead = git("commit-tree", tree, "-p", earlier, "-m", "pr 2");
      git("push", "-q", "origin", `${prHead}:refs/pull/7/head`);
      // (an annotated tag archived: listed as the tag and, peeled, as `refs/archive/tagged^{}`)
      const tagged = git("commit-tree", tree, "-p", "origin/main", "-m", "tagged");
      git("tag", "-a", "-m", "t", "tagged", tagged);
      git("push", "-q", "origin", "refs/tags/tagged:refs/archive/tagged");
      const stray = git("commit-tree", tree, "-p", "origin/main", "-m", "stray");
      git("fetch", "-q", "origin");
      const text = [local, prHead, earlier, tagged, stray]
        .map((sha) => sha.slice(0, 10))
        .join(", ");
      const { status, out } = check(text, [directory]);
      assert.equal(status, 1, out);
      for (const [sha, ref] of [
        [local, `refs/archive/item/${local}`],
        [prHead, "refs/pull/7/head"],
        [earlier, "refs/pull/7/head"],
        [tagged, "refs/archive/tagged"],
      ])
        assert.match(
          out,
          new RegExp(`resolved +${sha.slice(0, 10)} +${sha} in .*, on origin at ${ref}\n`, "u"),
        );
      assert.match(out, new RegExp(`local only +${stray.slice(0, 10)} `, "u"));
      assert.match(out.trim().split("\n").at(-1), /5 tokens: 4 resolved, .* 1 local only,/u);
      // An origin that cannot be listed is named, and leaves the commit local only.
      git("remote", "set-url", "origin", join(origin, "missing"));
      const unlisted = check(local, [directory]);
      assert.equal(unlisted.status, 1, unlisted.out);
      assert.match(
        unlisted.out,
        /cannot list origin's refs in .*: archived and pull-request heads not checked/u,
      );
      assert.match(unlisted.out, /1 tokens: 0 resolved, .* 1 local only,/u);
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
