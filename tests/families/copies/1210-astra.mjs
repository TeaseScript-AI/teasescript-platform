// #1210, Astra review (R/astra-m4-i1210-review-evidence/review.mjs): its correctness cases. Its fixture runs (review.md:79)
// compiled the repository's type-core fixture (`tests/fixtures/type-core/cells.jsonl`; every one of those sources is
// unchanged on `main`), which the corpus does not copy.
export const cases = (() => {
  const cases = [];
  function add(name, text, path, read, extra = {}) {
    let source = "",
      expected = [];
    for (const [i, p] of text.split("^").entries()) {
      if (i) expected.push(`0:${source.length}-${source.length + /^\w+/.exec(p)[0].length}`);
      source += p;
    }
    source += '\nsay "DONE"\nexit\n';
    cases.push({ name, source, path, read, expected: expected.sort(), ...extra });
  }
  add(
    "three-same-index",
    "let bag = [{p: ^hostValue[2]}, {p: ^hostValue[2]}, {p: ^hostValue[2]}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
    { good: [1, 2, 7], bad: [1, 2, "bad"] },
  );
  add(
    "three-property",
    "let bag = [{p: ^hostValue.z}, {p: ^hostValue.z}, {p: ^hostValue.z}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
    { good: { z: 7 }, bad: { z: "bad" } },
  );
  add(
    "nested-index-property",
    "let bag = [[{p: ^hostValue.rows[1].n}], [{p: ^hostValue.rows[1].n}], [{p: ^hostValue.rows[1].n}]]\nlet chosen: integer = bag[1][0].p",
    ["element", "element", "p"],
    "bag[1][0].p",
    { good: { rows: [{ n: 1 }, { n: 7 }] }, bad: { rows: [{ n: 1 }, { n: "bad" }] } },
  );
  add(
    "reverse-fields",
    "let bag = [{p: ^hostValue.right, r: hostValue.left}, {r: hostValue.left, p: ^hostValue.right}, {p: ^hostValue.right, r: hostValue.left}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
  );
  add(
    "two-globals",
    "let bag = [{p: ^hostInit.x}, {p: ^hostValue.x}, {p: ^hostInit.x}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "selected-different-paths",
    "let bag = [{p: ^hostValue.a}, {p: ^hostValue.b}, {p: ^hostValue.a}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "element-key-name",
    "let bag = [{element: {entry: ^hostValue.z}}, {element: {entry: ^hostValue.z}}]\nlet chosen: integer = bag[1].element.entry",
    ["element", "'element", "'entry"],
    "bag[1].element.entry",
  );
  add(
    "record-list-wrapper",
    "let bag = [{p: [^hostValue.z]}, {p: [^hostValue.z]}, {p: [^hostValue.z]}]\nlet chosen: integer = bag[1].p[0]",
    ["element", "p", "element"],
    "bag[1].p[0]",
  );
  add(
    "selected-last",
    "let bag = [{p: ^hostValue.z}, {p: ^hostValue.z}, {p: ^hostValue.z}].last\nlet chosen: integer = bag.p",
    ["p"],
    "bag.p",
    { good: { z: 7 }, bad: { z: "bad" } },
  );
  add(
    "bare-below-member",
    "let bag = [^hostValue.payload, ^hostValue.payload, ^hostValue.payload]\nlet chosen: integer = bag[1].score",
    ["element", "score"],
    "bag[1].score",
    { good: { payload: { score: 7 } }, bad: { payload: { score: "bad" } } },
  );
  add(
    "direct-control",
    "let bag = [{p: ^hostValue}, {p: ^hostValue}, {p: ^hostValue}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
    { good: 7, bad: "bad" },
  );
  add(
    "direct-known-mix",
    "let bag = [{p: ^hostValue.z}, {p: ^hostValue}, {p: 3}, {p: ^hostValue.z}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
  );
  add(
    "named-root-control",
    "let saved = ^hostValue\nlet bag = [{p: saved.z}, {p: saved.z}, {p: saved.z}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "named-projection-control",
    "let saved = ^hostValue.rows[1]\nlet bag = [{p: saved.z}, {p: saved.z}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "guard-at-root",
    "if hostValue is object {\nlet bag = [{p: ^hostValue.z}, {p: ^hostValue.z}, {p: ^hostValue.z}]\nlet chosen: integer = bag[1].p\n}",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "guard-descendant",
    "if hostValue.payload.score is integer {\nlet bag = [{p: ^hostValue.payload}, {p: ^hostValue.payload}]\nlet chosen: integer = bag[1].p.score\n}",
    ["element", "p", "score"],
    "bag[1].p.score",
  );
  add(
    "changed-selected-field",
    "function change {\nhostValue.z = 8\nreturn 8\n}\nlet bag = [{p: ^hostValue.z}, {p: change()}, {p: ^hostValue.z}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
  );
  add(
    "changed-other-field",
    "function change {\nhostValue.other = 8\nreturn 8\n}\nlet bag = [{p: ^hostValue.z}, {p: change()}, {p: ^hostValue.z}]\nlet chosen: integer = bag[2].p",
    ["element", "p"],
    "bag[2].p",
  );
  add(
    "choice-list-wrapper",
    'let bag = askChoice {text: "L", value: {p: [^hostValue.z]}}, {text: "R", value: {p: [^hostValue.z]}}\nlet chosen: integer = bag.p[0]',
    ["p", "element"],
    "bag.p[0]",
  );
  add(
    "added-index",
    "let bag = []\nbag.add(^hostValue[2])\nbag.add(^hostValue[2])\nbag.add(^hostValue[2])\nlet chosen: integer = bag[1]",
    ["element"],
    "bag[1]",
  );
  add(
    "stored-nested-projection",
    "let bag = {p: ^hostValue.rows[0].n}\nbag.p = ^hostValue.rows[0].n\nlet chosen: integer = bag.p",
    ["p"],
    "bag.p",
    { valueExpectedLast: true },
  );
  add(
    "fallback-read",
    "let bag = [^hostValue.a otherwise ^hostValue.b, ^hostValue.a otherwise ^hostValue.b]\nlet chosen: integer = bag[1]",
    ["element"],
    "bag[1]",
  );
  add(
    "deep-path",
    "let bag = [{p: ^hostValue.a.b.c.d.e.f.g.h.i.j.k.l}, {p: ^hostValue.a.b.c.d.e.f.g.h.i.j.k.l}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
  );
  add(
    "copy-aliases",
    "let red = ^hostValue.z\nlet blue = ^hostValue.z\nlet bag = [{p: red}, {p: blue}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
    { followup: true },
  );
  add(
    "copy-records",
    "let red = {p: ^hostValue.z}\nlet blue = {p: ^hostValue.z}\nlet bag = [blue, red]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
    { followup: true },
  );
  add(
    "copy-lists",
    "let red = [^hostValue.z]\nlet blue = [^hostValue.z]\nlet bag = [{p: blue[0]}, {p: red[0]}]\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
    { followup: true },
  );
  add(
    "record-added",
    "let bag = []\nbag.add({p: ^hostValue.z})\nbag.add({p: ^hostValue.z})\nlet chosen: integer = bag[1].p",
    ["element", "p"],
    "bag[1].p",
    { followup: true },
  );
  add(
    "record-replaced",
    "let bag = {p: ^hostValue.z}\nbag = {p: ^hostValue.z}\nlet chosen: integer = bag.p",
    ["p"],
    "bag.p",
    { followup: true, valueExpectedLast: true },
  );
  add(
    "copy-direct",
    "let red = ^hostValue\nlet blue = ^hostValue\nlet bag = [blue, red]\nlet chosen: integer = bag[1].z",
    ["element", "z"],
    "bag[1].z",
    { followup: true },
  );
  add(
    "record-two-functions",
    "global bag = {p: 1}\nfunction red {bag = {p: ^hostValue.z}}\nfunction blue {bag = {p: ^hostValue.z}}\nred()\nblue()\nlet chosen: integer = bag.p",
    ["p"],
    "bag.p",
    { followup: true },
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node review.mjs "$PWD" correctness',
      "R/astra-m4-i1210-review-evidence/astra-m4-i1210-review.md:78",
    ],
  ],
  sources: 30,
  sha256: "df377adf046de2d6dea0fb8093e43801710d51685b57f08ee52013d9ef00115d",
};
