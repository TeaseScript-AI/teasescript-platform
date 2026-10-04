import assert from "node:assert/strict";
import test from "node:test";

import { compileProject, compileSource } from "../src/compiler.js";
import { run } from "../src/runtime/engine.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

const ownerExample = `---
title: "Strict punishment"
author: "Mistress X"
description: "Corner time with lines, for after a failed task."
tags: "chastity", punishment: 4
keywords: "chastity", "femdom", "long session"
---
say "Your punishment begins."
exit
`;

function codes(source: string): [string, string, number][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.span.start.line,
  ]);
}

function firstMessage(source: string): string {
  return compileSource(source).diagnostics[0]?.message ?? "";
}

function header(source: string) {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  return result.header;
}

test("a header holds the file's metadata and never executes", () => {
  const result = compileSource(ownerExample);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.header, {
    title: "Strict punishment",
    author: "Mistress X",
    description: "Corner time with lines, for after a failed task.",
    tags: [
      { name: "chastity", value: null },
      { name: "punishment", value: 4 },
    ],
    keywords: ["chastity", "femdom", "long session"],
    span: result.header!.span,
  });
  assert.deepEqual(
    [result.header!.span.start.line, result.header!.span.end.line, result.header!.span.end.column],
    [0, 6, 3],
  );

  // The script below keeps its own source lines and runs as if there were no header.
  const plan = result.plan!;
  const withoutHeader = compileSource('say "Your punishment begins."\nexit\n').plan!;
  assert.equal(plan.instructions.length, withoutHeader.instructions.length);
  assert.equal(plan.instructions[0]!.span.sl, 7);
  const finished = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.deepEqual(
    finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["Your punishment begins."],
  );

  assert.equal(compileSource('say "hi"\nexit').header, null);
});

test("every header field is optional, and only blank lines and comments may precede the header", () => {
  assert.deepEqual(header("---\n---\nexit"), {
    title: null,
    author: null,
    description: null,
    tags: [],
    keywords: [],
    span: header("---\n---\nexit")!.span,
  });
  const commented = header(
    '\n// A module\n/* about it */\n---\n// the name shown on the website\ntitle: "Hall"  // trailing\n\n---\nexit',
  );
  assert.equal(commented!.title, "Hall");
});

test("a block-string description keeps a --- line as text", () => {
  const described = header(
    '---\ndescription: """\n    Part one\n    ---\n    Part two\n    """\n---\nexit',
  );
  assert.equal(described!.description, "Part one\n---\nPart two");
});

test("tag names are normalized, and a tag may carry any finite number", () => {
  const tagged = header(
    '---\ntags: " Punishment ", "CORNER-time", Intensity: -1.5, level-2: +3,\n  big: 2e3, zero: 0\n---\nexit',
  );
  assert.deepEqual(tagged!.tags, [
    { name: "punishment", value: null },
    { name: "corner-time", value: null },
    { name: "intensity", value: -1.5 },
    { name: "level-2", value: 3 },
    { name: "big", value: 2000 },
    { name: "zero", value: 0 },
  ]);
});

test("a valued tag name may start with a digit, even where it looks like a number", () => {
  assert.deepEqual(header("---\ntags: 1easy: 4, 2e-test: 3, 3d: 1\n---\nexit")!.tags, [
    { name: "1easy", value: 4 },
    { name: "2e-test", value: 3 },
    { name: "3d", value: 1 },
  ]);
  // A malformed number as a value is still the lexer's error.
  assert.equal(compileSource("---\ntags: easy: 1e\n---\nexit").diagnostics[0]!.code, "TSL006");
});

test("a repeated tag is merged with a warning; two different numbers are an error", () => {
  const repeated = compileSource('---\ntags: "punishment", punishment: 4, "Punishment"\n---\nexit');
  assert.deepEqual(repeated.header!.tags, [{ name: "punishment", value: 4 }]);
  assert.deepEqual(
    repeated.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.severity]),
    [
      ["TSH011", "warning"],
      ["TSH011", "warning"],
    ],
  );
  assert.notEqual(repeated.plan, null);

  assert.deepEqual(codes("---\ntags: punishment: 4, punishment: 5, punishment: 6\n---\nexit"), [
    ["TSH012", "error", 1],
  ]);
});

test("keywords are trimmed text; an empty keyword is an error and a repeated one a warning", () => {
  assert.deepEqual(header('---\nkeywords: " long session ", "Femdom"\n---\nexit')!.keywords, [
    "long session",
    "Femdom",
  ]);
  // As elsewhere in the header, the first error ends the reading of its line.
  assert.deepEqual(codes('---\nkeywords: "a", "a", "  ", "b"\n---\nexit'), [
    ["TSH014", "warning", 1],
    ["TSH013", "error", 1],
  ]);
});

test("malformed header lines are reported one per line, and the script below still parses", () => {
  const source = [
    "---",
    'title: "One"',
    'title: "Two"',
    "intensity: 4",
    "author: Mistress",
    'description: "Room ${name}"',
    "tags",
    'title "x"',
    "---",
    'say "after"',
    "exit",
  ].join("\n");
  assert.deepEqual(codes(source), [
    ["TSH005", "error", 2],
    ["TSH004", "error", 3],
    ["TSH006", "error", 4],
    ["TSH007", "error", 5],
    ["TSH003", "error", 6],
    ["TSH003", "error", 7],
  ]);
  assert.deepEqual(codes('---\ntitle: "${a} and ${b}"\n---\nexit'), [["TSH007", "error", 1]]);

  // An unterminated interpolation still ends at its string, so the header closes and the script stays.
  const unterminated = compileSource('---\ntitle: "${name"\n---\nsay "after"\nexit');
  assert.deepEqual(
    unterminated.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSL005", "TSH007"],
  );
  assert.equal(unterminated.program.statements.length, 2);
});

test("each malformed tag explains the accepted spelling", () => {
  const cases: [string, string][] = [
    ["tags: chastity", 'Write a tag without a number in quotes: "chastity".'],
    ['tags: "punishment: 4"', "Write a tag with a number without quotes, such as punishment: 4."],
    [
      'tags: "corner-time": 3',
      "Write the name of a tag with a number without quotes, such as punishment: 4.",
    ],
    [
      'tags: "corner time"',
      "'corner time' is not a tag name: use lowercase letters a–z, digits, and hyphens.",
    ],
    [
      'tags: "spanking_hard"',
      "'spanking_hard' is not a tag name: use lowercase letters a–z, digits, and hyphens.",
    ],
    [
      'tags: "fessée"',
      "'fessée' is not a tag name: use lowercase letters a–z, digits, and hyphens.",
    ],
    [
      "tags: corner time: 3",
      "'corner time' is not a tag name: use lowercase letters a–z, digits, and hyphens.",
    ],
    ['tags: punishment: "4"', "A tag's value is a number, such as punishment: 4."],
    ["tags: punishment: 4 cm", "A tag's value is a plain number, such as punishment: 4."],
    ["tags: punishment: 1e999", "A tag's number must be finite."],
    ['tags: "a",', "Expected a value after the ':' or ','."],
    ["tags:", "Expected a value after the ':' or ','."],
    ['tags: "a" "b"', "Expected the end of the line after the header field 'tags'."],
  ];
  for (const [line, message] of cases) {
    assert.deepEqual(
      compileSource(`---\n${line}\n---\nexit`).diagnostics.map((diagnostic) => diagnostic.message),
      [message],
      line,
    );
  }
});

test("a header must be closed and must come first", () => {
  assert.deepEqual(codes('---\ntitle: "Hall"\n')[0], ["TSH001", "error", 0]);

  // A later --- block is reported once and left out, so the code around it still compiles.
  const misplaced = 'say "first"\n---\ntitle: "Hall"\n---\nsay "second"\nexit';
  assert.deepEqual(codes(misplaced), [["TSH002", "error", 1]]);
  assert.equal(
    firstMessage(misplaced),
    "A header between --- lines must come first in the file, before any code.",
  );
  assert.deepEqual(codes('---\n---\nsay "x"\n---\nexit'), [["TSH002", "error", 3]]);
  assert.deepEqual(codes('if true {\n---\ntitle: "Hall"\n---\n}\nexit'), [["TSH002", "error", 1]]);
});

test("a --- line inside a continued expression stays three minus signs", () => {
  for (const source of [
    "let x = (\n---\n1\n)\nsay x\nexit",
    "let x =\n---\n1\nsay x\nexit",
    'say """${\n---\n1\n}"""\nexit',
  ]) {
    const plan = compileSource(source).plan;
    assert.notEqual(plan, null, source);
    const finished = run(plan!, createImmediatePacingRuntimeSnapshot(plan!));
    assert.deepEqual(
      finished.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      ["-1"],
      source,
    );
  }
});

test("each project file has its own header", () => {
  const result = compileProject([
    { path: "main.tease", source: '---\ntitle: "Main"\n---\nexit' },
    { path: "rooms/hall.tease", source: '---\ntitle: "Hall"\ntags: "room"\n---\nexit' },
    { path: "rooms/plain.tease", source: "exit" },
  ]);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(
    result.files.map((file) => [file.path, file.header?.title ?? null, file.header?.tags ?? []]),
    [
      ["main.tease", "Main", []],
      ["rooms/hall.tease", "Hall", [{ name: "room", value: null }]],
      ["rooms/plain.tease", null, []],
    ],
  );
});
