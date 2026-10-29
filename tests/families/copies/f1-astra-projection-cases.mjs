// Astra review; shared generation code from one original module.
export const sizes = [8, 16];
const outputs = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const source = (...lines) => lines.flat(Infinity).join("\n") + "\nexit\n";
  const fields = (n, value = "t", prefix = "f") =>
    rows(n, (i) => `${prefix}${i}:${value}`).join(",");
  function cases() {
    const all = [];
    const add = (name, text) => all.push({ name, files: [{ path: "main.tease", source: text }] });
    const types = [
      ["integer", "7"],
      ["integer?", "null"],
      ["integer | string", "7"],
      ["string", '"ok"'],
      ["null", "null"],
    ];
    const values = ["8", "2.5", '"bad"', "null", "hostValue"];
    const shapes = {
      "forward-projection": (v) => [
        "let box={left:root}",
        "let twin={right:box.left}",
        "let a=twin.right",
        `a.nest.n=${v}`,
        "let out={selected:a.nest}",
        "repeat out.selected.n {}",
      ],
      "local-above": (v) => [
        "let a=root",
        "let b=a",
        `a.nest={n:${v},keep:1}`,
        "let c={p:a}",
        "let d=c.p",
        "let out=[b,d]",
        "repeat out[0].nest.n {}",
      ],
      "local-below": (v) => [
        "let a=root",
        `a.nest.n=${v}`,
        "let b=a",
        "b.n=8",
        "let c={p:b}",
        "let out=[root,c.p]",
        "repeat out[0].nest.n {}",
      ],
      "two-root-forward": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let left={a:root}",
        "let right={b:other}",
        "let a=left.a",
        "let b=right.b",
        "a=b",
        "let out=a",
        "repeat out.nest.n {}",
      ],
      "whole-cycle-local": (v) => [
        "let a=root",
        "let b=a",
        "let c=b",
        "b=c",
        "a=b",
        `c.nest.n=${v}`,
        "let out={p:a}",
        "repeat out.p.nest.n {}",
      ],
      "path-cycle-local": (v) => [
        "let a=root",
        "let wrap={slot:a}",
        "a=wrap.slot",
        `wrap.slot.nest.n=${v}`,
        "let out=wrap.slot",
        "repeat out.nest.n {}",
      ],
      "two-fed-cycle": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=root",
        "let b=a",
        "a=b",
        "b=other",
        "let out=[a,b]",
        "repeat out[0].n {}",
      ],
      "guarded-replacement": (v) => [
        "let a=root",
        `if hostValue != null { a.nest.n=${v} }`,
        "let b={x:a}",
        "let c=b.x",
        "if c != null { let out=[root,c]\nrepeat out[0].nest.n {} }",
      ],
      "guarded-join": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=root",
        "if other != null { a=other }",
        "let b=a",
        "repeat b.n {}",
      ],
      "snapshot-local": (v) => [
        "let a=root",
        "let old=a.nest",
        `a.nest.n=${v}`,
        "let fresh=a.nest",
        "let out=[old,fresh]",
        "repeat out[0].n {}",
      ],
      "list-copy": (v) => [
        "let a=[root]",
        "let b=a",
        `b[0].nest.n=${v}`,
        "let c={list:b}",
        "let out=c.list",
        "repeat out[0].nest.n {}",
      ],
      "local-then-landing": (v) => [
        `let plain={n:1,nest:{n:1,keep:1},spare:1}`,
        "let a=plain",
        `a.nest.n=${v}`,
        "let b=a",
        "let out=root",
        "out=b",
        "repeat out.nest.n {}",
      ],
      duplicates: (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=[root,root,other,root]",
        "let b=[root,other,root,root]",
        "let out=[a,b]",
        "repeat out[0][0].n {}",
      ],
      defaults: (v) => [
        `function make(arg=root) { let a=arg\na.nest.n=${v}\nreturn a }`,
        "let out=make()",
        "repeat out.nest.n {}",
      ],
      "default-null-word": (v) => [
        "function make(arg=null) { let a=arg\na=root\nreturn a }",
        "let out=make()",
        `out.nest.n=${v}`,
        "let z=out.nest.n otherwise 1",
        "repeat z {}",
      ],
      "read-operation": (v) => [
        "let a=root",
        "let b={p:a}",
        `b.p.nest.n=${v}`,
        "let out=[b.p,root].get(0, default: root)",
        "repeat out.nest.n {}",
      ],
    };
    for (const [type, init] of types)
      for (const value of values)
        for (const [name, shape] of Object.entries(shapes)) {
          add(
            `${name}/${type}/${value}`,
            source(
              `let t:${type}=${init}`,
              "let root={n:t,nest:{n:t,keep:1},spare:t}",
              shape(value),
            ),
          );
        }
    for (const count of [2, 3, 5])
      for (const plain of [false, true]) {
        const refs = rows(count, (i) => `r${i}`);
        add(
          `dedup/${count}/${plain}`,
          source(
            "let t:integer=1",
            rows(count, (i) => `let r${i}={same:t,nest:{same:t}}`),
            "let raw={same:1,nest:{same:hostValue}}",
            `let a=[${[...refs, ...refs, ...(plain ? ["raw"] : [])].join(",")}]`,
            `let b=[${[...refs, ...(plain ? ["raw"] : [])].reverse().join(",")}]`,
            "repeat a[0].nest.same {}",
            "repeat b[0].nest.same {}",
          ),
        );
      }
    all.push({
      name: "project-file-order",
      files: [
        { path: "z.tease", source: source("let z:integer=hostValue", "repeat hostValue {}") },
        { path: "a.tease", source: source("let a:integer=hostValue", "repeat hostValue {}") },
        { path: "main.tease", source: source("let m:integer=hostValue", "repeat hostValue {}") },
      ],
    });
    return all;
  }
  const workShapes = {
    "forest-disjoint-stores": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)},${fields(n, "1", "g")}}`,
        "let a=root",
        rows(n, (i) => `a.g${i}=2`),
        rows(n, (i) => `let c${i}=a.f${i}`),
      ),
    "forest-nested-projections": (n) =>
      source(
        "let t:integer=1",
        `let root={${rows(n, (i) => `f${i}:{leaf:t}`).join(",")},${fields(n, "1", "g")}}`,
        "let a=root",
        rows(n, (i) => `a.g${i}=2`),
        rows(n, (i) => `let c${i}={p:a.f${i}}\nlet d${i}=[c${i}.p,root.f${i}]`),
      ),
    "diamond-local-fit": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        rows(
          n,
          (i) =>
            `let a${i}=root\na${i}.f${i}=2\nlet b${i}={slot:a${i}}\nlet c${i}=[b${i}.slot,root]`,
        ),
      ),
    "guarded-whole-chain": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        "let a0=root",
        rows(n - 1, (i) => `let a${i + 1}=a${i}\nif hostValue != null { a${i + 1}=root }`),
      ),
    "projected-twice-disjoint": (n) =>
      source(
        "let t:integer=1",
        rows(n, (i) => `let r${i}={left:{f${i}:t},right:{f${i}:t}}`),
        `let a=[${rows(n, (i) => `r${i}.left`).join(",")}]`,
        `let b=[${rows(n, (i) => `r${i}.right`).join(",")}]`,
      ),
    // Required reproductions of r8's disclosed notes, separate from independent cases above.
    "r8-prefix-paths": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        rows(n, (i) => rows(2, (j) => `let c${i}_${j}={p${i}:root,z:root}`)),
      ),
    "r8-mix-landed": (n) =>
      source(
        "let t:integer=1",
        rows(n, (i) => `let r${i}={f${i}:t}`),
        `let wide={${fields(n)}}`,
        `let a=[${rows(n, (i) => `r${i}`).join(",")},wide]`,
        `let b=[${rows(n, (i) => `r${i}`).join(",")}]`,
      ),
    "r8-direct-locals-misfits": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        `let plain={${fields(n, "1")}}`,
        rows(n, (i) => [
          `let local${i}=plain`,
          `local${i}.f${i}="bad"`,
          `let c${i}=root`,
          `c${i}=local${i}`,
        ]),
      ),
  };
  const __fixedG171_0 = cases();
  const cases0 = (() => {
    return __fixedG171_0.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
  })();
  const shapes1 = (() => {
    return {
      "forest-disjoint-stores": (n) => workShapes["forest-disjoint-stores"](n),
      "forest-nested-projections": (n) => workShapes["forest-nested-projections"](n),
      "diamond-local-fit": (n) => workShapes["diamond-local-fit"](n),
      "guarded-whole-chain": (n) => workShapes["guarded-whole-chain"](n),
      "projected-twice-disjoint": (n) => workShapes["projected-twice-disjoint"](n),
      "r8-prefix-paths": (n) => workShapes["r8-prefix-paths"](n),
      "r8-mix-landed": (n) => workShapes["r8-mix-landed"](n),
      "r8-direct-locals-misfits": (n) => workShapes["r8-direct-locals-misfits"](n),
    };
  })();
  return { cases0, shapes1 };
})();
export const cases = [...outputs.cases0];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];
