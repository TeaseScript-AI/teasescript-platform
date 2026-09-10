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
    for (const [name, open, close] of families) {
      for (const depth of [256, 1024, 4096]) {
        const source = 'let value = ' + open.repeat(depth) + '1' + close.repeat(depth) + '\\nexit';
        const parsed = parse(source);
        assert.deepEqual(parsed.diagnostics, [], name + ':' + depth);
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
        const repeats = (code, count) => Array(count).fill(code);
        const codes = name === 'groups' ? repeats('TSP012', depth * 2 + 1)
          : name === 'interpolation' ? ['TSL008', ...Array.from({length: depth}, () => ['TSL005', 'TSL003']).flat(), ...repeats('TSP009', depth), 'TSP012']
          : name === 'hint' ? ['TSP029']
          : name === 'choice' ? ['TSP030']
          : ['TSP012', ...repeats('TSP017', name === 'mixed' ? depth * 2 : name === 'index' ? depth - 1 : depth), ...(name === 'sets' ? [] : ['TSP002'])];
        assert.deepEqual(rejected.diagnostics.map(d => d.code), codes, name + ':' + depth);
        const statements = name === 'groups' || name === 'interpolation' ? []
          : name === 'hint' || name === 'choice' ? ['letStatement', 'exitStatement'] : ['letStatement'];
        assert.deepEqual(rejected.program.statements.map(s => s.kind), statements, name);

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
      "say order.length",
      "say order[0]",
      "say order[7]",
      "exit",
    ].join("\n"),
    { scenarioName: "general expression parser continuations", seed: 42 },
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["12", "18", "outer inner 15", "8", "1", "8"],
  );
});

// Expected recovery results captured from main before the continuation repair.
// These rows cover distinct grammar continuations; the complete differential
// campaign also compared ASTs and every span against that baseline.
test("nested malformed expressions retain diagnostic order, messages, spans, and statement recovery", () => {
  const fixtures = [
    {
      expression: "{a:1,b:{x:},c:2}",
      diagnostics: [["TSP012", "Expected an expression.", 22, 22]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "[0,{value:[1,]},2]",
      diagnostics: [["TSP012", "Expected a collection element after ','.", 25, 25]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1 + (2 * ))",
      diagnostics: [
        ["TSP012", "Expected an expression after the arithmetic operator.", 22, 22],
        ["TSP012", "Expected an expression.", 22, 22],
        ["TSP012", "Expected an expression after the arithmetic operator.", 22, 22],
        ["TSP012", "Expected an expression.", 22, 22],
        ["TSP012", "Expected an expression.", 22, 22],
      ],
      statements: ["exitStatement"],
    },
    {
      expression: "f(0,f(a:1,2),2)",
      diagnostics: [
        ["TSP019", "Positional and named arguments may not be mixed in one call.", 22, 23],
      ],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: '"a${"b${1:2}"}c"',
      diagnostics: [
        [
          "TSP009",
          "Only identifiers and chained property access are supported in string interpolation.",
          21,
          22,
        ],
        ["TSP009", "Expected a supported expression inside the string interpolation.", 25, 26],
        ["TSP012", "Expected an expression.", 28, 28],
      ],
      statements: ["exitStatement"],
    },
    {
      expression: "a[b[]].p",
      diagnostics: [
        ["TSP012", "Expected an expression.", 16, 16],
        ["TSP002", "Expected a newline after the statement.", 17, 17],
      ],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "askText askText as",
      diagnostics: [["TSP029", "Expected a speaker identifier after 'as'.", 30, 30]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "choose first:choose second:",
      diagnostics: [["TSP030", "Expected a choice option expression after ':'.", 39, 39]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1 < 2 < 3) and true",
      diagnostics: [["TSP020", "Comparisons may not be chained.", 19, 20]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "(1..2..3)",
      diagnostics: [["TSP022", "Ranges may not be chained.", 17, 19]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "{a:1,b:{x 2},c:2}",
      diagnostics: [["TSP005", "Expected ':' after the object property name.", 22, 22]],
      statements: ["letStatement", "exitStatement"],
    },
    {
      expression: "{a:1,b:{:2},c:2}",
      diagnostics: [["TSP004", "Expected an object property name.", 20, 20]],
      statements: ["letStatement", "exitStatement"],
    },
  ];
  for (const fixture of fixtures) {
    const parsed = parse(`let value = ${fixture.expression}\nexit`);
    assert.deepEqual(
      parsed.diagnostics.map((d) => [d.code, d.message, d.span.start.offset, d.span.end.offset]),
      fixture.diagnostics,
      fixture.expression,
    );
    assert.deepEqual(
      parsed.program.statements.map((s) => s.kind),
      fixture.statements,
      fixture.expression,
    );
  }
});
