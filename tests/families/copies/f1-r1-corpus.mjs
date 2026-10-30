// F1 review r1's differential set (`probe.mjs diff`): 8 written types × 7 forms × 15 mutations, cycles, parameter
// defaults, list adds, its 12 scaling shapes at 5, and 240 whole-copy, cycle and diamond graphs
// (/tmp/agent-work/o4-m4-f1/review/r1/probe.mjs; copy kept in desktop:~/work/evidence/1463/retained/).
export const cases = (() => {
  const fields = (n, value = "typed") =>
    Array.from({ length: n }, (_, i) => `f${i}:${value}`).join(",");
  const lines = (...s) => s.flat().join("\n") + "\nexit\n";
  const copies = (n, expr) => Array.from({ length: n }, (_, i) => `let a${i}=${expr(i)}`);
  const seed = (n) => ["let typed:integer=1", `let root={${fields(n)}}`];
  const each = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const shapes = {
    "double-store-chain": (n) =>
      lines(
        seed(n),
        copies(n, (i) => (i ? `a${i - 1}` : "root")).map(
          (s, i) => s + `\na${i}=${i ? `a${i - 1}` : "root"}`,
        ),
      ),
    "wrapped-projection-chain": (n) =>
      lines(
        seed(n),
        "let box=[root]",
        copies(n, (i) => `[${i ? `a${i - 1}` : "box"}[0]]`),
      ),
    "object-projection-chain": (n) =>
      lines(
        seed(n),
        "let box={p:root}",
        copies(n, (i) => `{p:${i ? `a${i - 1}` : "box"}.p}`),
      ),
    "replaced-copy": (n) =>
      lines(
        seed(n),
        `let other={${fields(n, "2")}}`,
        copies(n, () => "root").map((s, i) => s + `\na${i}=other`),
      ),
    "two-roots": (n) =>
      lines(
        seed(n),
        `let other={${fields(n)}}`,
        copies(n, () => "root").map((s, i) => s + `\na${i}=other`),
      ),
    "fanin-own-extra": (n) =>
      lines(
        seed(n),
        copies(n, () => "root").map((s, i) => s + `\na${i}.extra=2`),
        `let out=[${each(n, (i) => `a${i}`).join(",")}]`,
      ),
    "fanin-distinct-extra": (n) =>
      lines(
        seed(n),
        copies(n, () => "root").map((s, i) => s + `\na${i}.extra${i}=2`),
        `let out=[${each(n, (i) => `a${i}`).join(",")}]`,
      ),
    "tree-distinct-stores": (n) =>
      lines(
        seed(n),
        copies(n, (i) => (i ? `a${(i - 1) >> 1}` : "root")).map((s, i) => s + `\na${i}.f${i}=2`),
      ),
    "path-cycle-chain": (n) =>
      lines(
        seed(n),
        copies(n, (i) => (i ? `a${i - 1}` : "root")).map((s, i) => s + `\na${i}.q=a${i}`),
      ),
    "deep-wrapper": (n) =>
      lines(
        seed(n),
        copies(n, (i) => `{p:${i ? `a${i - 1}` : "root"}}`),
      ),
    "fanout-list": (n) =>
      lines(
        seed(n),
        copies(n, () => "[root]"),
      ),
    "cycle-many-sources": (n) =>
      lines(
        seed(n),
        copies(n, (i) => (i ? `a${i - 1}` : "root")),
        `a0=a${n - 1}`,
      ),
  };
  const cases = [];
  const add = (name, source) => cases.push([name, source + "\nexit\n"]);
  const types = [
    ["integer", "1"],
    ["integer?", "null"],
    ["null", "null"],
    ["list", "[1]"],
    ["integer[]", "[1]"],
    ["integer?[]", "[null]"],
    ["object", "{p:1}"],
    ["string", '"s"'],
  ];
  const forms = [
    ["plain", "root"],
    ["chain", "mid"],
    ["literal", "[root][0]"],
    ["object", "{p:root}.p"],
    ["projection", "holder[0]"],
    ["otherwise", "null otherwise root"],
    ["get", "[].get(0,default:root)"],
  ];
  const mutations = [
    "",
    "root.f=hostValue",
    "a.f=hostValue",
    'a.f="bad"',
    "a={f:hostValue,g:typed}",
    'a={f:"bad",g:typed}',
    "a.f=null",
    "a=other",
    "a=hostValue",
    "a.q=a",
    "a=root\nroot=a",
    "a.f=other.f",
    "a.g=1\na=other",
    "if hostValue is integer { a.f=hostValue }",
    "a.f=hostValue\na.f=typed",
  ];
  for (const [t, v] of types)
    for (const [form, e] of forms)
      for (const mutation of mutations)
        add(
          `${t}/${form}/${mutation}`,
          `let typed:${t}=${v}\nlet root={f:typed,g:typed}\nlet other={f:2,g:typed}\nlet mid=root\nlet holder=[root]\nlet a=${e}\n${mutation}`,
        );
  for (const [t, v] of types)
    for (const tail of [
      "",
      "let copy=a",
      "let copy=a\ncopy.f=hostValue",
      "a=b",
      "a.q=b\nb.q=a",
      "a=b\nb=a",
      "a=[b]\nb=a[0]",
      "a.p=b\nb=a.p",
    ])
      add(`cycle/${t}/${tail}`, `let typed:${t}=${v}\nlet a={f:typed}\nlet b=a\n${tail}`);
  for (const [t, v] of types)
    for (const mutation of ["", "a.f=hostValue", 'a.f="bad"', "a=other"])
      for (const calls of ["", "use()", "use(root)\nuse(other)"])
        add(
          `default/${t}/${mutation}/${calls}`,
          `let typed:${t}=${v}\nlet root={f:typed}\nlet other={f:"bad"}\nfunction use(p=root){let a=p\n${mutation}\nlet b=a}\n${calls}`,
        );
  for (const [t, v] of types)
    for (const op of [
      "xs.add(root)",
      "xs.add({f:hostValue})",
      'xs.add({f:"bad"})',
      'xs=[root,{f:"bad"}]',
      "xs[0].f=hostValue",
      'xs[0].f="bad"',
    ])
      add(
        `adds/${t}/${op}`,
        `let typed:${t}=${v}\nlet root={f:typed}\nlet xs=[root]\n${op}\nlet copy=xs`,
      );
  for (const name of Object.keys(shapes)) add(`shape/${name}`, shapes[name](5));
  // the whole-copy, cycle and diamond graph space: direct typed roots, literals, path-changing edges, own stores
  for (let i = 0; i < 240; i++) {
    const bases = [
      "root",
      "b",
      "[root][0]",
      "{p:root}.p",
      "root otherwise {f:1}",
      "[].get(0,default:root)",
    ];
    const stores = [
      "",
      "a.f=hostValue",
      'b.f="bad"',
      "a=b\nb=a",
      "a.q=b\nb.q=a",
      "a=other",
      "b=a\na={f:1}",
      "a.f=null",
    ];
    add(
      `graph/${i}`,
      `let typed:integer?=1\nlet text:string="s"\nlet root={f:typed,g:typed}\nlet other={f:text,g:text}\nlet b=root\nlet a=${bases[i % 6]}\n${stores[((i / 6) | 0) % 8]}\nlet c=${["a", "b", "[a,b][0]", "{p:a}.p", "a.q"][(i / 48) | 0]}\n${i % 2 ? "c.f=hostValue" : ""}`,
    );
  }
  return cases;
})();

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node probe.mjs diff", "/tmp/agent-work/o4-m4-f1/review/r1/report.md:139"]],
  sources: 1300,
  sha256: "391387ea5ece03f0fc0ffd05311071d156e4218939345e7aa0ed96d16bb50671",
};
