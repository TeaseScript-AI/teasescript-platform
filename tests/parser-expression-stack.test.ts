import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { parse } from "../src/parser.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("general expression continuations parse valid and malformed nesting on a constrained stack", () => {
  const parserUrl = new URL("../src/parser.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { parse } from ${JSON.stringify(parserUrl)};
    const families = [
      ['siblings', '{a:0,b:', ',c:2}'],
      ['mixed', '[0,{value:', '},2]'],
      ['groups', '(1 + ', ')'],
      ['calls', 'f(0,', ',2)'],
      ['named calls', 'f(a:', ',b:2)'],
      ['interpolation', '"a\u0024{', '}b"'],
      ['index', 'items[', ']'],
      ['sets', 'set[0,', ']'],
      ['hint', 'askText ', ''],
      ['choice', 'choose first:', ''],
    ];
    // One depth far beyond the old guard proves stack safety; smaller depths add no failure mode.
    const depth = 4096;
    for (const [name, open, close] of families) {
      const source = 'let value = ' + open.repeat(depth) + '1' + close.repeat(depth) + '\\nexit';
      const parsed = parse(source);
      assert.deepEqual(parsed.diagnostics, [], name);
      assert.equal(parsed.program.statements.length, 2);
      const declaration = parsed.program.statements[0];
      assert.equal(declaration.kind, 'letStatement');
      assert.equal(declaration.initializer.span.start.offset, 12);
      assert.equal(declaration.initializer.span.end.offset, source.length - 5);
      assert.equal(parsed.program.statements[1].kind, 'exitStatement');
      // Inspect without native JSON/deepEqual recursion, which is not parser evidence.
      const pending = [declaration.initializer];
      let nodes = 0;
      while (pending.length) {
        const value = pending.pop();
        if (value === null || typeof value !== 'object') continue;
        assert.equal(Object.isFrozen(value), true);
        if ('kind' in value) nodes++;
        for (const child of Object.values(value)) {
          if (child !== null && typeof child === 'object') pending.push(child);
        }
      }
      assert.ok(nodes >= depth);
      // Missing inner operand/property values and closers exercise recovery at
      // every suspended level without any optimized-path retry/reparse.
      const malformed = 'let value = ' + open.repeat(depth) + (name === 'hint' ? 'as' : '') + '\\nexit';
      const rejected = parse(malformed);
      if (name === 'hint' || name === 'choice') {
        // The missing hint or option is the only diagnostic, and 'exit' survives.
        assert.deepEqual(rejected.diagnostics.map((d) => d.code), [name === 'hint' ? 'TSP029' : 'TSP030'], name);
        assert.deepEqual(rejected.program.statements.map((s) => s.kind), ['letStatement', 'exitStatement'], name);
        continue;
      }
      // Only the root diagnostic is fixed: the missing value before 'exit', or
      // the physical newline inside the innermost string. Secondary unwinding
      // may improve but must stay structured, source-associated and deterministic.
      const compact = (d) => [d.code, d.span.start.offset, d.span.end.offset];
      const root = name === 'interpolation'
        ? ['TSL008', malformed.indexOf('\\n'), malformed.indexOf('\\n') + 1]
        : ['TSP012', malformed.lastIndexOf('exit'), malformed.lastIndexOf('exit')];
      assert.deepEqual(compact(rejected.diagnostics[0]), root, name);
      for (const d of rejected.diagnostics) {
        assert.match(d.code, /^TS[LP][0-9]{3}$/u, name);
        assert.ok(0 <= d.span.start.offset && d.span.start.offset <= d.span.end.offset
          && d.span.end.offset <= malformed.length, name);
      }
      assert.deepEqual(parse(malformed).diagnostics.map(compact), rejected.diagnostics.map(compact));
      for (const s of rejected.program.statements) {
        assert.ok(['letStatement', 'exitStatement'].includes(s.kind), name);
      }
    }
    console.log('all expression families passed');
  `;
  const child = spawnSync(
    process.execPath,
    ["--stack-size=256", "--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
  );
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "all expression families passed");
});

test("nested expression parsing preserves runtime order, grouping, interpolation, and resume", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      "let order = []",
      "function mark(item) { order.add(item)\nreturn item }",
      "function add(a,b) { return a + b }",
      "let value = { before: mark(1), child: [mark(2), { nested: add(mark(3), add(mark(4), mark(5))) }], after: mark(6) }",
      'let text = "outer ${"inner ${add(mark(7), mark(8))}"}"',
      "say value.child[1].nested",
      "say (10 - (3 - 2)) * 2",
      "say text",
      "for item in order { say item }",
      "exit",
    ].join("\n"),
    { scenarioName: "general expression parser continuations", seed: 42 },
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["12", "18", "outer inner 15", "1", "2", "3", "4", "5", "6", "7", "8"],
  );
});

// Expected recovery results captured from main before the continuation repair.
// These rows cover distinct grammar continuations; the complete differential
// campaign also compared ASTs and every span against that baseline.
test("nested malformed expressions retain root diagnostics, spans, and statement recovery", () => {
  const fixtures = [
    {
      expression: "{a:1,b:{x:},c:2}",
      diagnostics: [["TSP012", 22, 22]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "[0,{value:[1,]},2]",
      diagnostics: [["TSP012", 25, 25]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1 + (2 * ))",
      // Only the missing-operand root is fixed; same-offset unwinding may change.
      root: ["TSP012", 22, 22],
      statements: ["exitStatement"],
    },
    {
      expression: "f(0,f(a:1,2),2)",
      diagnostics: [["TSP019", 22, 23]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: '"a${"b${1:2}"}c"',
      diagnostics: [
        ["TSP009", 21, 22],
        ["TSP009", 25, 26],
        ["TSP012", 28, 28],
      ],
      statements: ["exitStatement"],
    },
    {
      expression: "a[b[]].p",
      diagnostics: [
        ["TSP012", 16, 16],
        ["TSP002", 17, 17],
      ],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "askText askText as",
      diagnostics: [["TSP029", 30, 30]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "choose first:choose second:",
      diagnostics: [["TSP030", 40, 40]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1 < 2 < 3) and true",
      diagnostics: [["TSP020", 19, 20]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1..2..3)",
      diagnostics: [["TSP022", 17, 19]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "{a:1,b:{x 2},c:2}",
      diagnostics: [["TSP005", 22, 22]],
      statements: ["letStatement", "exitStatement"],
      outerProperties: ["a", "b", "c"],
    },
    {
      expression: "{a:1,b:{:2},c:2}",
      diagnostics: [["TSP004", 20, 20]],
      statements: ["letStatement", "exitStatement"],
      outerProperties: ["a", "b", "c"],
    },
  ];
  for (const fixture of fixtures) {
    const parsed = parse(`let value = ${fixture.expression}\nexit`);
    const diagnostics = parsed.diagnostics.map((d) => [
      d.code,
      d.span.start.offset,
      d.span.end.offset,
    ]);
    if ("root" in fixture) {
      assert.deepEqual(diagnostics[0], fixture.root, fixture.expression);
    } else {
      assert.deepEqual(diagnostics, fixture.diagnostics, fixture.expression);
    }
    assert.deepEqual(
      parsed.program.statements.map((s) => s.kind),
      fixture.statements,
      fixture.expression,
    );
    if ("outerProperties" in fixture) {
      // The inner object error must not discard the outer siblings around it.
      const [declaration] = parsed.program.statements;
      const outer = declaration?.kind === "letStatement" ? declaration.initializer : undefined;
      assert.deepEqual(
        outer?.kind === "objectLiteral"
          ? outer.properties.map((property) => property.name.name)
          : null,
        fixture.outerProperties,
        fixture.expression,
      );
    }
  }
});
