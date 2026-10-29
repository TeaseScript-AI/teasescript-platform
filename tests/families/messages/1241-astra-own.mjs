// #1241; Astra review.
export const cases = (() => {
  const cases = [];
  const add = (name, setup, pattern, expression) => {
    const [left, right] = pattern.split("@");
    const prefix = setup + "\n" + left;
    cases.push({
      name,
      source: prefix + expression + right + "\nexit\n",
      start: prefix.length,
      end: prefix.length + expression.length,
    });
  };
  for (const [name, setup, expr] of [
    ["objects", 'let bag = [{s: "one"}]', "bag.join"],
    ["dicts", 'let bag = [dict{s: "one"}]', "bag.join"],
    ["nested-list", "let bag = [[1]]", "bag.join"],
    ["nested-owner", 'let box = {bag: [{s: "one"}]}', "box.bag.join"],
    ["cleared-text", 'let bag = ["one"]\nbag.clear()', "bag.join"],
    ["cleared-object", 'let bag = [{s: "one"}]\nbag.clear()', "bag.join"],
    ["numeric-union", "let bag = [1, 1.5]", "bag.join"],
    ["nullable-text", 'let bag = ["a", null]', "bag.join"],
  ])
    add(name, setup, "say @", expr);
  for (const site of [
    "say @",
    "let n: integer = @",
    "let text: string = @",
    "let xs: integer[] = @",
    "say -(@ + 2)",
    "let result: string = -(@ + 2)",
    'say "answer=${@ + 2}"',
    "say (@ + 2) * 3",
    "say [@][0]",
    "say (@).trim()",
    "wait @",
    'repeat @ { say "once" }',
    "let x = @\nsay x.trim()",
    "function take(p) {\n return p.trim()\n}\nsay take(@)",
    'say @ otherwise "empty"',
  ])
    add("size:" + site, 'let txt = "a"', site, "txt.size");
  for (const site of [
    "say @",
    "say (@).length",
    'say "${@}"',
    "let xs: string[] = @",
    "say (@).trim().length",
  ])
    add("trim:" + site, 'let txt = " a "', site, "txt.trim");
  for (const [name, setup, expr] of [
    ["missing-key", 'let d = dict{found: " a "}', 'd["absent"].trim'],
    ["present-key", 'let d = dict{found: " a "}', 'd["found"].trim'],
    ["missing-key-list", "let d = dict{found: [1]}", 'd["absent"] + 2'],
    ["missing-property", 'let box = {a: "x"}', "box.b.size"],
    ["empty-selected-list", "let bags = [[1]]\nbags.clear()", "bags.first + 2"],
    ["empty-list-index", 'let labels = ["x"]\nlabels.clear()', "labels[0].size"],
  ])
    add(name, setup, "say @", expr);
  for (const site of [
    "say @",
    "let xs: integer[] = @",
    "let xs: string[] = @",
    "let text: string = @",
    "say (@).length",
    "say 1 + (@).length",
  ])
    add("plus:" + site, "let bag = [2]", site, "bag + (4..6)");
  for (const [type, expr] of [
    ["duration", "-2"],
    ["angle", "1 + 2"],
    ["date", '"2028-03-10"'],
    ["date", '"bad"'],
    ["time", '"18:30"'],
    ["datetime", '"2028-03-10T18:30"'],
  ])
    add("convert:" + type + expr, "", `let v: ${type} = @\nsay v`, expr);
  for (const site of [
    "say @",
    "say -@",
    "say 2 / @",
    "say 2 % (@ + 1)",
    "say 2 / [@][0]",
    "say 2 / ({n: @}).n",
    'say 2 / toInteger("${@}", default: 2)',
    'function parseIt(input: string) { say toInteger(input, default: @) }\nparseIt("bad")',
    'function parseIt(input: string) { say 2 / toInteger(input, default: @) }\nparseIt("bad")',
    "function take(p) { say p }\ntake(@)",
    "say (@ is integer)",
    "let n = @\nsay n",
  ])
    add("null:" + site, 'let labels = ["a", null]', site, "labels[1].length");
  add("otherwise-is", "let flags = [true, null]", "say (@ and true) is boolean", "flags[1]");
  for (const key of ["absent", "found"]) {
    for (const expression of [
      `d["${key}"] + 2`,
      `2 + d["${key}"]`,
      `d["${key}"] + (2..3)`,
      `(2..3) + d["${key}"]`,
    ])
      add("dict-list:" + expression, "let d = dict{found: [1]}", "say @", expression);
    for (const type of ["duration", "angle", "string"])
      add(
        "dict-convert:" + key + ":" + type,
        "let d = dict{found: 2}",
        `let v: ${type} = @\nsay v`,
        `d["${key}"]`,
      );
    add(
      "nested-dict-list:" + key,
      "let d = dict{found: {items: [1]}}",
      "say @",
      `d["${key}"].items + 2`,
    );
  }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
