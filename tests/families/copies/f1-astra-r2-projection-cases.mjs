// Astra review.
export const cases = (() => {
  const permutations = (xs) =>
    xs.length === 0
      ? [[]]
      : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((t) => [x, ...t]));
  function cases() {
    const out = [];
    const add = (name, body) =>
      out.push({ name, files: [{ path: "main.tease", source: body + "\nexit\n" }] });
    for (const reverse of [false, true])
      add(
        `r1-${reverse ? "reverse" : "original"}`,
        `let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[${reverse ? "root,other" : "other,root"}]`,
      );
    const shapes = [
      [
        "mixed-fields",
        'let t:string="oak"\nlet n:integer=7\nlet a={p:t,q:1}\nlet b={p:3,q:n}\nlet c={p:"elm",unique:false}',
        ["a", "b", "c"],
      ],
      [
        "nested-middle",
        'let t:string="oak"\nlet a={box:{p:t,q:1}}\nlet b={box:{p:3,q:2}}\nlet c={box:{p:"elm",only:true}}',
        ["a", "b", "c"],
      ],
      [
        "copy-chain-locals",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet c0=root\nlet c1=c0\nc1.q=2\nlet c2=c1\nc2.only=true\nlet a={p:3,q:2}\nlet b={p:"elm"}',
        ["c2", "a", "b"],
      ],
      [
        "rejected-middle-store",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet a=root\na.p=9\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
      [
        "union",
        'let t:integer|string="oak"\nlet a={p:t,q:1}\nlet b={p:3}\nlet c={p:true,only:null}',
        ["a", "b", "c"],
      ],
      [
        "nullable",
        'let t:string?="oak"\nlet a={p:t}\nlet b={p:null,q:1}\nlet c={p:4}',
        ["a", "b", "c"],
      ],
      [
        "missing-field",
        'let t:string="oak"\nlet a={only:t}\nlet b={elsewhere:1}\nlet c={elsewhere:2}',
        ["a", "b", "c"],
      ],
      [
        "same-identity-locals",
        'let t:string="oak"\nlet root={p:t,q:null}\nlet a=root\na.q=2\nlet b=root\nb.q="elm"\nlet c=root',
        ["a", "b", "c"],
      ],
      [
        "projected",
        'let t:string="oak"\nlet root={box:{p:t},q:0}\nlet cp=root\nlet cp2=cp\ncp2.q=1\nlet a=cp2.box\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
      [
        "two-written",
        'let t:string="oak"\nlet n:integer=7\nlet a={p:t}\nlet b={p:n}\nlet c={p:"elm",single:1}',
        ["a", "b", "c"],
      ],
      [
        "plain-after-landing",
        'let t:string="oak"\nlet root={p:t}\nlet a={p:1}\nlet b={p:"elm"}\nlet c={q:1}\nlet xs=[root]',
        ["a", "b", "c"],
      ],
      [
        "guarded-copy",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet cp=root\nif hostValue == 1 { cp.q=2 }\nlet a=cp\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
    ];
    for (const [name, preamble, els] of shapes) {
      for (const perm of permutations(els)) {
        const body = `${preamble}\n${name === "plain-after-landing" ? "xs=" : "let xs="}[${perm.join(",")}]\nlet read=xs[0]`;
        add(`${name}-${perm.join("-")}`, body);
      }
      add(
        `${name}-guarded`,
        `${preamble}\n${name === "plain-after-landing" ? "" : "let xs=[]"}\nif hostValue == 1 { xs=[${els.join(",")}] }\nlet read=xs[0]`,
      );
      add(`${name}-nested`, `${preamble}\nlet nested=[[${els.join(",")}]]\nlet read=nested[0][0]`);
    }
    for (const value of ["hostValue", "maker()", "root.box", "root.box otherwise {p:3}"])
      for (const rev of [false, true]) {
        add(
          `opaque-${value}-${rev}`,
          `let t:string="oak"\nlet root={box:{p:t},q:1}\nfunction maker { return {p:2} }\nlet other=${value}\nlet xs=[${rev ? "other,root.box" : "root.box,other"}]\nlet r=xs[0].p`,
        );
      }
    for (const form of ["set", "dict"])
      for (const rev of [false, true]) {
        const a = rev ? "other" : "root",
          b = rev ? "root" : "other";
        add(
          `${form}-${rev}`,
          `let t:string="oak"\nlet root={p:t}\nlet other={p:2}\nlet xs=${form === "set" ? `set[${a},${b}]` : `dict{one:${a},two:${b}}`}`,
        );
      }
    out.push({
      name: "three-file",
      files: [
        { path: "z.tease", source: 'let t:string="z"\nlet r={p:t}\nlet a=[{p:1},r]\nexit\n' },
        { path: "main.tease", source: 'let t:string="m"\nlet r={p:t}\nlet a=[r,{p:1}]\nexit\n' },
        { path: "a.tease", source: 'let t:integer=2\nlet r={p:t}\nlet a=[r,{p:"a"}]\nexit\n' },
      ],
    });
    return out;
  }
  const __corpusFixed0 = cases();
  return __corpusFixed0.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];
