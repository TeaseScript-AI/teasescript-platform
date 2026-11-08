import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ADMITTED,
  NOT_PINS,
  PIN_SUITES,
  builtOf,
  groundRefusals,
  groundsOf,
  pinFormsOf,
  pinsOf,
  readingOf,
  refusalsOf,
  scanOf,
  suitesFor,
  testFiles,
} from "./pin-suites.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Each suite whose pins `--check-grounds` reads, with its file's text, scan and pins. */
const read = () =>
  PIN_SUITES.filter((suite) => !suite.listed).map((suite) => {
    const file = suite.in ?? suite.file;
    const text = readFileSync(join(ROOT, file), "utf8");
    const raw = text.split("\n");
    const scan = scanOf(text);
    return { suite, file, text, raw, scan, pins: pinsOf(scan, raw, suite.pin) };
  });

/**
 * `text` with line edits applied (each `[line, removed, ...added]`, 1-based on `text`, in order), and their `git diff -U0`.
 */
const edited = (text, ...edits) => {
  const lines = text.split("\n");
  const out = [];
  const hunks = [];
  let next = 1;
  for (const [line, removed, ...added] of edits) {
    out.push(...lines.slice(next - 1, line - 1));
    hunks.push(
      `@@ -${line},${removed} +${out.length + 1},${added.length} @@`,
      ...lines.slice(line - 1, line - 1 + removed).map((old) => `-${old}`),
      ...added.map((now) => `+${now}`),
    );
    out.push(...added);
    next = line + removed;
  }
  out.push(...lines.slice(next - 1));
  return { head: out.join("\n"), diff: hunks.join("\n") };
};

/** Each pin line of the read suites that takes a form, with its reading. */
const pinLines = () =>
  read().flatMap((entry) =>
    entry.pins.flatMap(({ from, to }) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index).flatMap((line) => {
        const reading = readingOf(entry.scan[line - 1], entry.raw[line - 1], entry.suite);
        return reading?.form === undefined ? [] : [{ ...entry, line, reading }];
      }),
    ),
  );

/** The suites and forms whose values `--check-grounds` must read, written here apart from the tool's declarations. */
const PLANNED = [
  "tests/helpers/type-core-families.ts row",
  "tests/type-core-candidate.test.ts asserted",
  "tests/type-core-closure.test.ts row",
  "tests/type-core-closure.test.ts tuple",
  "tests/type-core-contract-capture.test.ts asserted",
  "tests/type-core-f18.test.ts totals",
  "tests/type-core-work-a.test.ts row",
  "tests/type-core-work-c.test.ts counters",
  "tests/type-core-work-c.test.ts keyed",
  "tests/type-core-work-c.test.ts row",
];

/** The refusals the check gives for a line it cannot read: no declared form, or a lost opening line. */
const UNREADABLE =
  /in none of its declared forms|an opening line changed|though alone it reads as code/u;

const refusals = (entry, { head, diff }) =>
  refusalsOf(entry.file, entry.text, head, diff, entry.suite);

test("a core change lists every pinning suite; another change lists none, a suite's own change or its pins' file itself", () => {
  assert.deepEqual(suitesFor(["src/type-inference/core/admission/literals.ts"]), PIN_SUITES);
  assert.deepEqual(suitesFor(["src/runtime/engine.ts", "docs/TESTING.md"]), []);
  assert.deepEqual(suitesFor(["src/type-inference/core-like.ts"]), []);
  assert.deepEqual(
    suitesFor(["tests/type-core-kept.test.ts"]).map((suite) => suite.file),
    ["tests/type-core-kept.test.ts"],
  );
  assert.deepEqual(
    suitesFor(["tests/helpers/type-core-families.ts"]).map((suite) => suite.file),
    ["tests/type-core-work-b.test.ts"],
  );
  assert.equal(builtOf("tests/type-core-closure.test.ts"), "dist/tests/type-core-closure.test.js");
});

test("the list is kept true: each file a pin form finds is declared; each pin, ground and pin line is found, in a declared form, with a header", () => {
  const declared = new Set([...PIN_SUITES, ...NOT_PINS].map((entry) => entry.file));
  const unlisted = testFiles(ROOT).filter(
    (file) => !declared.has(file) && pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
  );
  assert.deepEqual(
    unlisted.map(
      (file) =>
        `${file} holds a pin form (${pinFormsOf(readFileSync(join(ROOT, file), "utf8")).join(", ")}) but is in neither PIN_SUITES nor NOT_PINS (tools/repository-checks/pin-suites.mjs)`,
    ),
    [],
  );
  for (const suite of PIN_SUITES) {
    const lines = readFileSync(join(ROOT, suite.in ?? suite.file), "utf8").split("\n");
    for (const found of [suite.pin, suite.ground].filter((regex) => regex !== undefined))
      assert.ok(
        lines.some((line) => found.test(line)),
        `${suite.in ?? suite.file} holds no line ${found} finds (${suite.file})`,
      );
  }
  for (const { suite, file, scan, raw, pins } of read())
    for (const { from, to } of pins) {
      for (let line = from; line <= to; line += 1) {
        const reading = readingOf(scan[line - 1], raw[line - 1], suite);
        assert.ok(
          reading === null || reading.form !== undefined,
          `${file}:${line} takes none of ${suite.file}'s forms: declare it`,
        );
      }
      assert.ok(
        groundsOf(scan, raw, from, suite.ground).header.length > 0,
        `${file}:${from}: a pin with no header: declare its \`ground\``,
      );
    }
  for (const { file } of NOT_PINS)
    assert.ok(
      pinFormsOf(readFileSync(join(ROOT, file), "utf8")).length > 0,
      `${file} holds no pin form: drop it from NOT_PINS`,
    );
});

test("the three pin forms are found by their text, and a pin written another way is not", () => {
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 22_962_573);"), ["total"]);
  assert.deepEqual(pinFormsOf("    [20044, 21252, 19818, 21009, 32920, 34389, 32070, 33448],"), [
    "table",
  ]);
  assert.deepEqual(pinFormsOf('  decide: [\n    6,\n    "a stopped decision\'s path"'), ["listed"]);
  // (the named limits: another assertion, a short total, a nested table)
  assert.deepEqual(pinFormsOf("  assert.strictEqual(budget.total, 22_962_573);"), []);
  assert.deepEqual(pinFormsOf("  assert.equal(budget.total, 573);"), []);
  assert.deepEqual(pinFormsOf("    [7995, 60],\n    [7081, 60],"), []);
});

test("every expected value of today's pins, moved by one, is refused without its ground and passes with one", () => {
  let values = 0;
  const cells = new Set();
  for (const entry of pinLines()) {
    if (entry.reading.values.length > 0) cells.add(`${entry.file} ${entry.reading.form}`);
    const text = entry.raw[entry.line - 1];
    const indent = text.slice(0, text.length - text.trimStart().length);
    for (const { text: value, from, to } of entry.reading.values) {
      values += 1;
      const moved = `${text.slice(0, from)}${Number(value.replaceAll("_", "")) + 1}${text.slice(to)}`;
      const [refusal, ...more] = refusals(entry, edited(entry.text, [entry.line, 1, moved]));
      assert.deepEqual(more, [], `${entry.file}:${entry.line}`);
      assert.match(
        refusal ?? "",
        new RegExp(`^${entry.file}:${entry.line}: re-pinned .* with no change to its ground`, "u"),
        `${entry.file}:${entry.line} ${value}`,
      );
      // (the ground written directly above, once a line)
      if (from !== entry.reading.values[0].from) continue;
      const grounded = edited(entry.text, [
        entry.line,
        1,
        `${indent}// (1 unit more since #1)`,
        moved,
      ]);
      assert.deepEqual(refusals(entry, grounded), [], `${entry.file}:${entry.line} ${value}`);
    }
  }
  assert.ok(values > 300, `${values} expected values`);
  assert.deepEqual([...cells].sort(), PLANNED);
});

test("a changed pin line in no declared form is refused with the fix, in every planned suite and form", () => {
  const cells = new Set();
  for (const entry of pinLines()) {
    const key = `${entry.file} ${entry.reading.form}`;
    if (cells.has(key) || entry.reading.values.length === 0) continue;
    cells.add(key);
    const text = entry.raw[entry.line - 1];
    const [{ text: value, from, to }] = entry.reading.values;
    const swapped = (now) => [`${text.slice(0, from)}${now}${text.slice(to)}`];
    const split = text.indexOf(", ", from);
    // (a counter snapshot's values are in its string: a call cannot hold them, but a joined string can)
    const variants =
      entry.reading.form === "counters"
        ? [[`${text.slice(0, from)}" + "${text.slice(from)}`]]
        : [
            swapped(`Number(${value})`),
            swapped(`Number("${value}")`),
            swapped(`Number(\`${value}\`)`),
            swapped("Math.PI"),
            ...(split > 0 ? [[text.slice(0, split + 1), `  ${text.slice(split + 2)}`]] : []),
          ];
    // (the line split before its closing brackets, its value as is and as a name)
    const closers = /[\])}]+[,;)]*$/u.exec(text.trimEnd());
    if (closers !== null && closers.index > from) {
      const indent = text.slice(0, text.length - text.trimStart().length);
      const head = text.slice(0, closers.index);
      variants.push([head, `${indent}${closers[0]}`]);
      variants.push([
        `${text.slice(0, from)}reviewExpected${head.slice(to)}`,
        `${indent}${closers[0]}`,
      ]);
    }
    // (a line's values written as one string, where the suite's strings are no input: closure's names and sources are,
    // and a string where its type holds numbers fails the type check)
    if (!entry.suite.forms.includes("string"))
      variants.push([`${text.slice(0, text.length - text.trimStart().length)}"${text.trim()}",`]);
    for (const lines of variants) {
      const found = refusals(entry, edited(entry.text, [entry.line, 1, ...lines]));
      assert.ok(
        found.some((refusal) =>
          /in none of its declared forms.*declare its form in tools\/repository-checks\/pin-suites\.mjs/su.test(
            refusal,
          ),
        ),
        `${entry.file}:${entry.line} ${lines.join(" / ")}: ${found.join(" | ")}`,
      );
      for (const refusal of found) assert.match(refusal, UNREADABLE);
    }
  }
  assert.deepEqual([...cells].sort(), PLANNED);
});

test("each form reads its expected values and only those", () => {
  const suite = { forms: Object.keys(ADMITTED), pin: /^const PIN\b/u, opener: /^const PIN = \[$/u };
  for (const [line, form, values] of [
    ["  assert.equal(budget.total, 22_962_573);", "asserted", ["22_962_573"]],
    ["  assert.deepEqual(units, [194, 17], JSON.stringify(mode));", "asserted", ["194", "17"]],
    ['  ["the C-R1 chain", chain(16), [11837, 12196]],', "tuple", ["11837", "12196"]],
    ['  ["an add", "let b = [[1]]", [684, 1020]],', "tuple", ["684", "1020"]],
    ["    [7995, 60],", "row", ["7995", "60"]],
    ["  { total: 246, decisions: [15], default: [4] },", "totals", ["246", "15", "4"]],
    ["      16: [", "sizeKey", []],
    ["        total: [8855, 23083],", "keyed", ["8855", "23083"]],
    ['        "checks 142 invSteps 105",', "counters", ["142", "105"]],
    ['    "the 8 places",', "string", []],
    ["  [", "open", []],
    ["  ],", "close", []],
    ["const PIN = [", "opener", []],
    ['  assert.equal(budget.total, Number("22962573"));', undefined, []],
    ['        "checks " + "143 invSteps 105",', undefined, []],
    ["  Math.PI,", undefined, []],
    ["const PIN = [1, 2];", undefined, []],
    ["const PIN = x;", undefined, []],
    ["`text with 1`,", "string", []],
  ]) {
    const reading = readingOf(scanOf(line)[0], line, suite);
    assert.deepEqual(
      [reading.form, reading.values.map((value) => value.text)],
      [form, values],
      line,
    );
  }
});

test("the scan sets strings, templates, comments and regular expressions apart", () => {
  const text = [
    'const a = "x // y"; // a note',
    "const t = `a ${f(`b ${1}`)} // c`;",
    "function r() { return /`/; }",
    "function p() { return /* a note */ /[/*]/; }",
    "const q = x! / 2;",
    "const n = !/'/.test(s);",
    "/* a block",
    "   still */ const z = 3;",
    '  "a string line",',
    "const m = `one",
    "// inside a template",
    "two`;",
  ].join("\n");
  const scan = scanOf(text);
  assert.deepEqual(
    scan.map((line) => [line.code.trim(), line.comment, line.top]),
    [
      ['const a = "";', false, true],
      ['const t = "";', false, true],
      ["function r() { return /r/; }", false, true],
      ["function p() { return  /r/; }", false, true],
      ["const q = x! / 2;", false, true],
      ["const n = !/r/.test(s);", false, true],
      ["", true, true],
      ["const z = 3;", true, false],
      ['"",', false, true],
      ['const m = ""', false, true],
      ["", false, false],
      [";", false, false],
    ],
  );
  assert.equal(scan.ended, true);
  assert.equal(scanOf("const a = `open").ended, false);
});

const closure = () =>
  read().find((entry) => entry.suite.file === "tests/type-core-closure.test.ts");
const lineOf = (entry, start) => entry.raw.findIndex((text) => text.startsWith(start)) + 1;

test("an input in a pin, a moved or reworded row, and a listed count need no ground; reworded values do", () => {
  const entry = closure();
  const chain = lineOf(entry, '  ["the C-R1 chain", chain(16),');
  const row = entry.raw[chain - 1];
  for (const now of [
    row.replace("chain(16)", "chain(32)"),
    row.replace('"the C-R1 chain"', '"a chain"'),
  ])
    assert.deepEqual(refusals(entry, edited(entry.text, [chain, 1, now])), []);
  const template = entry.raw.findIndex((text) => text.includes("`${chain(4)}")) + 1;
  const source = entry.raw[template - 1];
  assert.deepEqual(
    refusals(entry, edited(entry.text, [template, 1, source.replace("chain(4)", "chain(8)")])),
    [],
  );
  const add = lineOf(entry, '  ["an add",');
  const moved = edited(entry.text, [chain, 0, entry.raw[add - 1]], [add, 1]);
  assert.deepEqual(refusals(entry, moved), []);
  const reworded = entry.raw[add - 1]
    .replace('"an add"', '"an addition"')
    .replace("[684,", "[685,");
  assert.equal(refusals(entry, edited(entry.text, [add, 1, reworded])).length, 1);
  const split = row.replace("chain(16)", "chain(\n    16\n  )").split("\n");
  assert.match(
    refusals(entry, edited(entry.text, [chain, 1, ...split])).join("\n"),
    /in none of its declared forms/u,
  );
  const families = read().find((each) => each.suite.file === "tests/type-core-work-b.test.ts");
  const size = families.raw.findIndex((text) => /^\s*16: \[$/u.test(text)) + 1;
  const key = families.raw[size - 1].replace("16", "17");
  assert.deepEqual(refusals(families, edited(families.text, [size, 1, key])), []);
  // (a changed string beside a re-pin is no ground: only a comment is)
  const named = lineOf(entry, '    "a list join",');
  const renamed = entry.raw[named - 1].replace("a list join", "a list join (1 unit more since #1)");
  const value = entry.raw[named + 1].replace("32920", "32921");
  assert.equal(
    refusals(entry, edited(entry.text, [named, 1, renamed], [named + 2, 1, value])).length,
    1,
  );
  // (a listed-site count is named by its reason, so its file is not read)
  const kept = "tests/type-core-kept.test.ts";
  const listed = 'const LISTED = {\n  "a site": [\n    2,\n    "a reason",\n  ],\n};';
  const count = edited(listed, [3, 1, "    1,"]);
  assert.deepEqual(
    groundRefusals(
      [kept],
      () => count.head,
      () => listed,
      () => count.diff,
    ),
    [],
  );
});

test("a pin outside a test is grounded at its declared anchor, not in a template's text or by an earlier block", () => {
  const entry = closure();
  const find = (text, has) => text.split("\n").findIndex((line) => line.includes(has)) + 1;
  const repinned = (text) => {
    const at = find(text, '    "a list join",') + 2;
    return [at, 1, text.split("\n")[at - 1].replace("32920", "32921")];
  };
  const grounded = (text) => {
    const at = find(text, "every unit charged as on `main`");
    return [
      at,
      1,
      text.split("\n")[at - 1].replace("every unit", "(1 unit more since #1) every unit"),
    ];
  };
  assert.equal(refusals(entry, edited(entry.text, repinned(entry.text))).length, 1);
  assert.deepEqual(
    refusals(entry, edited(entry.text, grounded(entry.text), repinned(entry.text))),
    [],
  );
  // (a block before the ground, and `frozen` written over lines: a template holding a `//` line, or a joined list)
  let doc = find(entry.text, "every unit charged as on `main`");
  while (!entry.raw[doc - 1].startsWith("/**")) doc -= 1;
  const frozen = lineOf(entry, "const frozen");
  const fixture = [doc, 0, "/** a fixture count */", "const COUNT = 1;", ""];
  for (const written of [
    ["const frozen = `let a = {f: [[1]]}", "// (the source's own comment)", "let b = a`;"],
    ["const frozen = [", '  "let a = {f: [[1]]}",', '  "let b = a",', '].join("\\n");'],
  ]) {
    const base = { ...entry, text: edited(entry.text, fixture, [frozen, 1, ...written]).head };
    const lines = base.text.split("\n");
    assert.equal(refusals(base, edited(base.text, repinned(base.text))).length, 1);
    const earlier = [find(base.text, "/** a fixture count */"), 1, "/** (1 unit more since #1) */"];
    assert.equal(refusals(base, edited(base.text, earlier, repinned(base.text))).length, 1);
    const comment = find(base.text, "// (the source's own comment)");
    if (comment > 0) {
      const source = [comment, 1, "// (1 unit more since #1)"];
      assert.equal(refusals(base, edited(base.text, source, repinned(base.text))).length, 1);
    }
    assert.deepEqual(
      refusals(base, edited(base.text, grounded(base.text), repinned(base.text))),
      [],
      lines[frozen - 1],
    );
  }
});

test("an edit that breaks an opener, or a construct the scan could misread, cannot hide a re-pin", () => {
  const entry = closure();
  const opener = lineOf(entry, "const OUTSIDE");
  const add = lineOf(entry, '  ["an add",');
  const row = entry.raw[add - 1].replace("[684,", "[685,");
  const [, rest] = entry.raw[opener - 1].split("const ");
  const broken = edited(entry.text, [opener, 1, "const", rest], [add, 0, row]);
  assert.match(refusals(entry, broken).join("\n"), /an opening line changed/u);
  assert.ok(refusals(entry, broken).some((refusal) => /:\d+: re-pinned \(685,/u.test(refusal)));
  const capture = read().find(
    (each) => each.suite.file === "tests/type-core-contract-capture.test.ts",
  );
  const total = capture.raw.findIndex((text) => text.includes("assert.equal(budget.total,")) + 1;
  const moved = capture.raw[total - 1].replace("22_962_573", "22_962_574");
  const regex = edited(
    capture.text,
    [1, 0, "export function reviewPattern() { return /`/; }"],
    [total, 1, moved],
  );
  assert.equal(refusals(capture, regex).length, 1);
  // (a misread above the pin, its scan recovered below and its pin count kept by a pin added there)
  const source =
    capture.raw.findLastIndex((text, index) => index < total && text.includes("const source =")) +
    1;
  const end = capture.raw.findIndex((text, index) => index >= total && text === "});") + 1;
  for (const misread of [
    "  function reviewPattern() { return /* a note */ /[/*]/; }",
    "  if (true) /[/*]/;",
  ]) {
    const recovered = edited(
      capture.text,
      [source, 0, misread],
      [total, 1, moved],
      [
        end + 1,
        0,
        "/* scanner recovery */",
        "export function reviewReference(budget: { total: number }) {",
        "  assert.equal(budget.total, 22_962_573);",
        "}",
        "",
      ],
    );
    assert.ok(refusals(capture, recovered).length > 0, misread);
  }
  const open = edited(capture.text, [1, 0, "const unclosed = `"], [total, 1, moved]);
  assert.match(refusals(capture, open).join("\n"), /its scan ends inside/u);
});
