// original subject origins, joins and argument-literal cases; astra-m4-s8d-review-r2-evidence, archived Python/shell
// evidence (R/astra-m4-s8d-review-r2-evidence/make-cases.py).
export const cases = (() => {
  let cases, expr, extra, family, form, literal, name, operand, pre, source, use, want;
  cases = [];
  function add(name, source) {
    cases.push({ name: name, source: source + "\nexit\n" });
  }
  for ([family, literal, extra, use] of [
    ["set", "set[13, 21]", "", (x) => `say "\${${x}}"`],
    [
      "dict",
      "dict{{r: 13, s: 21}}".replaceAll("{{", "{").replaceAll("}}", "}"),
      "",
      (x) => `say "\${${x}}"`,
    ],
    ["object", '{tags: ["skip"], title: "Beacon", count: 13}', "", (x) => `say "\${${x}}"`],
    ["key", "13", 'let lookup = dict{"13": "key"}\n', (x) => `say lookup[${x}]`],
    ["string-conversion", "false", "", (x) => `let caption: string = ${x}`],
    ["number-member", "13", "", (x) => `say (${x}).length`],
    ["duration", "7 s", "", (x) => `say (${x}).seconds`],
    ["absolute", 'toAbsoluteDateTime("2026-03-05T09:00:00Z")', "", (x) => `say (${x}).year`],
  ]) {
    for (form of ["named", "property", "literal", "grouped", "index", "call"]) {
      pre = "let value = set[97]\n" + extra;
      expr = literal;
      if (form === "named") {
        pre += `let subject = ${literal}
`;
        expr = "subject";
      }
      if (form === "property") {
        pre += `let holder = {subject: ${literal}}
`;
        expr = "holder.subject";
      }
      if (form === "grouped") {
        pre += `let subject = ${literal}
`;
        expr = "(subject)";
      }
      if (form === "index") {
        pre += `let holders = [{subject: ${literal}}]
`;
        expr = "holders[0].subject";
      }
      if (form === "call") {
        pre += `function obtain { return ${literal} }
`;
        expr = "obtain()";
      }
      add(`${family}-${form}`, pre + use(expr));
    }
  }
  for ([name, pre, operand, want] of [
    ["sum", "let amount = 8\n", "(amount-3)*2", "10"],
    ["member", "let pouch = {coins: 14}\n", "pouch.coins", "14"],
    ["index", "let scores = [6, 11]\n", "scores[1]", "11"],
    ["call", "function award(x) { return x*3 }\n", "award(4)", "12"],
    ["nested-quotes", "", 'toInteger("23")', "23"],
    ["dict-literal", "", 'dict{"x": 17}["x"]', "17"],
    ["escaped-quotes", "", '"x\\"y".length', "3"],
    ["comment", "", "(8 /* marker */ + 2)", "10"],
    ["multiline", "", "(8 +\n2)", "10"],
    ["quantity", "", "750 ms", "750 ms"],
  ]) {
    add("join-" + name, pre + 'say "L:" + ' + operand + ' + ":R"');
  }
  for ([name, operand] of [
    ["escape", '"q\\"r\\\\s"'],
    ["duration", "4 ms"],
    ["calendar", "2 calendar weeks"],
    ["angle", "35 deg"],
    ["regex", "/a[bc]/i"],
    ["bool", "false"],
    ["null", "null"],
    ["negative", "-12"],
    ["decimal", ".75"],
    ["exponent", "2e3"],
    ["grouped-bool", "(false)"],
    ["grouped-number", "(12)"],
    ["expression", "6 + 7"],
    ["call", 'toInteger("9")'],
    ["index-path", "holders[0].id"],
  ]) {
    add(
      "literal-" + name,
      'let holders = [{id: 9}]\nlet cacheKey = "inventory"\nlet remote = load(cacheKey, default: null)\nsay remote.get(' +
        operand +
        ", default: 9)",
    );
  }
  for ([name, source] of Object.entries({
    "mixed-scalar": 'let entries = [17, "oak"]',
    "mixed-nested": 'let entries = [[17], ["oak"]]',
    "mixed-record": 'let entries = [{weight: 17}, {weight: "oak"}]',
    "missing-property":
      'let room = {visits: 2}\nif askBoolean("Elsewhere?") { room = {title: "porch"} }\nrepeat room.visits {}',
    "method-call":
      'let key = "inventory"\nlet remote = load(key, default: null)\nremote.removeAt(1)',
    "selection-composed":
      "let first: integer[]? = null\nlet backup: integer[] = []\nsay (first otherwise backup).last",
    "selection-call": "function obtain { return [] }\nsay obtain().last",
    "selection-index": "let shelves: integer[][] = [[]]\nsay shelves[0].last",
    "selection-named": "let shelf: integer[] = []\nsay shelf.last",
    "null-path": "let boxes = [{count: 2}, {count: null}]\nrepeat boxes[1].count {}",
    "null-variable": "let count: integer? = null\nrepeat count {}",
    "union-operand": 'let score: integer | string = "red"\nsay score - 4',
    "union-variable": 'let setting = 17\nsetting = "red"',
    "union-list": 'let marks = [17]\nmarks.add("red")',
    "union-dict": 'let marks = dict{first: 17}\nmarks["next"] = "red"',
    typo: 'let person = {title: "Beacon"}\nsay person.titel',
    "condition-literal": 'if 17 { say "yes" }',
    "condition-expression": 'let size = 8\nif size + 2 { say "yes" }',
    "condition-name": 'let size = 8\nif size { say "yes" }',
    "shown-lists-only": 'let bag = {tags: ["oak"]}\nsay "${bag}"',
    "shown-list-of-records": 'let rows = [{n: 4}]\nsay "${rows}"',
    "shown-reference": 'say "${player}"',
    "speaker-create": "player.badge = 17\nsay player.badge",
    "speaker-missing": "say player.badge",
    profile: "say player.firstName",
    branch: 'let passes = 1\nif askBoolean("More?") { passes = 1.25 }\nrepeat passes {}',
    "date-move": 'let start = toDate("2026-04-08")\nsay start + 3 days',
    "datetime-move": 'let start = toDateTime("2026-04-08T12:00:00")\nsay start + 4 s',
    "absolute-move":
      'let start = toAbsoluteDateTime("2026-04-08T12:00:00Z")\nsay start + 3 calendar days',
  })) {
    add(name, source);
  }

  cases = cases.filter((c) => /let |global /.test(c.source));

  return cases.map((c) => [c.name, c.source ?? c.files[0].source]);
})();
export const checks = ["publication", "stops"];

for (const input of [
  ["original/1/join-call", 'function award(x) { return x*3 }\nsay "L:" + award(4) + ":R"\nexit\n'],
  ["original/2/join-nested-quotes", 'say "L:" + toInteger("23") + ":R"\nexit\n'],
  ["original/3/join-dict-literal", 'say "L:" + dict{"x": 17}["x"] + ":R"\nexit\n'],
  ["original/4/join-escaped-quotes", 'say "L:" + "x\\"y".length + ":R"\nexit\n'],
  ["original/5/join-comment", 'say "L:" + (8 /* marker */ + 2) + ":R"\nexit\n'],
  ["original/6/join-multiline", 'say "L:" + (8 +\n2) + ":R"\nexit\n'],
  ["original/7/join-quantity", 'say "L:" + 750 ms + ":R"\nexit\n'],
  ["original/8/selection-call", "function obtain { return [] }\nsay obtain().last\nexit\n"],
  ["original/9/condition-literal", 'if 17 { say "yes" }\nexit\n'],
  ["original/10/shown-reference", 'say "${player}"\nexit\n'],
  ["original/11/speaker-create", "player.badge = 17\nsay player.badge\nexit\n"],
  ["original/12/speaker-missing", "say player.badge\nexit\n"],
  ["original/13/profile", "say player.firstName\nexit\n"],
])
  cases.push(input);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [['node review.mjs "$PWD" 0', "R/astra-m4-s8d-review-r2.md:91"]],
  sources: 102,
  sha256: "5038583ed158d74e320fa6c9470f301ecd768e3bcb9ad622437baf5fbb4d78dd",
};
