// #1165's Codex r5 review: its loss, default and settled-sibling cases, run by its own stops.mjs, compare-fresh.mjs and
// settled-only.mjs in the builder's rerun (desktop:~/work/evidence/1165/dbefff11c5dff5590c1b00b2dd0680824bf32e75/
// generators/tools/c-r5/, desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/
// reviewers.sh). The case files are the review's own, beside its drivers; no other recorded run holds them.
export const cases = [
  ["B1-scalar", "let n = 1\nn = \"wrong\"\nsay \"AFTER\"\nexit\n"],
  ["B1-list", "let n = [1]\nn = [\"wrong\"]\nsay \"AFTER\"\nexit\n"],
  ["B1-object", "let n = {x:1}\nn = {x:\"wrong\"}\nsay \"AFTER\"\nexit\n"],
  ["B1-nested", "let n = {x:{y:1}}\nn = {x:{y:\"wrong\"}}\nsay n\nexit\n"],
  ["B1-copy", "let n = 1\nn = \"wrong\"\nlet m = n\nsay m\nexit\n"],
  ["B1-decimal", "let n = 1\nn = 2.5\nsay n\nexit\n"],
  ["B2-nullable-list", "let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay \"AFTER\"\nexit\n"],
  ["B2-nullable-record", "let base: {n: integer}? = hostValue\nlet copy = base\nsay copy.n\nsay \"AFTER\"\nexit\n"],
  ["B3-missing", "let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay room.n\nsay \"DONE\"\nexit\n"],
  ["B3-nested", "let flag: boolean = hostValue\nlet room = {a: {n: 1}}\nif flag { room = {a: {other: 0}} }\nsay room.a.n\nsay \"DONE\"\nexit\n"],
  ["B3-kind", "let flag: boolean = hostValue\nlet room = {n: 1}\nif flag { room = [1] }\nsay room.n\nsay \"DONE\"\nexit\n"],
  ["nestedDefault", "let value = fromJson(hostValue, default: {list: [{n: fromJson(\"3\", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay \"DONE\"\nexit\n"],
  ["chunks", "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n"],
  ["parseNeighbour", "let parsed = fromJson(hostValue, default: {parts: [{ids: [5]}]})\nsay parsed.parts.get(0, default: {ids: [4]}).ids[0]\nexit\n"],
  ["loadNeighbour", "let parsed = load(\"saved\", default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n"],
  ["hostDefault", "let parsed = fromJson(hostOther, default: {chunks: [[{id: hostValue}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n"],
  ["written", "let parsed: integer[][] = fromJson(hostValue, default: [[5]])\nsay parsed.get(0, default: [4])[0]\nexit\n"],
  ["scalar-neighbor", "let n = 1\nn = \"wrong\"\nsay n\nrepeat 2 { say \"AFTER\" }\nexit\n"],
  ["nested-neighbor", "let n = {x:{y:1}}\nn = {x:{y:\"wrong\"}}\nsay n.x.y\nrepeat 2 { say \"AFTER\" }\nexit\n"],
  ["default-scalar", "let n = fromJson(hostValue, default: {a:[1]})\nn = {a:[\"bad\"]}\nsay n.a.get(0, default: 2)\nsay \"AFTER\"\nexit\n"],
  ["default-nested", "let n = fromJson(hostValue, default: {chunks:[[{id:5}]]})\nn = {chunks:[[{id:\"bad\"}]]}\nsay n.chunks.get(0, default:[{id:4}])[0].id\nsay \"AFTER\"\nexit\n"],
  ["default-missing", "let flag: boolean = hostValue\nlet n = fromJson(hostOther, default: {chunks:[[{id:5}]]})\nif flag { n = {chunks:[[{other:2}]]} }\nsay n.chunks.get(0, default:[{id:4}])[0].id\nsay \"AFTER\"\nexit\n"],
  ["default-kind", "let flag: boolean = hostValue\nlet n = fromJson(hostOther, default: {chunks:[[{id:5}]]})\nif flag { n = {chunks:[[1]]} }\nsay n.chunks.get(0, default:[{id:4}])[0].id\nsay \"AFTER\"\nexit\n"],
  ["default-written-copy", "let base: integer[]? = hostValue\nlet n = fromJson(hostOther, default: {a:base})\nsay n.a.length\nsay \"AFTER\"\nexit\n"],
  ["default-null", "let flag: boolean = hostValue\nlet n = fromJson(hostOther, default: {chunks:[[{id:5}]]})\nif flag { n = {chunks:[[null]]} }\nsay n.chunks.get(0, default:[{id:4}])[0].id\nsay \"AFTER\"\nexit\n"],
  ["default-two", "let flag: boolean = hostValue\nlet n = fromJson(hostOther, default: {chunks:[[{id:5}]]})\nif flag { n = fromJson(hostOther, default: {chunks:[[{id:\"bad\"}]]}) }\nsay n.chunks.get(0, default:[{id:4}])[0].id\nsay \"AFTER\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "r c-r5-loss.jsonl node \"$t/c-r5/stops.mjs\" \"$base/head\" loss \"$t/c-r5/loss-cases.json\"",
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/reviewers.sh:8"
    ],
    [
      "r c-r5-defaults.jsonl node \"$t/c-r5/stops.mjs\" \"$base/head\" defaults \"$t/c-r5/default-cases6.json\"",
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/reviewers.sh:9"
    ],
    [
      "r c-r5-compare-fresh.log node \"$t/c-r5/compare-fresh.mjs\" \"$base/head\" \"$base/main\"",
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/reviewers.sh:12"
    ],
    [
      "r c-r5-every-settled.jsonl node \"$t/c-r5/settled-only.mjs\" \"$base/head\" siblings \"$t/c-r5/settled-siblings.json\"",
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/reviewers.sh:10"
    ]
  ],
  "sources": 26,
  "sha256": "046348a6c82d56f9a44cb4394f9b54add70d9c181036c4f936509ecb3394e69c"
};
