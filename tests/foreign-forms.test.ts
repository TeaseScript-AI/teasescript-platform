import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

// A form of another language names the TeaseScript form where the script fails without it (`FOREIGN_FORMS`), and the
// parser reads on as with the TeaseScript form, so that nothing after it reports another error.

function diagnostics(source: string): [string, string, string][] {
  return compileSource(source).diagnostics.map((diagnostic) => [
    diagnostic.code,
    diagnostic.message,
    source.slice(diagnostic.span.start.offset, diagnostic.span.end.offset),
  ]);
}

const writes = (teaseScript: string, written: string, example: string) =>
  `TeaseScript writes '${teaseScript}' instead of '${written}': ${example}`;

const SEMICOLON = "TeaseScript ends a statement with a line break instead of ';'. Remove the ';'.";

test("each form of another language is one error that names the TeaseScript form", () => {
  const cases: [string, [string, string, string][]][] = [
    ...["def", "fn", "func", "fun"].map((word): [string, [string, string, string][]] => [
      `${word} countTo(n: integer) {\n  say "\${n}"\n}\ncountTo(3)\nexit`,
      [["TSP037", writes("function", word, "function countTo(n) { ... }"), word]],
    ]),
    ...["var", "local"].map((word): [string, [string, string, string][]] => [
      `${word} count = 1\nsay "\${count}"\nexit`,
      [["TSP037", writes("let", word, "let count = 1"), word]],
    ]),
    // On the line of the `}`, and on the next line before a condition, also one in parentheses.
    ...["elif", "elsif", "elseif"].map((word): [string, [string, string, string][]] => [
      `let a = 1\nif a == 1 { say "one" } ${word} a == 2 { say "two" }\nexit`,
      [["TSP037", writes("else if", word, "if a { ... } else if b { ... }"), word]],
    ]),
    ...["a == 2", "not done", "(done)"].map((condition): [string, [string, string, string][]] => [
      `let a = 1\nlet done = false\nif a == 1 {\n  say "one"\n}\nelif ${condition} {\n  say "two"\n}\nexit`,
      [["TSP037", writes("else if", "elif", "if a { ... } else if b { ... }"), "elif"]],
    ]),
    ['print "Hello"\nexit', [["TSP037", writes("say", "print", 'say "Hello"'), "print"]]],
    ['print("Hello")\nexit', [["TSP037", writes("say", "print", 'say "Hello"'), "print"]]],
    [
      'console.log("Hello")\nexit',
      [["TSP037", writes("say", "console.log", 'say "Hello"'), "console.log"]],
    ],
    ...["None", "nil", "undefined"].map((word): [string, [string, string, string][]] => [
      `let answer: string? = ${word}\nexit`,
      [["TSP037", writes("null", word, "let answer = null"), word]],
    ]),
    ['if True { say "x" }\nexit', [["TSP037", writes("true", "True", "let done = true"), "True"]]],
    [
      'if False { say "x" }\nexit',
      [["TSP037", writes("false", "False", "let done = false"), "False"]],
    ],
    [
      'let a = 1\nif a === 1 { say "x" }\nexit',
      [["TSP037", writes("==", "===", "if a == b { ... }"), "==="]],
    ],
    [
      'let a = 1\nif a !== 1 { say "x" }\nexit',
      [["TSP037", writes("!=", "!==", "if a != b { ... }"), "!=="]],
    ],
    ["let i = 0\ni++\nexit", [["TSP037", writes("+= 1", "++", "count += 1"), "++"]]],
    ["let i = 0\ni--\nexit", [["TSP037", writes("-= 1", "--", "count -= 1"), "--"]]],
    ['let a = 1;\nsay "${a}"\nexit', [["TSP037", SEMICOLON, ";"]]],
    [
      'if true & false { say "x" }\nexit',
      [["TSP037", writes("and", "&", "if a and b { ... }"), "&"]],
    ],
    // The block after the head still parses, also on the next line.
    [
      'for (let i = 0; i < 3; i++)\n{\n  say "x"\n}\nexit',
      [
        ["TSP037", SEMICOLON, ";"],
        ["TSP037", SEMICOLON, ";"],
        [
          "TSP037",
          writes("for ... in", "for (...)", "for i in 0..3 { ... }"),
          "for (let i = 0; i < 3; i++)",
        ],
      ],
    ],
  ];
  for (const [source, expected] of cases) assert.deepEqual(diagnostics(source), expected, source);
});

test("a script that uses such a word as a name compiles as before", () => {
  for (const source of [
    'let var = 1\nvar = 3\nsay "${var}"\nexit',
    'let elif = 1\nif elif == 1 { say "one" }\nelif = 3\nexit',
    'function elif(done: boolean) { say "x" }\nif true { say "one" }\nelif(true)\nexit',
    'let fun = 1\nfun += 1\nsay "${fun}"\nexit',
    'let None = 1\nlet nil = None + 1\nsay "${nil}"\nexit',
    'function print(text: string) { say text }\nprint("Hello")\nexit',
    'let i = 1\nlet j = i++i\nsay "${j}"\nexit',
  ])
    assert.deepEqual(diagnostics(source), [], source);
});
