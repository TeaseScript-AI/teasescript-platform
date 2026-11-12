// A store's check by the whole receiving type, and the mixed error that names it.

import assert from "node:assert/strict";
import test from "node:test";
import { compileProject } from "../../../src/compiler.js";
import { inMode, MODES } from "../../helpers/type-core-oracles.js";
import {
  reported,
  main,
  STOPS,
  OUTSIDE,
} from "../../helpers/type-core/type-core-messages-setup.js";

/**
 * #1753 (ADR 0021 rule 4.2): a store whose place is an element below the stored value, through collections alone, is
 * checked by the value's whole receiving type, which tests every element, where the root's written type proves every
 * layer of it with its `null` (a `let`, a `global`, a parameter, as the parser reads it: Codex r1's B1, `integer[]?[]`,
 * and r2's B2, a comment beside it); pasted where `codeAt`
 * proves it, else in words, and with no fallback, which would replace the whole value. Where no written type proves
 * the layers (a copy of one), the words name the elements the check tests. An element store keeps its element's test.
 * Each pasted check compiles under both checkers, where the element's scalar test it replaces is an error. Below a
 * literal's element, the mixed error names the earliest element's type with its `null`; the element itself keeps its
 * kinds' words. In four modes.
 */
test("a store below its value checks the whole receiving type, null kept, and the mixed error names it (#1753)", () => {
  const warned = (into: string, value: string, fix: string) =>
    `${into}, but '${value}' may be a value of another type here. ${STOPS} ${fix} ${OUTSIDE(value)}`;
  const nullable = "'a' holds whole numbers or null (integer?[])";
  const cases: readonly (readonly [source: string, site: string, message: string])[] = [
    [
      'let a:integer?[]=[1]\na=hostValue\nlet b=a\nlet c=b\nlet xs=[c,["x"]]\nexit\n',
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer?[] { a=hostValue }'.",
      ),
    ],
    [
      'let a:integer?[]=[1]\na=hostValue\nlet b=a\nlet c=b\nlet xs=[c,["x"]]\nexit\n',
      '"x"',
      "This list mixes a list (integer?[]) and a list (string[]). A list holds one type. Use values of one type in it.",
    ],
    [
      'let a:integer?[]=[1]\na=hostValue\nlet xs=[{f:a},{f:["x"]}]\nexit\n',
      '"x"',
      "This list mixes objects whose property 'f' holds a list (integer?[]) in one and a list (string[]) in another. " +
        "A list holds one type. Give 'f' one type in every element.",
    ],
    [
      'let xs=[[1,null],["x"]]\nexit\n',
      '"x"',
      "This list mixes a list (integer?[]) and a list (string[]). A list holds one type. Use values of one type in it.",
    ],
    [
      'let n:integer?=1\nlet xs=[n,"x"]\nexit\n',
      '"x"',
      "This list mixes a whole number (integer) and text (string). A list holds one type. To allow both, declare it " +
        "as 'let xs: (integer | string)[] =[n,\"x\"]'.",
    ],
    [
      "let d:integer? dict=dict {}\nd=hostValue\nexit\n",
      "hostValue",
      warned(
        "'d' holds whole numbers or null (integer? dict)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer? dict { d=hostValue }'.",
      ),
    ],
    [
      "let a:integer?[][]=[[1]]\na=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'a' is declared as a whole number (integer) or null",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer?[][] { a=hostValue }'.",
      ),
    ],
    [
      "let a:integer[]=[1]\nlet b=[1, hostValue]\na=b\nexit\n",
      "b",
      warned(
        "'a' holds whole numbers (integer[])",
        "b",
        "Check 'b' first, as in 'if b is integer[] { a=b }'.",
      ),
    ],
    [
      "let a:integer[]=[1]\nlet b=[hostValue otherwise null]\na=b\nexit\n",
      "b",
      "'a' holds whole numbers (integer[]), but 'b' may be null here. " +
        `${STOPS} Check 'b' first, as in 'if b is integer[] { a=b }'.`,
    ],
    // (every layer's `null`, from the written type: Codex r1's B1)
    ...[
      "An element of 'a' is declared as a list or null",
      "An element of an element of 'a' is declared as a whole number (integer)",
    ].map(
      (into) =>
        [
          "let a:integer[]?[]=[[1]]\na=hostValue\nexit\n",
          "hostValue",
          warned(
            into,
            "hostValue",
            "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { a=hostValue }'.",
          ),
        ] as const,
    ),
    [
      "let a:integer[]?=[1]\na=hostValue\nexit\n",
      "hostValue",
      warned(
        "'a' holds whole numbers (integer[])",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]? { a=hostValue }'.",
      ),
    ],
    [
      "global g: integer[]? dict = dict {}\ng=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'g' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]? dict { g=hostValue }'.",
      ),
    ],
    [
      'function f(p: integer[]?[]) {\n    p=hostValue\n    say "${p.length}"\n}\nf([[1]])\nexit\n',
      "hostValue",
      warned(
        "An element of an element of 'p' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { p=hostValue }'.",
      ),
    ],
    // (the annotation as the parser reads it, beside a comment and a default: Codex r2's B2)
    [
      'let a /* was: string[][] = [["old"]] */ : integer[]?[] = [[1]]\na=hostValue\nexit\n',
      "hostValue",
      warned(
        "An element of an element of 'a' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { a=hostValue }'.",
      ),
    ],
    [
      'function f(p: integer[]?[] = [[1]]) {\n    p=hostValue\n    say "${p.length}"\n}\nf()\nexit\n',
      "hostValue",
      warned(
        "An element of an element of 'p' is declared as a whole number (integer)",
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer[]?[] { p=hostValue }'.",
      ),
    ],
    // (a copy of a written type: no written type proves its layers, so the words name the elements)
    [
      "let x:integer[]?[]=[[1]]\nlet b=x\nb=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'b' holds a whole number (integer) since line 2",
        "hostValue",
        "Check that every element of every element of 'hostValue' is a whole number (integer) first.",
      ),
    ],
    [
      "let x:integer[]? dict=dict {}\nlet b=x\nb=hostValue\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'b' holds a whole number (integer) since line 2",
        "hostValue",
        "Check that every element of every value of 'hostValue' is a whole number (integer) first.",
      ),
    ],
    // (unproved, the layer between keeps its own check)
    [
      "let x:integer[]? dict=dict {}\nlet b=x\nb=hostValue\nexit\n",
      "hostValue",
      `An element of 'b' holds a list or null since line 2, but 'hostValue' may be a value of another type here. ${STOPS} ${OUTSIDE("hostValue")}`,
    ],
    [
      "let x:integer[]?[]=[[1]]\nlet a={f: x}\na.f=[hostValue]\nexit\n",
      "hostValue",
      warned(
        "An element of an element of 'a.f' holds a whole number (integer) since line 2",
        "hostValue",
        "Check that every element of 'hostValue' is a whole number (integer) first.",
      ),
    ],
    // (words where no form holds: a declaration's start value)
    [
      "let a:integer?[]=hostValue\nexit\n",
      "hostValue",
      warned(nullable, "hostValue", "Check that 'hostValue' is a list (integer?[]) first."),
    ],
    // (an element store, and a literal's element: the element's own test)
    [
      "let a:integer?[]=[1]\na[0]=hostValue\nexit\n",
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer { a[0]=hostValue }'.",
      ),
    ],
    [
      "let a:integer?[]=[1]\na=[1, hostValue]\nexit\n",
      "hostValue",
      warned(
        nullable,
        "hostValue",
        "Check 'hostValue' first, as in 'if hostValue is integer { a=[1, hostValue] }'.",
      ),
    ],
  ];
  for (const mode of MODES)
    for (const [source, site, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.site === site && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (each pasted check compiles under both checkers; the scalar test it replaces does not)
  const errors = (source: string) => [
    ...compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] })
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `current ${diagnostic.code}`),
    ...reported(main(source))
      .filter((each) => each.error)
      .map((each) => `core ${each.code}`),
  ];
  for (const followed of [
    "let a:integer?[]=[1]\nif hostValue is integer?[] { a=hostValue }\nexit\n",
    "let d:integer? dict=dict {}\nif hostValue is integer? dict { d=hostValue }\nexit\n",
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[][] { a=hostValue }\nexit\n",
    "let a:integer[]=[1]\nlet b=[1, hostValue]\nif b is integer[] { a=b }\nexit\n",
    "let a:integer[]?[]=[[1]]\nif hostValue is integer[]?[] { a=hostValue }\nexit\n",
    "let a:integer[]?=[1]\nif hostValue is integer[]? { a=hostValue }\nexit\n",
    "global g: integer[]? dict = dict {}\nif hostValue is integer[]? dict { g=hostValue }\nexit\n",
  ])
    assert.deepEqual(errors(followed), [], followed);
  assert.deepEqual(
    errors("let a:integer?[]=[1]\nif hostValue is integer { a=hostValue }\nexit\n"),
    ["current TSV041", "core TSV041"],
  );
});

/**
 * #1763: a store's check where the value's landing was unknown, an argument's (its parameter, by its place or its name,
 * also inside a literal or another value) and an index target's (one list or dict step per index), tests the value by
 * its whole receiving type, as #1753's does where the landing is known, and a storing method's argument (`add`, `addAll`)
 * by its receiver's (`addAll`'s never null), or no check where its receiver is off the place's path; a flat index store
 * keeps its element's test.
 * Each pasted check compiles under both checkers. In four modes.
 */
test("a store's check tests an argument or an index target by its whole receiving type (#1763)", () => {
  const warned = (into: string, fix: string) =>
    `${into}, but 'hostValue' may be a value of another type here. ${STOPS} ${fix} ${OUTSIDE("hostValue")}`;
  const check = (code: string) => `Check 'hostValue' first, as in '${code}'.`;
  const p = "'p' holds whole numbers or null (integer?[])";
  const deep = (name: string) =>
    `An element of an element of '${name}' is declared as a whole number (integer) or null`;
  const f = (parameters: string, call: string) =>
    `function f(${parameters}) {\n  say "\${p.length}"\n}\n${call}\nexit\n`;
  const g = (call: string) => `function g(p: integer?[]) {\n  return p.length\n}\n${call}\nexit\n`;
  const cases: readonly (readonly [source: string, message: string])[] = [
    [
      f("p: integer?[]", "f(hostValue)"),
      warned(p, check("if hostValue is integer?[] { f(hostValue) }")),
    ],
    [
      f("q: integer, p: integer?[]", "f(1, p: hostValue)"),
      warned(p, check("if hostValue is integer?[] { f(1, p: hostValue) }")),
    ],
    [
      f("q: integer, p: integer?[]", "f(p: hostValue, q: 1)"),
      warned(p, check("if hostValue is integer?[] { f(p: hostValue, q: 1) }")),
    ],
    [
      f("p: integer?[][]", "f([hostValue])"),
      warned(deep("p"), check("if hostValue is integer?[] { f([hostValue]) }")),
    ],
    // (past another call's argument before it, out to the argument that holds it)
    [
      `function h(n: integer) {\n  return [n]\n}\n${f("p: integer?[][]", "f([h(1), hostValue])")}`,
      warned(deep("p"), "Check that 'hostValue' is a list (integer?[]) first."),
    ],
    [g("let x=[g(hostValue)]"), warned(p, "Check that 'hostValue' is a list (integer?[]) first.")],
    [
      "let a:integer?[][]=[[1]]\na[0]=hostValue\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[] { a[0]=hostValue }")),
    ],
    [
      'let d:integer?[] dict=dict {}\nd["k"]=hostValue\nexit\n',
      warned(deep("d"), check('if hostValue is integer?[] { d["k"]=hostValue }')),
    ],
    // (an index target through parentheses, Codex r1 on #1817)
    [
      "let a:integer?[][]=[[1]]\n(a)[0]=hostValue\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[] { (a)[0]=hostValue }")),
    ],
    // (a storing method's argument: `add`'s a member of its receiver, `addAll`'s its receiver whole; a user function
    // named `add` is its own; a method whose parameter is no element keeps its parameter's test; Astra r1 on #1817)
    [
      "let a:integer?[][]=[[1]]\na.add(hostValue)\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[] { a.add(hostValue) }")),
    ],
    [
      "let a:integer?[][]=[[1]]\na.addAll(hostValue)\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[][] { a.addAll(hostValue) }")),
    ],
    [
      'function add(p: integer) {\n  say "${p}"\n}\nadd(hostValue)\nexit\n',
      warned(
        "'p' is declared as a whole number (integer)",
        check("if hostValue is integer { add(hostValue) }"),
      ),
    ],
    // (a method read through parentheses; a receiver off the place's path gives no check; `addAll` takes a list,
    // never null; Codex r3 on #1817)
    [
      "let a:integer?[][]=[[1]]\n(a.add)(hostValue)\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[] { (a.add)(hostValue) }")),
    ],
    [
      "let a:integer?[][][]=[[[1]]]\na.first.add(hostValue)\nexit\n",
      `An element of an element of an element of 'a' is declared as a whole number (integer) or null, but ` +
        `'hostValue' may be a value of another type here. ${STOPS} ${OUTSIDE("hostValue")}`,
    ],
    [
      "let a:integer?[][]?=[[1]]\nif a == null { exit }\na.addAll(hostValue)\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[][] { a.addAll(hostValue) }")),
    ],
    [
      "let a:integer?[][]=[[1]]\nsay a.take(hostValue)\nexit\n",
      warned(
        "take() needs a whole number (integer)",
        check("if hostValue is integer { say a.take(hostValue) }"),
      ),
    ],
    // (a flat index store: its element's test)
    [
      "let a:integer?[]=[1]\na[0]=hostValue\nexit\n",
      warned(
        "'a' holds whole numbers or null (integer?[])",
        check("if hostValue is integer { a[0]=hostValue }"),
      ),
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.site === "hostValue" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (a call names its own file's function, where another file declares one of the same name, Codex r1 on #1817)
  for (const mode of MODES) {
    const files = [
      {
        path: "main.tease",
        source:
          'function f(p:integer?[]) { return p.length }\nf(hostValue)\ncall "other.tease"\nexit\n',
      },
      {
        path: "other.tease",
        source: "function f(p:string?[]) { return p.length }\nf(hostValue)\nend\n",
      },
    ];
    const fixes = inMode(mode, () => reported(files))
      .map((each) => /as in '([^']*)'/u.exec(each.message)?.[1])
      .filter((each) => each !== undefined)
      .sort();
    assert.deepEqual(
      fixes,
      ["if hostValue is integer?[] { f(hostValue) }", "if hostValue is string?[] { f(hostValue) }"],
      JSON.stringify(mode),
    );
  }
  // (each pasted check compiles under both checkers)
  const errors = (source: string) => [
    ...compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] })
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `current ${diagnostic.code}`),
    ...reported(main(source))
      .filter((each) => each.error)
      .map((each) => `core ${each.code}`),
  ];
  for (const followed of [
    f("p: integer?[]", "if hostValue is integer?[] { f(hostValue) }"),
    f("p: integer?[][]", "if hostValue is integer?[] { f([hostValue]) }"),
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[] { a[0]=hostValue }\nexit\n",
    'let d:integer?[] dict=dict {}\nif hostValue is integer?[] { d["k"]=hostValue }\nexit\n',
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[] { a.add(hostValue) }\nexit\n",
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[][] { a.addAll(hostValue) }\nexit\n",
    "let a:integer?[][]=[[1]]\nif hostValue is integer?[] { (a.add)(hostValue) }\nexit\n",
    "let a:integer?[][]?=[[1]]\nif a == null { exit }\nif hostValue is integer?[][] { a.addAll(hostValue) }\nexit\n",
  ])
    assert.deepEqual(errors(followed), [], followed);
});

/**
 * #1827: a value in a dict literal's value, a set literal's element or a set literal's selected element lands as a list
 * literal's does, by the literal's step (a key is no value of it), so a store's check tests the whole receiving type
 * there, as #1763's does; the walk to it is charged as a list's or an object's is (#1730). Each pasted check compiles
 * under both checkers (the candidate route refuses a dict or set literal). In four modes.
 */
test("a store's check inside a dict or set literal tests its whole receiving type (#1827)", () => {
  const warned = (into: string, fix: string) =>
    `${into}, but 'hostValue' may be a value of another type here. ${STOPS} ${fix} ${OUTSIDE("hostValue")}`;
  const check = (code: string) => `Check 'hostValue' first, as in '${code}'.`;
  const deep = (name: string) =>
    `An element of an element of '${name}' is declared as a whole number (integer) or null`;
  const deeper = (name: string) =>
    `An element of an element of an element of '${name}' is declared as a whole number (integer) or null`;
  const cases: readonly (readonly [source: string, message: string])[] = [
    // (a dict literal's value, also by a written name, after another entry, through parentheses and either
    // operand of `otherwise`; a set literal's element; nested in a list, a dict or a set; an argument's; a `let`'s, in
    // words; a property below a dict's value, its own test)
    ...[
      'd=dict {"k":hostValue}',
      "d=dict {k:hostValue}",
      'd=dict {"a":[1], "k":hostValue}',
      'd=(dict {"k":hostValue})',
      'd=dict {"k":hostValue otherwise [1]}',
    ].map((store): readonly [string, string] => [
      `let d:integer?[] dict=dict {}\n${store}\nexit\n`,
      warned(deep("d"), check(`if hostValue is integer?[] { ${store} }`)),
    ]),
    [
      "let s:integer?[] set=set []\ns=set [hostValue]\nexit\n",
      warned(deep("s"), check("if hostValue is integer?[] { s=set [hostValue] }")),
    ],
    [
      'let a:integer?[] dict[]=[]\na=[dict {"k":hostValue}]\nexit\n',
      warned(deeper("a"), check('if hostValue is integer?[] { a=[dict {"k":hostValue}] }')),
    ],
    [
      'let d:integer?[] dict dict=dict {}\nd=dict {"a":dict {"k":hostValue}}\nexit\n',
      warned(
        deeper("d"),
        check('if hostValue is integer?[] { d=dict {"a":dict {"k":hostValue}} }'),
      ),
    ],
    [
      'let d:integer?[] set dict=dict {}\nd=dict {"a":set [hostValue]}\nexit\n',
      warned(deeper("d"), check('if hostValue is integer?[] { d=dict {"a":set [hostValue]} }')),
    ],
    [
      'function f(p: integer?[] dict) {\n  say "x"\n}\nf(dict {"k":hostValue})\nexit\n',
      warned(deep("p"), check('if hostValue is integer?[] { f(dict {"k":hostValue}) }')),
    ],
    [
      'let d:integer?[] dict=dict {"k":hostValue}\nexit\n',
      warned(deep("d"), "Check that 'hostValue' is a list (integer?[]) first."),
    ],
    [
      'let d=dict {"k":{x:1}}\nd=dict {"k":{x:hostValue}}\nexit\n',
      warned(
        "'x' of an element of 'd' holds a whole number (integer) since line 1",
        check('if hostValue is integer { d=dict {"k":{x:hostValue}} }'),
      ),
    ],
    // (a set literal's selected element is the place itself, as a list literal's)
    [
      "let x:integer?[]=[1]\nx=set [hostValue, [2]].random\nexit\n",
      warned(
        "'x' holds whole numbers or null (integer?[])",
        check("if hostValue is integer?[] { x=set [hostValue, [2]].random }"),
      ),
    ],
    // (unchanged: a flat dict's value, a key, an element of a set's element, a list's and an object's)
    [
      'let d:integer dict=dict {}\nd=dict {"k":hostValue}\nexit\n',
      warned(
        "'d' holds whole numbers (integer dict)",
        check('if hostValue is integer { d=dict {"k":hostValue} }'),
      ),
    ],
    [
      "let d:integer?[] dict=dict {}\nd=dict {[hostValue]:[1]}\nexit\n",
      warned(
        "A dict key is text (string)",
        check("if hostValue is string { d=dict {[hostValue]:[1]} }"),
      ),
    ],
    [
      "let s:integer?[] set=set []\ns=set [[hostValue]]\nexit\n",
      warned(deep("s"), check("if hostValue is integer { s=set [[hostValue]] }")),
    ],
    [
      "let a:integer?[][]=[[1]]\na=[hostValue]\nexit\n",
      warned(deep("a"), check("if hostValue is integer?[] { a=[hostValue] }")),
    ],
    [
      "let o={p:[1]}\no={p:[hostValue]}\nexit\n",
      warned(
        "'o.p' holds whole numbers (integer[]) since line 1",
        check("if hostValue is integer { o={p:[hostValue]} }"),
      ),
    ],
  ];
  for (const mode of MODES)
    for (const [source, message] of cases) {
      const found = inMode(mode, () => reported(main(source))).filter(
        (each) => each.site === "hostValue" && each.message === message,
      );
      assert.equal(found.length, 1, `${JSON.stringify(mode)} ${source}: ${message}`);
    }
  // (each pasted check compiles under both checkers)
  const errors = (source: string) => [
    ...compileProject([{ path: "main.tease", source }], { globals: ["hostValue"] })
      .diagnostics.filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => `current ${diagnostic.code}`),
    ...reported(main(source))
      .filter((each) => each.error)
      .map((each) => `core ${each.code}`),
  ];
  for (const followed of [
    ...[
      'd=dict {"k":hostValue}',
      "d=dict {k:hostValue}",
      'd=dict {"a":[1], "k":hostValue}',
      'd=(dict {"k":hostValue})',
      'd=dict {"k":hostValue otherwise [1]}',
    ].map(
      (store) => `let d:integer?[] dict=dict {}\nif hostValue is integer?[] { ${store} }\nexit\n`,
    ),
    "let s:integer?[] set=set []\nif hostValue is integer?[] { s=set [hostValue] }\nexit\n",
    'let a:integer?[] dict[]=[]\nif hostValue is integer?[] { a=[dict {"k":hostValue}] }\nexit\n',
    'let d:integer?[] dict dict=dict {}\nif hostValue is integer?[] { d=dict {"a":dict {"k":hostValue}} }\nexit\n',
    'let d:integer?[] set dict=dict {}\nif hostValue is integer?[] { d=dict {"a":set [hostValue]} }\nexit\n',
    'function f(p: integer?[] dict) {\n  say "x"\n}\nif hostValue is integer?[] { f(dict {"k":hostValue}) }\nexit\n',
    'let d=dict {"k":{x:1}}\nif hostValue is integer { d=dict {"k":{x:hostValue}} }\nexit\n',
    "let x:integer?[]=[1]\nif hostValue is integer?[] { x=set [hostValue, [2]].random }\nexit\n",
  ])
    assert.deepEqual(errors(followed), [], followed);
});
