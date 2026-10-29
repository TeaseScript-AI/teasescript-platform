// #1165 S8 part 3, r7 retained builder/probe9 evidence.
export const cases = (() => {
  const cases = [
    [
      "list-repeat-wrong",
      'let labels: integer[] = ["red", "blue", "green"]\nexit',
      { literalErrors: true },
    ],
    [
      "list-object",
      "let counts: integer[] = [{value: hostValue}, {value: 4}]\nexit",
      { literalErrors: true },
    ],
    [
      "set-objects",
      "let counts: integer set = set[{value: 7}, {value: 8}]\nexit",
      { literalErrors: true },
    ],
    [
      "dict-mixed",
      'let flags: boolean dict = dict{first: 3, second: "bad", third: true}\nexit',
      { literalErrors: true },
    ],
    [
      "nested-mixed",
      'let groups: integer[][] = [[1, "bad"], [2, false]]\nexit',
      { literalErrors: true },
    ],
    [
      "set-nested",
      'let groups: integer[] set = set[["one", "two"], [true, false]]\nexit',
      { literalErrors: true },
    ],
    [
      "dict-set",
      'let groups: integer set dict = dict{one: set["x", "y"], two: set[false]}\nexit',
      { literalErrors: true },
    ],
    [
      "mixed-union",
      'let groups: (integer | string)[] set = set[]\ngroups.add([3, "bad"])\nexit',
      { literalErrors: true },
    ],
    [
      "mixed-copy",
      'let pair = [3, "bad"]\nlet second = pair\nsay second\nexit',
      { literalErrors: true },
    ],
    ["mixed-direct", 'say [2, "bad"]\nexit', { literalErrors: true }],
    ["mixed-named-direct", 'let count = 2\nsay [count, "bad"]\nexit'],
    [
      "mixed-named-calls",
      'function accept(xs: (integer | string)[]) { say xs }\nlet count = 2\naccept([count, "bad"])\naccept([count, "other"])\nexit',
    ],
    [
      "multi-nested-call",
      'function accept(xs: integer[][]) { say xs }\naccept([["one", "two"]])\naccept([[false, true]])\nexit',
      { literalErrors: true },
    ],
    [
      "dead-set-call",
      'function accept(xs: integer set) { say xs }\nexit\naccept(set["one", "two"])',
      { literalErrors: true },
    ],
    [
      "written-result",
      'function make: integer[][] { return [["bad", "also"]] }\nsay make()\nexit',
      { literalErrors: true },
    ],
    [
      "written-ingress",
      'let data: integer[] dict = dict{one: [hostValue], two: [hostOther]}\nsay data.get("one", default: [1])\nexit',
    ],
    ["written-null", "let data: integer[] = [null, hostValue]\nsay data\nexit"],
    [
      "parse-default-mixed",
      'let decoded = fromJson(hostValue, default: {groups: [[3, "bad"]]})\nsay decoded\nexit',
      { literalErrors: true },
    ],
    [
      "parse-default-ingress",
      "let decoded = fromJson(hostValue, default: dict{one: [hostOther]})\nsay decoded\nexit",
    ],
    [
      "narrow-copy",
      "let quantity: integer? = hostValue\nif quantity != null { let copy: integer = quantity\n repeat copy {} }\nexit",
      { fitting: [{ hostValue: 2 }, { hostValue: null }] },
    ],
    [
      "narrow-stored-op",
      "let quantity: integer | string = hostValue\nif quantity is integer { let amount = quantity + 2\n repeat amount {} }\nexit",
      { fitting: [{ hostValue: 2 }, { hostValue: "skip" }] },
    ],
    [
      "narrow-preserve",
      "let quantity: integer? = hostValue\nwhile quantity != null { quantity = quantity otherwise 4\nlet copy: integer = quantity\nsay copy\nbreak }\nexit",
      { fitting: [{ hostValue: 2 }, { hostValue: null }] },
    ],
    [
      "narrow-component",
      "let left: integer? = hostValue\nlet right: integer? = hostOther\nwhile left != null { while right != null { left = right\nright = left\nlet copy: integer = left\nsay copy\nbreak }\nbreak }\nexit",
      {
        fitting: [
          { hostValue: 2, hostOther: 3 },
          { hostValue: null, hostOther: null },
        ],
      },
    ],
    [
      "narrow-new-store",
      "let quantity: integer? = hostValue\nif quantity != null { quantity = null\nlet copy: integer? = quantity\nsay copy otherwise hostOther }\nexit",
      { fitting: [{ hostValue: 2, hostOther: "fallback" }] },
    ],
    [
      "nullable-field",
      "let quantity: integer? = null\nlet box = {item: quantity}\nlet copy = box\nlet again = copy\nsay again.item otherwise hostValue\nquantity = 3\nexit",
      { fitting: [{ hostValue: "fallback" }] },
    ],
    [
      "null-get",
      "let quantity: integer? = null\nlet values = [quantity]\nlet copy = values\nsay copy.get(3, default: hostValue)\nexit",
      { fitting: [{ hostValue: "fallback" }] },
    ],
    ["host-sibling", "hostValue.other = 3\nlet box: integer = hostValue.amount\nsay box\nexit"],
    [
      "host-ancestor",
      "hostValue.box = {amount: 3}\nlet total = hostValue.box.amount + 2\nsay total\nexit",
    ],
  ];
  for (const [name, expression] of Object.entries({
    plus: "hostValue + 13",
    minus: "hostValue - 13",
    times: "hostValue * 3",
    divide: "hostValue / 3",
    mod: "hostValue % 3",
    less: "hostValue < 3",
    equal: "hostValue == 3",
    negate: "-hostValue",
    not: "not hostValue",
    fallback: "hostValue otherwise 3",
    convert: "toInteger(hostValue)",
    index: "[3, 4][hostValue]",
  }))
    cases.push([`op-${name}`, `let answer = ${expression}\nsay answer\nexit`]);
  cases.push(
    ["mixed-written-direct", 'let count: integer = 2\nsay [count, "bad"]\nexit'],
    ["mixed-written-first", 'let count: integer = 2\nsay [count, "bad"].first\nexit'],
    ["mixed-written-dict", 'let count: integer = 2\nsay dict{one: count, two: "bad"}\nexit'],
    ["mixed-written-set", 'let count: integer = 2\nsay set[count, "bad"]\nexit'],
    ["mixed-written-nested", 'let count: integer = 2\nsay {items: [[count, "bad"]]}\nexit'],
    ["mixed-written-stored", 'let count: integer = 2\nlet items = [count, "bad"]\nsay items\nexit'],
    [
      "mixed-named-argument",
      'function show(xs) { say xs }\nlet count = 2\nshow([count, "bad"])\nshow([count, "other"])\nexit',
    ],
    [
      "mixed-named-return",
      'let count = 2\nfunction make { return [count, "bad"] }\nsay make()\nexit',
    ],
  );
  const { extras: extras } = (() => {
    const extras = [
      [
        "parse-direct",
        "say fromJson(hostValue, default: 9)\nexit",
        { fitting: [{ hostValue: "9" }, { hostValue: '"word"' }] },
      ],
      ["parse-direct-list", "say fromJson(hostValue, default: [9])\nexit"],
      ["parse-direct-object", "say fromJson(hostValue, default: {value: 9})\nexit"],
      ["load-direct", 'say load("sample", default: 9)\nexit'],
      [
        "parse-in-call",
        "function show(x) { say x }\nshow(fromJson(hostValue, default: 9))\nshow(2)\nexit",
      ],
      [
        "parse-stored-control",
        "let amount = fromJson(hostValue, default: 9)\nsay amount\nexit",
        { fitting: [{ hostValue: "9" }, { hostValue: '"word"' }] },
      ],
    ];
    for (const [name, expr] of Object.entries({
      le: "hostValue <= 7",
      greater: "hostValue > 7",
      ge: "hostValue >= 7",
      and: "hostValue and true",
      or: "hostValue or false",
      builtin: "min(hostValue, 3)",
      method: "hostValue.toUpper()",
    }))
      extras.push([`extra-op-${name}`, `let answer = ${expr}\nsay answer\nexit`]);
    return { extras };
  })();
  cases.push(...extras);
  const { dischargeCases: dischargeCases } = (() => {
    const dischargeCases = [
      [
        "parse-stored-text",
        'let titleText = fromJson(hostValue, default: "safe")\nsay titleText\nexit',
      ],
      ["parse-stored-bool", "let enabled = fromJson(hostValue, default: true)\nsay enabled\nexit"],
      ["load-stored", 'let amount = load("sample", default: 9)\nsay amount\nexit'],
    ];
    return { dischargeCases };
  })();
  cases.push(...dischargeCases);
  const { readCases: readCases } = (() => {
    const readCases = [
      [
        "read-copy",
        "let quantity = 6.0\nif quantity is integer { let whole: integer = quantity\nsay whole }\nexit",
      ],
      [
        "read-op",
        "let quantity = 6.0\nif quantity is integer { let whole: integer = quantity + 3\nsay whole }\nexit",
      ],
      [
        "read-preserve",
        "let quantity = 6.0\nwhile quantity is integer { quantity = quantity + 1\nlet whole: integer = quantity\nsay whole\nbreak }\nexit",
      ],
      [
        "read-component",
        "let left = 6.0\nlet right = 4.0\nwhile left is integer { while right is integer { left = right\nright = left\nlet whole: integer = left\nsay whole\nbreak }\nbreak }\nexit",
      ],
      [
        "read-new-store",
        "let quantity = 6.0\nif quantity is integer { quantity = 2.5\nlet whole: number = quantity\nsay whole }\nexit",
      ],
    ];
    return { readCases };
  })();
  cases.push(...readCases);
  const { matrix: matrix } = (() => {
    const prefix = "let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\n";
    const values = {
      scalar: ["integer", "9"],
      list: ["integer[]", "[1]"],
      object: ["object", "{n: 1}"],
    };
    const shapes = {
      "mixed-list": '[count, "bad"]',
      "mixed-set": 'set[count, "bad"]',
      "mixed-dict": 'dict{a: count, b: "bad"}',
      "mixed-nested": '{items: [[count, "bad"]]}',
      "plain-list": "[1, 2]",
      // (a literal with one named element, no mixed kinds: its composed questions are the children's reads, r4.144 B1)
      "named-list": "[count]",
      "named-set": "set[count]",
      "named-dict": "dict{a: count}",
      "named-object": "{n: count}",
      "named-union": ["let pick: integer | boolean = 3\n", "[pick]"],
      "named-nullable": ["let maybe: integer? = 3\n", "{n: maybe}"],
      "named-retained": ["let kept = 8.0\nlet observed: number = kept\n", "[kept]"],
      "named-copy": ["let copied = base\n", "{n: copied}"],
      "lazy-list": ["let basket = [2, 4]\n", "[basket.first]"],
      "lazy-nested": ["let basket = [2, 4]\n", "{outer: {inner: basket.first}}"],
      "lazy-copy": ["let basket = [2, 4]\nlet mirror = basket\n", "set[mirror.first]"],
      "ingress-scalar": "hostValue",
      "ingress-list": "[hostValue]",
      "ingress-object": "{n: hostValue}",
      "copy-written": "base",
      "copy-inferred": "src",
    };
    for (const [call, open] of [
      ["parse", "fromJson(hostValue"],
      ["load", 'load("key"'],
    ])
      for (const [kind, [type, literal]] of Object.entries(values)) {
        const name = `${call}-${kind}`;
        shapes[name] = `${open}, default: ${literal})`;
        shapes[`${name}-written`] = [
          `let fallback: ${type} = ${literal}\n`,
          `${open}, default: fallback)`,
        ];
        shapes[`${name}-inferred`] = [`let fallback = ${literal}\n`, `${open}, default: fallback)`];
        shapes[`${name}-call`] = [
          `function fallback { return ${literal} }\n`,
          `${open}, default: fallback())`,
        ];
      }
    const positions = {
      "store-inferred": (x) => `let v = ${x}\nsay v`,
      "store-written": (x) => `let v: (integer | string)[] = [1]\nv = ${x}\nsay v`,
      direct: (x) => `say ${x}`,
      "argument-single": (x) => `function f(p) { say p }\nf(${x})`,
      "argument-multi": (x) => `function f(p) { say p }\nf(${x})\nf(${x})`,
      return: (x) => `function make { return ${x} }\nsay make()`,
      condition: (x) => `if ${x} != null { say "set" }`,
      "selection-first": (x) => `say ${x}.first`,
      "selection-get": (x) => `say ${x}.get(0, default: 3)`,
    };
    const matrix = [];
    for (const [p, place] of Object.entries(positions))
      for (const [s, shape] of Object.entries(shapes)) {
        const [declarations, value] = typeof shape === "string" ? ["", shape] : shape;
        matrix.push([`m-${p}-${s}`, `${prefix}${declarations}${place(value)}\nsay "DONE"\nexit`]);
      }
    return { matrix };
  })();
  cases.push(...matrix);
  const { cases: r6 } = (() => {
    const cases = [];
    const add = (name, source, config = {}) => cases.push([name, source + "\nexit", config]);
    const prefix = "let seed: integer = 7\n";
    for (const [name, expr] of Object.entries({
      list: "[seed, false]",
      set: "set[seed, false]",
      dict: "dict{west: seed, east: false}",
      nested: "{payload: [set[seed, false]]}",
    })) {
      add("direct-" + name, prefix + `say ${expr}`);
      add("condition-" + name, prefix + `if ${expr} != null { say "there" }`);
    }
    add(
      "return-nested",
      prefix +
        "function create { return dict{west: [seed, false], east: [seed, true]} }\nsay create()",
    );
    add(
      "multi-default-argument",
      prefix + "function show(p = [3]) { say p }\nshow([seed, false])\nshow([seed, true])",
    );
    add("single-argument", prefix + "function show(p) { say p }\nshow(set[seed, false])");
    add("store-inferred", prefix + "let bag = [[seed, false]]\nsay bag");
    add("store-written", prefix + "let bag: (integer | boolean)[] = [seed, false]\nsay bag");
    add("add-receiver", prefix + "let bag = []\nbag.add([seed, false])\nsay bag");
    add("loop-iterable", prefix + "for value in [seed, false] { say value }");
    add("computed-index", prefix + "let bag = [8, 9]\nsay bag[[seed, false].first]");
    add("interpolation", prefix + 'say "value: ${[seed, false]}"');
    for (const [name, expr, valid] of [
      ["parse-scalar", "fromJson(hostValue, default: false)", "true"],
      ["parse-list", "fromJson(hostValue, default: [false])", "[true]"],
      ["parse-object", "fromJson(hostValue, default: {flag: false})", '{"flag":true}'],
      ["load-scalar", 'load("r6-key", default: false)', null],
      ["load-list", 'load("r6-key", default: [false])', null],
      ["load-object", 'load("r6-key", default: {flag: false})', null],
    ]) {
      add(name + "-direct", `say ${expr}`, { fitting: [{ hostValue: valid }] });
      add(name + "-argument", `function show(p) { say p }\nshow(${expr})\nshow(${expr})`, {
        fitting: [{ hostValue: valid }],
      });
    }
    for (const [name, type, defaultValue, valid] of [
      ["nullable", "boolean?", "null", "null"],
      ["union", "integer | boolean", "false", "true"],
    ]) {
      add(
        "stored-parse-" + name,
        `let value: ${type} = fromJson(hostValue, default: ${defaultValue})\nsay value`,
        { fitting: [{ hostValue: valid }] },
      );
      add(
        "stored-load-" + name,
        `let value: ${type} = load("r6-key", default: ${defaultValue})\nsay value`,
        { fitting: [{}] },
      );
    }
    add("stored-parse-inferred", "let value = fromJson(hostValue, default: false)\nsay value", {
      fitting: [{ hostValue: "true" }],
    });
    add("stored-load-inferred", 'let value = load("r6-key", default: false)\nsay value', {
      fitting: [{}],
    });
    add("typed-selection-empty", "say fromJson(hostValue, default: [false]).last", {
      fitting: [{ hostValue: "[true]" }],
    });
    add("typed-selection-random", 'say load("r6-key", default: [false]).random', { fitting: [{}] });
    add(
      "typed-null-fallback",
      "let value: integer? = fromJson(hostValue, default: null)\nsay value otherwise hostOther",
      { fitting: [{ hostValue: "null", hostOther: 3 }] },
    );
    add(
      "typed-copy-null-fallback",
      'let value: integer? = load("r6-key", default: null)\nlet wrap = {part: value}\nlet copy = wrap\nsay copy.part otherwise hostOther',
      { fitting: [{ hostOther: "fallback" }] },
    );
    add("decline-untyped-parse", "say fromJson(hostValue)", { fitting: [{ hostValue: "42" }] });
    add("mixed-literal-only", "say set[3, false]", { literalErrors: true });
    add("written-reject", "let values: boolean dict = dict{west: 3, east: false}", {
      literalErrors: true,
    });
    add("own-fallback-ingress", "say null otherwise hostValue", { fitting: [{ hostValue: "ok" }] });
    add("consumer-own-ingress", 'repeat hostValue { say "step" }', { fitting: [{ hostValue: 1 }] });
    add("written-ingress", "let value: boolean = hostValue\nsay value", {
      fitting: [{ hostValue: true }],
    });
    add("literal-same-identity", prefix + "say [seed, seed]");
    add("interaction-mixed", prefix + "showButton [seed, false].first");
    add("interaction-parse", 'showButton fromJson(hostValue, default: "Continue")', {
      fitting: [{ hostValue: '"Go"' }],
    });
    add("named-parse", "let fallback: integer = 3\nsay fromJson(hostValue, default: fallback)", {
      fitting: [{ hostValue: "4" }, { hostValue: '"wrong"' }],
    });
    add("named-load", 'let fallback: boolean = false\nsay load("key", default: fallback)', {
      fitting: [{}],
    });
    add(
      "named-parse-list",
      "let fallback: integer[] = [3]\nsay fromJson(hostValue, default: fallback)",
      { fitting: [{ hostValue: "[4]" }] },
    );
    add(
      "named-load-object",
      'let fallback: object = {amount: 3}\nsay load("key", default: fallback)',
      { fitting: [{}] },
    );
    return { cases };
  })();
  cases.push(...r6.map(([name, ...rest]) => [`a6-${name}`, ...rest]));
  const { own: r7 } = (() => {
    const own = [
      ["composed-list", "let ratio: number = 2.75\nsay [[ratio, 3.5]]\nexit"],
      ["composed-set", 'let caption: string = "ink"\nsay set[caption, "blue"]\nexit'],
      ["composed-dict", "let enabled: boolean = true\nsay dict{a: enabled, b: false}\nexit"],
      [
        "composed-object",
        "let ratio: number = 2.75\nsay {outer: {inner: ratio, sibling: false}}\nexit",
      ],
      [
        "composed-union",
        "let variant: string | boolean = true\nsay {outer: {inner: variant}}\nexit",
      ],
      [
        "composed-nullable",
        "let interval: duration? = null\nsay [{inner: interval}]\ninterval = 2 s\nexit",
      ],
      [
        "composed-copy",
        "let seed: number[] = [2.5]\nlet mirror = seed\nsay {outer: {inner: mirror}}\nexit",
      ],
      [
        "composed-result",
        "function makeRatio(ratio: number): number { return ratio }\nsay [{inner: makeRatio(2.5)}]\nexit",
      ],
      ["lazy-list", "let basket = [2, 4]\nsay [basket.first]\nexit"],
      ["lazy-nested", "let basket = [2, 4]\nsay {outer: {inner: basket.first}}\nexit"],
      ["lazy-copy", "let basket = [2, 4]\nlet mirror = basket\nsay set[mirror.first]\nexit"],
      [
        "lazy-member",
        "let basket = [{score: 2}, {score: 4}]\nsay dict{a: basket.first.score}\nexit",
      ],
      [
        "default-projected",
        "let defaults = {inner: {fallback: 4}}\nsay fromJson(hostValue, default: defaults.inner.fallback)\nexit",
      ],
      [
        "default-copy-chain",
        'let seed: boolean = false\nlet second = seed\nlet third = second\nsay load("cache", default: third)\nexit',
      ],
      [
        "default-function-parameter",
        "function decode(fallback: integer) { say fromJson(hostValue, default: fallback) }\ndecode(4)\nexit",
      ],
      [
        "default-call-nested",
        'function fallback: integer[] { return [4] }\nsay load("cache", default: fromJson(hostValue, default: fallback()))\nexit',
      ],
      [
        "existence-present",
        "let fallback: object = {score: 4}\nsay fromJson(hostValue, default: fallback).score\nexit",
      ],
      [
        "existence-absent",
        "let fallback: object = {score: 4}\nsay fromJson(hostValue, default: fallback).other\nexit",
      ],
      ["literal-element", "let score: integer = 4\nsay set[score].first\nexit"],
    ];
    for (const [kind, type, value] of [
      ["text", "string", '"ink"'],
      ["boolean", "boolean", "true"],
      ["number", "number", "2.75"],
      ["duration", "duration", "3 s"],
      ["list", "integer[]", "[4, 5]"],
      ["object", "object", "{score: 4}"],
      ["nullable", "integer?", "null"],
    ])
      for (const call of ["fromJson(hostValue", 'load("cache"'])
        for (const argument of [false, true]) {
          const invoke = `${call}, default: backup)`;
          own.push([
            `default-${call.startsWith("load") ? "load" : "parse"}-${kind}-${argument ? "arg" : "direct"}`,
            `let backup: ${type} = ${value}\n${argument ? "function show(value) { say value }\nshow(" + invoke + ")" : "say " + invoke}\nexit`,
          ]);
        }
    for (const [kind, type, value] of [
      ["text", "string", '"ink"'],
      ["nullable", "integer?", "null"],
    ])
      for (const provenance of ["inferred", "call"])
        own.push([
          `default-${kind}-${provenance}`,
          `${provenance === "inferred" ? `let backup = ${value}` : `function backup: ${type} { return ${value} }`}\nsay fromJson(hostValue, default: backup${provenance === "call" ? "()" : ""})\nexit`,
        ]);
    return { own };
  })();
  cases.push(...r7.map(([name, ...rest]) => [`a7-${name}`, ...rest]));
  cases.push(
    [
      "rv-copy-list",
      "let origin: number = 3.5\nlet quantity = origin\nlet observed: number = quantity\nsay [quantity]\nexit",
    ],
    ["rv-written-list", "let quantity: number = 3.5\nsay [quantity]\nexit"],
    ["rv-written-object", "let quantity: number = 3.5\nsay {part: quantity}\nexit"],
    ["rv-written-set", "let quantity: number = 3.5\nsay set[quantity]\nexit"],
    ["rv-written-dict", "let quantity: number = 3.5\nsay dict{part: quantity}\nexit"],
    [
      "rv-retained-list",
      "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay [quantity] }\nexit",
    ],
    [
      "rv-retained-object",
      "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay {part: quantity} }\nexit",
    ],
    ["rv-union-list", "let quantity: integer | boolean = 3\nsay [quantity]\nexit"],
    ["rv-nullable-object", "let quantity: integer? = 3\nsay {part: quantity}\nexit"],
  );
  const { formerExceptions: formerExceptions } = (() => {
    const formerExceptions = [
      [
        "x1165-list-default",
        'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n',
      ],
      [
        "x1165-chunks",
        "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n",
      ],
    ];
    return { formerExceptions };
  })();
  cases.push(...formerExceptions);
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
