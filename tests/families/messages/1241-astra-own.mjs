const corpus = (() => {
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
  return { cases: cases.map(({ name, source }) => [name, source]) };
})();
export const cases = corpus.cases;

for (const input of [
  [
    "original/1/archived paste/(2..3).toList()",
    'let d = dict{found: [1]}\nsay ((2..3).toList()) + d["found"]\nexit\n',
  ],
  [
    'original/2/archived paste/d["found"] s',
    'let d = dict{found: 2}\nlet v: duration = d["found"] s\nsay v\nexit\n',
  ],
  ["original/3/archived paste/txt.trim()", 'let txt = " a "\nsay (txt.trim()).length\nexit\n'],
  [
    'original/4/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nlet n = (labels[1] otherwise "").length\nsay n\nexit\n',
  ],
  ["original/5/archived paste/txt.trim()", 'let txt = " a "\nsay "${txt.trim()}"\nexit\n'],
  ["original/6/archived paste/bag.join()", "let bag = [1, 1.5]\nsay bag.join()\nexit\n"],
  [
    "original/7/archived paste/(4..6).toList()",
    "let bag = [2]\nsay 1 + (bag + ((4..6).toList())).length\nexit\n",
  ],
  [
    'original/8/archived paste/toDate("2028-03-10")',
    '\nlet v: date = toDate("2028-03-10")\nsay v\nexit\n',
  ],
  [
    'original/9/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nsay (labels[1] otherwise "").length\nexit\n',
  ],
  [
    'original/10/archived paste/d["found"] deg',
    'let d = dict{found: 2}\nlet v: angle = d["found"] deg\nsay v\nexit\n',
  ],
  [
    'original/11/archived paste/d["absent"] s',
    'let d = dict{found: 2}\nlet v: duration = d["absent"] s\nsay v\nexit\n',
  ],
  ["original/12/archived paste/txt.length", 'let txt = "a"\nsay txt.length\nexit\n'],
  [
    "original/13/archived paste/(2..3).toList()",
    'let d = dict{found: [1]}\nsay ((2..3).toList()) + d["absent"]\nexit\n',
  ],
  ["original/14/archived paste/bag.join()", 'let bag = ["a", null]\nsay bag.join()\nexit\n'],
  [
    'original/15/archived paste/d["found"].items + [2]',
    'let d = dict{found: {items: [1]}}\nsay d["found"].items + [2]\nexit\n',
  ],
  [
    'original/16/archived paste/d["found"].items.add(2)',
    'let d = dict{found: {items: [1]}}\nd["found"].items.add(2)\nsay d["found"].items\nexit\n',
  ],
  [
    'original/17/archived paste/d["absent"] deg',
    'let d = dict{found: 2}\nlet v: angle = d["absent"] deg\nsay v\nexit\n',
  ],
  [
    'original/18/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nfunction take(p) { say p }\ntake((labels[1] otherwise "").length)\nexit\n',
  ],
  [
    "original/19/archived paste/bag.join()",
    'let bag = ["one"]\nbag.clear()\nsay bag.join()\nexit\n',
  ],
  [
    "original/20/archived paste/(4..6).toList()",
    "let bag = [2]\nsay bag + ((4..6).toList())\nexit\n",
  ],
  [
    "original/21/archived paste/(2..3).toList()",
    'let d = dict{found: [1]}\nsay d["absent"] + ((2..3).toList())\nexit\n',
  ],
  [
    'original/22/archived paste/d["absent"] + [2]',
    'let d = dict{found: [1]}\nsay d["absent"] + [2]\nexit\n',
  ],
  [
    'original/23/archived paste/d["absent"].add(2)',
    'let d = dict{found: [1]}\nd["absent"].add(2)\nsay d["absent"]\nexit\n',
  ],
  [
    "original/24/archived paste/(2..3).toList()",
    'let d = dict{found: [1]}\nsay d["found"] + ((2..3).toList())\nexit\n',
  ],
  [
    'original/25/archived paste/"${d["found"]}"',
    'let d = dict{found: 2}\nlet v: string = "${d["found"]}"\nsay v\nexit\n',
  ],
  [
    'original/26/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nsay ((labels[1] otherwise "").length is integer)\nexit\n',
  ],
  ["original/27/archived paste/(-2) s", "\nlet v: duration = (-2) s\nsay v\nexit\n"],
  [
    'original/28/archived paste/toDateTime("2028-03-10T18:30")',
    '\nlet v: datetime = toDateTime("2028-03-10T18:30")\nsay v\nexit\n',
  ],
  [
    'original/29/archived paste/d["absent"].items + [2]',
    'let d = dict{found: {items: [1]}}\nsay d["absent"].items + [2]\nexit\n',
  ],
  [
    'original/30/archived paste/d["absent"].items.add(2)',
    'let d = dict{found: {items: [1]}}\nd["absent"].items.add(2)\nsay d["absent"].items\nexit\n',
  ],
  [
    "original/31/archived paste/txt.length",
    'let txt = "a"\nrepeat txt.length { say "once" }\nexit\n',
  ],
  [
    'original/32/archived paste/"${d["absent"]}"',
    'let d = dict{found: 2}\nlet v: string = "${d["absent"]}"\nsay v\nexit\n',
  ],
  ['original/33/archived paste/toTime("18:30")', '\nlet v: time = toTime("18:30")\nsay v\nexit\n'],
  [
    'original/34/archived paste/[2] + d["found"]',
    'let d = dict{found: [1]}\nsay [2] + d["found"]\nexit\n',
  ],
  [
    "original/35/archived paste/txt.length",
    'let txt = "a"\nsay "answer=${txt.length + 2}"\nexit\n',
  ],
  ["original/36/archived paste/txt.length", 'let txt = "a"\nlet n: integer = txt.length\nexit\n'],
  [
    'original/37/archived paste/[2] + d["absent"]',
    'let d = dict{found: [1]}\nsay [2] + d["absent"]\nexit\n',
  ],
  ["original/38/archived paste/txt.trim()", 'let txt = " a "\nsay txt.trim()\nexit\n'],
  [
    "original/39/archived paste/(4..6).toList()",
    "let bag = [2]\nlet xs: integer[] = bag + ((4..6).toList())\nexit\n",
  ],
  [
    "original/40/archived paste/(flags[1] otherwise false)",
    "let flags = [true, null]\nsay ((flags[1] otherwise false) and true) is boolean\nexit\n",
  ],
  [
    'original/41/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nfunction parseIt(input: string) { say toInteger(input, default: (labels[1] otherwise "").length) }\nparseIt("bad")\nexit\n',
  ],
  ["original/42/archived paste/txt.length", 'let txt = "a"\nsay -(txt.length + 2)\nexit\n'],
  [
    'original/43/archived paste/(labels[1] otherwise "")',
    'let labels = ["a", null]\nsay -(labels[1] otherwise "").length\nexit\n',
  ],
  ["original/44/archived paste/(1 + 2) deg", "\nlet v: angle = (1 + 2) deg\nsay v\nexit\n"],
  [
    'original/45/archived paste/d["found"] + [2]',
    'let d = dict{found: [1]}\nsay d["found"] + [2]\nexit\n',
  ],
  [
    'original/46/archived paste/d["found"].add(2)',
    'let d = dict{found: [1]}\nd["found"].add(2)\nsay d["found"]\nexit\n',
  ],
  [
    "original/47/archived paste/(4..6).toList()",
    "let bag = [2]\nsay (bag + ((4..6).toList())).length\nexit\n",
  ],
  ["original/48/archived paste/txt.length", 'let txt = "a"\nsay (txt.length + 2) * 3\nexit\n'],
])
  cases.push(input);

export const checks = ["publication"];
