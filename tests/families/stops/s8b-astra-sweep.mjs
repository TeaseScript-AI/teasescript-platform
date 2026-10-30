// record, quiet and related fixed cases; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8b-evidence/sweep.mjs).
const corpus = (() => {
  const object = (props) => ({
    kind: "object",
    properties: Object.entries(props).map(([name, value]) => ({ name, value })),
  });
  const cases = {
    record: {
      source:
        'let seed = {ticks: 2, title: "ok"}\nlet state = seed\nstate = hostValue\nrepeat state.ticks {}\nsay state.title\nexit\n',
      good: [object({ ticks: 2, title: "yes" })],
      bad: [object({ ticks: 1.5, title: "yes" }), object({ ticks: 2, title: 3 })],
    },
    quiet: {
      source:
        "let slots = [3, 7]\nlet index = 1\nlet rounds = 2\nrepeat rounds { say slots[index] }\nlet sentinel: integer = hostValue\nexit\n",
      good: [2],
      bad: [1.5],
    },
    fallback: {
      source:
        "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
      good: [2],
      bad: ["bad"],
      other: 3,
    },
    error: {
      source:
        'let original = {nested: {n: 1}}\nlet text = {nested: {n: "bad"}}\nlet copied = original\ncopied = text\nlet final = copied\nrepeat final.nested.n {}\nlet sink: integer = hostValue\nexit\n',
      good: [],
      bad: [],
    },
    missing: {
      source:
        "let flag: boolean = hostValue\nlet state = {left: 1, right: 2}\nif flag { state = {other: 3} }\nlet first = state.left\nlet second = state.right\nsay first\nsay second\nexit\n",
      good: [false],
      bad: [true],
    },
    typed: {
      source:
        'let payload = fromJson(hostValue, default: {rows: [{count: fromJson("2", default: 0), note: null}], tag: "x"}, files: false)\nsay payload.rows.get(0, default: {count: 0, note: null}).count\nsay payload.tag\nexit\n',
      good: [
        '{"rows":[{"count":2,"note":"free"}],"tag":"ok"}',
        '{"rows":[{"count":"bad"}],"tag":"bad"}',
      ],
      bad: [],
    },
    defaults: {
      source:
        'function emit(item = null) {\n let alias = item\n say alias.title\n say item.title\n}\nemit({title: "one"})\nemit({title: "two"})\nlet sink: integer = hostValue\nexit\n',
      good: [],
      bad: [],
      analysisOnly: true,
    },
    method: {
      source:
        'function read(item) {\n let alias = item\n say alias.get("name", default: "blank")\n say item.name\n}\nread({name: "one"})\nread({name: "two"})\nlet sink: integer = hostValue\nexit\n',
      good: [],
      bad: [],
      analysisOnly: true,
    },
    cycle: {
      source:
        'let a = 1\nlet b = a\na = b\nb = "bad"\na = hostValue\nrepeat a {}\nlet n: integer = hostOther\nexit\n',
      good: [2],
      bad: [1.5],
    },
  };
  return {
    cases: [
      ["record", cases["record"].source],
      ["quiet", cases["quiet"].source],
      ["fallback", cases["fallback"].source],
      ["error", cases["error"].source],
      ["missing", cases["missing"].source],
      ["typed", cases["typed"].source],
      ["defaults", cases["defaults"].source],
      ["method", cases["method"].source],
      ["cycle", cases["cycle"].source],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node sweep.mjs <case> quick|all, for record, quiet, fallback, error, missing, typed, defaults, method and cycle (no shell line kept: each result's file name records its case and range)",
      "R/astra-m4-s8b-evidence/<case>-quick.jsonl and <case>-all.jsonl",
    ],
  ],
  sources: 9,
  sha256: "eb5221f243bb8dd6ea3b6172d9b58087fe3b647603361ba997045a50b1c342fd",
};
