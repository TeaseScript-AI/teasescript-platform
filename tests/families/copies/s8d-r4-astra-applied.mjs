// captured r4 astra applied inputs; astra-m4-s8d-r4-evidence, review/builder evidence
// (R/astra-m4-s8d-r4-evidence/applied.mjs).
const applied = [
  [
    "condition/integer/fixed",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/integer/computed",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/integer/call-path",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/fixed",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/computed",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/call-path",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/text/fixed",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal != "" { say "open" }\nexit\n',
  ],
  [
    "condition/text/computed",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "condition/text/call-path",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "condition/list/fixed",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/list/computed",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/list/call-path",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/fixed",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/computed",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/call-path",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/fixed",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/computed",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/call-path",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/integer/variable-index",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/integer/nested-random",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/integer/parenthesized",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/variable-index",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/nested-random",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/number/parenthesized",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/text/variable-index",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal != "" { say "open" }\nexit\n',
  ],
  [
    "condition/text/nested-random",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "condition/text/parenthesized",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "condition/list/variable-index",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/list/nested-random",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/list/parenthesized",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/variable-index",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/nested-random",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/set/parenthesized",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/variable-index",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/nested-random",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "condition/dict/parenthesized",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  ["plain-property", 'let badge = {tags: ["orchid"], count: 19}\nsay "${badge.count}"\nexit\n'],
  [
    "speaker-method-fix",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\nsay packet.guide.title\nexit\n',
  ],
  ["union-variable", 'let blossom: integer | string = 19\nblossom = "Iris"\nsay blossom\nexit\n'],
  [
    "union-list",
    'let blossoms: (integer | string)[] = [19]\nblossoms.add("Iris")\nsay blossoms.last\nexit\n',
  ],
  [
    "union-dict",
    'let blossoms: (integer | string) dict = dict{a: 19}\nblossoms["b"] = "Iris"\nsay blossoms["b"]\nexit\n',
  ],
  ["join-operand", 'let petal = 19\nsay "Petals: ${petal + 3}"\nexit\n'],
  [
    "mixed-store",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.orchid = 19\nsay "done"\nexit\n',
  ],
  [
    "mixed-method",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.clear()\nexit\n',
  ],
  [
    "pure-method",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.clear()\nexit\n',
  ],
  [
    "property-store",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.orchid = 19\nsay packet.guide.orchid\nexit\n',
  ],
];

// the run analysed the four store and method programs with hostValue; the conditions it only compiled, without globals
const analysed = new Set(["mixed-store", "mixed-method", "pure-method", "property-store"]);
export const cases = applied.map(([name, source]) =>
  analysed.has(name) ? [name, source, ["hostValue"]] : [name, source],
);
export const globals = [];
export const checks = ["publication"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node applied.mjs <root>", "R/astra-m4-s8d-review-r4.md:75"]],
  sources: 46,
  sha256: "bcf485296c4f473975f7830ee8fb2a7d898f530c8a2dd480d69f768f8ce0cfc9",
};
