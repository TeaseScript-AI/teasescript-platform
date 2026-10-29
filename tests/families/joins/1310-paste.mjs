// #1310; builder/review archive.
export const cases = (() => {
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
