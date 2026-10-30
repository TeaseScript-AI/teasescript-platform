// #1293's review r3 (the #1249 A2 review): its own matrix cases, seven store shapes over every ordered pair of five
// values, rings of 2 to 5 copies at depths 0 to 2 fed at each member in six ways, and container boundaries
// (desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/make-cases.py, run by matrix.mjs). The 301 cases it copied from
// review r2's case files (cases.json, dict-cases.json, focus.json, minimize.json, effects.json) are r2's, not copied.
export const cases = (() => {
  const out = [];
  const add = (name, source) => out.push([`r3/${name}`, source + "\nexit\n"]);
  const values = ["1", '"x"', "true", "null", "2.5"];
  const SHAPES = {
    relay: 'let a={box:{inner:bad}}\nlet b={box:{inner:good}}\nlet c=b\nc=a\nsay "AFTER"\nb=c\na=b',
    single: "let a=good\nlet b=a\nlet c=bad\na=b\nb=c\nc=a",
    property: "let a={p:good,q:good}\nlet b=a\nlet c=b\na=c\nb.p=bad\nc.q=bad",
    add: "let a=[good]\nlet b=a\nlet c=b\na=c\nb.add(bad)\nc.add(good)",
    nested: "let a=good\nlet b=a\na=b\nlet c={inner:a}\nlet d=c\nc=d\nd={inner:bad}",
    literal: "let a=good\nlet b=a\na=b\nlet xs=[a,bad]\nlet ys=[bad,b]\nxs.add(b)",
    split: "let a=good\nlet b=a\nlet c=b\na=c\nb=bad\nc=a\nlet xs=[c,bad]",
  };
  for (const v of values)
    for (const w of values) {
      if (v === w) continue;
      for (const [shape, body] of Object.entries(SHAPES))
        add(`${shape}/${v}/${w}`, `let good={n:${v}}\nlet bad={n:${w}}\n` + body);
    }
  for (const n of [2, 3, 4, 5])
    for (const depth of [0, 1, 2])
      for (let feed = 0; feed < n; feed++)
        for (const kind of ["copy", "property", "literal", "null", "add", "double"]) {
          const wrap = (x) =>
            depth === 1 ? `{inner:${x}}` : depth === 2 ? `{outer:{inner:${x}}}` : x;
          const listify = (x) => (kind === "add" ? `[${x}]` : x);
          const s = ["let good={n:1}", 'let bad={n:"x"}', `let a0=${listify(wrap("good"))}`];
          for (let i = 1; i < n; i++) s.push(`let a${i}=a${i - 1}`);
          s.push(`a0=a${n - 1}`);
          if (["copy", "literal", "null", "add"].includes(kind)) {
            const val =
              kind === "copy" || kind === "add" ? "bad" : kind === "literal" ? '{n:"x"}' : "null";
            s.push(kind === "add" ? `a${feed}.add(${wrap(val)})` : `a${feed}=${wrap(val)}`);
          } else if (kind === "property")
            s.push(
              `a${feed}.` + (depth === 1 ? "inner." : depth === 2 ? "outer.inner." : "") + 'n="x"',
            );
          else {
            for (let i = 0; i < n; i++) s.push(`a${i}=a${(i + n - 1) % n}`);
            s.push(`a${feed}=${wrap("bad")}`);
          }
          add(`ring/n${n}/d${depth}/f${feed}/${kind}`, s.join("\n"));
        }
  // list, set and dict boundaries and paths supplied by different members
  for (const [box, x] of [
    ["[{v}]", "[a,bad]"],
    ["set [{v}]", "set [a,bad]"],
    ["dict {{key:{v}}}", "dict {key:a}"],
  ])
    for (const extra of ["b=bad", 'b.n="x"', "a=b\nb=a"])
      add(
        `container/${box}/${extra}`,
        `let good={n:1}\nlet bad={n:"x"}\nlet a=good\nlet b=a\na=b\n${extra}\nlet x=${x}`,
      );
  return out;
})();

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node matrix.mjs $root $root/cases.json $root/results/matrix-v2.jsonl",
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-matrix.sh:3",
    ],
  ],
  sources: 401,
  sha256: "8900b1a8b3056a15c99e2e0a7b028bca3255e0be72ca58c05ceecb1f5feffe38",
};
