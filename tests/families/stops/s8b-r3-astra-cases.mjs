// storemissing, storenull and related fixed cases; #1165 / S8, Astra review, r3 (R/astra-m4-s8b-r3-evidence/cases.mjs).
export const cases = (() => {
  const h = (hostValue, hostOther = 4) => ({ hostValue, hostOther });
  const cases = {
    storemissing: {
      source: "let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit",
      good: [],
      bad: [],
      analysisOnly: true,
    },
    storenull: {
      source: "let blank: object? = null\nlet mirror = blank\nmirror.field = hostValue\nexit",
      good: [],
      bad: [],
      analysisOnly: true,
    },
    builtin: {
      source:
        'let seed: string? = "ok"\nlet box = {seed:seed}\nlet mirror = box\nsay mirror.seed.startsWith(hostValue)\nexit',
      good: [],
      bad: [],
      analysisOnly: true,
    },

    literal: {
      source: "let ratio: integer = 2.75\nlet need: boolean = hostValue\nexit",
      good: [],
      bad: [],
    },
    written: {
      source: "let count: integer = 7\ncount = hostValue\nrepeat count {}\nexit",
      good: [h(2)],
      bad: [h(2.5)],
    },
    decided: {
      source: "let level = 7\nlevel = hostValue\nrepeat level {}\nexit",
      good: [h(2)],
      bad: [h(2.5)],
    },
    copy: {
      source:
        "let base: number[] = [1.25]\nlet cache = base\nsay cache.get(hostOther, default: hostValue)\nexit",
      good: [h(3.25)],
      bad: [h("bad")],
    },
    lazy: {
      source:
        "let base: integer[] = [7]\nlet bundle = {rows:base}\nlet copy = bundle\nlet again = copy\nsay again.rows.get(hostOther, default: hostValue)\nexit",
      good: [h(3)],
      bad: [h("bad")],
    },
    nullonly: {
      source:
        "let empty = null\nlet pack = {choice:empty}\nlet clone = pack\nsay clone.choice otherwise hostValue\nexit",
      good: [h("open"), h(9)],
      bad: [],
    },
    nullchain: {
      source:
        "let optional: number? = null\nlet first = {choice:optional}\nlet second = first\nlet third = second\nsay third.choice otherwise hostValue\noptional = 1.25\nexit",
      good: [h("open"), h(9)],
      bad: [],
    },
    nullget: {
      source:
        "let optional: number?[] = [null]\nlet pack = {choices:optional}\nlet clone = pack\nsay clone.choices.get(hostOther, default: hostValue)\noptional = [1.25]\nexit",
      good: [h("open")],
      bad: [],
    },
    mixedget: {
      source:
        "let optional: number?[] = [null,1.25]\nlet pack = {choices:optional}\nlet clone = pack\nsay clone.choices.get(hostOther, default: hostValue)\nexit",
      good: [h(2.5)],
      bad: [h("bad")],
    },
    union: {
      source:
        'let variant: integer | string = "one"\nlet bundle = {choice:variant}\nlet alias = bundle\nsay alias.choice otherwise hostValue\nvariant = 3\nexit',
      good: [h("two")],
      bad: [],
      analysisOnly: true,
    },
    empty: {
      source:
        "let samples: number[] = []\nlet pack = {samples:samples}\nlet clone = pack\nsay clone.samples.first\nexit",
      good: [],
      bad: [h(0)],
      analysisOnly: true,
    },
    dict: {
      source:
        'let lookup: number dict = dict{"key":1.25}\nlet first = lookup\nlet second = first\nsay second.get("missing", default: hostValue)\nexit',
      good: [h(2.5)],
      bad: [h("bad")],
      analysisOnly: true,
    },
    conversion: {
      source:
        "let seed: integer? = null\nlet pack = {seed:seed}\nlet copy = pack\nsay toInteger(hostValue, default: copy.seed)\nseed = 4\nexit",
      good: [h("oops"), h("17")],
      bad: [],
      analysisOnly: true,
    },
    parse: {
      source:
        "let seed: integer? = null\nlet pack = {seed:seed}\nlet copy = pack\nlet parsed: integer? = fromJson(hostValue, default: copy.seed, files: false)\nsay parsed\nseed = 4\nexit",
      good: [h("null"), h("4"), h("oops")],
      bad: [],
      analysisOnly: true,
    },
    load: {
      source:
        'let seed: integer? = null\nlet pack = {seed:seed}\nlet copy = pack\nlet saved: integer? = load("astra-review-absent", default: copy.seed)\nsay saved\nseed = 4\nexit',
      good: [h(1)],
      bad: [],
      analysisOnly: true,
    },
    fixed: {
      source:
        "let count: integer? = 2\nlet pack = {count:count}\nlet copy = pack\nrepeat copy.count {}\nlet target: integer = hostValue\nexit",
      good: [h(3)],
      bad: [h(3.5)],
    },
    index: {
      source:
        "let entries: integer[] = [5,8]\nlet pack = {rows:entries}\nlet clone = pack\nsay clone.rows.get(hostOther, default: 0)\nexit",
      good: [h(0, 1)],
      bad: [h(0, 0.5)],
    },
    method: {
      source:
        "let entries: integer[] = [5]\nlet pack = {rows:entries}\nlet clone = pack\nclone.rows.add(hostValue)\nsay clone.rows.count\nexit",
      good: [h(8)],
      bad: [h("bad")],
      analysisOnly: true,
    },
    parameters: {
      source:
        "function echo(input: integer?) {\n let pack = {input:input}\n let twin = pack\n say twin.input otherwise hostValue\n}\necho(null)\necho(7)\nexit",
      good: [],
      bad: [],
      analysisOnly: true,
    },
    result: {
      source:
        "function fetch(input: integer?) { return {item:input} }\nlet pack = fetch(null)\nlet twin = pack\nsay twin.item otherwise hostValue\nexit",
      good: [],
      bad: [],
      analysisOnly: true,
    },
    cycle: {
      source:
        "let one = {next:{value:3}}\nlet two = one.next\none = two\nlet copied = one\nsay copied.value otherwise hostValue\nexit",
      good: [],
      bad: [],
      analysisOnly: true,
    },
    operator: {
      source:
        'let amount: integer | string = 2\nlet pack = {amount:amount}\nlet twin = pack\nsay twin.amount + hostValue\namount = "late"\nexit',
      good: [h(3)],
      bad: [h(false)],
      analysisOnly: true,
    },
    typedrecord: {
      source:
        'let incoming = fromJson(hostValue, default: {rows:[{total:0}], title:"unset"}, files:false)\nsay incoming.rows.get(0, default:{total:0}).total\nsay incoming.title\nexit',
      good: [
        h('{"rows":[{"total":9}],"title":"ready"}'),
        h('{"rows":[{"total":"bad"}],"title":2}'),
      ],
      bad: [],
    },
  };
  function collectSources(value, name = "case", out = []) {
    const isSource = (s) =>
      typeof s === "string" &&
      /(^|\n)\s*(global |let |function |say |exit\b|if |repeat |speaker |scene |call |goto |wait |show)/.test(
        s,
      );
    const isFiles = (v) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string");
    const leaf = (v) => isSource(v) || isFiles(v);
    if (leaf(value)) out.push([name, value]);
    else if (value && typeof value === "object") {
      if (leaf(value.source)) out.push([value.name ?? value.id ?? name, value.source]);
      else if (leaf(value.files)) out.push([value.name ?? value.id ?? name, value.files]);
      else if (Array.isArray(value) && typeof value[0] === "string" && leaf(value[1]))
        out.push([value[0], value[1]]);
      else
        for (const [key, item] of Object.entries(value)) {
          if (
            ![
              "where",
              "expected",
              "expect",
              "description",
              "message",
              "fallback",
              "say",
              "diagnostics",
              "patch",
            ].includes(key)
          )
            collectSources(item, name + "/" + key, out);
        }
    }
    return out;
  }
  return collectSources(cases);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node sweep.mjs "$PWD/wt" <case> all, and <case> quick, for each of its cases',
      "R/astra-m4-s8b-r3-evidence/launch-all.sh, launch-quick.sh",
    ],
  ],
  sources: 26,
  sha256: "db1ac64bea8915908a5551568cd3d563f174300f0c677f1033cb747b5862689f",
};
