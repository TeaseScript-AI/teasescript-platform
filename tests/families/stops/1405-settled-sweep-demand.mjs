// 38 fixed settled sweep demand inputs; #1405, builder/review archive
// (desktop:~/work/evidence/1405/3627aa0f4/probe/settled-sweep-demand.mjs).
export const cases = (() => {
  const object = (props) => ({
    kind: "object",
    properties: Object.entries(props).map(([name, value]) => ({ name, value })),
  });
  const cases = {
    // Astra B1: an inferred scalar contract, a record's, a found error, a quiet proof
    scalar: [
      'let count = 1\ncount = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [{ hostValue: 2, hostOther: 2 }],
      [{ hostValue: 1.5, hostOther: 2 }],
    ],
    record: [
      'let parcel = {count: 1}\nparcel = hostValue\nlet n: integer = hostOther\nsay "DONE"\nexit\n',
      [{ hostValue: object({ count: 2 }), hostOther: 2 }],
      [{ hostValue: object({ count: 1.5 }), hostOther: 2 }],
    ],
    error: [
      'let good = {n:1}\nlet bad = {n:"x"}\nlet copy = good\ncopy = bad\nsay copy.n\nlet n: integer = hostValue\nexit\n',
      [{ hostValue: 2, hostOther: 2 }],
      [],
    ],
    quiet: [
      'let count = 2\nrepeat count {}\nlet n: integer = hostValue\nsay "DONE"\nexit\n',
      [{ hostValue: 2, hostOther: 2 }],
      [{ hostValue: 1.5, hostOther: 2 }],
    ],
    // the earlier shapes
    inherited: [
      'let a: integer = 0\nlet b = a\nb = hostValue\nsay "DONE"\nexit\n',
      [{ hostValue: 2, hostOther: 2 }],
      [{ hostValue: "wrong", hostOther: 2 }],
    ],
    nestedRecord: [
      'let b = {stats: {n: 1}}\nb = hostValue\nsay "DONE"\nexit\n',
      [{ hostValue: object({ stats: object({ n: 2 }) }), hostOther: 2 }],
      [{ hostValue: object({ stats: object({ n: "wrong" }) }), hostOther: 2 }],
    ],
    fromJson: [
      'let b: integer = fromJson(hostValue, default: 0)\nsay b\nsay "DONE"\nexit\n',
      [
        { hostValue: '"wrong"', hostOther: 2 },
        { hostValue: "5", hostOther: 2 },
      ],
      [],
    ],
    // #1172's explanations: a `missing` read's own-store question (`hasWriter`), a parameter's default (`defaultOf`)
    missingRead: [
      'let flag: boolean = hostValue\nlet room = {n: 1}\nroom = {n: 1}\nif flag { room = {other: 0} }\nsay room.n\nsay room.n\nsay "DONE"\nexit\n',
      [{ hostValue: false, hostOther: 2 }],
      [{ hostValue: true, hostOther: 2 }],
    ],
    // (functions are outside the candidate route: these two through their analysis alone)
    parameterRead: [
      'function show(item) {\n  say item.name\n  say item.name\n}\nshow({name: "n0"})\nshow({name: "n1"})\nlet n: integer = hostValue\nsay "DONE"\nexit\n',
      [],
      [],
      true,
    ],
    nullDefault: [
      'function show(item = null) {\n  say item.name\n}\nshow({name: "n0"})\nlet n: integer = hostValue\nexit\n',
      [],
      [],
      true,
    ],
    // Astra's round-2 sources (`astra-m4-s8b-evidence/sweep.mjs`): a copied record, quiet uses, a default beside an
    // `otherwise`, a copied nested-field error, a missing property, a nested typed parse, an A6 cycle (functions below)
    aRecord: [
      'let seed = {ticks: 2, title: "ok"}\nlet state = seed\nstate = hostValue\nrepeat state.ticks {}\nsay state.title\nexit\n',
      [{ hostValue: object({ ticks: 2, title: "yes" }), hostOther: 2 }],
      [
        { hostValue: object({ ticks: 1.5, title: "yes" }), hostOther: 2 },
        { hostValue: object({ ticks: 2, title: 3 }), hostOther: 2 },
      ],
    ],
    aQuiet: [
      "let slots = [3, 7]\nlet index = 1\nlet rounds = 2\nrepeat rounds { say slots[index] }\nlet sentinel: integer = hostValue\nexit\n",
      [{ hostValue: 2, hostOther: 2 }],
      [{ hostValue: 1.5, hostOther: 2 }],
    ],
    aFallback: [
      "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
      [{ hostValue: 2, hostOther: 3 }],
      [{ hostValue: "bad", hostOther: 3 }],
    ],
    aOtherwise: [
      'let anchor = 4\nlet value = anchor otherwise hostValue\nsay value\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 3 }],
      [{ hostValue: "bad", hostOther: 3 }],
    ],
    // TABLE r4.100's neighbour: an `otherwise` whose left is an inferred list's element
    aElementOtherwise: [
      'let items = [2, 3]\nlet value = items[0] otherwise hostValue\nsay value\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 3 }],
      [{ hostValue: "bad", hostOther: 3 }],
    ],
    // Codex r8's B1 and its copy/projection variants: a settled contract reached through copies, a field, a chain
    writtenCopy: [
      'let items: integer[] = [2, 3]\nlet alias = items\nsay alias.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 4 }],
      [{ hostValue: "bad", hostOther: 4 }],
    ],
    copyChain: [
      'let items: integer[] = [2, 3]\nlet a = items\nlet b = a\nsay b.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 4 }],
      [{ hostValue: "bad", hostOther: 4 }],
    ],
    fieldCopy: [
      'let items: integer[] = [2, 3]\nlet box = {xs: items}\nsay box.xs.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 4 }],
      [{ hostValue: "bad", hostOther: 4 }],
    ],
    inferredCopy: [
      'let items = [2, 3]\nlet alias = items\nsay alias.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 4 }],
      [{ hostValue: "bad", hostOther: 4 }],
    ],
    nullableCopy: [
      'let base: integer? = null\nlet copy = base\nlet v = copy otherwise hostValue\nsay v\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 4 }],
      [{ hostValue: "bad", hostOther: 4 }],
    ],
    nullableListCopy: [
      'let base: integer[]? = hostValue\nlet copy = base\nsay copy.length\nsay "AFTER"\nexit\n',
      [{ hostValue: { kind: "list", items: [1, 2] }, hostOther: 4 }],
      [{ hostValue: null, hostOther: 4 }],
    ],
    // a fixed need read from a domain (S3 §5 revision 15): a copied written list that may be empty, its selection
    emptyCopy: [
      'let grow: boolean = hostValue\nlet a: integer[] = []\nif grow { a.add(2) }\nlet b = a\nsay b.first\nsay "AFTER"\nexit\n',
      [],
      [],
      true,
    ],
    aWritten: [
      'let items: integer[] = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 3 }],
      [{ hostValue: "bad", hostOther: 3 }],
    ],
    aInferred: [
      'let items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
      [{ hostValue: 2, hostOther: 3 }],
      [{ hostValue: "bad", hostOther: 3 }],
    ],
    aError: [
      'let original = {nested: {n: 1}}\nlet text = {nested: {n: "bad"}}\nlet copied = original\ncopied = text\nlet final = copied\nrepeat final.nested.n {}\nlet sink: integer = hostValue\nexit\n',
      [],
      [],
    ],
    aMissing: [
      "let flag: boolean = hostValue\nlet state = {left: 1, right: 2}\nif flag { state = {other: 3} }\nlet first = state.left\nlet second = state.right\nsay first\nsay second\nexit\n",
      [{ hostValue: false, hostOther: 2 }],
      [{ hostValue: true, hostOther: 2 }],
    ],
    aCycle: [
      'let a = 1\nlet b = a\na = b\nb = "bad"\na = hostValue\nrepeat a {}\nlet n: integer = hostOther\nexit\n',
      [{ hostValue: 2, hostOther: 2 }],
      [{ hostValue: 1.5, hostOther: 2 }],
    ],
    aDefaults: [
      'function emit(item = null) {\n let alias = item\n say alias.title\n say item.title\n}\nemit({title: "one"})\nemit({title: "two"})\nlet sink: integer = hostValue\nexit\n',
      [],
      [],
      true,
    ],
    aMethod: [
      'function read(item) {\n let alias = item\n say alias.get("name", default: "blank")\n say item.name\n}\nread({name: "one"})\nread({name: "two"})\nlet sink: integer = hostValue\nexit\n',
      [],
      [],
      true,
    ],
    // Codex r6's nested typed default, whose route questions take more than 400 units past its analysis
    // Astra r3's T1 (TABLE r4.108): a property store's guard, and the guard beside a default a stop marks
    astraGuard: [
      'let vessel = hostValue\nvessel.amount = 4\nsay "AFTER"\nexit\n',
      [{ hostValue: object({ amount: 1 }), hostOther: 2 }],
      [{ hostValue: object({ other: 2 }), hostOther: 2 }],
    ],
    astraMask: [
      'let nums: number?[] = [null,1.25]\nlet pack={nums:nums}\nlet twin=pack\nsay twin.nums.get(4, default:hostValue)\nlet vessel=hostOther\nvessel.amount=4\nsay "AFTER"\nexit\n',
      [{ hostValue: 2.5, hostOther: object({ amount: 1 }) }],
      [
        { hostValue: 2.5, hostOther: object({ other: 2 }) },
        { hostValue: "bad", hostOther: object({ amount: 1 }) },
      ],
    ],
    // Astra r3's N1: C5's record at the literal the receiver copies
    astraAbsent: [
      "let original = {kept:1}\nlet mirror = original\nmirror.absent = hostValue\nexit\n",
      [],
      [],
    ],
    // Codex r12's B1 (TABLE r4.113): a host global the script writes; its reads' ingress is structural
    b1Field: [
      "hostValue.n = 2\nexit\n",
      [{ hostValue: object({ n: 1 }), hostOther: 2 }],
      [{ hostValue: 3, hostOther: 2 }],
    ],
    b1PathNull: [
      'hostValue.n = null\nsay hostValue.n otherwise "ok"\nexit\n',
      [{ hostValue: object({ n: 1 }), hostOther: 2 }],
      [{ hostValue: 3, hostOther: 2 }],
    ],
    b1Below: [
      "hostValue.n = 2\nsay hostValue.n.x\nexit\n",
      [],
      [{ hostValue: object({ n: 1 }), hostOther: 2 }],
    ],
    b1ReadThenField: [
      "say hostValue.m\nhostValue.n = 2\nexit\n",
      [{ hostValue: object({ m: 1, n: 1 }), hostOther: 2 }],
      [{ hostValue: object({ n: 1 }), hostOther: 2 }],
    ],
    // Astra r4's N1: #1165's class, a typed parse's nested default
    n1Chunks: [
      "let parsed = fromJson(hostValue, default: {chunks: [[{id: 5}]]})\nsay parsed.chunks.get(0, default: [{id: 4}])[0].id\nexit\n",
      [
        { hostValue: '{"chunks":[[{"id":7}]]}', hostOther: 2 },
        { hostValue: '{"chunks":[[{"id":"bad"}]]}', hostOther: 2 },
        { hostValue: "{}", hostOther: 2 },
      ],
      [],
    ],
    nestedDefault: [
      'let value = fromJson(hostValue, default: {list: [{n: fromJson("3", default: 0), open: null}]})\nsay value.list.get(0, default: {n: 0, open: null}).n\nsay "DONE"\nexit\n',
      [
        { hostValue: '{"list":[{"n":2,"open":"text"}]}', hostOther: 2 },
        { hostValue: '{"list":[{"n":"wrong"}]}', hostOther: 2 },
      ],
      [],
    ],
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
      "node settled-sweep-demand.mjs (no command recorded: its run without arguments)",
      "D/1405/3627aa0f4/probe/settled-sweep-demand.mjs",
    ],
  ],
  sources: 38,
  sha256: "29962c96f3e3b4f8c58070a079b443e33fb613b3cd3c87126181200e2812bd64",
};
