import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { FOREIGN_FORMS } from "../src/language-facts.js";

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
const COLON = `TeaseScript writes a block between '{' and '}' instead of after ':': if done { say "done" }`;

test("each form of another language is one error that names the TeaseScript form", () => {
  const cases: [string, [string, string, string][]][] = [
    ...["def", "fn", "func", "fun"].map((word): [string, [string, string, string][]] => [
      `${word} countTo(n: integer) {\n  say "\${n}"\n}\ncountTo(3)\nexit`,
      [["TSP037", writes("function", word, 'function countTo(n) { say "${n}" }'), word]],
    ]),
    ...["var", "local"].map((word): [string, [string, string, string][]] => [
      `${word} count = 1\nsay "\${count}"\nexit`,
      [["TSP037", writes("let", word, "let count = 1"), word]],
    ]),
    // On the line of the `}`, and on the next line before a condition, also one in parentheses.
    ...["elif", "elsif", "elseif"].map((word): [string, [string, string, string][]] => [
      `let a = 1\nif a == 1 { say "one" } ${word} a == 2 { say "two" }\nexit`,
      [["TSP037", writes("else if", word, 'if a { say "a" } else if b { say "b" }'), word]],
    ]),
    ...["a == 2", "not done", "(done)"].map((condition): [string, [string, string, string][]] => [
      `let a = 1\nlet done = false\nif a == 1 {\n  say "one"\n}\nelif ${condition} {\n  say "two"\n}\nexit`,
      [["TSP037", writes("else if", "elif", 'if a { say "a" } else if b { say "b" }'), "elif"]],
    ]),
    ['print "Hello"\nexit', [["TSP037", writes("say", "print", 'say "Hello"'), "print"]]],
    ['print("Hello")\nexit', [["TSP037", writes("say", "print", 'say "Hello"'), "print"]]],
    ...["console.log", "console.error", "console.warn"].map(
      (written): [string, [string, string, string][]] => [
        `${written}("Hello")\nexit`,
        [["TSP037", writes("say", written, 'say "Hello"'), written]],
      ],
    ),
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
      [["TSP037", writes("==", "===", 'if a == b { say "same" }'), "==="]],
    ],
    [
      'let a = 1\nif a !== 1 { say "x" }\nexit',
      [["TSP037", writes("!=", "!==", 'if a != b { say "different" }'), "!=="]],
    ],
    [
      'let a = 1\nif a ~= 1 { say "x" }\nexit',
      [["TSP037", writes("!=", "~=", 'if a != b { say "different" }'), "~="]],
    ],
    // First on its line, and before a space.
    [
      '# a comment\nlet a = 1 # one\nsay "${a}"\nexit',
      [
        ["TSP037", writes("//", "#", "// a comment"), "#"],
        ["TSP037", writes("//", "#", "// a comment"), "#"],
      ],
    ],
    [
      'let name = "Ann"\nsay `She said "Hi ${name}"`\nexit',
      [
        [
          "TSP037",
          "TeaseScript writes text between double quotes instead of backticks, and a backslash before each double " +
            'quote in the text: say "She said \\"Hi ${name}\\""',
          "`",
        ],
      ],
    ],
    [
      'let name = "Ann"\nsay f"Hi {name}"\nexit',
      [
        [
          "TSP037",
          "TeaseScript writes text without the 'f' before the quotes, and with '$' before each '{': " +
            'say "Hi ${name}"',
          "f",
        ],
      ],
    ],
    [
      'for i in range(5) { say "${i}" }\nexit',
      [
        [
          "TSP037",
          `TeaseScript writes a range with '..' instead of 'range(...)': for i in 0..5 { say "\${i}" }`,
          "range",
        ],
      ],
    ],
    // The lines indented deeper than the first line of the head are the block, also of an `else` and a function.
    [
      'let a = 1\n    if a == 2 {\n        say "two"\n} else if (a == 1 or\n    a == 3):\n    say "one"\nelse:\n    say "other"\nsay "after"\nexit',
      [
        ["TSP037", COLON, ":"],
        ["TSP037", COLON, ":"],
      ],
    ],
    ['function countTo(n: integer):\n    say "${n}"\ncountTo(3)\nexit', [["TSP037", COLON, ":"]]],
    [
      "let i = 0\ni++\ni = 2\nexit",
      [
        [
          "TSP037",
          "TeaseScript writes '+= 1' on a line of its own instead of '++': count += 1",
          "++",
        ],
      ],
    ],
    [
      "let i = 0\ni--\nexit",
      [
        [
          "TSP037",
          "TeaseScript writes '-= 1' on a line of its own instead of '--': count -= 1",
          "--",
        ],
      ],
    ],
    ['let a = 1;\nsay "${a}"\nexit', [["TSP037", SEMICOLON, ";"]]],
    [
      'if true & false { say "x" }\nexit',
      [
        [
          "TSP037",
          `TeaseScript writes 'and' with a space on each side instead of '&': if a and b { say "both" }`,
          "&",
        ],
      ],
    ],
    // The block after the head still parses, also on the next line.
    [
      'for (let i = 0; i < 3; i++)\n{\n  say "x"\n}\nexit',
      [
        ["TSP037", SEMICOLON, ";"],
        ["TSP037", SEMICOLON, ";"],
        [
          "TSP037",
          `TeaseScript writes a loop with 'in' instead of 'for (...)': for i in 0..3 { say "\${i}" }`,
          "for (let i = 0; i < 3; i++)",
        ],
      ],
    ],
  ];
  for (const [source, expected] of cases) assert.deepEqual(diagnostics(source), expected, source);
});

/**
 * How sources write each form of `FOREIGN_FORMS`, by its key: the names that they and the message's example use, and
 * the sources, with `@` where the form is written and `·` for a space that a symbol does not need, so that each source
 * is also written without those spaces, as `a&&b`.
 */
const USES: Readonly<
  Record<string, { readonly names: string; readonly sources: readonly string[] }>
> = (() => {
  const ab = "let a = true\nlet b = false\n";
  const numbers = "let a = 1\nlet b = 2\n";
  const between = (names: string) => ({
    names,
    sources: ['if a·@·b { say "x" }', 'let c = a·@·b\nsay "${c}"'],
  });
  const uses: Record<string, { names: string; sources: string[] }> = {
    "&&": between(ab),
    "&": between(ab),
    "||": between(ab),
    "!": { names: "let a = true\n", sources: ['if @·a { say "x" }', 'let c = @·a\nsay "${c}"'] },
    "??": {
      names: "let nickname: string? = null\n",
      sources: ['let name = nickname·@·"pet"\nsay name', 'say nickname·@·"pet"'],
    },
    "===": between(numbers),
    "!==": between(numbers),
    "~=": between(numbers),
    // In a statement of its own, and inside a value.
    "++": { names: "let count = 0\n", sources: ["count·@", "let value = count·@"] },
    "--": { names: "let count = 0\n", sources: ["count·@", "let value = count·@"] },
    ";": { names: "", sources: ['let a = 1·@\nsay "${a}"'] },
    // First on its line, and after a statement, where it needs the space.
    "#": { names: "", sources: ['@·a comment\nsay "x"', 'say "x" @ a comment'] },
    "`": { names: 'let name = "Ann"\n', sources: ['say `She said "Hi ${name}"`'] },
    // With another name than the message's.
    'f"Hi {name}"': {
      names: 'let name = "Ann"\nlet petName = "Bo"\n',
      sources: ['say f"Hi {petName}"', 'let greeting = f"Hi {name}"\nsay greeting'],
    },
    "for (...)": { names: "", sources: ['for (let j = 2; j < 7; j++) {\n  say "${j}"\n}'] },
    ":": {
      names: "let done = true\n",
      sources: [
        'if done·@\n    say "x"',
        'if done {\n  say "x"\n}\nelse·@\n    say "y"',
        'function countTo(n: integer)·@\n    say "${n}"\ncountTo(3)',
      ],
    },
    // With other bounds than the message's, and before a method call.
    range: {
      names: "",
      sources: [
        'for i in range(5) { say "${i}" }',
        'let items = range(2, 7).toList()\nsay "${items.length}"',
      ],
    },
    print: { names: "", sources: ['@("Hello")', '@ "Hello"'] },
    None: { names: "", sources: ["let answer: string? = @"] },
    True: { names: "", sources: ['if @ { say "x" }', 'let done = @\nsay "${done}"'] },
  };
  for (const word of ["def", "fn", "func", "fun"])
    uses[word] = { names: "", sources: ['@ countTo(n: integer) {\n  say "${n}"\n}\ncountTo(3)'] };
  for (const word of ["var", "local"])
    uses[word] = { names: "", sources: ['@ count = 1\nsay "${count}"'] };
  // On the line of the `}`, and on the next line.
  for (const word of ["elif", "elsif", "elseif"])
    uses[word] = {
      names: ab,
      sources: ['if a { say "x" } @ b { say "y" }', 'if a {\n  say "x"\n}\n@ b {\n  say "y"\n}'],
    };
  for (const written of ["console.log", "console.error", "console.warn"])
    uses[written] = { names: "", sources: ['@("Hello")'] };
  for (const word of ["nil", "undefined"]) uses[word] = uses.None!;
  uses.False = { names: "", sources: ['let done = @\nsay "${done}"'] };
  return uses;
})();

test("every form of another language is written in sources that report it", () => {
  assert.deepEqual(Object.keys(USES).sort(), [...FOREIGN_FORMS.keys()].sort());
});

test("the code that such an error shows compiles where it is pasted, in every spelling", () => {
  for (const [written, { message }] of FOREIGN_FORMS) {
    const { names, sources } = USES[written]!;
    // The code to paste in place of the form: as the message shows it, or with a space on each side.
    const shown = /^TeaseScript writes '([^']+)' (with a space on each side )?instead of '/u.exec(
      message,
    );
    const pasted = shown === null ? null : shown[2] === undefined ? shown[1]! : ` ${shown[1]} `;
    for (const spelling of new Set(
      sources.flatMap((source) => [source.replaceAll("·", " "), source.replaceAll("·", "")]),
    )) {
      const source = `${names}${spelling.replace("@", written)}\nexit`;
      assert.ok(
        compileSource(source).diagnostics.some((diagnostic) => diagnostic.message === message),
        `${source}\ndoes not report: ${message}`,
      );
      if (pasted !== null)
        assert.deepEqual(diagnostics(`${names}${spelling.replace("@", pasted)}\nexit`), [], source);
    }
    // The example, after the names it uses.
    const example = message.includes(": ") ? message.slice(message.lastIndexOf(": ") + 2) : null;
    if (example !== null) assert.deepEqual(diagnostics(`${names}${example}\nexit`), [], message);
  }
});

test("the example of a missing switch value or case value compiles", () => {
  for (const [source, code] of [
    ['let answer = "yes"\nswitch {\n  case "yes" { say "yes" }\n}\nexit', "TSP012"],
    ['let answer = "open"\nswitch answer {\n  case { say "x" }\n}\nexit', "TSP012"],
  ] as const) {
    const [error] = compileSource(source).diagnostics;
    assert.equal(error?.code, code, source);
    const example = /, as in '(.+)'\.$/u.exec(error!.message)![1]!;
    assert.deepEqual(
      diagnostics(`${source.slice(0, source.indexOf("\n") + 1)}${example}\nexit`),
      [],
      example,
    );
  }
});

test("a script that uses such a word as a name, or such a symbol in text, compiles as before", () => {
  for (const source of [
    'let var = 1\nvar = 3\nsay "${var}"\nexit',
    'let elif = 1\nif elif == 1 { say "one" }\nelif = 3\nexit',
    'function elif(done: boolean) { say "x" }\nif true { say "one" }\nelif(true)\nexit',
    'let fun = 1\nfun += 1\nsay "${fun}"\nexit',
    'let None = 1\nlet nil = None + 1\nsay "${nil}"\nexit',
    'function print(text: string) { say text }\nprint("Hello")\nexit',
    'let i = 1\nlet j = i++i\nsay "${j}"\nexit',
    'speaker f { name: "F" }\nsay as f"Hi"\nlet name = askText as f"Name?"\nsay "#1 `${name}` ~= x"\nexit',
  ])
    assert.deepEqual(diagnostics(source), [], source);
});
