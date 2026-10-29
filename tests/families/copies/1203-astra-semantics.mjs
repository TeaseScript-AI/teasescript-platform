// pure-scalar, pure-null and related fixed cases; #1203, Astra review, round unrecorded
// (R/astra-m4-i1203-review/semantics.mjs).
export const cases = (() => {
  const cases = [];
  const add = (name, source, oracle = [], errors = []) =>
    cases.push({ name, source: source + "\nexit\n", oracle, errors });
  const load = (key, d) => `load(${key}, default: ${d})`;
  const fields =
    "repeat parcel[0].north {}\nrepeat parcel[2].south.depth {}\nlet whole = parcel[1]";
  const keys = [
    "hostValue",
    "hostOther",
    "key",
    "names.slot",
    "keylist[0]",
    'key + "suffix"',
    '"slot.${key}"',
  ];
  const pre = 'let key = "atlas"\nlet names = {slot: "b"}\nlet keylist = ["c"]\n';
  for (const [name, d] of [
    ["scalar", "9"],
    ["null", "null"],
    ["record", "{north: 2, south: 3}"],
    ["nested", "{south: {depth: 5}}"],
    ["classless", "(askChoice set[3, 8])"],
  ]) {
    const source = pre + `let parcel = [${keys.map((k) => load(k, d)).join(", ")}]\n` + fields;
    add("pure-" + name, source, [
      ["parcel[0].north", "all", "unknown"],
      ["parcel[2].south.depth", "all", "unknown"],
      ["parcel[1]", "all", name === "null" ? "unknown,null" : "unknown"],
    ]);
  }
  const mixed = ["null", "23", "{west: 1}", "{north: {inner: 2}}", "(askChoice [7, 12])"];
  const many = mixed.map((d, i) => load(keys[i], d)).join(", ");
  add("varied", pre + `let parcel = [${many}]\n` + fields, [
    ["parcel[0].north", "all", "unknown"],
    ["parcel[2].south.depth", "all", "unknown"],
    ["parcel[1]", "all", "unknown,null"],
  ]);
  add(
    "interleaved",
    pre +
      `let parcel = [${load("hostOther", "null")}, {north: 5}, ${load("key", "(askChoice [9, 11])")}, load("fixed", default: {south: {depth: 2}}), ${load("hostValue", "{east: 4}")}]\n` +
      fields,
  );
  add(
    "records",
    pre +
      `let parcel = [{inside: ${load("hostOther", "{north: 2}")}}, {inside: ${load("key", "null")}}, {inside: ${load("hostValue", "(askChoice [2, 6])")}}]\nrepeat parcel[0].inside.north {}\nrepeat parcel[1].inside.east {}\nlet whole = parcel[2].inside`,
    [["parcel[0].inside.north", "all", "unknown"]],
  );
  add(
    "set",
    pre +
      `let parcel = set[${many}]\nfor item in parcel {\nrepeat item.north {}\nrepeat item.south.depth {}\n}`,
    [["item.north", "all", "unknown"]],
  );
  add(
    "dict",
    pre +
      `let parcel = dict{red: ${load("key", "null")}, blue: ${load("hostOther", "{north: 2}")}}\nrepeat parcel["red"].north {}\nrepeat parcel["blue"].south {}\nlet whole = parcel["red"]`,
    [['parcel["red"].north', "all", "unknown"]],
  );
  add("alias-container", pre + `let original = [${many}]\nlet parcel = original\n` + fields, [
    ["parcel[0].north", "all", "unknown"],
  ]);
  add(
    "argument",
    pre +
      `function inspectParcel(parcel) {\nrepeat parcel[0].north {}\nrepeat parcel[2].south.depth {}\n}\ninspectParcel([${many}])`,
  );
  add(
    "guarded",
    pre +
      `let parcel = [${many}]\nif parcel[0].north is integer { repeat parcel[0].north {} }\nif parcel[1] != null { repeat parcel[1].south {} }\nif parcel[2] is object { repeat parcel[2].north {} }`,
  );
  add(
    "mutation",
    pre +
      `let parcel = [${many}]\nrepeat parcel[0].north {}\nparcel[0] = {north: 7}\nparcel.add(${load("hostOther", "null")})\nrepeat parcel[1].south {}\nif hostOther == 1 { parcel = [{north: 8}] }\nrepeat parcel[0].north {}`,
  );
  add(
    "loop-mutation",
    pre +
      `let parcel = [${many}]\nrepeat 2 { repeat parcel[0].north {}\nparcel.add(${load("key", "{north: 4}")}) }\nrepeat parcel[0].south {}`,
  );
  add(
    "nested-lists",
    pre +
      `let parcel = [[${many}], [${load("hostOther", "null")}, ${load("key", "3")}]]\nrepeat parcel[0][0].north {}\nrepeat parcel[1][1].south {}\nlet whole = parcel[0][0]`,
  );
  add(
    "two-globals",
    'global northKey = "north"\nglobal southKey = "south"\nlet parcel = [load(northKey, default: null), load(southKey, default: {north: 9})]\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}\nlet whole = parcel[1]',
    [
      ["parcel[0].north", "all", "unknown"],
      ["parcel[1].south", "all", "unknown"],
      ["parcel[1]", "all", "unknown,null"],
    ],
  );
  add(
    "copies",
    `let original = ${load("hostOther", "null")}\nlet parcel = [original, original, original]\n` +
      fields,
    [["parcel[0].north", "all", "unknown"]],
  );
  add(
    "disjoint",
    `let left = [${load("hostOther", "null")}, ${load("hostValue", "{north: 4}")} ]\nlet right = [${load("hostValue", "false")}, ${load("hostOther", "9")}]\nrepeat left[0].north {}\nrepeat right[0].north {}`,
    [
      ["left[0].north", "left", "unknown"],
      ["right[0].north", "right", "unknown"],
    ],
  );
  for (const [label, type, defaults] of [
    [
      "object",
      "object[]",
      ["{north: 8}", "{south: {depth: 4}}", "(askChoice [{north: 5}, {east: 3}])"],
    ],
    ["nullable", "object?[]", ["null", "{north: 6}", "(askChoice [null, {south: 3}])"]],
    ["integers", "integer[]", ["7", "11", "19"]],
    ["bad-integers", "integer[]", ['"bad-first"', "7", "false"]],
    ["bad-objects", "object[]", ["9", "null", "{north: 8}"]],
    ["union", "(integer | object)[]", ["11", "{north: 3}", "(askChoice [7, 13])"]],
    ["nested", "integer[][]", ["[1, 2]", "[3]", '["bad-nested"]']],
    ["dict-elements", "(integer dict)[]", ["dict{a: 1}", "dict{b: 3}", 'dict{c: "bad-dict"}']],
  ]) {
    add(
      "written-" + label,
      pre +
        `let parcel: ${type} = [${defaults.map((d, i) => load(keys[i], d)).join(", ")}]\n` +
        fields,
      [],
      label === "bad-integers" ? ['"bad-first"', "false"] : [],
    );
  }
  add(
    "written-dict",
    pre +
      `let parcel: object? dict = dict{sun: ${load("key", "null")}, moon: ${load("hostOther", "{north: 8}")}, star: ${load("hostValue", "{west: {q: 2}}")}}\nrepeat parcel["sun"].north {}\nrepeat parcel["moon"].south {}\nlet whole = parcel["star"]`,
  );
  add(
    "written-set",
    pre +
      `let parcel: object set = set[${load("key", "{north: 8}")}, ${load("hostOther", "{south: 1}")}]\nfor item in parcel { repeat item.north {}\nrepeat item.south {} }`,
  );
  add(
    "written-param",
    pre +
      `function inspectParcel(parcel: object?[]) {\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}\n}\ninspectParcel([${load("key", "null")}, ${load("hostOther", "{north: 2}")}, ${load("hostValue", "false")}])`,
  );
  add(
    "written-return",
    pre +
      `function gather(unused): object[] { return [${load("hostValue", "{north: 3}")}, ${load("hostOther", "false")}] }\nlet parcel = gather(0)\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}`,
  );
  add(
    "written-assignment",
    pre +
      `let parcel: object?[] = []\nparcel = [${load("key", "null")}, ${load("hostOther", "{north: 8}")}, ${load("hostValue", "{south: 7}")}]\n` +
      fields,
  );
  add(
    "actual-receiver",
    `let received: object? = ${load("hostValue", "null")}\nlet other: integer = ${load("hostOther", '"bad-receiver"')}\nlet parcel = [received, other]\nrepeat received.north {}\nrepeat received.south {}\nrepeat parcel[0].north {}`,
  );
  add(
    "typed-direct-control",
    `let direct: integer = load("counter", default: 5)\nlet parcel: integer[] = [load("counter", default: 2), load("counter", default: "bad-direct")]\nrepeat parcel[0] {}\nrepeat direct {}`,
  );
  add(
    "member-paths",
    pre +
      `let parcel = [${many}]\nrepeat parcel[0].year {}\nrepeat parcel[1][0].north {}\nrepeat parcel[2].keys[0].length {}\nlet picked = askChoice parcel\nrepeat picked.north {}`,
  );
  add(
    "otherwise",
    pre +
      `let parcel = [${load("key", "null")} otherwise {north: 2}, ${load("hostOther", "null")} otherwise {south: 4}]\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}`,
  );
  add(
    "choice-options",
    pre +
      `let picked = askChoice {text: "first", value: ${load("key", "null")}}, {text: "second", value: ${load("hostOther", "{north: 3}")}}\nrepeat picked.north {}\nrepeat picked.south {}`,
  );
  add(
    "alias-members",
    pre +
      `let one = ${load("key", "null")}\nlet two = ${load("hostOther", "{north: 4}")}\nlet parcel = [one, two]\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}`,
  );
  add(
    "admission-named",
    pre +
      `let entry = hostOther\nlet parcel = [entry, ${many}]\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}`,
  );
  add(
    "cyclic-default",
    `let parcel = []\nparcel = [${load("hostOther", "parcel[0]")}, ${load("hostValue", "null")}]\nrepeat parcel[0].north {}\nrepeat parcel[1].south {}\nlet whole = parcel[0]`,
  );
  add(
    "storing-function",
    `global parcel = []\nfunction replace(unused) { parcel = [{north: 8}] }\nparcel = [${load("hostOther", "null")}, ${load("hostValue", "3")}]\nrepeat parcel[0].north {}\nreplace(0)\nrepeat parcel[0].north {}`,
  );
  add("quiet", "let parcel = [{north: 2}, {north: 5}]\nrepeat parcel[0].north {}");
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node semantics.mjs . 0 100 # quick complete comparison",
      "R/astra-m4-i1203-review/commands.md:26",
    ],
    [
      "VALIDATE=1 node semantics.mjs . # fixture validity, initial failure diagnosed",
      "R/astra-m4-i1203-review/commands.md:27",
    ],
    ["node semantics.mjs . 0 2 # final even sources", "R/astra-m4-i1203-review/commands.md:28"],
    ["node semantics.mjs . 1 2 # final odd sources", "R/astra-m4-i1203-review/commands.md:29"],
    [
      "RESULT_DIR=mutant-results node --import=./drop-origin.mjs semantics.mjs . 0 100",
      "R/astra-m4-i1203-review/commands.md:38",
    ],
  ],
  sources: 42,
  sha256: "04fbcf76f439ec72f286cfe8513f50cbd23ad8eea9fc4233566dc2ebf8374983",
};
