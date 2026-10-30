// kinds-0-depth-0, kinds-0-depth-1 and related fixed cases; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/extended2.mjs).
const generated = (() => {
  const cases = [];
  function add(name, body, where, whole = null, all = true) {
    cases.push({ name, source: body + "\nexit\n", where, whole, all });
  }
  const scalars = [
    "1",
    "1.5",
    '"x"',
    "true",
    "1 s",
    "1 calendar day",
    "90 deg",
    'toDate("2026-10-04")',
    'toTime("14:30")',
    'toDateTime("2026-10-04T18:00")',
    'toAbsoluteDateTime("2026-10-04T12:30:00Z")',
    "{n: 1}",
  ];
  for (const [i, element] of scalars.entries()) {
    const other = i === 2 ? "1" : '"x"';
    for (const depth of [0, 1, 2]) {
      const nest = (x) => "[".repeat(depth + 1) + x + "]".repeat(depth + 1);
      add(
        `kinds-${i}-depth-${depth}`,
        `let xs = ${nest(element)}\nlet both = xs + ${nest(other)}`,
        ["let xs = ", "let xs: TYPE = "],
        nest(element + ", " + other),
        depth === 0,
      );
    }
  }
  for (const [name, left, right] of [
    ["dict-elements", '[dict{"n": 1}]', '[dict{"n": "x"}]'],
    ["set-elements", "[set[1]]", '[set["x"]]'],
    ["dict-scalar", '[dict{"n": 1}]', '["x"]'],
    ["set-scalar", "[set[1]]", '["x"]'],
    ["dict-set", '[dict{"n": 1}]', "[set[1]]"],
    ["list-scalar", "[[1]]", '["x"]'],
    ["scalar-list", '["x"]', "[[1]]"],
    ["nullable-set", "[set[1, null], null]", '[set["x"]]'],
    ["dict-list", '[dict{"n": [1]}]', '[dict{"n": ["x"]}]'],
    ["deep-objects", "[[{n: {a: [1]}}]]", '[[{n: {a: ["x"]}}]]'],
    ["external-nested-number", "[[[1, hostValue / 2], null], null]", '[[["x"]]]'],
    ["external-nested-plain", "[[1, hostValue], null]", '[["x"]]'],
    ["external-nested-string", "[[1, toString(hostValue)], null]", '[["x"]]'],
    ["external-only-tail", "[1]", '["x"] + [hostValue]'],
    ["external-typed-tail", "[1]", '["x"] + [toDate(hostValue)]'],
    ["ext-list-level", "[[1], hostValue]", '[["x"]]'],
    ["ext-before-known", "[hostValue, 1]", '["x"]'],
    ["ext-call", "[1, toNumber(hostValue)]", '["x"]'],
  ])
    add(name, `let xs = ${left}\nlet both = xs + ${right}`, ["let xs = ", "let xs: TYPE = "]);
  for (const [name, type, value, right] of [
    ["written-union", "(integer | boolean)[]", "[1]", '["x"]'],
    ["written-other-value", "(integer | boolean)[]", "[true]", '["x"]'],
    ["written-union-null", "(integer | boolean | null)[]", "[1]", '["x"]'],
    ["written-nested-union", "(integer | boolean)[][]", "[[1]]", '[["x"]]'],
    ["written-optional-union", "((integer | boolean)[]?)[]", "[[1]]", '[["x"]]'],
    ["written-number-union", "(number | boolean)[]", "[1]", '["x"]'],
    ["written-number-copy", "number[]", "[1]", '["x"]'],
    ["written-object-union", "(object | integer)[]", "[1]", '["x"]'],
  ]) {
    add(name, `let xs: ${type} = ${value}\nlet both = xs + ${right}`, [
      new RegExp("let xs: [^=]+ = "),
      "let xs: TYPE = ",
    ]);
    add(
      name + "-copy",
      `let source: ${type} = ${value}\nlet xs = source\nlet both = xs + ${right}`,
      ["let xs = ", "let xs: TYPE = "],
    );
    add(
      name + "-call",
      `function make: ${type} { return ${value} }\nlet xs = make()\nlet both = xs + ${right}`,
      ["let xs = ", "let xs: TYPE = "],
    );
    add(
      name + "-call-direct",
      `function make: ${type} { return ${value} }\nlet both = make() + ${right}`,
      ["let both = ", "let both: TYPE = "],
    );
  }
  for (const [name, value, right] of [
    ["nullable", "[1, null]", '["x"]'],
    ["nested-nullable", "[[1], null]", '[["x"]]'],
    ["deep-nullable", "[[[1], null], null]", '[[["x"]]]'],
    ["number", "[1, 1.5]", '["x"]'],
    ["external-number", "[1, hostValue / 2]", '["x"]'],
  ]) {
    for (const selection of ["first", "last", "random"]) {
      // A `values` fix here is tested by retyping the property initializer the += reads.
      add(
        `own-${selection}-${name}`,
        `let box = {${selection}: {items: ${value}}}\nbox.${selection}.items += ${right}`,
        [`items: ${value}`, `items: typed`],
      );
    }
    add(`call-${name}`, `function make { return ${value} }\nlet both = make() + ${right}`, [
      "let both = ",
      "let both: TYPE = ",
    ]);
    add(`parameter-${name}`, `function f(xs = ${value}) { return xs + ${right} }\nsay f().length`, [
      "xs = ",
      "xs: TYPE = ",
    ]);
    add(`late-mutated-${name}`, `let xs = ${value}\nlet both = xs + ${right}\nxs.add(null)`, [
      "let xs = ",
      "let xs: TYPE = ",
    ]);
  }
  for (const [name, body] of [
    ["left-written-root", 'let xs = [1]\nlet both = xs + ["x"] + [true] + [null]'],
    ["right-written-root", 'let ys = ["x", null]\nlet both = [1] + ys + [true]'],
    [
      "call-later-return",
      'function make(n: boolean) { if n { return [1, null] }\nreturn [2, null] }\nlet both = make(true) + ["x"]',
    ],
    ["object-shape", "let xs = [{n: 1}]\nlet both = xs + [true]"],
    ["object-multi", "let xs = [[{n: {a: 1}}, null], null]\nlet both = xs + [[true]]"],
    [
      "own-written-union",
      'let typed: (integer | boolean | null)[] = [1]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]',
    ],
    [
      "narrowed-external",
      "if hostValue is string {\nlet xs = [1, hostValue]\nlet both = xs + [true]\n}",
    ],
  ])
    add(name, body, [
      body.includes("let xs = ")
        ? "let xs = "
        : body.includes("let ys = ")
          ? "let ys = "
          : "let both = ",
      body.includes("let xs = ")
        ? "let xs: TYPE = "
        : body.includes("let ys = ")
          ? "let ys: TYPE = "
          : "let both: TYPE = ",
    ]);
  for (const [name, op] of [
    ["null", "xs.add(null)"],
    ["fraction", "xs.add(1.5)"],
  ])
    for (const when of ["before", "after"]) {
      add(
        `assigned-${name}-${when}`,
        `let xs = [1]\n${when === "before" ? op + "\n" : ""}let both = xs + ["x"]\n${when === "after" ? op : ""}`,
        ["let xs = ", "let xs: TYPE = "],
      );
      add(
        `stored-${name}-${when}`,
        `let xs = [1]\n${when === "before" ? "xs[0] = " + (name === "null" ? "null" : "1.5") + "\n" : ""}let both = xs + ["x"]\n${when === "after" ? "xs[0] = " + (name === "null" ? "null" : "1.5") : ""}`,
        ["let xs = ", "let xs: TYPE = "],
      );
    }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];

// The pasted forms and typed holds the recorded runs compiled, each original's suggested fix pasted in as the
// compiler of its tree wrote it: from their results (desktop:/home/peter/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/paste/
// extended2.out and the same driver's two later runs, 64105f339's pre-rebase-a0ee092f3/ and run/).
const captured = [
  ["kinds-0-depth-0/pasted", 'let xs: (integer | string)[] = [1]\nlet both = xs + ["x"]\nexit\n'],
  [
    "kinds-0-depth-0/holds.typed",
    'let checkValues: (integer | string)[] = [1, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-0-depth-1/pasted",
    'let xs: (integer | string)[][] = [[1]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-0-depth-1/holds.typed",
    'let checkValues: (integer | string)[][] = [[1, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-0-depth-2/pasted",
    'let xs: (integer | string)[][][] = [[[1]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-0-depth-2/holds.typed",
    'let checkValues: (integer | string)[][][] = [[[1, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  ["kinds-1-depth-0/pasted", 'let xs: (number | string)[] = [1.5]\nlet both = xs + ["x"]\nexit\n'],
  [
    "kinds-1-depth-0/holds.typed",
    'let checkValues: (number | string)[] = [1.5, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-1-depth-1/pasted",
    'let xs: (number | string)[][] = [[1.5]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-1-depth-1/holds.typed",
    'let checkValues: (number | string)[][] = [[1.5, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-1-depth-2/pasted",
    'let xs: (number | string)[][][] = [[[1.5]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-1-depth-2/holds.typed",
    'let checkValues: (number | string)[][][] = [[[1.5, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  ["kinds-2-depth-0/pasted", 'let xs: (string | integer)[] = ["x"]\nlet both = xs + [1]\nexit\n'],
  [
    "kinds-2-depth-0/holds.typed",
    'let checkValues: (string | integer)[] = ["x", 1]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-2-depth-1/pasted",
    'let xs: (string | integer)[][] = [["x"]]\nlet both = xs + [[1]]\nexit\n',
  ],
  [
    "kinds-2-depth-1/holds.typed",
    'let checkValues: (string | integer)[][] = [["x", 1]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-2-depth-2/pasted",
    'let xs: (string | integer)[][][] = [[["x"]]]\nlet both = xs + [[[1]]]\nexit\n',
  ],
  [
    "kinds-2-depth-2/holds.typed",
    'let checkValues: (string | integer)[][][] = [[["x", 1]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-3-depth-0/pasted",
    'let xs: (boolean | string)[] = [true]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-3-depth-0/holds.typed",
    'let checkValues: (boolean | string)[] = [true, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-3-depth-1/pasted",
    'let xs: (boolean | string)[][] = [[true]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-3-depth-1/holds.typed",
    'let checkValues: (boolean | string)[][] = [[true, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-3-depth-2/pasted",
    'let xs: (boolean | string)[][][] = [[[true]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-3-depth-2/holds.typed",
    'let checkValues: (boolean | string)[][][] = [[[true, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-4-depth-0/pasted",
    'let xs: (duration | string)[] = [1 s]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-4-depth-0/holds.typed",
    'let checkValues: (duration | string)[] = [1 s, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-4-depth-1/pasted",
    'let xs: (duration | string)[][] = [[1 s]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-4-depth-1/holds.typed",
    'let checkValues: (duration | string)[][] = [[1 s, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-4-depth-2/pasted",
    'let xs: (duration | string)[][][] = [[[1 s]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-4-depth-2/holds.typed",
    'let checkValues: (duration | string)[][][] = [[[1 s, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-5-depth-0/pasted",
    'let xs: (calendarDuration | string)[] = [1 calendar day]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-5-depth-0/holds.typed",
    'let checkValues: (calendarDuration | string)[] = [1 calendar day, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-5-depth-1/pasted",
    'let xs: (calendarDuration | string)[][] = [[1 calendar day]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-5-depth-1/holds.typed",
    'let checkValues: (calendarDuration | string)[][] = [[1 calendar day, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-5-depth-2/pasted",
    'let xs: (calendarDuration | string)[][][] = [[[1 calendar day]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-5-depth-2/holds.typed",
    'let checkValues: (calendarDuration | string)[][][] = [[[1 calendar day, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-6-depth-0/pasted",
    'let xs: (angle | string)[] = [90 deg]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-6-depth-0/holds.typed",
    'let checkValues: (angle | string)[] = [90 deg, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-6-depth-1/pasted",
    'let xs: (angle | string)[][] = [[90 deg]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-6-depth-1/holds.typed",
    'let checkValues: (angle | string)[][] = [[90 deg, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-6-depth-2/pasted",
    'let xs: (angle | string)[][][] = [[[90 deg]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-6-depth-2/holds.typed",
    'let checkValues: (angle | string)[][][] = [[[90 deg, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-7-depth-0/pasted",
    'let xs: (date | string)[] = [toDate("2026-10-04")]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-7-depth-0/holds.typed",
    'let checkValues: (date | string)[] = [toDate("2026-10-04"), "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-7-depth-1/pasted",
    'let xs: (date | string)[][] = [[toDate("2026-10-04")]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-7-depth-1/holds.typed",
    'let checkValues: (date | string)[][] = [[toDate("2026-10-04"), "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-7-depth-2/pasted",
    'let xs: (date | string)[][][] = [[[toDate("2026-10-04")]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-7-depth-2/holds.typed",
    'let checkValues: (date | string)[][][] = [[[toDate("2026-10-04"), "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-8-depth-0/pasted",
    'let xs: (time | string)[] = [toTime("14:30")]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-8-depth-0/holds.typed",
    'let checkValues: (time | string)[] = [toTime("14:30"), "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-8-depth-1/pasted",
    'let xs: (time | string)[][] = [[toTime("14:30")]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-8-depth-1/holds.typed",
    'let checkValues: (time | string)[][] = [[toTime("14:30"), "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-8-depth-2/pasted",
    'let xs: (time | string)[][][] = [[[toTime("14:30")]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-8-depth-2/holds.typed",
    'let checkValues: (time | string)[][][] = [[[toTime("14:30"), "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-9-depth-0/pasted",
    'let xs: (datetime | string)[] = [toDateTime("2026-10-04T18:00")]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-9-depth-0/holds.typed",
    'let checkValues: (datetime | string)[] = [toDateTime("2026-10-04T18:00"), "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-9-depth-1/pasted",
    'let xs: (datetime | string)[][] = [[toDateTime("2026-10-04T18:00")]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-9-depth-1/holds.typed",
    'let checkValues: (datetime | string)[][] = [[toDateTime("2026-10-04T18:00"), "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-9-depth-2/pasted",
    'let xs: (datetime | string)[][][] = [[[toDateTime("2026-10-04T18:00")]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-9-depth-2/holds.typed",
    'let checkValues: (datetime | string)[][][] = [[[toDateTime("2026-10-04T18:00"), "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-10-depth-0/pasted",
    'let xs: (absoluteDateTime | string)[] = [toAbsoluteDateTime("2026-10-04T12:30:00Z")]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-10-depth-0/holds.typed",
    'let checkValues: (absoluteDateTime | string)[] = [toAbsoluteDateTime("2026-10-04T12:30:00Z"), "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-10-depth-1/pasted",
    'let xs: (absoluteDateTime | string)[][] = [[toAbsoluteDateTime("2026-10-04T12:30:00Z")]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-10-depth-1/holds.typed",
    'let checkValues: (absoluteDateTime | string)[][] = [[toAbsoluteDateTime("2026-10-04T12:30:00Z"), "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-10-depth-2/pasted",
    'let xs: (absoluteDateTime | string)[][][] = [[[toAbsoluteDateTime("2026-10-04T12:30:00Z")]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-10-depth-2/holds.typed",
    'let checkValues: (absoluteDateTime | string)[][][] = [[[toAbsoluteDateTime("2026-10-04T12:30:00Z"), "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-11-depth-0/pasted",
    'let xs: (object | string)[] = [{n: 1}]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "kinds-11-depth-0/holds.typed",
    'let checkValues: (object | string)[] = [{n: 1}, "x"]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-11-depth-1/pasted",
    'let xs: (object | string)[][] = [[{n: 1}]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "kinds-11-depth-1/holds.typed",
    'let checkValues: (object | string)[][] = [[{n: 1}, "x"]]\nsay checkValues.length\nexit\n',
  ],
  [
    "kinds-11-depth-2/pasted",
    'let xs: (object | string)[][][] = [[[{n: 1}]]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "kinds-11-depth-2/holds.typed",
    'let checkValues: (object | string)[][][] = [[[{n: 1}, "x"]]]\nsay checkValues.length\nexit\n',
  ],
  [
    "external-nested-number/pasted",
    'let xs: (((number | duration | calendarDuration | angle | string)[]?)[]?)[] = [[[1, hostValue / 2], null], null]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "external-nested-plain/pasted",
    'let xs: ((integer | string)[]?)[] = [[1, hostValue], null]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "external-nested-string/pasted",
    'let xs: ((integer | string)[]?)[] = [[1, toString(hostValue)], null]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "external-only-tail/pasted",
    'let xs: (integer | string)[] = [1]\nlet both = xs + ["x"] + [hostValue]\nexit\n',
  ],
  [
    "external-typed-tail/pasted",
    'let xs: (integer | string | date)[] = [1]\nlet both = xs + ["x"] + [toDate(hostValue)]\nexit\n',
  ],
  [
    "ext-list-level/pasted",
    'let xs: (integer | string)[][] = [[1], hostValue]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "ext-before-known/pasted",
    'let xs: (integer | string)[] = [hostValue, 1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "ext-call/pasted",
    'let xs: (number | string)[] = [1, toNumber(hostValue)]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union/pasted",
    'let xs: (integer | boolean | string)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-copy/pasted",
    'let source: (integer | boolean)[] = [1]\nlet xs: (integer | boolean | string)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-call/pasted",
    'function make: (integer | boolean)[] { return [1] }\nlet xs: (integer | boolean | string)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-call-direct/pasted",
    'function make: (integer | boolean)[] { return [1] }\nlet both: (integer | boolean | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "written-other-value/pasted",
    'let xs: (integer | boolean | string)[] = [true]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-other-value-copy/pasted",
    'let source: (integer | boolean)[] = [true]\nlet xs: (integer | boolean | string)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-other-value-call/pasted",
    'function make: (integer | boolean)[] { return [true] }\nlet xs: (integer | boolean | string)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-other-value-call-direct/pasted",
    'function make: (integer | boolean)[] { return [true] }\nlet both: (integer | boolean | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "written-union-null/pasted",
    'let xs: (integer | boolean | string | null)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-null-copy/pasted",
    'let source: (integer | boolean | null)[] = [1]\nlet xs: (integer | boolean | string | null)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-null-call/pasted",
    'function make: (integer | boolean | null)[] { return [1] }\nlet xs: (integer | boolean | string | null)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-union-null-call-direct/pasted",
    'function make: (integer | boolean | null)[] { return [1] }\nlet both: (integer | boolean | string | null)[] = make() + ["x"]\nexit\n',
  ],
  [
    "written-nested-union/pasted",
    'let xs: (integer | boolean | string)[][] = [[1]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-nested-union-copy/pasted",
    'let source: (integer | boolean)[][] = [[1]]\nlet xs: (integer | boolean | string)[][] = source\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-nested-union-call/pasted",
    'function make: (integer | boolean)[][] { return [[1]] }\nlet xs: (integer | boolean | string)[][] = make()\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-nested-union-call-direct/pasted",
    'function make: (integer | boolean)[][] { return [[1]] }\nlet both: (integer | boolean | string)[][] = make() + [["x"]]\nexit\n',
  ],
  [
    "written-optional-union/pasted",
    'let xs: ((integer | boolean | string)[]?)[] = [[1]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-optional-union-copy/pasted",
    'let source: ((integer | boolean)[]?)[] = [[1]]\nlet xs: ((integer | boolean | string)[]?)[] = source\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-optional-union-call/pasted",
    'function make: ((integer | boolean)[]?)[] { return [[1]] }\nlet xs: ((integer | boolean | string)[]?)[] = make()\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-optional-union-call-direct/pasted",
    'function make: ((integer | boolean)[]?)[] { return [[1]] }\nlet both: ((integer | boolean | string)[]?)[] = make() + [["x"]]\nexit\n',
  ],
  [
    "written-number-union/pasted",
    'let xs: (number | boolean | string)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-union-copy/pasted",
    'let source: (number | boolean)[] = [1]\nlet xs: (number | boolean | string)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-union-call/pasted",
    'function make: (number | boolean)[] { return [1] }\nlet xs: (number | boolean | string)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-union-call-direct/pasted",
    'function make: (number | boolean)[] { return [1] }\nlet both: (number | boolean | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "written-number-copy/pasted",
    'let xs: (number | string)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-copy-copy/pasted",
    'let source: number[] = [1]\nlet xs: (number | string)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-copy-call/pasted",
    'function make: number[] { return [1] }\nlet xs: (number | string)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-number-copy-call-direct/pasted",
    'function make: number[] { return [1] }\nlet both: (number | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "written-object-union/pasted",
    'let xs: (object | integer | string)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-object-union-copy/pasted",
    'let source: (object | integer)[] = [1]\nlet xs: (object | integer | string)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-object-union-call/pasted",
    'function make: (object | integer)[] { return [1] }\nlet xs: (object | integer | string)[] = make()\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-object-union-call-direct/pasted",
    'function make: (object | integer)[] { return [1] }\nlet both: (object | integer | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "own-first-nullable/pasted",
    'let typed: (integer | string | null)[] = [1, null]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]\nexit\n',
  ],
  [
    "own-last-nullable/pasted",
    'let typed: (integer | string | null)[] = [1, null]\nlet box = {last: {items: typed}}\nbox.last.items += ["x"]\nexit\n',
  ],
  [
    "own-random-nullable/pasted",
    'let typed: (integer | string | null)[] = [1, null]\nlet box = {random: {items: typed}}\nbox.random.items += ["x"]\nexit\n',
  ],
  [
    "call-nullable/pasted",
    'function make { return [1, null] }\nlet both: (integer | string | null)[] = make() + ["x"]\nexit\n',
  ],
  [
    "parameter-nullable/pasted",
    'function f(xs: (integer | string | null)[] = [1, null]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  [
    "late-mutated-nullable/pasted",
    'let xs: (integer | string | null)[] = [1, null]\nlet both = xs + ["x"]\nxs.add(null)\nexit\n',
  ],
  [
    "own-first-nested-nullable/pasted",
    'let typed: ((integer | string)[]?)[] = [[1], null]\nlet box = {first: {items: typed}}\nbox.first.items += [["x"]]\nexit\n',
  ],
  [
    "own-last-nested-nullable/pasted",
    'let typed: ((integer | string)[]?)[] = [[1], null]\nlet box = {last: {items: typed}}\nbox.last.items += [["x"]]\nexit\n',
  ],
  [
    "own-random-nested-nullable/pasted",
    'let typed: ((integer | string)[]?)[] = [[1], null]\nlet box = {random: {items: typed}}\nbox.random.items += [["x"]]\nexit\n',
  ],
  [
    "call-nested-nullable/pasted",
    'function make { return [[1], null] }\nlet both: ((integer | string)[]?)[] = make() + [["x"]]\nexit\n',
  ],
  [
    "parameter-nested-nullable/pasted",
    'function f(xs: ((integer | string)[]?)[] = [[1], null]) { return xs + [["x"]] }\nsay f().length\nexit\n',
  ],
  [
    "late-mutated-nested-nullable/pasted",
    'let xs: ((integer | string)[]?)[] = [[1], null]\nlet both = xs + [["x"]]\nxs.add(null)\nexit\n',
  ],
  [
    "own-first-deep-nullable/pasted",
    'let typed: (((integer | string)[]?)[]?)[] = [[[1], null], null]\nlet box = {first: {items: typed}}\nbox.first.items += [[["x"]]]\nexit\n',
  ],
  [
    "own-last-deep-nullable/pasted",
    'let typed: (((integer | string)[]?)[]?)[] = [[[1], null], null]\nlet box = {last: {items: typed}}\nbox.last.items += [[["x"]]]\nexit\n',
  ],
  [
    "own-random-deep-nullable/pasted",
    'let typed: (((integer | string)[]?)[]?)[] = [[[1], null], null]\nlet box = {random: {items: typed}}\nbox.random.items += [[["x"]]]\nexit\n',
  ],
  [
    "call-deep-nullable/pasted",
    'function make { return [[[1], null], null] }\nlet both: (((integer | string)[]?)[]?)[] = make() + [[["x"]]]\nexit\n',
  ],
  [
    "parameter-deep-nullable/pasted",
    'function f(xs: (((integer | string)[]?)[]?)[] = [[[1], null], null]) { return xs + [[["x"]]] }\nsay f().length\nexit\n',
  ],
  [
    "late-mutated-deep-nullable/pasted",
    'let xs: (((integer | string)[]?)[]?)[] = [[[1], null], null]\nlet both = xs + [[["x"]]]\nxs.add(null)\nexit\n',
  ],
  [
    "own-first-number/pasted",
    'let typed: (number | string)[] = [1, 1.5]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]\nexit\n',
  ],
  [
    "own-last-number/pasted",
    'let typed: (number | string)[] = [1, 1.5]\nlet box = {last: {items: typed}}\nbox.last.items += ["x"]\nexit\n',
  ],
  [
    "own-random-number/pasted",
    'let typed: (number | string)[] = [1, 1.5]\nlet box = {random: {items: typed}}\nbox.random.items += ["x"]\nexit\n',
  ],
  [
    "call-number/pasted",
    'function make { return [1, 1.5] }\nlet both: (number | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "parameter-number/pasted",
    'function f(xs: (number | string)[] = [1, 1.5]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  [
    "late-mutated-number/pasted",
    'let xs: (number | string | null)[] = [1, 1.5]\nlet both = xs + ["x"]\nxs.add(null)\nexit\n',
  ],
  [
    "own-first-external-number/pasted",
    'let typed: (number | string)[] = [1, hostValue / 2]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]\nexit\n',
  ],
  [
    "own-last-external-number/pasted",
    'let typed: (number | string)[] = [1, hostValue / 2]\nlet box = {last: {items: typed}}\nbox.last.items += ["x"]\nexit\n',
  ],
  [
    "own-random-external-number/pasted",
    'let typed: (number | string)[] = [1, hostValue / 2]\nlet box = {random: {items: typed}}\nbox.random.items += ["x"]\nexit\n',
  ],
  [
    "call-external-number/pasted",
    'function make { return [1, hostValue / 2] }\nlet both: (number | duration | calendarDuration | angle | string)[] = make() + ["x"]\nexit\n',
  ],
  [
    "parameter-external-number/pasted",
    'function f(xs: (number | duration | calendarDuration | angle | string)[] = [1, hostValue / 2]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  [
    "late-mutated-external-number/pasted",
    'let xs: (number | string | duration | calendarDuration | angle | null)[] = [1, hostValue / 2]\nlet both = xs + ["x"]\nxs.add(null)\nexit\n',
  ],
  [
    "left-written-root/pasted",
    'let xs: (integer | string | boolean | null)[] = [1]\nlet both = xs + ["x"] + [true] + [null]\nexit\n',
  ],
  [
    "right-written-root/pasted",
    'let ys: (integer | string | boolean | null)[] = ["x", null]\nlet both = [1] + ys + [true]\nexit\n',
  ],
  [
    "call-later-return/pasted",
    'function make(n: boolean) { if n { return [1, null] }\nreturn [2, null] }\nlet both: (integer | string | null)[] = make(true) + ["x"]\nexit\n',
  ],
  [
    "object-shape/pasted",
    "let xs: (object | boolean)[] = [{n: 1}]\nlet both = xs + [true]\nexit\n",
  ],
  [
    "object-multi/pasted",
    "let xs: ((object | boolean | null)[]?)[] = [[{n: {a: 1}}, null], null]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "own-written-union/pasted",
    'let typed: (integer | boolean | string | null)[] = [1]\nlet box = {first: {items: typed}}\nbox.first.items += ["x"]\nexit\n',
  ],
  [
    "narrowed-external/pasted",
    "if hostValue is string {\nlet xs: (integer | boolean)[] = [1, hostValue]\nlet both = xs + [true]\n}\nexit\n",
  ],
  [
    "assigned-null-before/pasted",
    'let xs: (integer | string | null)[] = [1]\nxs.add(null)\nlet both = xs + ["x"]\n\nexit\n',
  ],
  [
    "stored-null-before/pasted",
    'let xs: (integer | string | null)[] = [1]\nxs[0] = null\nlet both = xs + ["x"]\n\nexit\n',
  ],
  [
    "assigned-null-after/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + ["x"]\nxs.add(null)\nexit\n',
  ],
  [
    "stored-null-after/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + ["x"]\nxs[0] = null\nexit\n',
  ],
  [
    "assigned-fraction-before/pasted",
    'let xs: (number | string)[] = [1]\nxs.add(1.5)\nlet both = xs + ["x"]\n\nexit\n',
  ],
  [
    "stored-fraction-before/pasted",
    'let xs: (number | string)[] = [1]\nxs[0] = 1.5\nlet both = xs + ["x"]\n\nexit\n',
  ],
  [
    "assigned-fraction-after/pasted",
    'let xs: (number | string)[] = [1]\nlet both = xs + ["x"]\nxs.add(1.5)\nexit\n',
  ],
  [
    "stored-fraction-after/pasted",
    'let xs: (number | string)[] = [1]\nlet both = xs + ["x"]\nxs[0] = 1.5\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node extended2.mjs <tree>",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r3.sh:28",
    ],
  ],
  sources: 288,
  sha256: "52eec64084f70ace7e589d470c44432447e5c65513cdbf596cf5c829dcdc0046",
};
