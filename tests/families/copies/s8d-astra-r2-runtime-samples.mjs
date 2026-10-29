// Astra review: 18 fixed samples source cases.
const corpus = (() => {
  const obj = (fields) => ({
    kind: "object",
    properties: Object.entries(fields).map(([name, value]) => ({ name, value })),
  });
  const samples = [
    ["count", "repeat hostValue {}", "oops"],
    ["empty-external", "say hostValue.last", { kind: "list", items: [] }],
    ["null-external", "repeat hostValue {}", null],
    ["missing-object", "let room: object = hostValue\nsay room.visits", obj({ title: "porch" })],
    ["condition", 'if hostValue { say "yes" }', 13],
    ["operator", "say hostValue - 3", "oak"],
    ["key", "let ledger = dict{a: 1}\nsay ledger[hostValue]", 13],
    ["iterable", "for item in hostValue { say item }", 13],
    ["shown", 'say "${hostValue}"', obj({ n: 4 })],
    ["store", "let limit: integer = hostValue\nsay limit", "oak"],
    ["fallback", "let count: integer? = null\nsay count otherwise hostValue", "oak"],
    ["default", "let scores = [2]\nsay scores.get(4, default: hostValue)", "oak"],
    [
      "missing",
      'let room = {visits: 2}\nif hostValue { room = {title: "porch"} }\nsay room.visits',
      true,
    ],
    ["empty", "let scores: integer[] = []\nsay scores.last", null],
    ["null", "let count: integer? = null\nsay count + 3", null],
    ["member", "say hostValue.weight", 13],
    ["speaker", "player.emblem = 21\nsay player.emblem", null],
    [
      "object-store",
      "let receiver: object = hostValue\nreceiver.weight = 3",
      obj({ title: "porch" }),
    ],
    [
      "typed-load",
      'let amount: integer = load("quota", default: 12)\nsay amount',
      null,
      [{ key: "quota", value: "oak" }],
    ],
    ["method", "hostValue.removeAt(0)", 13],
  ];
  return {
    cases: [
      ["count", samples["0"][1]],
      ["empty-external", samples["1"][1]],
      ["null-external", samples["2"][1]],
      ["missing-object", samples["3"][1]],
      ["condition", samples["4"][1]],
      ["operator", samples["5"][1]],
      ["key", samples["6"][1]],
      ["shown", samples["8"][1]],
      ["store", samples["9"][1]],
      ["fallback", samples["10"][1]],
      ["default", samples["11"][1]],
      ["missing", samples["12"][1]],
      ["empty", samples["13"][1]],
      ["null", samples["14"][1]],
      ["member", samples["15"][1]],
      ["speaker", samples["16"][1]],
      ["object-store", samples["17"][1]],
      ["typed-load", samples["18"][1]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication"];
