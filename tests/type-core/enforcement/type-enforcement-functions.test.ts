// Functions: parameters and results by their types, script variables in bodies, calls that change no other place's
// type, and an object that does not fit, which adds no properties.

import assert from "node:assert/strict";
import test from "node:test";
import { runValidSource } from "../../helpers/run-valid-source.js";
import { mismatches, codes, sayTexts } from "../../helpers/type-core/type-enforcement-setup.js";

test("a function called before a script variable is declared is checked once the variable has its type", () => {
  // The first call skips the store; the body is checked against the variable when every script variable is typed.
  const early = (body: string, declaration: string, use: string) =>
    codes(
      `function change(active = false) {\n    if active {\n        ${body}\n    }\n}\nchange()\n${declaration}\nchange(true)\n${use}\nexit`,
    );
  assert.deepEqual(early('score = "wrong"', "let score = 1", "say score + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  assert.deepEqual(early('items.add("wrong")', "let items = [1]", "say items[0] + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  assert.deepEqual(early('item.value = "wrong"', "let item = { value: 1 }", "say item.value + 1"), [
    ["TSV041", '"wrong"'],
  ]);
  // A non-whole number widens the variable, so an integer-only use is reported.
  assert.deepEqual(
    early("index = index / 2", "let index = 1\nlet items = [10, 20]", "say items[index]"),
    [["TSV043", "index"]],
  );
  // A valid store runs.
  assert.deepEqual(
    sayTexts(
      "function change(active = false) {\n    if active {\n        score = 2\n    }\n}\nchange()\nlet score = 1\nchange(true)\nsay score + 1\nexit",
    ),
    ["3"],
  );
});

test("function bodies check assignments to script variables", () => {
  assert.deepEqual(
    mismatches('let count = 0\nfunction reset {\n    count = "none"\n}\nexit')[0]?.[0],
    "TSV041",
  );
});

test("a function's result type comes from its return values, and returns of different types are an error", () => {
  assert.deepEqual(codes('function name {\n    return "Ada"\n}\nlet n = name()\nn = 5\nexit'), [
    ["TSV041", "5"],
  ]);
  assert.deepEqual(
    mismatches(
      'function pick(n) {\n    if n > 3 {\n        return "big"\n    }\n    return 1\n}\nexit',
    ),
    [
      [
        "TSV044",
        "'pick' returns a whole number (integer) here, but text (string) on line 3. To return both, declare the result type, as in 'function pick(...): string | integer'.",
        "1",
      ],
    ],
  );
  // Integers and numbers together are numbers; a function that can end without a value has an optional result.
  assert.deepEqual(
    codes(
      "function ratio(n) {\n    if n > 3 {\n        return 1\n    }\n    return 0.5\n}\nlet r = ratio(1)\nr = 2.5\nexit",
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function maybe(flag) {\n    if flag {\n        return 1\n    }\n}\nlet m = maybe(true)\nm = null\nm = "x"\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A function used before its declaration, a recursive function, and a function returning an object.
  assert.deepEqual(
    codes('let total = later()\nfunction later {\n    return 5\n}\ntotal = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  assert.deepEqual(
    codes(
      "function fact(n: integer): integer {\n    if n <= 1 {\n        return 1\n    }\n    return n * fact(n - 1)\n}\nlet x: integer = fact(5)\nx = 2.5\nexit",
    ),
    [["TSV041", "2.5"]],
  );
  assert.deepEqual(
    codes('function make {\n    return { hp: 10 }\n}\nlet m = make()\nm.hp = "x"\nexit'),
    [["TSV041", '"x"']],
  );
  // An unknown return value decides nothing; values the compiler cannot know are never rejected.
  assert.deepEqual(
    codes('function pass(value) {\n    return value\n}\nlet p = pass(1)\np = "x"\nexit'),
    [],
  );
});

test("a return of a variable that held only null decides no result type, also when several such variables reach it", () => {
  // V30 §12: a variable that starts as null and never takes another value holds only null, so beside a list the
  // result is that list, and may be null (#831).
  const info = (rest: string, other = "return [1]") =>
    `let kindA = null\nlet kindB = null\nfunction info(type) {\n    let typeout = null\n    if type == 0 {\n        typeout = kindA\n    } else {\n        typeout = kindB\n    }\n    if type == 0 {\n        return typeout\n    }\n    ${other}\n}\n${rest}\nexit`;
  assert.deepEqual(sayTexts(info('say "${info(0)}"\nsay "${info(1)}"')), ["null", "1"]);
  // The result is `integer[]?`: like any `T?`, a caller checks it for null before using it as a list.
  assert.deepEqual(codes(info('let r = info(1)\nsay "${r.length}"')), [["TSV043", "r"]]);
  assert.deepEqual(
    codes(
      info(
        'let r = info(1)\nif r != null {\n    say "${r.length}"\n}\nlet n: integer[]? = info(0)\nlet s: string[]? = info(1)',
      ),
    ),
    [["TSV041", "info(1)"]],
  );
  // A value the compiler cannot know that reached one of them is still checked where the result is stored.
  const unknownA = (value: string) =>
    info(
      `function assign(value) {\n    kindA = value\n}\nassign(${value})\nlet r: integer[]? = info(0)\nsay "\${r}"`,
    );
  assert.equal(runValidSource(unknownA('"s"')).snapshot.failure?.code, "TSR058");
  assert.deepEqual(sayTexts(unknownA("[2]")), ["2"]);
  // A value of another type is compared with the return that decided the type, not with one that held only null.
  const mixed = 'if type == 1 {\n        return [1]\n    }\n    return "x"';
  assert.deepEqual(mismatches(info("", mixed)), [
    [
      "TSV044",
      "'info' returns text (string) here, but a list (integer[]) on line 14. To return both, declare the result type, as in 'function info(...): integer[] | string | null'.",
      '"x"',
    ],
  ]);
  // The returns the compiler knows still agree beside one that a value it cannot know reached (V30 §17), also inside
  // a list or an object, and with one such variable or several.
  const assign = 'function assign(value) {\n    kindA = value\n}\nassign("s")';
  const wrapped = (wrap: string) => {
    const value = (inner: string) => wrap.replace("%", inner);
    return info(
      assign,
      `if type == 1 {\n        return ${value("1")}\n    }\n    return ${value('"x"')}`,
    ).replace("return typeout", `return ${value("typeout")}`);
  };
  assert.deepEqual(codes(wrapped("%")), [["TSV044", '"x"']]);
  assert.deepEqual(codes(wrapped("{ t: % }")), [["TSV044", '{ t: "x" }']]);
  assert.deepEqual(mismatches(wrapped("[%]")), [
    [
      "TSV044",
      "'info' returns a list (string[]) here, but a list (integer[]) on line 14. To return both, declare the result type, as in 'function info(...): integer?[] | string[]'.",
      '["x"]',
    ],
  ]);
  assert.deepEqual(codes(info(assign, mixed).replace("typeout = kindB", "typeout = kindA")), [
    ["TSV044", '"x"'],
  ]);
  // Every return must also fit the result, which keeps what the compiler cannot know: a union return that the known
  // values allow is still an error beside a list of unknown elements, so the result never leaves out its text.
  assert.deepEqual(
    codes(
      "function f(n: integer, p, q: integer[] | string) {\n    if n == 0 {\n        return [p]\n    }\n    if n == 1 {\n        return [1]\n    }\n    return q\n}\nexit",
    ),
    [["TSV044", "q"]],
  );
});

test("annotated parameters and results are checked, and a default types a parameter like let", () => {
  assert.deepEqual(
    mismatches('function shout(times = 1) {\n    say "${times}"\n}\nshout(0.5)\nexit'),
    [
      [
        "TSV041",
        "'shout' takes 'times' as a whole number (integer), so it cannot take a number. Round it with floor(...), round(...), or ceil(...), or declare the parameter as 'times: number = 1'.",
        "0.5",
      ],
    ],
  );
  assert.deepEqual(
    codes(
      'function greet(name: string, polite = true) {\n    say name\n}\ngreet("Ada", polite: "yes")\ngreet(5)\nexit',
    ),
    [
      ["TSV041", '"yes"'],
      ["TSV041", "5"],
    ],
  );
  assert.deepEqual(codes('function f(count: integer = "x") {\n    say "${count}"\n}\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(mismatches("function half(n: integer): integer {\n    return n / 2\n}\nexit"), [
    [
      "TSV041",
      "'half' returns integer, so it cannot return a number. Round it with floor(...), round(...), or ceil(...).",
      "n / 2",
    ],
  ]);
  assert.deepEqual(
    mismatches("function f: integer {\n    if chance(50) {\n        return 1\n    }\n}\nexit"),
    [
      [
        "TSV041",
        "'f' returns integer, but it can end without returning a value. Add a 'return' at the end. To allow null, declare the result as 'integer?'.",
        "f",
      ],
    ],
  );
  assert.deepEqual(codes("function g: integer {\n    return\n}\nexit"), [["TSV041", "return"]]);
  // A loop that only a return leaves ends every path; a parameter without a type or decided default is unknown.
  assert.deepEqual(
    codes("function f: integer {\n    while true {\n        return 1\n    }\n}\nexit"),
    [],
  );
  assert.deepEqual(
    codes('function greet(name = null) {\n    say "Hi"\n}\ngreet("Ada")\ngreet(5)\nexit'),
    [],
  );
});

test("calls never decide parameter types, and an unknown return makes a result unknown", () => {
  assert.deepEqual(
    codes(
      'function get(record = {}) {\n    return record.item\n}\nlet a = get({ item: 1 })\nget({ item: "x" })\nlet b: string = get({ item: 1 })\nexit',
    ),
    [],
  );
  assert.deepEqual(
    codes(
      'function f(value) {\n    if chance(50) {\n        return 1\n    }\n    return value\n}\nlet a: string = f("x")\nexit',
    ),
    [],
  );
  // A recursive call keeps the declared result type.
  assert.deepEqual(
    codes(
      'function f(n: integer): string {\n    if n == 0 {\n        return "x"\n    }\n    return f(n - 1) + 1\n}\nlet a = f(1)\nexit',
    ),
    [["TSV043", "f(n - 1) + 1"]],
  );
});

test("a loop that certainly runs, or ends only through a return, ends the function", () => {
  for (const [body, expected] of [
    ["repeat 1 {\n        return 1\n    }", []],
    ["for n in [1] {\n        return n\n    }", []],
    ["for n in 1..=3 {\n        return n\n    }", []],
    // The `break` after the `return` never runs.
    ["while true {\n        return 1\n        break\n    }", [["TSV065", "break"]]],
  ] as const)
    assert.deepEqual(
      codes(`function f: integer {\n    ${body}\n}\nlet a = f()\nexit`),
      expected,
      body,
    );
  assert.deepEqual(
    codes("function f(n): integer {\n    repeat n {\n        return 1\n    }\n}\nexit"),
    [["TSV041", "f"]],
  );
});

test("an object that does not fit adds no properties, and annotated functions run", () => {
  assert.deepEqual(codes('let x = { a: 1 }\nx = { b: true, a: "x" }\nx.b = 1\nexit'), [
    ["TSV041", '"x"'],
  ]);
  assert.deepEqual(
    sayTexts(
      'function scale(value: number, by: integer = 2): number {\n    return value * by\n}\nsay "${scale(1.5)} ${scale(1, by: 3)}"\nexit',
    ),
    ["3 3"],
  );
});

test("a function result, a body, or a copy never changes the types another place keeps", () => {
  // Joining a function's returns copies a stored object's properties instead of changing them.
  assert.deepEqual(
    codes(
      "let objs = [{ a: 1 }, { b: 1 }]\nfunction f(flag) {\n    if flag {\n        return objs[0]\n    }\n    return { c: true }\n}\nlet result = f(true)\nobjs[0].c = 1\nexit",
    ),
    [],
  );
  // Every call is checked against the parameters as the whole body uses them, so identical calls agree.
  assert.deepEqual(
    codes("function f(obj = {}) {\n    obj.flag = true\n}\nf({ flag: 1 })\nf({ flag: 1 })\nexit"),
    [
      ["TSV041", "1"],
      ["TSV041", "1"],
    ],
  );
  assert.deepEqual(
    codes(
      'function f(opts = { a: 1 }, flag = false) {\n    if flag {\n        opts.b = "x"\n    }\n    let s: string = opts.b\n    return s\n}\nlet given = { a: 2, b: 5 }\nf(given)\nexit',
    ),
    [["TSV041", "given"]],
  );
  // A return that mixes types adds nothing to the result's properties.
  assert.deepEqual(
    codes(
      'function f(n) {\n    if n > 1 {\n        return { a: 1 }\n    }\n    if n > 2 {\n        return { b: "x", a: "s" }\n    }\n    return { a: 2, b: 3 }\n}\nlet r = f(1)\nlet s: integer = r.b\nexit',
    ),
    [["TSV044", '{ b: "x", a: "s" }']],
  );
  // A copy of a collection that has seen null may still take null.
  for (const empty of ["[]", "set[]"])
    assert.deepEqual(
      codes(`let a = ${empty}\na.add(null)\nlet b = a\nb.add(1)\nb.add(null)\nexit`),
      [],
      empty,
    );
  // A converted collection is a new one with its source's type, because it holds what the source held when it was
  // converted: in either order, a value of another type fits neither (ADR 0021 rule 1.2). Their values stay apart,
  // and a first null stays a first null in both. One already decided keeps its type.
  for (const [empty, convert, decided, nullFirst] of [
    ["[]", "toSet", "[1]", "[null, 2]"],
    ["set[]", "toList", "set[1]", "[null, 2, null]"],
  ]) {
    for (const stores of ['a.add(1)\nb.add("x")', 'b.add("x")\na.add(1)'])
      assert.deepEqual(
        mismatches(`let a = ${empty}\nlet b = a.${convert}()\n${stores}\nexit`).map(
          ([code, message, text]) => [code, message.includes("'b' was copied from 'a'"), text],
        ),
        [["TSV041", true, '"x"']],
        stores,
      );
    assert.deepEqual(
      sayTexts(`let a = ${empty}\nlet b = a.${convert}()\na.add(1)\nb.add(2)\nsay a\nsay b\nexit`),
      ["[1]", "[2]"],
    );
    assert.deepEqual(
      sayTexts(
        `let a = ${empty}\na.add(null)\nlet b = a.${convert}()\na.add(1)\nb.add(2)\nb.add(null)\nsay b\nexit`,
      ),
      [nullFirst],
    );
    assert.deepEqual(codes(`let a = ${decided}\nlet b = a.${convert}()\nb.add("x")\nexit`), [
      ["TSV041", '"x"'],
    ]);
  }
  // A timer block checked after the conversion may fill the source before the conversion runs.
  assert.deepEqual(
    codes(
      'let a = []\ntimer async 1 s { a.add(1) }\nwait 2 s\nlet b = a.toSet()\nb.add("x")\nexit',
    ),
    [["TSV041", '"x"']],
  );
  // A mismatch in a copy, or in a part of one, names the variable it was copied from, also when the copy was taken
  // through an index, a function, or a literal, but not for a copy or a part that its own first value decided. Around a
  // cycle of copies, the first value in checking order decides.
  const copyNotes = (source: string) =>
    mismatches(source).map(([code, message, text]) => [
      code,
      /'\w+' was copied from '(\w+)'/u.exec(message)?.[1] ?? null,
      text,
    ]);
  for (const copy of ["let b = a[0]", "let b = first()", "let b = { n: a[0] }.n"])
    assert.deepEqual(
      copyNotes(
        `let a = [[]]\nfunction first {\n    return a[0]\n}\n${copy}\na[0].add(1)\nb.add("x")\nexit`,
      ),
      [["TSV041", "a", '"x"']],
      copy,
    );
  for (const store of ['b.add({ n: "x" })', 'let c = { n: "x" }\nb.add(c)', 'b += [{ n: "x" }]'])
    assert.deepEqual(
      copyNotes(`let a = []\nlet b = a\na.add({ n: 1 })\n${store}\nexit`).map(([code, source]) => [
        code,
        source,
      ]),
      [[store.startsWith("b +=") ? "TSV044" : "TSV041", "a"]],
      store,
    );
  assert.deepEqual(
    copyNotes('let a = []\nlet b = a\na.add({ n: 1 })\nb[0].m = "x"\nb[0].m = 2\nexit'),
    [["TSV041", null, "2"]],
  );
  assert.deepEqual(copyNotes('let a = 1\nlet b = a\nb = 0.5\nb = "x"\nexit'), [
    ["TSV041", null, '"x"'],
  ]);
  assert.deepEqual(
    copyNotes('let a = []\nlet b = a\na = b\na.add(1)\nb.add("x")\na.add(true)\nexit'),
    [
      ["TSV041", "a", '"x"'],
      ["TSV041", null, "true"],
    ],
  );
  // A return is the value as it was evaluated: a later statement of the body changes only the place it was read from.
  for (const [setup, read, write] of [
    ["let given = {}", "given", "given.flag = 1"],
    ["let given = {}", "(given)", "given.flag = 1"],
    ["let given = { nest: {} }", "given.nest", "given.nest.flag = 1"],
    ["let given = [{}]", "given[0]", "given[0].flag = 1"],
    ["", "local", "local.flag = 1"],
  ])
    assert.deepEqual(
      sayTexts(
        `${setup}\nfunction f(flag = false) {\n    let local = {}\n    if flag {\n        return ${read}\n    }\n    ${write}\n    return { flag: true }\n}\nsay f(true)\nsay f(false)\nexit`,
      ),
      ["{}", "{ flag: true }"],
      read,
    );
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(flag = false) {\n    if flag {\n        return given\n    }\n    return { flag: true }\n}\nlet result = f(true)\nexit",
    ),
    [["TSV044", "{ flag: true }"]],
  );
});

test("arguments are checked as they were evaluated, against the parameters of the whole body", () => {
  // The body and later arguments add properties to the caller's object only after the argument was evaluated.
  const given = "let given = {}\nfunction fill {\n    given.flag = 1\n    return 0\n}\n";
  for (const [parameter, use, call] of [
    ["obj = {}, n = 0", "obj.flag", "f(given)"],
    ["obj = {}, n = 0", "obj.flag", "f(given, fill())"],
    ["obj = {}, n = 0", "obj.flag", "f(holder.given, fill())"],
    ["obj = {}, n = 0", "obj.flag", "f(row[0], fill())"],
    ["obj = { nest: {} }", "obj.nest.flag", "f({ nest: given })"],
    ["items = [{}]", "items[0].flag", "f([given])"],
  ])
    assert.deepEqual(
      sayTexts(
        `${given}let holder = { given: {} }\nlet row = [{}]\nfunction f(${parameter}) {\n    ${use} = true\n    given.flag = 1\n    holder.given.flag = 1\n    row[0].flag = 1\n    return ${use}\n}\nsay "\${${call}}"\nexit`,
      ),
      ["true"],
      call,
    );
  // A converted collection has its source's element type, also as a part of a literal argument: elements added before
  // the conversion or by a later argument must fit (ADR 0021 rule 1.2).
  for (const [empty, convert, typed, texts] of [
    ["[]", "toSet", "string set", 'set["s"]'],
    ["set[]", "toList", "string[]", '["s"]'],
  ]) {
    const functions = `let a = ${empty}\nfunction fill {\n    a.add(1)\n    return 0\n}\nfunction f(items: ${typed}, n = 0) {\n    return items.length\n}\nfunction g(obj = { items: ${texts}, tick: 0 }) {\n    return obj.items.length\n}\n`;
    const converted = `a.${convert}()`;
    for (const [call, earlier] of [
      [`f(${converted}, fill())`, `f(${converted})`],
      [`g({ items: ${converted}, tick: fill() })`, `g({ items: ${converted}, tick: 0 })`],
    ]) {
      assert.deepEqual(codes(`${functions}say "\${${call}}"\nexit`), [["TSV041", converted]], call);
      assert.deepEqual(
        codes(`${functions}a.add(1)\nlet count = ${earlier}\nexit`),
        [["TSV041", converted]],
        earlier,
      );
    }
  }
  // A property the argument already has when it is evaluated must fit.
  assert.deepEqual(
    codes(
      "let given = { flag: 1 }\nfunction f(obj = { nest: {} }) {\n    obj.nest.flag = true\n}\nf({ nest: given })\nexit",
    ),
    [["TSV041", "given"]],
  );
  // A call made inside the body, directly or through another function, is checked once the body is complete.
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ flag: 1 }, 1)\n    }\n    obj.flag = true\n    return obj.flag\n}\nlet result = f()\nexit",
    ),
    [["TSV041", "1"]],
  );
  assert.deepEqual(
    codes(
      "function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return g()\n    }\n    obj.flag = true\n    return obj.flag\n}\nfunction g: boolean {\n    return f({ flag: 1 }, 1)\n}\nlet result = f()\nexit",
    ),
    [["TSV041", "1"]],
  );
  // A later part of a literal argument does not change an earlier part as it was evaluated.
  assert.deepEqual(
    sayTexts(
      `${given}function f(obj = { nest: {}, tick: 0 }) {\n    obj.nest.flag = true\n    return obj.nest.flag\n}\nsay "\${f({ nest: given, tick: fill() })}"\nexit`,
    ),
    ["true"],
  );
  // A call reached while the function's defaults are checked waits for its parameters too, and a list it mixes is
  // reported once, by the parameter that decides it.
  assert.deepEqual(
    codes(
      'function f(n: integer = seed(false)): integer {\n    return n\n}\nfunction seed(recurse = false): integer {\n    if recurse {\n        return f("bad")\n    }\n    return 0\n}\nlet result = f()\nexit',
    ),
    [["TSV041", '"bad"']],
  );
  assert.deepEqual(
    codes(
      'function f(obj = {}, n = 0): boolean {\n    if n == 0 {\n        return f({ items: [1, "a"] }, 1)\n    }\n    obj.items = [1]\n    return true\n}\nf()\nexit',
    ),
    [["TSV041", '"a"']],
  );
  // A declared element type decides a literal argument also when the call checks the body first.
  assert.deepEqual(codes('function f(values: integer[]) {\n    say "x"\n}\nf([1, "a"])\nexit'), [
    ["TSV041", '"a"'],
  ]);
});

test("a loop that may end through continue can still reach the function's end", () => {
  for (const loop of [
    "repeat 1 {\n        continue\n    }",
    "for n in [1] {\n        continue\n    }",
  ])
    assert.deepEqual(codes(`function f: integer {\n    ${loop}\n}\nlet a: integer = f()\nexit`), [
      ["TSV041", "f"],
    ]);
});
