import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { parse } from "../src/parser.js";
import { validateSemantics } from "../src/semantic.js";

test("reports unknown variables and withholds an executable plan", () => {
  const result = compileSource("let score = missing + 1");

  assert.deepEqual(result.parserDiagnostics, []);
  assert.deepEqual(
    result.semanticDiagnostics.map((item) => item.code),
    ["TSV002"],
  );
  assert.equal(result.plan, null);
});

test("rejects declarations that duplicate a visible name", () => {
  const result = compileSource(["let score = 1", "if true {", "  let score = 2", "}"].join("\n"));

  assert.deepEqual(
    result.semanticDiagnostics.map((item) => item.code),
    ["TSV001"],
  );
});

test("reports assignment to unknown variables and invalid binding replacement", () => {
  const result = compileSource(["missing = 1", "speaker vera {}", "vera = 2"].join("\n"));

  assert.deepEqual(
    result.semanticDiagnostics.map((item) => item.code),
    ["TSV003", "TSV004"],
  );
});

test("reports unknown speaker references", () => {
  const result = compileSource(["speaker missing", 'say as other "Hello"'].join("\n"));

  assert.deepEqual(
    result.semanticDiagnostics.map((item) => item.code),
    ["TSV005", "TSV005"],
  );
});

test("accepts nested lexical access and sibling-local reuse", () => {
  const result = compileSource(
    [
      "let score = 1",
      "if true {",
      "  let first = score + 1",
      "  score = first",
      "}",
      "if false {",
      "  let local = score",
      "} else {",
      "  let local = score + 1",
      "}",
      "exit",
    ].join("\n"),
  );

  // Only the warning that the branch of `if false` never runs.
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["TSV065"],
  );
  assert.notEqual(result.plan, null);
});

test("keeps parser and semantic diagnostics distinct", () => {
  const parserFailure = compileSource("let = 1");
  assert.ok(parserFailure.parserDiagnostics.length > 0);
  assert.deepEqual(parserFailure.semanticDiagnostics, []);

  const semanticFailure = compileSource("say unknownName");
  assert.deepEqual(semanticFailure.parserDiagnostics, []);
  assert.deepEqual(
    semanticFailure.semanticDiagnostics.map((item) => item.code),
    ["TSV002"],
  );
});

test("the name pass checks a timer's named parts in the order they are written", () => {
  assert.deepEqual(
    compileSource(
      "let t = timer(label: a, duration: b s, display: c, async: true)\nexit",
    ).diagnostics.map(({ code, message }) => [code, message]),
    ["a", "b", "c"].map((name) => ["TSV002", `Unknown variable '${name}'.`]),
  );
});

test("accepts explicitly declared injected built-ins and globals", () => {
  const result = compileSource("capture(player)\nexit", {
    builtins: ["capture"],
    globals: ["player"],
  });

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("rejects core and injected builtin identifiers in ordinary value positions", () => {
  const cases = [
    ["declaration initializer", "let value = BUILTIN"],
    ["list literal", "let values = [BUILTIN]"],
    ["object property value", "let value = { callback: BUILTIN }"],
    ["template interpolation", 'say "${BUILTIN}"'],
    ["function parameter default", "function sample(value = BUILTIN) { return value }"],
    ["return expression", "function sample { return BUILTIN }"],
    ["parenthesized expression", "let value = (BUILTIN)"],
    ["parenthesized call callee", "let value = (BUILTIN)()"],
    ["call argument", "function consume(value) { return value }\nlet result = consume(BUILTIN)"],
    ["binary expression", "let value = BUILTIN + 1"],
    ["property receiver", "let value = BUILTIN.length"],
    ["index receiver", "let value = BUILTIN[0]"],
  ] as const;

  for (const [label, template] of cases) {
    for (const builtin of ["random", "customBuiltin"] as const) {
      const source = template.replace("BUILTIN", builtin);
      const result = compileSource(source, {
        ...(builtin === "customBuiltin" ? { builtins: [builtin] } : {}),
      });
      const start = source.indexOf(builtin);

      assert.deepEqual(result.parserDiagnostics, [], `${label}: ${source}`);
      assert.equal(result.plan, null, `${label}: ${source}`);
      assert.deepEqual(
        result.semanticDiagnostics.map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.start.offset,
          diagnostic.span.end.offset,
        ]),
        [["TSV028", start, start + builtin.length]],
        `${label}: ${source}`,
      );
    }
  }
});

test("reports each invalid builtin value once in deterministic source order", () => {
  const source = "let values = [random, customBuiltin, random]";
  const result = compileSource(source, { builtins: ["customBuiltin"] });
  const names = ["random", "customBuiltin", "random"] as const;
  let offset = 0;
  const expected = names.map((name) => {
    const start = source.indexOf(name, offset);
    offset = start + name.length;
    return ["TSV028", start, start + name.length];
  });

  assert.deepEqual(result.parserDiagnostics, []);
  assert.equal(result.plan, null);
  assert.deepEqual(
    result.semanticDiagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    expected,
  );
});

test("preserves direct builtin calls in every supported nested context", () => {
  const result = compileSource(
    [
      "let values = [random(), randomInteger(1..=6), customBuiltin()]",
      "let objectValue = { core: random(), coin: chance(50), injected: customBuiltin() }",
      'say "${random()}:${customBuiltin()}"',
      "function sample(core = random(), injected = customBuiltin()) {",
      "  return core",
      "}",
      "let result = sample()",
      "values.remove(1)",
      "exit",
    ].join("\n"),
    { builtins: ["customBuiltin"] },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
});

test("preserves existing function, unknown-name, callable, and protected-name diagnostics", () => {
  const functionValueSource = ["function sample { return 1 }", "let stored = sample"].join("\n");
  const functionValue = compileSource(functionValueSource);
  const storedStart = functionValueSource.lastIndexOf("sample");
  assert.deepEqual(
    functionValue.semanticDiagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.span.start.offset,
      diagnostic.span.end.offset,
    ]),
    [["TSV028", storedStart, storedStart + "sample".length]],
  );

  const unknownFunction = compileSource("missing()");
  assert.deepEqual(
    unknownFunction.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV018"],
  );

  const nonCallable = compileSource("let value = 1\nvalue()");
  assert.deepEqual(
    nonCallable.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV019"],
  );

  const protectedCore = compileSource("let random = 1");
  assert.deepEqual(
    protectedCore.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001"],
  );

  const protectedInjected = compileSource("let customBuiltin = 1", { builtins: ["customBuiltin"] });
  assert.deepEqual(
    protectedInjected.semanticDiagnostics.map((diagnostic) => diagnostic.code),
    ["TSV001"],
  );
});

test("rejects a call of anything but a function or a method", () => {
  const notCallable =
    "Only a function or a method can be called. Call a function by its name instead.";
  for (const [source, callee, message] of [
    ["let value = 1\nsay (value)()", "value", "'value' is a variable, not a callable function."],
    ["let value = 1\nsay ((value))()", "value", "'value' is a variable, not a callable function."],
    ["speaker vera {}\n(vera)()", "vera", "'vera' is a speaker, not a callable function."],
    [
      'speaker vera {}\nsay as vera "${(speaker)()}"',
      "speaker",
      "'speaker' is the current speaker, not a callable function.",
    ],
    [
      "say (debugMode)()",
      "debugMode",
      "'debugMode' is a read-only value, not a callable function.",
    ],
    // Without parentheses around the name, too.
    [
      'speaker vera {}\nsay as vera "${speaker()}"',
      "speaker",
      "'speaker' is the current speaker, not a callable function.",
    ],
    ["say debugMode()", "debugMode", "'debugMode' is a read-only value, not a callable function."],
    ["let items = [1]\nsay items[0]()", "items[0]", notCallable],
    ["let items = [1]\nsay (items[0])()", "items[0]", notCallable],
    ["function pick(value) {\n    return value\n}\nsay pick(1)()", "pick(1)", notCallable],
    ['say ("Hi")()', '"Hi"', notCallable],
  ] as const) {
    const start = source.lastIndexOf(callee);
    assert.deepEqual(
      compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [["TSV019", message, start, start + callee.length]],
      source,
    );
  }

  // A function stays an invalid value, reported once.
  assert.deepEqual(
    compileSource("function sample { return 1 }\nsay (sample)()\nexit").diagnostics.map(
      (diagnostic) => diagnostic.code,
    ),
    ["TSV028"],
  );
});

test("reports a declaration named after the set keyword as a protected name", () => {
  for (const source of [
    "let set = 1",
    "for set in [1] {\n}",
    "function set {\n}",
    "function pick(set) {\n    return 1\n}",
    'speaker set {\n    name: "Set"\n}',
  ]) {
    const result = compileSource(source);
    const start = source.indexOf("set");
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => [
        diagnostic.code,
        diagnostic.message,
        diagnostic.span.start.offset,
        diagnostic.span.end.offset,
      ]),
      [
        [
          "TSV001",
          "Declaration 'set' conflicts with a protected TeaseScript name. Choose another name, such as 'setValue'.",
          start,
          start + 3,
        ],
      ],
      source,
    );
  }
});

test("a protected name where a declaration's name belongs gives its diagnostic with the fix in every form", () => {
  // `wait` and `if` are keyword tokens and `timer` a command the parser reads by name; the diagnostic is the same.
  for (const name of ["wait", "if", "timer", "round"]) {
    const forms = [
      `let ${name} = 1`,
      `global ${name} = 1`,
      `function ${name}(x) {\n  return x\n}`,
      `global function ${name}(x) {\n  return x\n}`,
      `function sample(${name}) {\n  return 1\n}`,
      `for ${name} in [1] {\n  say "x"\n}`,
      `for key, ${name} in dict{ a: 1 } {\n  say "x"\n}`,
      `speaker ${name} { name: "N" }`,
      `label ${name}`,
    ];
    for (const form of forms) {
      const source = `${form}\nexit`;
      const start = source.indexOf(name, form.startsWith("for key") ? 8 : 0);
      const label = form.startsWith("label");
      const expected = [
        [
          "TSV001",
          label
            ? `Label '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Label'.`
            : `Declaration '${name}' conflicts with a protected TeaseScript name. Choose another name, such as '${name}Value'.`,
          start,
          start + name.length,
        ],
      ];
      const result = compileSource(source);
      assert.deepEqual(result.diagnostics.map(located), expected, source);
      // It is a problem of the names, which leaves the syntax whole, and the name check alone reports it too.
      assert.deepEqual(result.parserDiagnostics, [], source);
      assert.deepEqual(
        validateSemantics(parse(source).program).diagnostics.map(located),
        expected,
        source,
      );
    }
  }
  // A declared speaker `player` has a text of its own, through both.
  const player = 'speaker player { name: "P" }\nexit';
  const playerText = [
    [
      "TSV001",
      "'player' is the built-in speaker for the person playing, so it needs no declaration. Assign its fields instead, as in 'player.color = ...'.",
      8,
      14,
    ],
  ];
  assert.deepEqual(compileSource(player).diagnostics.map(located), playerText);
  assert.deepEqual(validateSemantics(parse(player).program).diagnostics.map(located), playerText);
  // A later use that cannot be parsed does not hide it.
  assert.deepEqual(
    compileSource('let timer = 5\nsay "${timer}"\nexit').diagnostics.map(({ code, span }) => [
      code,
      span.start.line,
    ]),
    [
      ["TSP012", 1],
      ["TSV001", 0],
    ],
  );
  // The other problems of the names are still reported, and a missing loop variable is still one.
  assert.deepEqual(
    compileSource("let wait = 1\nsay missing\nexit").diagnostics.map(({ code }) => code),
    ["TSV001", "TSV002"],
  );
  assert.deepEqual(
    compileSource('for in [1] {\n  say "x"\n}\nexit').diagnostics.map(({ code }) => code)[0],
    "TSP013",
  );
});

function located({
  code,
  message,
  span,
}: {
  readonly code: string;
  readonly message: string;
  readonly span: {
    readonly start: { readonly offset: number };
    readonly end: { readonly offset: number };
  };
}): readonly [string, string, number, number] {
  return [code, message, span.start.offset, span.end.offset];
}
