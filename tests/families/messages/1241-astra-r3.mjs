// #1241; Astra review.
export const cases = (() => {
  const cases = [];
  const add = (name, setup, expr, line = "say @", expect) => {
    const [left, right] = line.split("@");
    const prefix = setup + "\n" + left;
    cases.push({
      name,
      source: prefix + expr + right + "\nexit\n",
      start: prefix.length,
      end: prefix.length + expr.length,
      expect,
    });
  };
  for (const [name, setup, access, expect] of [
    ["r2", 'let boxes = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = boxes[1]', "box", 0],
    [
      "chain2",
      'let choices = [{inner: {n: 2, text: "alpha", items: [1]}}, null]\nlet box = choices[1]',
      "box.inner",
      0,
    ],
    [
      "chain3",
      'let choices = [{inner: {nested: {n: 2, text: "alpha", items: [1]}}}, null]\nlet box = choices[1]',
      "box.inner.nested",
      0,
    ],
    [
      "inner-null",
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = {inner: choices[1]}',
      "box.inner",
      0,
    ],
    [
      "selection-null",
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]',
      "choices.random",
      0,
    ],
    [
      "selection-empty",
      'let choices = [{n: 2, text: "alpha", items: [1]}]\nchoices.clear()',
      "choices.first",
      0,
    ],
    [
      "present3",
      'let box = {inner: {nested: {n: 2, text: "alpha", items: [1]}}}',
      "box.inner.nested",
      "some",
    ],
    [
      "mutated",
      'let box = {inner: {n: 2, text: "alpha", items: [1]}}\nfunction change() { box.inner = null }\nchange()',
      "box.inner",
      0,
    ],
  ]) {
    add(
      name + ":duration",
      setup,
      access + ".n",
      "let converted: duration = @\nsay converted",
      expect,
    );
    add(name + ":member", setup, access + ".text.size", "say @", expect);
    add(name + ":list", setup, access + ".items + 2", "say @", expect);
    add(
      name + ":interpolation",
      setup,
      '"${' + access + '.n}"',
      "let converted: date = @",
      expect === "some" ? undefined : expect,
    );
  }
  for (const member of ["n", "text.size", "items + 2"])
    add(
      "guard:" + member,
      'let choices = [{n: 2, text: "alpha", items: [1]}, null]\nlet box = choices[0]\nif box != null {',
      "box." + member,
      member === "n" ? "let converted: duration = @\nsay converted\n}" : "say @\n}",
    );
  for (const [name, setup, subject] of [
    ["nested-warning", 'let box = {inner: {values: ["alpha", null]}}', "box.inner.values[1]"],
    ["dict-warning", 'let box = {inner: dict{ok: "alpha", missing: null}}', 'box.inner["missing"]'],
    [
      "ellipsis-warning",
      'let box = {inner: dict{"...": "alpha", missing: null}}',
      'box.inner["..."]',
    ],
  ])
    add(name, setup, subject + ".length", "say @", "some");
  const nullable = "let ns = [2, null]\nlet n = ns[1]";
  for (const [name, expr] of [
    ["binary", "n + 1"],
    ["unary", "-n"],
    ["literal-binary", "({inner: n + 1}).inner"],
    ["interpolated-binary", '"${n + 1}".length'],
    ["nested-binary", "(n + 1) * 2"],
  ])
    add("nullable-operand:" + name, nullable, expr, "let converted: duration = @\nsay converted");
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];
