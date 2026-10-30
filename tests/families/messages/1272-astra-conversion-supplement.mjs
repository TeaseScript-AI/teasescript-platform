// original conversion and operand supplements; #1272, astra-m4-i1272-review, archived Python/shell evidence, round
// unrecorded (R/astra-m4-i1272-review/make-supplement.py).
export const cases = (() => {
  let annotation, before, cases, decl, expr, init, label, name, place, suffix, value;
  cases = [];
  function add(name, source, hosts = ["bad", 2]) {
    cases.push({ name: name, source: source + "\n" });
  }
  for (init of ['["a"]', "[3]"]) {
    for ([suffix, expr] of [
      ["flat", '[1] + typed + ["b"]'],
      ["right", '[1] + (typed + ["b"])'],
      ["left", '([1] + typed) + ["b"]'],
      ["swap", '["b"] + typed + [1]'],
      ["last", '[1] + ["b"] + typed'],
      ["start", 'typed + [1] + ["b"]'],
      ["two", "[1] + typed"],
    ]) {
      add(
        "union-" + init + "-" + suffix,
        `let typed: (integer | string)[] = ${init}
let result = ${expr}
say result.join(",")
exit`,
      );
    }
    add(
      "union-" + init + "-copy-inner",
      `let typed: (integer | string)[] = ${init}
let inner = typed + ["b"]
let result = [1] + inner
say result.join(",")
exit`,
    );
    add(
      "union-" + init + "-copy-left",
      `let typed: (integer | string)[] = ${init}
let inner = [1] + typed
let result = inner + ["b"]
say result.join(",")
exit`,
    );
  }
  for ([label, before, expr] of [
    ["result", 'function typed: (integer | string)[] { return ["a"] }', '[1] + (typed() + ["b"])'],
    ["nested", 'let typed: (integer | string)[][] = [["a"]]', '[[1]] + (typed + [["b"]])'],
    ["boolean", 'let typed: (boolean | string)[] = ["a"]', '[false] + (typed + ["b"])'],
    ["written-destination", 'let typed: (integer | string)[] = ["a"]', '[1] + (typed + ["b"])'],
  ]) {
    annotation = label === "written-destination" ? ": (integer | string)[]" : "";
    add(
      "union-" + label,
      `${before}
let result${annotation} = ${expr}
say result.length
exit`,
    );
  }
  add("external-pr-exact", 'let xs = [1, hostValue / 2]\nlet both = xs + ["x"]\nexit', [3]);
  add(
    "external-narrowed",
    'if hostValue is number {\nlet xs = [1, hostValue / 2]\nlet both = xs + ["x"]\nsay both.length\n}\nexit',
    [3],
  );
  add(
    "parameter-fixed",
    'function change(arg) { arg.first.n = "bad" }\nlet box = {first:{n:1}}\nchange(box)\nsay box.first.n\nexit',
  );
  for (name of ["first", "last", "random"]) {
    for (value of ['"bad"', "hostValue", "2.5", "null"]) {
      add(
        `method-${name}-${value}`,
        `let box = {${name}:{items:[1]}}
say "BEFORE"
box.${name}.items.add(${value})
say box.${name}.items.length
say "AFTER"
exit`,
      );
      add(
        `compound-${name}-${value}`,
        `let box = {${name}:{n:1}}
say "BEFORE"
box.${name}.n += ${value}
say box.${name}.n
say "AFTER"
exit`,
      );
    }
  }
  for ([name, decl, place] of [
    ["list-first", "let boxes = [{n:1}]", "boxes.first.n"],
    ["set-first", "let boxes = set([{n:1}])", "boxes.first.n"],
    ["dict-own", "let boxes = {a:{first:{n:1}}}", "boxes.a.first.n"],
  ]) {
    add(
      name + "-literal",
      `${decl}
${place} = "bad"
exit`,
    );
  }

  return cases.map((c) => [c.name, c.source]);
})();
export const checks = ["publication"];

for (const index of [50]) cases.splice(index, 1);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node review.mjs supplement",
      "R/astra-m4-i1272-review/supplement-results.jsonl:1 (its result's header)",
    ],
  ],
  sources: 52,
  sha256: "56e4f845312a0f76fec4589de8a9a88357229885c5abd511148f7304d4f1dd43",
  dropped: [
    [
      "92953bb45f721c4d1d62d2c7f5a0e81747137384d040cc3f523ba0b77772ae07",
      "Incidental obsolete/invalid set(...) construction. The origin tests a literal store below a set selection, not TSP017 parsing; accepted set literals use set[...]. (R/astra-m4-i1272-review/make-supplement.py:35-39)",
    ],
  ],
};
