// #1310; builder/review archive.
export const cases = (() => {
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
