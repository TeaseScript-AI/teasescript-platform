// condition/integer/fixed, condition/integer/variable-index and related fixed cases; Astra review, r4
// (R/astra-m4-s8d-r4-evidence/review.mjs).
export const cases = (() => {
  const cases = [];
  function add(name, source, advice = null, example = null) {
    cases.push({ name, source: source + "\nexit\n", advice, example });
  }
  const variants = [
    ["integer", "19"],
    ["number", "1.75"],
    ["text", '"Orchid"'],
    ["list", "[19]"],
    ["set", "set[19]"],
    ["dict", "dict{petal: 19}"],
  ];
  for (const [type, init] of variants) {
    const prefix = `let value = 404\nlet grove = [{petal: ${init}}]\nlet pos = 0\nfunction bloom { return grove[0] }\n`;
    for (const [shape, expr, example] of [
      ["fixed", "grove[0].petal", true],
      ["variable-index", "grove[pos].petal", true],
      ["computed", "grove[pos + 0].petal", false],
      ["nested-random", "grove.random.petal", false],
      ["call-path", "bloom().petal", false],
      ["parenthesized", "(grove[0]).petal", false],
    ])
      add(
        `condition/${type}/${shape}`,
        `${prefix}if ${expr} { say "open" }`,
        ["list", "set", "dict"].includes(type) ? "Check its length instead" : "Compare it instead",
        example,
      );
  }
  const prefix = 'let value = "unrelated"\nlet garden = [{item: 19}]\n';
  add(
    "number-convert",
    prefix + "say garden.random.item.length",
    "Convert 'garden.random.item' to text first with 'toString(...)'.",
    false,
  );
  add(
    "elapsed-member",
    "let clips = [{span: 9 s}]\nsay clips.random.span.minutes",
    "Divide 'clips.random.span' by a unit, such as '1 minute'.",
    false,
  );
  add(
    "absolute-member",
    'let dates = [{stamp: toAbsoluteDateTime("2027-04-11T12:30:00Z")}]\nsay dates.random.stamp.hour',
    "Convert 'dates.random.stamp' with 'toDateTime()' first.",
    false,
  );
  add(
    "set-method",
    "let baskets = [{seeds: set[19]}]\nsay baskets.random.seeds.indexOf(19)",
    "Copy 'baskets.random.seeds' into a list with 'toList()' first.",
    false,
  );
  for (const [type, init] of [
    ["object", '{label: "Iris"}'],
    ["dict", 'dict{label: "Iris"}'],
    ["set", "set[19, 23]"],
  ]) {
    add(
      "shown/" + type,
      `let value = set[404]\nlet holders = [{payload: ${init}}]\nsay "\${holders.random.payload}"`,
      type === "object"
        ? "Show one of its properties instead."
        : type === "dict"
          ? "Select one value with a key, or show every value with 'values.join()'."
          : "Show its elements with 'toList().join()' instead.",
      false,
    );
  }
  add(
    "number-key",
    'let keys = [19]\nlet names = dict{"19": "Iris"}\nsay names[keys.random]',
    "Write a number key as text.",
    false,
  );
  add(
    "string-store",
    "let keys = [19]\nlet placard: string = keys.random",
    "To show it as text, put it in a text with '${...}'.",
    false,
  );
  add(
    "null-comment",
    "let leaves: integer?[] = [null, 19]\nsay (leaves[ /* select */ 0]) * 3",
    "in a new variable",
    false,
  );
  add(
    "selection-comment",
    "let baskets: integer[][] = [[], [19]]\nsay (baskets[ /* select */ 0]).first",
    "in a new variable and check its length first.",
    false,
  );
  add(
    "absolute-calendar",
    'let moments = [toAbsoluteDateTime("2027-04-11T12:30:00Z")]\nsay moments.random + 2 calendar weeks',
    "Convert it with 'toDateTime()' first.",
    false,
  );
  add(
    "local-elapsed",
    'let moments = [toDateTime("2027-04-11T12:30:00")]\nsay moments.random - 2 s',
    "Convert it with 'toAbsoluteDateTime()' first, or use calendar units to keep the clock time.",
    false,
  );
  add(
    "local-difference",
    'let moments = [toDateTime("2027-04-11T12:30:00")]\nsay moments[0] - moments.random',
    "Subtract their dates with 'toDate(...)', or convert both with 'toAbsoluteDateTime()' for the elapsed time.",
    false,
  );
  add(
    "date-compare",
    'let moments = [toDateTime("2027-04-11T12:30:00")]\nsay toDate("2027-04-11") >= moments.random',
    "Compare its date, with 'toDate(...)'.",
    false,
  );
  for (const [shape, pre, expr] of [
    ["alias", "let guide = player", "guide"],
    ["path", "let packet = {guide: player}", "packet.guide"],
    ["selected", "let cast = [player]", "cast.random"],
    ["returned", "function messenger { return player }", "messenger()"],
  ]) {
    for (const method of ["clear()", "removeAt(0)", "get(0, default: 19)", "contains(19)"])
      add(
        `speaker/${shape}/${method}`,
        `${pre}\n${expr}.${method}`,
        "A speaker has no methods. Use one of its properties instead.",
      );
    add(`speaker/${shape}/property`, `${pre}\n${expr}.orchid = 19\nsay ${expr}.orchid`);
  }
  add("speaker/union/method", "let audience: speaker | object = player\naudience.add(19)");
  add("speaker/union/store", "let audience: speaker | object = player\naudience.orchid = 19");
  add("speaker/index-store", "let guide = player\nguide[0] = 19");
  add(
    "property-plain",
    'let badge = {tags: ["orchid"], count: 19}\nsay "${badge}"',
    "as in '${badge.count}'",
  );
  add(
    "property-list-only",
    'let badge = {tags: ["orchid"]}\nsay "${badge}"',
    "Show one of its properties instead.",
    false,
  );
  add("literal-condition", 'if -19 { say "open" }', "Compare it instead.", false);
  add("union-variable", 'let blossom = 19\nblossom = "Iris"', "declare it as");
  add("union-list", 'let blossoms = [19]\nblossoms.add("Iris")', "declare it as");
  add("union-dict", 'let blossoms = dict{a: 19}\nblossoms["b"] = "Iris"', "declare it as");
  add(
    "property-typo",
    'let badge = {label: "Iris"}\nsay badge.lable',
    "Its only property is 'label'.",
  );
  add(
    "join-comment",
    'let petal = 19\nsay "Petals: " + (petal /* selected */ + 3)',
    "Put the value in the text instead.",
    false,
  );
  add(
    "join-sum",
    'let petal = 19\nsay "Petals: " + (petal + 3)',
    "Put the value in the text as '${petal + 3}' instead.",
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node review.mjs <root> 0", "R/astra-m4-s8d-review-r4.md:74"],
    ["node review.mjs ROOT 0", "R/astra-m4-s8d-r4-evidence/review-0.log:1"],
    ["node review.mjs ROOT 1", "R/astra-m4-s8d-r4-evidence/review-1.log:1"],
  ],
  sources: 83,
  sha256: "ac884df759bf7281ee6e76054a23a1e4b86868fdf40c366931ca37e04321e945",
};
