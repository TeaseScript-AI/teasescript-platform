// parameter-0-0, values-0-0 and related fixed cases; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/paste.mjs).
const generated = (() => {
  const cases = [];
  function add(name, source, replacement, all = false) {
    cases.push({ name, source: source + "\nexit\n", replacement, all });
  }
  const kinds = ["1", "1.5", '"x"', "true", "{n: 1}", "1, null", "null, 2.5", '"x", null'];
  for (const [i, left] of kinds.entries())
    for (const [j, right] of kinds.entries()) {
      const a = `[${left}]`,
        b = `[${right}]`;
      add(`parameter-${i}-${j}`, `function f(xs = ${a}) { return xs + ${b} }\nsay f().length`, [
        "xs = ",
        "xs: TYPE = ",
      ]);
      add(`values-${i}-${j}`, `let both = ${a} + ${b}`, ["let both = ", "let both: TYPE = "]);
      add(`right-${i}-${j}`, `let ys = ${b}\nlet both = ${a} + ys`, [
        "let ys = ",
        "let ys: TYPE = ",
      ]);
      add(`compound-${i}-${j}`, `let xs = ${a}\nxs += ${b}`, ["let xs = ", "let xs: TYPE = "]);
      add(`nested-${i}-${j}`, `let xs = [${a}]\nlet both = xs + [${b}]`, [
        "let xs = ",
        "let xs: TYPE = ",
      ]);
    }
  for (const [name, left, right] of [
    ["outer-left-null", "[[1], null]", '[["x"]]'],
    ["outer-right-null", "[[1]]", '[["x"], null]'],
    ["both-levels-null", "[[1, null], null]", '[["x", null], null]'],
    ["deep-middle-null", "[[[1], null]]", '[[["x"]]]'],
    ["deep-outer-null", "[[[1]], null]", '[[["x"]]]'],
    ["deep-every-null", "[[[1, null], null], null]", '[[["x", null], null], null]'],
    ["external-number", "[1, hostValue / 2]", '["x"]'],
    ["external-number-right", '["x"]', "[1, hostValue / 2]"],
    ["external-number-null", "[1, null, hostValue / 2]", '["x"]'],
    ["external-number-nested", "[[1, hostValue / 2]]", '[["x"]]'],
  ]) {
    add(name, `let xs = ${left}\nlet both = xs + ${right}`, ["let xs = ", "let xs: TYPE = "], true);
    add(
      name + "-values",
      `let both = ${left} + ${right}`,
      ["let both = ", "let both: TYPE = "],
      true,
    );
    add(
      name + "-param",
      `function f(xs = ${left}) { return xs + ${right} }\nsay f().length`,
      ["xs = ", "xs: TYPE = "],
      true,
    );
    add(
      name + "-compound",
      `let xs = ${left}\nxs += ${right}`,
      ["let xs = ", "let xs: TYPE = "],
      true,
    );
  }
  for (const [name, body] of [
    ["written-null", 'let xs: integer?[] = [1]\nlet both = xs + ["x"]'],
    ["written-outer-null", 'let xs: integer[]?[] = [[1]]\nlet both = xs + [["x"]]'],
    ["written-both-null", 'let xs: integer?[]?[] = [[1]]\nlet both = xs + [["x"]]'],
    ["written-copied-null", 'let source: integer?[] = [1]\nlet xs = source\nlet both = xs + ["x"]'],
    ["later-null", 'let xs = [1]\nlet both = xs + ["x"] + [null]'],
    ["earlier-null", 'let xs = [1]\nlet both = [null] + xs + ["x"]'],
    ["intervening-null", 'let xs = [1]\nlet both = xs + [null] + ["x"]'],
    ["later-third-type", 'let xs = [1]\nlet both = xs + ["x"] + [true]'],
    ["right-tree-later-null", 'let xs = [1]\nlet both = xs + (["x"] + [null])'],
    ["written-null-first-right", 'let ys: string?[] = ["x"]\nlet both = [1] + ys'],
    ["nullable-whole-list", 'let xs = [1]\nxs = null\nlet both = xs + ["x"]'],
  ]) {
    const binding = name === "written-null-first-right" ? "ys" : "xs";
    add(name, body, [new RegExp(`(let ${binding})(?:: [^=\\n]+)? = `), `$1: TYPE = `], true);
  }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];

// The pasted forms the recorded runs compiled, each original's suggested fix pasted in as the compiler of its tree
// wrote it: from their results (desktop:/home/peter/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/paste/paste.out and the
// same driver's two later runs, 64105f339's pre-rebase-a0ee092f3/ and run/).
const captured = [
  [
    "parameter-0-2/pasted",
    'function f(xs: (integer | string)[] = [1]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-0-2/pasted", 'let both: (integer | string)[] = [1] + ["x"]\nexit\n'],
  ["right-0-2/pasted", 'let ys: (integer | string)[] = ["x"]\nlet both = [1] + ys\nexit\n'],
  ["compound-0-2/pasted", 'let xs: (integer | string)[] = [1]\nxs += ["x"]\nexit\n'],
  ["nested-0-2/pasted", 'let xs: (integer | string)[][] = [[1]]\nlet both = xs + [["x"]]\nexit\n'],
  [
    "parameter-0-3/pasted",
    "function f(xs: (integer | boolean)[] = [1]) { return xs + [true] }\nsay f().length\nexit\n",
  ],
  ["values-0-3/pasted", "let both: (integer | boolean)[] = [1] + [true]\nexit\n"],
  ["right-0-3/pasted", "let ys: (integer | boolean)[] = [true]\nlet both = [1] + ys\nexit\n"],
  ["compound-0-3/pasted", "let xs: (integer | boolean)[] = [1]\nxs += [true]\nexit\n"],
  [
    "nested-0-3/pasted",
    "let xs: (integer | boolean)[][] = [[1]]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "parameter-0-4/pasted",
    "function f(xs: (integer | object)[] = [1]) { return xs + [{n: 1}] }\nsay f().length\nexit\n",
  ],
  ["values-0-4/pasted", "let both: (integer | object)[] = [1] + [{n: 1}]\nexit\n"],
  ["right-0-4/pasted", "let ys: (integer | object)[] = [{n: 1}]\nlet both = [1] + ys\nexit\n"],
  ["compound-0-4/pasted", "let xs: (integer | object)[] = [1]\nxs += [{n: 1}]\nexit\n"],
  [
    "nested-0-4/pasted",
    "let xs: (integer | object)[][] = [[1]]\nlet both = xs + [[{n: 1}]]\nexit\n",
  ],
  [
    "parameter-0-7/pasted",
    'function f(xs: (integer | string | null)[] = [1]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-0-7/pasted", 'let both: (integer | string | null)[] = [1] + ["x", null]\nexit\n'],
  [
    "right-0-7/pasted",
    'let ys: (integer | string | null)[] = ["x", null]\nlet both = [1] + ys\nexit\n',
  ],
  ["compound-0-7/pasted", 'let xs: (integer | string | null)[] = [1]\nxs += ["x", null]\nexit\n'],
  [
    "nested-0-7/pasted",
    'let xs: (integer | string | null)[][] = [[1]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-1-2/pasted",
    'function f(xs: (number | string)[] = [1.5]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-1-2/pasted", 'let both: (number | string)[] = [1.5] + ["x"]\nexit\n'],
  ["right-1-2/pasted", 'let ys: (number | string)[] = ["x"]\nlet both = [1.5] + ys\nexit\n'],
  ["compound-1-2/pasted", 'let xs: (number | string)[] = [1.5]\nxs += ["x"]\nexit\n'],
  ["nested-1-2/pasted", 'let xs: (number | string)[][] = [[1.5]]\nlet both = xs + [["x"]]\nexit\n'],
  [
    "parameter-1-3/pasted",
    "function f(xs: (number | boolean)[] = [1.5]) { return xs + [true] }\nsay f().length\nexit\n",
  ],
  ["values-1-3/pasted", "let both: (number | boolean)[] = [1.5] + [true]\nexit\n"],
  ["right-1-3/pasted", "let ys: (number | boolean)[] = [true]\nlet both = [1.5] + ys\nexit\n"],
  ["compound-1-3/pasted", "let xs: (number | boolean)[] = [1.5]\nxs += [true]\nexit\n"],
  [
    "nested-1-3/pasted",
    "let xs: (number | boolean)[][] = [[1.5]]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "parameter-1-4/pasted",
    "function f(xs: (number | object)[] = [1.5]) { return xs + [{n: 1}] }\nsay f().length\nexit\n",
  ],
  ["values-1-4/pasted", "let both: (number | object)[] = [1.5] + [{n: 1}]\nexit\n"],
  ["right-1-4/pasted", "let ys: (number | object)[] = [{n: 1}]\nlet both = [1.5] + ys\nexit\n"],
  ["compound-1-4/pasted", "let xs: (number | object)[] = [1.5]\nxs += [{n: 1}]\nexit\n"],
  [
    "nested-1-4/pasted",
    "let xs: (number | object)[][] = [[1.5]]\nlet both = xs + [[{n: 1}]]\nexit\n",
  ],
  [
    "parameter-1-7/pasted",
    'function f(xs: (number | string | null)[] = [1.5]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-1-7/pasted", 'let both: (number | string | null)[] = [1.5] + ["x", null]\nexit\n'],
  [
    "right-1-7/pasted",
    'let ys: (number | string | null)[] = ["x", null]\nlet both = [1.5] + ys\nexit\n',
  ],
  ["compound-1-7/pasted", 'let xs: (number | string | null)[] = [1.5]\nxs += ["x", null]\nexit\n'],
  [
    "nested-1-7/pasted",
    'let xs: (number | string | null)[][] = [[1.5]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-2-0/pasted",
    'function f(xs: (string | integer)[] = ["x"]) { return xs + [1] }\nsay f().length\nexit\n',
  ],
  ["values-2-0/pasted", 'let both: (string | integer)[] = ["x"] + [1]\nexit\n'],
  ["right-2-0/pasted", 'let ys: (string | integer)[] = [1]\nlet both = ["x"] + ys\nexit\n'],
  ["compound-2-0/pasted", 'let xs: (string | integer)[] = ["x"]\nxs += [1]\nexit\n'],
  ["nested-2-0/pasted", 'let xs: (string | integer)[][] = [["x"]]\nlet both = xs + [[1]]\nexit\n'],
  [
    "parameter-2-1/pasted",
    'function f(xs: (string | number)[] = ["x"]) { return xs + [1.5] }\nsay f().length\nexit\n',
  ],
  ["values-2-1/pasted", 'let both: (string | number)[] = ["x"] + [1.5]\nexit\n'],
  ["right-2-1/pasted", 'let ys: (string | number)[] = [1.5]\nlet both = ["x"] + ys\nexit\n'],
  ["compound-2-1/pasted", 'let xs: (string | number)[] = ["x"]\nxs += [1.5]\nexit\n'],
  ["nested-2-1/pasted", 'let xs: (string | number)[][] = [["x"]]\nlet both = xs + [[1.5]]\nexit\n'],
  [
    "parameter-2-3/pasted",
    'function f(xs: (string | boolean)[] = ["x"]) { return xs + [true] }\nsay f().length\nexit\n',
  ],
  ["values-2-3/pasted", 'let both: (string | boolean)[] = ["x"] + [true]\nexit\n'],
  ["right-2-3/pasted", 'let ys: (string | boolean)[] = [true]\nlet both = ["x"] + ys\nexit\n'],
  ["compound-2-3/pasted", 'let xs: (string | boolean)[] = ["x"]\nxs += [true]\nexit\n'],
  [
    "nested-2-3/pasted",
    'let xs: (string | boolean)[][] = [["x"]]\nlet both = xs + [[true]]\nexit\n',
  ],
  [
    "parameter-2-4/pasted",
    'function f(xs: (string | object)[] = ["x"]) { return xs + [{n: 1}] }\nsay f().length\nexit\n',
  ],
  ["values-2-4/pasted", 'let both: (string | object)[] = ["x"] + [{n: 1}]\nexit\n'],
  ["right-2-4/pasted", 'let ys: (string | object)[] = [{n: 1}]\nlet both = ["x"] + ys\nexit\n'],
  ["compound-2-4/pasted", 'let xs: (string | object)[] = ["x"]\nxs += [{n: 1}]\nexit\n'],
  [
    "nested-2-4/pasted",
    'let xs: (string | object)[][] = [["x"]]\nlet both = xs + [[{n: 1}]]\nexit\n',
  ],
  [
    "parameter-2-5/pasted",
    'function f(xs: (string | integer | null)[] = ["x"]) { return xs + [1, null] }\nsay f().length\nexit\n',
  ],
  ["values-2-5/pasted", 'let both: (string | integer | null)[] = ["x"] + [1, null]\nexit\n'],
  [
    "right-2-5/pasted",
    'let ys: (string | integer | null)[] = [1, null]\nlet both = ["x"] + ys\nexit\n',
  ],
  ["compound-2-5/pasted", 'let xs: (string | integer | null)[] = ["x"]\nxs += [1, null]\nexit\n'],
  [
    "nested-2-5/pasted",
    'let xs: (string | integer | null)[][] = [["x"]]\nlet both = xs + [[1, null]]\nexit\n',
  ],
  [
    "parameter-2-6/pasted",
    'function f(xs: (string | number | null)[] = ["x"]) { return xs + [null, 2.5] }\nsay f().length\nexit\n',
  ],
  ["values-2-6/pasted", 'let both: (string | number | null)[] = ["x"] + [null, 2.5]\nexit\n'],
  [
    "right-2-6/pasted",
    'let ys: (string | number | null)[] = [null, 2.5]\nlet both = ["x"] + ys\nexit\n',
  ],
  ["compound-2-6/pasted", 'let xs: (string | number | null)[] = ["x"]\nxs += [null, 2.5]\nexit\n'],
  [
    "nested-2-6/pasted",
    'let xs: (string | number | null)[][] = [["x"]]\nlet both = xs + [[null, 2.5]]\nexit\n',
  ],
  [
    "parameter-3-0/pasted",
    "function f(xs: (boolean | integer)[] = [true]) { return xs + [1] }\nsay f().length\nexit\n",
  ],
  ["values-3-0/pasted", "let both: (boolean | integer)[] = [true] + [1]\nexit\n"],
  ["right-3-0/pasted", "let ys: (boolean | integer)[] = [1]\nlet both = [true] + ys\nexit\n"],
  ["compound-3-0/pasted", "let xs: (boolean | integer)[] = [true]\nxs += [1]\nexit\n"],
  [
    "nested-3-0/pasted",
    "let xs: (boolean | integer)[][] = [[true]]\nlet both = xs + [[1]]\nexit\n",
  ],
  [
    "parameter-3-1/pasted",
    "function f(xs: (boolean | number)[] = [true]) { return xs + [1.5] }\nsay f().length\nexit\n",
  ],
  ["values-3-1/pasted", "let both: (boolean | number)[] = [true] + [1.5]\nexit\n"],
  ["right-3-1/pasted", "let ys: (boolean | number)[] = [1.5]\nlet both = [true] + ys\nexit\n"],
  ["compound-3-1/pasted", "let xs: (boolean | number)[] = [true]\nxs += [1.5]\nexit\n"],
  [
    "nested-3-1/pasted",
    "let xs: (boolean | number)[][] = [[true]]\nlet both = xs + [[1.5]]\nexit\n",
  ],
  [
    "parameter-3-2/pasted",
    'function f(xs: (boolean | string)[] = [true]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-3-2/pasted", 'let both: (boolean | string)[] = [true] + ["x"]\nexit\n'],
  ["right-3-2/pasted", 'let ys: (boolean | string)[] = ["x"]\nlet both = [true] + ys\nexit\n'],
  ["compound-3-2/pasted", 'let xs: (boolean | string)[] = [true]\nxs += ["x"]\nexit\n'],
  [
    "nested-3-2/pasted",
    'let xs: (boolean | string)[][] = [[true]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "parameter-3-4/pasted",
    "function f(xs: (boolean | object)[] = [true]) { return xs + [{n: 1}] }\nsay f().length\nexit\n",
  ],
  ["values-3-4/pasted", "let both: (boolean | object)[] = [true] + [{n: 1}]\nexit\n"],
  ["right-3-4/pasted", "let ys: (boolean | object)[] = [{n: 1}]\nlet both = [true] + ys\nexit\n"],
  ["compound-3-4/pasted", "let xs: (boolean | object)[] = [true]\nxs += [{n: 1}]\nexit\n"],
  [
    "nested-3-4/pasted",
    "let xs: (boolean | object)[][] = [[true]]\nlet both = xs + [[{n: 1}]]\nexit\n",
  ],
  [
    "parameter-3-5/pasted",
    "function f(xs: (boolean | integer | null)[] = [true]) { return xs + [1, null] }\nsay f().length\nexit\n",
  ],
  ["values-3-5/pasted", "let both: (boolean | integer | null)[] = [true] + [1, null]\nexit\n"],
  [
    "right-3-5/pasted",
    "let ys: (boolean | integer | null)[] = [1, null]\nlet both = [true] + ys\nexit\n",
  ],
  ["compound-3-5/pasted", "let xs: (boolean | integer | null)[] = [true]\nxs += [1, null]\nexit\n"],
  [
    "nested-3-5/pasted",
    "let xs: (boolean | integer | null)[][] = [[true]]\nlet both = xs + [[1, null]]\nexit\n",
  ],
  [
    "parameter-3-6/pasted",
    "function f(xs: (boolean | number | null)[] = [true]) { return xs + [null, 2.5] }\nsay f().length\nexit\n",
  ],
  ["values-3-6/pasted", "let both: (boolean | number | null)[] = [true] + [null, 2.5]\nexit\n"],
  [
    "right-3-6/pasted",
    "let ys: (boolean | number | null)[] = [null, 2.5]\nlet both = [true] + ys\nexit\n",
  ],
  [
    "compound-3-6/pasted",
    "let xs: (boolean | number | null)[] = [true]\nxs += [null, 2.5]\nexit\n",
  ],
  [
    "nested-3-6/pasted",
    "let xs: (boolean | number | null)[][] = [[true]]\nlet both = xs + [[null, 2.5]]\nexit\n",
  ],
  [
    "parameter-3-7/pasted",
    'function f(xs: (boolean | string | null)[] = [true]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-3-7/pasted", 'let both: (boolean | string | null)[] = [true] + ["x", null]\nexit\n'],
  [
    "right-3-7/pasted",
    'let ys: (boolean | string | null)[] = ["x", null]\nlet both = [true] + ys\nexit\n',
  ],
  [
    "compound-3-7/pasted",
    'let xs: (boolean | string | null)[] = [true]\nxs += ["x", null]\nexit\n',
  ],
  [
    "nested-3-7/pasted",
    'let xs: (boolean | string | null)[][] = [[true]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-4-0/pasted",
    "function f(xs: (object | integer)[] = [{n: 1}]) { return xs + [1] }\nsay f().length\nexit\n",
  ],
  ["values-4-0/pasted", "let both: (object | integer)[] = [{n: 1}] + [1]\nexit\n"],
  ["right-4-0/pasted", "let ys: (object | integer)[] = [1]\nlet both = [{n: 1}] + ys\nexit\n"],
  ["compound-4-0/pasted", "let xs: (object | integer)[] = [{n: 1}]\nxs += [1]\nexit\n"],
  [
    "nested-4-0/pasted",
    "let xs: (object | integer)[][] = [[{n: 1}]]\nlet both = xs + [[1]]\nexit\n",
  ],
  [
    "parameter-4-1/pasted",
    "function f(xs: (object | number)[] = [{n: 1}]) { return xs + [1.5] }\nsay f().length\nexit\n",
  ],
  ["values-4-1/pasted", "let both: (object | number)[] = [{n: 1}] + [1.5]\nexit\n"],
  ["right-4-1/pasted", "let ys: (object | number)[] = [1.5]\nlet both = [{n: 1}] + ys\nexit\n"],
  ["compound-4-1/pasted", "let xs: (object | number)[] = [{n: 1}]\nxs += [1.5]\nexit\n"],
  [
    "nested-4-1/pasted",
    "let xs: (object | number)[][] = [[{n: 1}]]\nlet both = xs + [[1.5]]\nexit\n",
  ],
  [
    "parameter-4-2/pasted",
    'function f(xs: (object | string)[] = [{n: 1}]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-4-2/pasted", 'let both: (object | string)[] = [{n: 1}] + ["x"]\nexit\n'],
  ["right-4-2/pasted", 'let ys: (object | string)[] = ["x"]\nlet both = [{n: 1}] + ys\nexit\n'],
  ["compound-4-2/pasted", 'let xs: (object | string)[] = [{n: 1}]\nxs += ["x"]\nexit\n'],
  [
    "nested-4-2/pasted",
    'let xs: (object | string)[][] = [[{n: 1}]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "parameter-4-3/pasted",
    "function f(xs: (object | boolean)[] = [{n: 1}]) { return xs + [true] }\nsay f().length\nexit\n",
  ],
  ["values-4-3/pasted", "let both: (object | boolean)[] = [{n: 1}] + [true]\nexit\n"],
  ["right-4-3/pasted", "let ys: (object | boolean)[] = [true]\nlet both = [{n: 1}] + ys\nexit\n"],
  ["compound-4-3/pasted", "let xs: (object | boolean)[] = [{n: 1}]\nxs += [true]\nexit\n"],
  [
    "nested-4-3/pasted",
    "let xs: (object | boolean)[][] = [[{n: 1}]]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "parameter-4-5/pasted",
    "function f(xs: (object | integer | null)[] = [{n: 1}]) { return xs + [1, null] }\nsay f().length\nexit\n",
  ],
  ["values-4-5/pasted", "let both: (object | integer | null)[] = [{n: 1}] + [1, null]\nexit\n"],
  [
    "right-4-5/pasted",
    "let ys: (object | integer | null)[] = [1, null]\nlet both = [{n: 1}] + ys\nexit\n",
  ],
  [
    "compound-4-5/pasted",
    "let xs: (object | integer | null)[] = [{n: 1}]\nxs += [1, null]\nexit\n",
  ],
  [
    "nested-4-5/pasted",
    "let xs: (object | integer | null)[][] = [[{n: 1}]]\nlet both = xs + [[1, null]]\nexit\n",
  ],
  [
    "parameter-4-6/pasted",
    "function f(xs: (object | number | null)[] = [{n: 1}]) { return xs + [null, 2.5] }\nsay f().length\nexit\n",
  ],
  ["values-4-6/pasted", "let both: (object | number | null)[] = [{n: 1}] + [null, 2.5]\nexit\n"],
  [
    "right-4-6/pasted",
    "let ys: (object | number | null)[] = [null, 2.5]\nlet both = [{n: 1}] + ys\nexit\n",
  ],
  [
    "compound-4-6/pasted",
    "let xs: (object | number | null)[] = [{n: 1}]\nxs += [null, 2.5]\nexit\n",
  ],
  [
    "nested-4-6/pasted",
    "let xs: (object | number | null)[][] = [[{n: 1}]]\nlet both = xs + [[null, 2.5]]\nexit\n",
  ],
  [
    "parameter-4-7/pasted",
    'function f(xs: (object | string | null)[] = [{n: 1}]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-4-7/pasted", 'let both: (object | string | null)[] = [{n: 1}] + ["x", null]\nexit\n'],
  [
    "right-4-7/pasted",
    'let ys: (object | string | null)[] = ["x", null]\nlet both = [{n: 1}] + ys\nexit\n',
  ],
  [
    "compound-4-7/pasted",
    'let xs: (object | string | null)[] = [{n: 1}]\nxs += ["x", null]\nexit\n',
  ],
  [
    "nested-4-7/pasted",
    'let xs: (object | string | null)[][] = [[{n: 1}]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-5-2/pasted",
    'function f(xs: (integer | string | null)[] = [1, null]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-5-2/pasted", 'let both: (integer | string | null)[] = [1, null] + ["x"]\nexit\n'],
  [
    "right-5-2/pasted",
    'let ys: (integer | string | null)[] = ["x"]\nlet both = [1, null] + ys\nexit\n',
  ],
  ["compound-5-2/pasted", 'let xs: (integer | string | null)[] = [1, null]\nxs += ["x"]\nexit\n'],
  [
    "nested-5-2/pasted",
    'let xs: (integer | string | null)[][] = [[1, null]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "parameter-5-3/pasted",
    "function f(xs: (integer | boolean | null)[] = [1, null]) { return xs + [true] }\nsay f().length\nexit\n",
  ],
  ["values-5-3/pasted", "let both: (integer | boolean | null)[] = [1, null] + [true]\nexit\n"],
  [
    "right-5-3/pasted",
    "let ys: (integer | boolean | null)[] = [true]\nlet both = [1, null] + ys\nexit\n",
  ],
  ["compound-5-3/pasted", "let xs: (integer | boolean | null)[] = [1, null]\nxs += [true]\nexit\n"],
  [
    "nested-5-3/pasted",
    "let xs: (integer | boolean | null)[][] = [[1, null]]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "parameter-5-4/pasted",
    "function f(xs: (integer | object | null)[] = [1, null]) { return xs + [{n: 1}] }\nsay f().length\nexit\n",
  ],
  ["values-5-4/pasted", "let both: (integer | object | null)[] = [1, null] + [{n: 1}]\nexit\n"],
  [
    "right-5-4/pasted",
    "let ys: (integer | object | null)[] = [{n: 1}]\nlet both = [1, null] + ys\nexit\n",
  ],
  [
    "compound-5-4/pasted",
    "let xs: (integer | object | null)[] = [1, null]\nxs += [{n: 1}]\nexit\n",
  ],
  [
    "nested-5-4/pasted",
    "let xs: (integer | object | null)[][] = [[1, null]]\nlet both = xs + [[{n: 1}]]\nexit\n",
  ],
  [
    "parameter-5-7/pasted",
    'function f(xs: (integer | string | null)[] = [1, null]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-5-7/pasted", 'let both: (integer | string | null)[] = [1, null] + ["x", null]\nexit\n'],
  [
    "right-5-7/pasted",
    'let ys: (integer | string | null)[] = ["x", null]\nlet both = [1, null] + ys\nexit\n',
  ],
  [
    "compound-5-7/pasted",
    'let xs: (integer | string | null)[] = [1, null]\nxs += ["x", null]\nexit\n',
  ],
  [
    "nested-5-7/pasted",
    'let xs: (integer | string | null)[][] = [[1, null]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-6-2/pasted",
    'function f(xs: (number | string | null)[] = [null, 2.5]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  ["values-6-2/pasted", 'let both: (number | string | null)[] = [null, 2.5] + ["x"]\nexit\n'],
  [
    "right-6-2/pasted",
    'let ys: (number | string | null)[] = ["x"]\nlet both = [null, 2.5] + ys\nexit\n',
  ],
  ["compound-6-2/pasted", 'let xs: (number | string | null)[] = [null, 2.5]\nxs += ["x"]\nexit\n'],
  [
    "nested-6-2/pasted",
    'let xs: (number | string | null)[][] = [[null, 2.5]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "parameter-6-3/pasted",
    "function f(xs: (number | boolean | null)[] = [null, 2.5]) { return xs + [true] }\nsay f().length\nexit\n",
  ],
  ["values-6-3/pasted", "let both: (number | boolean | null)[] = [null, 2.5] + [true]\nexit\n"],
  [
    "right-6-3/pasted",
    "let ys: (number | boolean | null)[] = [true]\nlet both = [null, 2.5] + ys\nexit\n",
  ],
  [
    "compound-6-3/pasted",
    "let xs: (number | boolean | null)[] = [null, 2.5]\nxs += [true]\nexit\n",
  ],
  [
    "nested-6-3/pasted",
    "let xs: (number | boolean | null)[][] = [[null, 2.5]]\nlet both = xs + [[true]]\nexit\n",
  ],
  [
    "parameter-6-4/pasted",
    "function f(xs: (number | object | null)[] = [null, 2.5]) { return xs + [{n: 1}] }\nsay f().length\nexit\n",
  ],
  ["values-6-4/pasted", "let both: (number | object | null)[] = [null, 2.5] + [{n: 1}]\nexit\n"],
  [
    "right-6-4/pasted",
    "let ys: (number | object | null)[] = [{n: 1}]\nlet both = [null, 2.5] + ys\nexit\n",
  ],
  [
    "compound-6-4/pasted",
    "let xs: (number | object | null)[] = [null, 2.5]\nxs += [{n: 1}]\nexit\n",
  ],
  [
    "nested-6-4/pasted",
    "let xs: (number | object | null)[][] = [[null, 2.5]]\nlet both = xs + [[{n: 1}]]\nexit\n",
  ],
  [
    "parameter-6-7/pasted",
    'function f(xs: (number | string | null)[] = [null, 2.5]) { return xs + ["x", null] }\nsay f().length\nexit\n',
  ],
  ["values-6-7/pasted", 'let both: (number | string | null)[] = [null, 2.5] + ["x", null]\nexit\n'],
  [
    "right-6-7/pasted",
    'let ys: (number | string | null)[] = ["x", null]\nlet both = [null, 2.5] + ys\nexit\n',
  ],
  [
    "compound-6-7/pasted",
    'let xs: (number | string | null)[] = [null, 2.5]\nxs += ["x", null]\nexit\n',
  ],
  [
    "nested-6-7/pasted",
    'let xs: (number | string | null)[][] = [[null, 2.5]]\nlet both = xs + [["x", null]]\nexit\n',
  ],
  [
    "parameter-7-0/pasted",
    'function f(xs: (string | integer | null)[] = ["x", null]) { return xs + [1] }\nsay f().length\nexit\n',
  ],
  ["values-7-0/pasted", 'let both: (string | integer | null)[] = ["x", null] + [1]\nexit\n'],
  [
    "right-7-0/pasted",
    'let ys: (string | integer | null)[] = [1]\nlet both = ["x", null] + ys\nexit\n',
  ],
  ["compound-7-0/pasted", 'let xs: (string | integer | null)[] = ["x", null]\nxs += [1]\nexit\n'],
  [
    "nested-7-0/pasted",
    'let xs: (string | integer | null)[][] = [["x", null]]\nlet both = xs + [[1]]\nexit\n',
  ],
  [
    "parameter-7-1/pasted",
    'function f(xs: (string | number | null)[] = ["x", null]) { return xs + [1.5] }\nsay f().length\nexit\n',
  ],
  ["values-7-1/pasted", 'let both: (string | number | null)[] = ["x", null] + [1.5]\nexit\n'],
  [
    "right-7-1/pasted",
    'let ys: (string | number | null)[] = [1.5]\nlet both = ["x", null] + ys\nexit\n',
  ],
  ["compound-7-1/pasted", 'let xs: (string | number | null)[] = ["x", null]\nxs += [1.5]\nexit\n'],
  [
    "nested-7-1/pasted",
    'let xs: (string | number | null)[][] = [["x", null]]\nlet both = xs + [[1.5]]\nexit\n',
  ],
  [
    "parameter-7-3/pasted",
    'function f(xs: (string | boolean | null)[] = ["x", null]) { return xs + [true] }\nsay f().length\nexit\n',
  ],
  ["values-7-3/pasted", 'let both: (string | boolean | null)[] = ["x", null] + [true]\nexit\n'],
  [
    "right-7-3/pasted",
    'let ys: (string | boolean | null)[] = [true]\nlet both = ["x", null] + ys\nexit\n',
  ],
  [
    "compound-7-3/pasted",
    'let xs: (string | boolean | null)[] = ["x", null]\nxs += [true]\nexit\n',
  ],
  [
    "nested-7-3/pasted",
    'let xs: (string | boolean | null)[][] = [["x", null]]\nlet both = xs + [[true]]\nexit\n',
  ],
  [
    "parameter-7-4/pasted",
    'function f(xs: (string | object | null)[] = ["x", null]) { return xs + [{n: 1}] }\nsay f().length\nexit\n',
  ],
  ["values-7-4/pasted", 'let both: (string | object | null)[] = ["x", null] + [{n: 1}]\nexit\n'],
  [
    "right-7-4/pasted",
    'let ys: (string | object | null)[] = [{n: 1}]\nlet both = ["x", null] + ys\nexit\n',
  ],
  [
    "compound-7-4/pasted",
    'let xs: (string | object | null)[] = ["x", null]\nxs += [{n: 1}]\nexit\n',
  ],
  [
    "nested-7-4/pasted",
    'let xs: (string | object | null)[][] = [["x", null]]\nlet both = xs + [[{n: 1}]]\nexit\n',
  ],
  [
    "parameter-7-5/pasted",
    'function f(xs: (string | integer | null)[] = ["x", null]) { return xs + [1, null] }\nsay f().length\nexit\n',
  ],
  ["values-7-5/pasted", 'let both: (string | integer | null)[] = ["x", null] + [1, null]\nexit\n'],
  [
    "right-7-5/pasted",
    'let ys: (string | integer | null)[] = [1, null]\nlet both = ["x", null] + ys\nexit\n',
  ],
  [
    "compound-7-5/pasted",
    'let xs: (string | integer | null)[] = ["x", null]\nxs += [1, null]\nexit\n',
  ],
  [
    "nested-7-5/pasted",
    'let xs: (string | integer | null)[][] = [["x", null]]\nlet both = xs + [[1, null]]\nexit\n',
  ],
  [
    "parameter-7-6/pasted",
    'function f(xs: (string | number | null)[] = ["x", null]) { return xs + [null, 2.5] }\nsay f().length\nexit\n',
  ],
  ["values-7-6/pasted", 'let both: (string | number | null)[] = ["x", null] + [null, 2.5]\nexit\n'],
  [
    "right-7-6/pasted",
    'let ys: (string | number | null)[] = [null, 2.5]\nlet both = ["x", null] + ys\nexit\n',
  ],
  [
    "compound-7-6/pasted",
    'let xs: (string | number | null)[] = ["x", null]\nxs += [null, 2.5]\nexit\n',
  ],
  [
    "nested-7-6/pasted",
    'let xs: (string | number | null)[][] = [["x", null]]\nlet both = xs + [[null, 2.5]]\nexit\n',
  ],
  [
    "outer-left-null/pasted",
    'let xs: ((integer | string)[]?)[] = [[1], null]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "outer-left-null-values/pasted",
    'let both: ((integer | string)[]?)[] = [[1], null] + [["x"]]\nexit\n',
  ],
  [
    "outer-left-null-param/pasted",
    'function f(xs: ((integer | string)[]?)[] = [[1], null]) { return xs + [["x"]] }\nsay f().length\nexit\n',
  ],
  [
    "outer-left-null-compound/pasted",
    'let xs: ((integer | string)[]?)[] = [[1], null]\nxs += [["x"]]\nexit\n',
  ],
  [
    "outer-right-null/pasted",
    'let xs: ((integer | string)[]?)[] = [[1]]\nlet both = xs + [["x"], null]\nexit\n',
  ],
  [
    "outer-right-null-values/pasted",
    'let both: ((integer | string)[]?)[] = [[1]] + [["x"], null]\nexit\n',
  ],
  [
    "outer-right-null-param/pasted",
    'function f(xs: ((integer | string)[]?)[] = [[1]]) { return xs + [["x"], null] }\nsay f().length\nexit\n',
  ],
  [
    "outer-right-null-compound/pasted",
    'let xs: ((integer | string)[]?)[] = [[1]]\nxs += [["x"], null]\nexit\n',
  ],
  [
    "both-levels-null/pasted",
    'let xs: ((integer | string | null)[]?)[] = [[1, null], null]\nlet both = xs + [["x", null], null]\nexit\n',
  ],
  [
    "both-levels-null-values/pasted",
    'let both: ((integer | string | null)[]?)[] = [[1, null], null] + [["x", null], null]\nexit\n',
  ],
  [
    "both-levels-null-param/pasted",
    'function f(xs: ((integer | string | null)[]?)[] = [[1, null], null]) { return xs + [["x", null], null] }\nsay f().length\nexit\n',
  ],
  [
    "both-levels-null-compound/pasted",
    'let xs: ((integer | string | null)[]?)[] = [[1, null], null]\nxs += [["x", null], null]\nexit\n',
  ],
  [
    "deep-middle-null/pasted",
    'let xs: ((integer | string)[]?)[][] = [[[1], null]]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "deep-middle-null-values/pasted",
    'let both: ((integer | string)[]?)[][] = [[[1], null]] + [[["x"]]]\nexit\n',
  ],
  [
    "deep-middle-null-param/pasted",
    'function f(xs: ((integer | string)[]?)[][] = [[[1], null]]) { return xs + [[["x"]]] }\nsay f().length\nexit\n',
  ],
  [
    "deep-middle-null-compound/pasted",
    'let xs: ((integer | string)[]?)[][] = [[[1], null]]\nxs += [[["x"]]]\nexit\n',
  ],
  [
    "deep-outer-null/pasted",
    'let xs: ((integer | string)[][]?)[] = [[[1]], null]\nlet both = xs + [[["x"]]]\nexit\n',
  ],
  [
    "deep-outer-null-values/pasted",
    'let both: ((integer | string)[][]?)[] = [[[1]], null] + [[["x"]]]\nexit\n',
  ],
  [
    "deep-outer-null-param/pasted",
    'function f(xs: ((integer | string)[][]?)[] = [[[1]], null]) { return xs + [[["x"]]] }\nsay f().length\nexit\n',
  ],
  [
    "deep-outer-null-compound/pasted",
    'let xs: ((integer | string)[][]?)[] = [[[1]], null]\nxs += [[["x"]]]\nexit\n',
  ],
  [
    "deep-every-null/pasted",
    'let xs: (((integer | string | null)[]?)[]?)[] = [[[1, null], null], null]\nlet both = xs + [[["x", null], null], null]\nexit\n',
  ],
  [
    "deep-every-null-values/pasted",
    'let both: (((integer | string | null)[]?)[]?)[] = [[[1, null], null], null] + [[["x", null], null], null]\nexit\n',
  ],
  [
    "deep-every-null-param/pasted",
    'function f(xs: (((integer | string | null)[]?)[]?)[] = [[[1, null], null], null]) { return xs + [[["x", null], null], null] }\nsay f().length\nexit\n',
  ],
  [
    "deep-every-null-compound/pasted",
    'let xs: (((integer | string | null)[]?)[]?)[] = [[[1, null], null], null]\nxs += [[["x", null], null], null]\nexit\n',
  ],
  [
    "external-number/pasted",
    'let xs: (number | duration | calendarDuration | angle | string)[] = [1, hostValue / 2]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "external-number-values/pasted",
    'let both: (number | string | duration | calendarDuration | angle)[] = [1, hostValue / 2] + ["x"]\nexit\n',
  ],
  [
    "external-number-param/pasted",
    'function f(xs: (number | duration | calendarDuration | angle | string)[] = [1, hostValue / 2]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  [
    "external-number-compound/pasted",
    'let xs: (number | string)[] = [1, hostValue / 2]\nxs += ["x"]\nexit\n',
  ],
  [
    "external-number-right/pasted",
    'let xs: (string | number)[] = ["x"]\nlet both = xs + [1, hostValue / 2]\nexit\n',
  ],
  [
    "external-number-right-values/pasted",
    'let both: (string | number)[] = ["x"] + [1, hostValue / 2]\nexit\n',
  ],
  [
    "external-number-right-param/pasted",
    'function f(xs: (string | number)[] = ["x"]) { return xs + [1, hostValue / 2] }\nsay f().length\nexit\n',
  ],
  [
    "external-number-right-compound/pasted",
    'let xs: (string | number)[] = ["x"]\nxs += [1, hostValue / 2]\nexit\n',
  ],
  [
    "external-number-null/pasted",
    'let xs: (number | duration | calendarDuration | angle | string | null)[] = [1, null, hostValue / 2]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "external-number-null-values/pasted",
    'let both: (number | string | duration | calendarDuration | angle | null)[] = [1, null, hostValue / 2] + ["x"]\nexit\n',
  ],
  [
    "external-number-null-param/pasted",
    'function f(xs: (number | duration | calendarDuration | angle | string | null)[] = [1, null, hostValue / 2]) { return xs + ["x"] }\nsay f().length\nexit\n',
  ],
  [
    "external-number-null-compound/pasted",
    'let xs: (number | string | null)[] = [1, null, hostValue / 2]\nxs += ["x"]\nexit\n',
  ],
  [
    "external-number-nested/pasted",
    'let xs: (number | duration | calendarDuration | angle | string)[][] = [[1, hostValue / 2]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "external-number-nested-values/pasted",
    'let both: (number | string | duration | calendarDuration | angle)[][] = [[1, hostValue / 2]] + [["x"]]\nexit\n',
  ],
  [
    "external-number-nested-param/pasted",
    'function f(xs: (number | duration | calendarDuration | angle | string)[][] = [[1, hostValue / 2]]) { return xs + [["x"]] }\nsay f().length\nexit\n',
  ],
  [
    "external-number-nested-compound/pasted",
    'let xs: (number | string)[][] = [[1, hostValue / 2]]\nxs += [["x"]]\nexit\n',
  ],
  [
    "written-null/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "written-outer-null/pasted",
    'let xs: ((integer | string)[]?)[] = [[1]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-both-null/pasted",
    'let xs: ((integer | string | null)[]?)[] = [[1]]\nlet both = xs + [["x"]]\nexit\n',
  ],
  [
    "written-copied-null/pasted",
    'let source: integer?[] = [1]\nlet xs: (integer | string | null)[] = source\nlet both = xs + ["x"]\nexit\n',
  ],
  [
    "later-null/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + ["x"] + [null]\nexit\n',
  ],
  [
    "earlier-null/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = [null] + xs + ["x"]\nexit\n',
  ],
  [
    "intervening-null/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + [null] + ["x"]\nexit\n',
  ],
  [
    "later-third-type/pasted",
    'let xs: (integer | string | boolean)[] = [1]\nlet both = xs + ["x"] + [true]\nexit\n',
  ],
  [
    "right-tree-later-null/pasted",
    'let xs: (integer | string | null)[] = [1]\nlet both = xs + (["x"] + [null])\nexit\n',
  ],
  [
    "written-null-first-right/pasted",
    'let ys: (integer | string | null)[] = ["x"]\nlet both = [1] + ys\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node paste.mjs <tree>",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r3.sh:28",
    ],
  ],
  sources: 631,
  sha256: "f549e43f2107364be41fe6bddced4e0c0b4bbbd862e86238968562a1873b4ad1",
};
