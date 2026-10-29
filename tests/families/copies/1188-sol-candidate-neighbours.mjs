// #1188; Sol review.
export const sizes = [4, 8];
export const shapes = (() => {
  const { shapes: old } = (() => {
    const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
    const fields = (n, v = "typed", p = "f") =>
      rows(n, (i) => `${p}${i}:${typeof v === "function" ? v(i) : v}`).join(",");
    const source = (...parts) => parts.flat(Infinity).join("\n") + "\nexit\n";
    const T = "let typed:integer=1";
    const S = 'let s:string="x"';
    const { shapes: astra } = (() => {
      const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
      const fields = (n, value = "t", prefix = "f") =>
        rows(n, (i) => `${prefix}${i}:${value}`).join(",");
      const source = (...s) => s.flat(Infinity).join("\n") + "\nexit\n";
      const T = "let t:integer=1";
      const shapes = {
        "nested-diamonds": (n) =>
          source(
            T,
            `let root={${fields(n)}}`,
            `let peer={${fields(n, "t", "g")}}`,
            rows(n, (i) => [
              `let x${i}={left:{cell:root},right:{cell:root}}`,
              `let y${i}=x${i}`,
              `y${i}.left.cell={h${i}:t}`,
              `let z${i}=[y${i}.left.cell,peer]`,
              `let w${i}=[y${i}.right.cell,peer]`,
            ]),
          ),
        "rejected-projections": (n) =>
          source(
            T,
            `let root={${fields(n)}}`,
            `let peer={${fields(n, "1")}}`,
            rows(n, (i) => [
              `let x${i}=root`,
              `x${i}.f0="bad"`,
              `let box${i}={cell:x${i}}`,
              `let copy${i}=box${i}.cell`,
              `let again${i}=copy${i}`,
              `let pair${i}=[again${i},peer]`,
            ]),
          ),
        "guarded-mixed-fan": (n) =>
          source(
            T,
            `let root={${fields(n)}}`,
            `let peer={${fields(n, "1")}}`,
            rows(n, (i) => [
              `let x${i}=root`,
              `if hostValue { x${i}={extra${i}:t} }`,
              `let y${i}={slot:x${i},direct:{own${i}:t}}`,
              `let z${i}=y${i}.slot`,
            ]),
            `let bag=[peer,${rows(n, (i) => `z${i}`).join(",")}]`,
          ),
        "fed-cycle-fan": (n) =>
          source(
            T,
            `let root={${fields(n)}}`,
            `let peer={${fields(n, "t", "g")}}`,
            rows(n, (i) => [
              `let a${i}=root`,
              `let b${i}=a${i}`,
              `a${i}=b${i}`,
              `b${i}.extra${i}=t`,
              `let c${i}={nest:b${i}}`,
              `let pair${i}=[c${i}.nest,peer]`,
            ]),
          ),
        "opaque-bag": (n) =>
          source(
            "function make(x) { return hostValue }",
            rows(n, (i) => `let u${i}=make(${i})`),
            `let bag=[${rows(n, (i) => `u${i}`).join(",")}]`,
          ),
        "opaque-projected-bag": (n) =>
          source(
            T,
            "function make(x) { return hostValue }",
            rows(n, (i) => `let u${i}={cell:make(${i})}`),
            `let bag=[${rows(n, (i) => `u${i}.cell`).join(",")},{x:t}]`,
          ),
        "sparse-pairs": (n) =>
          source(
            T,
            rows(n, (i) => `let r${i}={${fields(n, "t", `p${i}k`)}}`),
            rows(n, (i) => rows(n, (j) => (i < j ? `let pair${i}x${j}=[r${i},r${j}]` : []))),
          ),
        "equal-pairs": (n) =>
          source(
            T,
            rows(n, (i) => `let r${i}={${fields(n)}}`),
            rows(n, (i) => rows(n, (j) => (i < j ? `let pair${i}x${j}=[r${i},r${j}]` : []))),
          ),
      };
      shapes["opaque-distinct-functions"] = (n) =>
        source(
          T,
          rows(n, (i) => [`function make${i}(x) { return hostValue }`, `let u${i}=make${i}(0)`]),
          `let bag=[${rows(n, (i) => `u${i}`).join(",")},{x:t}]`,
        );
      shapes["opaque-cyclic-elements"] = (n) =>
        source(
          T,
          rows(n, (i) => [`let u${i}=hostValue`, `u${i}=u${i}`]),
          `let bag=[${rows(n, (i) => `u${i}`).join(",")},{x:t}]`,
        );
      shapes["fed-cycle-plain"] = (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let peer={${fields(n, "t", "g")}}`,
          rows(n, (i) => [
            `let a${i}=root`,
            `let b${i}=a${i}`,
            `a${i}=b${i}`,
            `let c${i}={nest:b${i}}`,
            `let pair${i}=[c${i}.nest,peer]`,
          ]),
        );
      shapes["acyclic-plain"] = (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let peer={${fields(n, "t", "g")}}`,
          rows(n, (i) => [
            `let a${i}=root`,
            `let b${i}=a${i}`,
            `let c${i}={nest:b${i}}`,
            `let pair${i}=[c${i}.nest,peer]`,
          ]),
        );
      shapes["fed-cycle-store"] = (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let peer={${fields(n, "t", "g")}}`,
          rows(n, (i) => [
            `let a${i}=root`,
            `let b${i}=a${i}`,
            `a${i}=b${i}`,
            `b${i}.f0=t`,
            `let c${i}={nest:b${i}}`,
            `let pair${i}=[c${i}.nest,peer]`,
          ]),
        );
      shapes["acyclic-store"] = (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let peer={${fields(n, "t", "g")}}`,
          rows(n, (i) => [
            `let a${i}=root`,
            `let b${i}=a${i}`,
            `b${i}.f0=t`,
            `let c${i}={nest:b${i}}`,
            `let pair${i}=[c${i}.nest,peer]`,
          ]),
        );
      shapes["opaque-cycle-place"] = (n) =>
        source(
          T,
          rows(n, (i) => [`let u${i}=hostValue`, `u${i}=u${i}`]),
          "let bag={x:t}",
          rows(n, (i) => `bag=u${i}`),
        );
      shapes["opaque-written-cycle-place"] = (n) =>
        source(
          rows(n, (i) => [`let u${i}:object=hostValue`, `u${i}=u${i}`]),
          "let bag=u0",
          rows(n, (i) => (i === 0 ? [] : `bag=u${i}`)),
        );
      return { shapes };
    })();
    const shapes = {
      // Sol r8 (generators as in f1-sol-r8.md)
      "prefix-paths": (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          rows(n, (i) => rows(2, (j) => `let c${i}_${j}={p${i}:root,z:root}`)),
        ),
      "prefix-paths-narrow": (n) =>
        source(
          T,
          `let root={${fields(1)}}`,
          rows(n, (i) => rows(2, (j) => `let c${i}_${j}={p${i}:root,z:root}`)),
        ),
      "mix-landed": (n) =>
        source(
          T,
          rows(n, (i) => `let r${i}={f${i}:typed}`),
          `let wide={${fields(n)}}`,
          `let a=[${rows(n, (i) => `r${i}`).join(",")},wide]`,
          `let b=[${rows(n, (i) => `r${i}`).join(",")}]`,
        ),
      "mix-no-wide": (n) =>
        source(
          T,
          rows(n, (i) => `let r${i}={f${i}:typed}`),
          `let a=[${rows(n, (i) => `r${i}`).join(",")}]`,
          `let b=[${rows(n, (i) => `r${i}`).join(",")}]`,
        ),
      "direct-locals-misfits": (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let plain={${fields(n, "1")}}`,
          rows(n, (i) => [
            `let local${i}=plain`,
            `local${i}.f${i}="bad"`,
            `let c${i}=root`,
            `c${i}=local${i}`,
          ]),
        ),
      "direct-locals-fitting": (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          `let plain={${fields(n, "1")}}`,
          rows(n, (i) => [
            `let local${i}=plain`,
            `local${i}.f${i}=2`,
            `let c${i}=root`,
            `c${i}=local${i}`,
          ]),
        ),
      // Sol r9 (f1-sol-r9.md)
      "two-wide-disjoint": (n) =>
        source(
          "let t:integer=1",
          S,
          `let root={${fields(n, "t", "f")}}`,
          `let other={${fields(n, "s", "g")}}`,
          rows(n, (i) => `let a${i}=[root,other]`),
        ),
      "long-locals-narrow": (n) =>
        source(
          "let t:integer=1",
          `let root={p:t,${fields(n, "null", "g")}}`,
          "let c0=root",
          rows(n, (i) => `let c${i + 1}=c${i}\nc${i + 1}.g${i}=2`),
          rows(n, (i) => `let o${i}={p:2}\nlet a${i}=[c${n},o${i}]`),
        ),
      "locals-wide": (n) =>
        source(
          "let t:integer=1",
          `let root={${fields(n, "t", "f")},${fields(n, "null", "g")}}`,
          "let c0=root",
          rows(n, (i) => `let c${i + 1}=c${i}\nc${i + 1}.g${i}=2`),
          rows(n, (i) => `let o${i}={f${i}:2}\nlet a${i}=[c${n},o${i}]`),
        ),
      // new: a place merging two copies (a "fat" identity: its landing is a shared root's plus its own), beside a common
      // wide group; as a merge place (#meeting) and as a literal (#elementsMeet)
      "fat-merge-place": (n) =>
        source(
          T,
          S,
          `let root={${fields(n)}}`,
          `let other={${fields(n, "s", "g")}}`,
          rows(n, (i) => [
            `let o${i}={h${i}:typed}`,
            `let d${i}=root`,
            `d${i}=o${i}`,
            `let a${i}=d${i}`,
            `a${i}=other`,
          ]),
        ),
      "fat-merge-literal": (n) =>
        source(
          T,
          S,
          `let root={${fields(n)}}`,
          `let other={${fields(n, "s", "g")}}`,
          rows(n, (i) => [
            `let o${i}={h${i}:typed}`,
            `let d${i}=root`,
            `d${i}=o${i}`,
            `let a${i}=[d${i},other]`,
          ]),
        ),
      // controls: the same without the merge (d_i = root alone), and without the common wide group
      "fat-merge-place-control": (n) =>
        source(
          T,
          S,
          `let root={${fields(n)}}`,
          `let other={${fields(n, "s", "g")}}`,
          rows(n, (i) => [
            `let o${i}={h${i}:typed}`,
            `let d${i}=root`,
            `d${i}.h${i}=2`,
            `let a${i}=d${i}`,
            `a${i}=other`,
          ]),
        ),
      "fat-merge-alone": (n) =>
        source(
          T,
          `let root={${fields(n)}}`,
          rows(n, (i) => [
            `let o${i}={h${i}:typed}`,
            `let d${i}=root`,
            `d${i}=o${i}`,
            `let a${i}=d${i}`,
          ]),
        ),
      // a chain of merges, each step merging one small record, its every step beside the common wide group
      "fat-chain-place": (n) =>
        source(
          T,
          S,
          `let root={${fields(n)}}`,
          `let other={${fields(n, "s", "g")}}`,
          "let m0=root",
          rows(n, (i) => [
            `let o${i + 1}={h${i + 1}:typed}`,
            `let m${i + 1}=m${i}`,
            `m${i + 1}=o${i + 1}`,
            `let a${i + 1}=m${i + 1}`,
            `a${i + 1}=other`,
          ]),
        ),
      // the residual: s distinct wide records (s fields each), every pair of them in its own literal; field names distinct
      // per record, or one set of names shared by all
      "distinct-wide-pairs": (n) =>
        source(
          T,
          rows(n, (a) => `let r${a}={${fields(n, "typed", `a${a}x`)}}`),
          rows(n, (a) => rows(n, (b) => (a < b ? `let p${a}_${b}=[r${a},r${b}]` : []))),
        ),
      "distinct-wide-pairs-shared": (n) =>
        source(
          T,
          rows(n, (a) => `let r${a}={${fields(n)}}`),
          rows(n, (a) => rows(n, (b) => (a < b ? `let p${a}_${b}=[r${a},r${b}]` : []))),
        ),
      // #1199's one list of a wide root and k records each meeting one field (value side), for no regression
      "list-of-records": (n) =>
        source(
          "let t:integer=1",
          `let root={${fields(n, "t")}}`,
          rows(n, (i) => `let o${i}={f${i}:2}`),
          `let a=[root,${rows(n, (i) => `o${i}`).join(",")}]`,
        ),
      // the lead's acceptance oracle beside the four: Sol r10's generators (f1-sol-r10.md; r2probe/shapes.mjs)
      "meet-reads-groups-shared": (n) =>
        source(
          "let t:integer=1",
          `let plain={${fields(n, "{left:1,right:1}")}}`,
          rows(n, (i) => `let w${i}={q:t}`),
          `let p={${fields(n, (i) => `w${i}`, "y")},${fields(n, (i) => `plain.f${i}`, "x")}}`,
          `let p2={${fields(n, (i) => `w${i}`, "y")},${fields(n, (i) => `plain.f${i}`, "x")}}`,
        ),
      "valid-copy-prefixes": (n) =>
        source(
          "let t:integer=1",
          "let w={q:t,r:1}",
          `let root={${rows(n, (i) => `f${i}:{a:{b:{c:w,d:w},e:w},z:w}`).join(",")}}`,
          "let a=root",
          "let b=a",
          rows(n, (i) =>
            [
              `b.f${i}.a.b.c=w`,
              `b.f${i}.z=w`,
              `b.f${i}.a.b.d.r=2`,
              `let r${i}=b.f${i}.a.b`,
              `let s${i}=b.f${i}.a.b.c`,
              `let u${i}=b.f${i}.a.b.c.q`,
            ].join("\n"),
          ),
        ),
      // Sol r1's witness (sol-r1.md): fat-chain-place with a fixed partner w times as wide as the root
      "chain-partner3": (n) => chainPartner(n, 3),
      "chain-partner8": (n) => chainPartner(n, 8),
      "holder-fan-in-plain": (n) => holderFanIn(n),
      "holder-fan-in-fitting": (n) => holderFanIn(n, true),
      "holder-fan-in-plain-narrow": (n) => holderFanIn(n, false, 1),
    };
    function holderFanIn(n, typedOther = false, width = n) {
      return source(
        "let t:integer=1",
        `let root={${rows(width, (i) => `f${i}:t`).join(",")}}`,
        `let other={${rows(width, (i) => `f${i}:${typedOther ? "t" : "1"}`).join(",")}}`,
        rows(n, (i) => [`let o${i}={h${i}:t}`, `let d${i}=root`, `d${i}=o${i}`]),
        `let a=[other,${rows(n, (i) => `d${i}`).join(",")}]`,
      );
    }
    function chainPartner(n, width) {
      return source(
        T,
        S,
        `let root={${fields(n, "t".replace("t", "typed"))}}`,
        `let other={${fields(width * n, "s", "g")}}`,
        "let m0=root",
        rows(n, (i) => [
          `let o${i + 1}={h${i + 1}:typed}`,
          `let m${i + 1}=m${i}`,
          `m${i + 1}=o${i + 1}`,
          `let a${i + 1}=m${i + 1}`,
          `a${i + 1}=other`,
        ]),
      );
    }
    for (const name of [
      "opaque-cyclic-elements",
      "fed-cycle-store",
      "fed-cycle-plain",
      "acyclic-store",
      "fed-cycle-fan",
      "nested-diamonds",
      "guarded-mixed-fan",
      "rejected-projections",
      "sparse-pairs",
      "equal-pairs",
    ])
      shapes[name] = astra[name];
    shapes["opaque-fixed-contributors"] = (n) =>
      source(
        T,
        rows(2, (i) => [`let u${i}=hostValue`, `u${i}=u${i}`]),
        `let wide={${fields(n)}}`,
        "let bag=[u0,u1,wide]",
      );
    shapes["opaque-fan-host"] = (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        rows(n, (i) => [`let u${i}=hostValue`, `let c${i}=root`, `c${i}=u${i}`]),
      );
    shapes["opaque-fan-call"] = (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        rows(n, (i) => [`let u${i}=make(${i})`, `let c${i}=root`, `c${i}=u${i}`]),
        "exit",
        `function make(v) {\n    return {${fields(n, "v")}}\n}`,
      );
    shapes["fed-cycle-store-place"] = (n) =>
      source(
        T,
        `let root={${fields(n)}}`,
        `let peer={${fields(n, "typed", "g")}}`,
        rows(n, (i) => [
          `let a${i}=root`,
          `let b${i}=a${i}`,
          `a${i}=b${i}`,
          `b${i}.f0=typed`,
          `let c${i}={nest:b${i}}`,
          `let m${i}=c${i}.nest`,
          `m${i}=peer`,
        ]),
      );
    for (const name of ["opaque-cycle-place", "opaque-written-cycle-place"])
      shapes[name] = astra[name];
    shapes["rejected-relay-literal"] = (n) =>
      source(
        "let typed:integer=17",
        `let shared={${rows(n, (i) => `f${i}:typed`).join(",")}}`,
        rows(n, (i) => [
          `let inner${i}=[{f${i}:false},shared]`,
          `let wrap${i}={value:inner${i}}`,
          `let relay${i}=wrap${i}`,
          `let final${i}=[relay${i}.value.first,shared]`,
        ]),
      );
    shapes["rejected-relay-place"] = (n) =>
      source(
        "let typed:integer=17",
        `let shared={${rows(n, (i) => `f${i}:typed`).join(",")}}`,
        rows(n, (i) => [
          `let inner${i}=[{f${i}:false},shared]`,
          `let wrap${i}={value:inner${i}}`,
          `let relay${i}=wrap${i}`,
          `let sink${i}=shared`,
          `sink${i}=relay${i}.value.first`,
        ]),
      );
    shapes["split-cycle-literal"] = (n) =>
      source(
        "let typed:integer=17",
        'let word:string="s"',
        `let shared={${rows(n, (i) => `f${i}:typed`).join(",")}}`,
        rows(n, (i) => [
          `let a${i}=shared`,
          `let b${i}={f0:word}`,
          `a${i}=b${i}`,
          `b${i}=a${i}`,
          `let box${i}={a:a${i},b:b${i}}`,
          `let final${i}=[box${i}.a,box${i}.b]`,
        ]),
      );
    shapes["split-cycle-place"] = (n) =>
      source(
        "let typed:integer=17",
        'let word:string="s"',
        `let shared={${rows(n, (i) => `f${i}:typed`).join(",")}}`,
        rows(n, (i) => [
          `let a${i}=shared`,
          `let b${i}={f0:word}`,
          `a${i}=b${i}`,
          `b${i}=a${i}`,
          `let s${i}=b${i}`,
          `s${i}=a${i}`,
        ]),
      );
    shapes["whole-cycle-control"] = (n) =>
      source(
        "let typed:integer=17",
        `let shared={${rows(n, (i) => `f${i}:typed`).join(",")}}`,
        rows(n, (i) => [
          `let a${i}=shared`,
          `let b${i}={f0:5}`,
          `a${i}=b${i}`,
          `b${i}=a${i}`,
          `let box${i}={a:a${i},b:b${i}}`,
          `let final${i}=[box${i}.a,box${i}.b]`,
        ]),
      );
    const { shapes: sol6 } = (() => {
      const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
      const source = (...parts) => parts.flat(Infinity).join("\n") + "\nexit\n";
      const fields = (n, value) => rows(n, (i) => `f${i}:${value}`).join(",");
      const shapes = {
        "rejected-relay-literal": (n) =>
          source(
            "let typed:integer=17",
            `let shared={${fields(n, "typed")}}`,
            rows(n, (i) => [
              `let inner${i}=[{f${i}:false},shared]`,
              `let wrap${i}={value:inner${i}}`,
              `let relay${i}=wrap${i}`,
              `let final${i}=[relay${i}.value.first,shared]`,
            ]),
          ),
        "dormant-meetings-literal": (n) =>
          source(
            "let typed:integer=17",
            `let exact={${fields(n, "typed")}}`,
            `let fraction={${fields(n, "1.5")}}`,
            "let container=fraction",
            "container=exact",
            rows(n, (i) => [
              `let alias${i}=container`,
              `alias${i}.extra${i}=typed`,
              `let final${i}=[container,alias${i}]`,
            ]),
          ),
        "dormant-meetings-place": (n) =>
          source(
            "let typed:integer=17",
            `let exact={${fields(n, "typed")}}`,
            `let fraction={${fields(n, "1.5")}}`,
            "let container=fraction",
            "container=exact",
            rows(n, (i) => [
              `let alias${i}=container`,
              `alias${i}.extra${i}=typed`,
              `let final${i}=container`,
              `final${i}=alias${i}`,
            ]),
          ),
        "three-groups-self": (n) =>
          source(
            "let typed:integer=17",
            'let word:string="x"',
            "let flag:boolean=true",
            `let shared={${fields(n, "typed")}}`,
            rows(n, (i) => [
              `let a${i}=shared`,
              `let b${i}=a${i}`,
              `a${i}=b${i}`,
              `let c${i}={f0:word}`,
              `let d${i}=c${i}`,
              `c${i}=d${i}`,
              `let e${i}={f0:flag}`,
              `let f${i}=e${i}`,
              `e${i}=f${i}`,
              `c${i}=a${i}`,
              `e${i}=c${i}`,
              `a${i}=e${i}`,
              `b${i}=b${i}`,
              `let box${i}={a:b${i},b:d${i},c:f${i}}`,
              `let final${i}=[box${i}.a,box${i}.b,box${i}.c]`,
            ]),
          ),
      };
      return { shapes };
    })();
    for (const name of ["dormant-meetings-literal", "dormant-meetings-place"])
      shapes[name] = sol6[name];
    return { shapes };
  })();
  const shapes = { ...old };
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const fields = (n, p, v) => rows(n, (i) => `${p}${i}:${v}`).join(",");
  for (const variant of ["balanced", "graft", "mixed"])
    shapes["node-" + variant] = (k) => {
      const rows = [
        `let a={n:1,${fields(k, "f", "null")}${variant === "mixed" ? "," + fields(k, "g", "null") : ""}}`,
      ];
      if (variant !== "graft")
        for (let i = 0; i < k; i++) rows.push(`let b${i}=a.f${i}`, `a.f${i}=b${i}`);
      if (variant !== "balanced")
        for (let i = 0; i < k; i++) rows.push(`a.${variant === "graft" ? "f" : "g"}${i}=a`);
      return rows.concat("let c=a", "exit").join("\n");
    };
  shapes["node-align-shared"] = (k) =>
    [
      `let w={${fields(k, "f", "1")},${fields(k, "h", "null")},z:null}`,
      ...rows(k, (i) => `let s${i}=w\ns${i}.h${i}=1`),
      `let r={${fields(k, "f", "null")},z:null}`,
      ...rows(k, (i) => `r=s${i}`),
      "w=r.z",
      "let c=r",
      "exit",
    ].join("\n");
  for (const dest of ["literal", "place"])
    for (const flip of [false, true])
      shapes[`a2-${dest}-${flip}`] = (k) =>
        [
          `let a={${fields(k, "f", "1")}}`,
          `let b={${fields(k, "f", "1").replace("f0:1", 'f0:"x"')}}`,
          ...(dest === "literal"
            ? [
                `let c=[${(flip ? ["b", ...rows(k, () => "a")] : [...rows(k, () => "a"), "b"]).join(",")}]`,
              ]
            : rows(k, (i) => `let c${i}=${flip ? "b" : "a"}\nc${i}=${flip ? "a" : "b"}`)),
          "exit",
        ].join("\n");
  shapes["node-congruence-chain"] = (k) =>
    [
      "let a0={x:null,n:1}",
      "let b0={x:null,n:1}",
      "a0=b0",
      "b0=a0",
      ...rows(k, (i) => [
        `let a${i + 1}={x:null,n:1}`,
        `let b${i + 1}={x:null,n:1}`,
        `a${i + 1}=a${i}.x`,
        `a${i}.x=a${i + 1}`,
        `b${i + 1}=b${i}.x`,
        `b${i}.x=b${i + 1}`,
      ]).flat(),
      "let c=a0",
      "exit",
    ].join("\n");
  shapes["node-directed-chain"] = (k) =>
    [
      "let a0={x:null,n:1}",
      "let b0={x:null,y:null,n:1}",
      "a0=b0",
      "b0.y=a0",
      ...rows(k, (i) => [
        `let a${i + 1}={x:null,n:1}`,
        `let b${i + 1}={x:null,n:1}`,
        `a${i + 1}=a${i}.x`,
        `a${i}.x=a${i + 1}`,
        `b${i + 1}=b${i}.x`,
        `b${i}.x=b${i + 1}`,
      ]).flat(),
      "let c=a0",
      "exit",
    ].join("\n");
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
