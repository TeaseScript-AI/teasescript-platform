// #1394 G5 5a Astra review / builder corpus.
export const sizes = [4, 6, 8, 12, 24, 48, 64, 96, 128];
export const shapes = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const families = {};
  const reads = (k) => rows(k, (i) => `say "\${a${i}.p0}"`);
  const manyFed = (k, other, read) =>
    [
      "let good = {p0: 1}",
      `let other = {p0: ${other}}`,
      "let a0 = good",
      ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
      `a0 = a${k - 1}`,
      ...rows(k - 1, (i) => `a${i + 1} = other`),
      ...(read ? reads(k) : []),
      "exit",
    ].join("\n");
  const chord = (k, other, read) => {
    const fields = (v) => rows(k, (i) => `p${i}: ${v}`).join(", ");
    return [
      `let source = {${fields("1")}}`,
      `let other = {${fields(other)}}`,
      "let a0 = source",
      ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
      `a0 = a${k - 1}`,
      ...rows(k, (i) => `a${i} = a${(i + 2) % k}`),
      `a${k - 1} = other`,
      ...(read ? reads(k) : []),
      "exit",
    ].join("\n");
  };
  for (const [name, make] of [
    ["i1339-many-fed", manyFed],
    ["i1339-chord", chord],
  ])
    families[name] = (k) => ({
      "quiet-read": make(k, "2", true),
      "quiet-unread": make(k, "2", false),
      "conflict-read": make(k, '"x"', true),
      "conflict-unread": make(k, '"x"', false),
    });
  const fieldsOf = (n) => rows(n, (i) => `f${i}:typed`).join(",");
  const recon = (...x) => x.flat(Infinity).join("\n") + "\nexit\n";
  families["ring-member-stores"] = (n) =>
    recon(
      "let typed:integer=1",
      `let root={${fieldsOf(n)},extra:1}`,
      rows(n, (i) => `let a${i}=${i ? `a${i - 1}` : "root"}\na${i}.f${i}=2`),
      `a0=a${n - 1}`,
    );
  families["ring-member-stores-width-2"] = (n) =>
    recon(
      "let typed:integer=1",
      `let root={${fieldsOf(2)},extra:1}`,
      rows(n, (i) => `let a${i}=${i ? `a${i - 1}` : "root"}\na${i}.f${i % 2}=2`),
      `a0=a${n - 1}`,
    );
  families["a2-whole-ring"] = (k) =>
    [
      ...rows(k, (i) => `let a${i} = {m${i}: ${i}}`),
      ...rows(k, (i) => `a${(i + 1) % k} = a${i}`),
      'let bad = {m0: "x"}',
      "let c = a0",
      "c = bad",
      "exit",
    ].join("\n");
  const fed = (k, owned) => {
    const fields = (v) => rows(k, (i) => `p${i}: ${v}`).join(", ");
    return [
      `let source = {${fields("1")}}`,
      `let bad = {${fields('"x"')}}`,
      owned ? "let a0 = {q0: 0}" : "let a0 = source",
      ...rows(k - 1, (i) =>
        owned
          ? `let a${i + 1} = {q${i + 1}: ${i + 1}}\na${i + 1} = a${i}`
          : `let a${i + 1} = a${i}`,
      ),
      `a0 = a${k - 1}`,
      ...(owned ? ["a0 = source"] : []),
      `a${k - 1} = bad`,
      "exit",
    ].join("\n");
  };
  families["a2-fed-ring"] = (k) => fed(k, false);
  families["a2-fed-ring-owned"] = (k) => fed(k, true);
  const axisRing = (k, width, second, order, read) => {
    const fields = (v) => rows(width, (i) => `p${i}: ${v}`).join(", ");
    const seconds = {
      none: () => [],
      empty: (i) => [`a${i} = {}`],
      same: (i) => [`a${i} = good`],
      conflicting: (i) => [`a${i} = bad`],
    };
    const tail = rows(k - 1, (i) => seconds[second](i + 1)).flat();
    const before = read === "before" ? reads(k) : [];
    const after = read === "after" ? reads(k) : [];
    return [
      `let good = {${fields("1")}}`,
      `let bad = {${fields('"x"')}}`,
      "let a0 = good",
      ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
      `a0 = a${k - 1}`,
      ...before,
      ...(order === "late" ? [...tail, "a0 = bad"] : ["a0 = bad", ...tail]),
      ...after,
      "exit",
    ].join("\n");
  };
  for (const second of ["none", "empty", "same", "conflicting"])
    families[`axis-${second}`] = (k) => {
      const out = {};
      for (const width of ["k", "2"])
        for (const order of ["late", "early"])
          for (const read of ["unread", "before", "after"])
            out[`w${width}-${order}-${read}`] = axisRing(
              k,
              width === "k" ? k : 2,
              second,
              order,
              read,
            );
      return out;
    };
  for (const second of ["none", "empty", "same", "conflicting"])
    families[`a2-axis-${second}`] = (k) => axisRing(k, k, second, "late", "unread");
  function lcg(seed) {
    let s = (seed * 2654435761 + 1013904223) >>> 0;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  }
  const FEEDS = [
    "none",
    "good",
    "bad",
    "empty",
    "host",
    "own",
    "written",
    "wobj",
    "null",
    "speaker",
    "other-place",
  ];
  function cutCase(seed, k) {
    const r = lcg(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    const topo = pick(["ring", "reverse", "chord", "two-rings", "self", "tail", "links"]);
    const list = r() < 0.15;
    const out = [];
    const val = (v) => (list ? `[${v}]` : `{p0: ${v}, p1: ${v}}`);
    out.push(`let good = ${val("1")}`, `let bad = ${val('"x"')}`, "let host = hostValue");
    if (!list)
      out.push(
        "let wint: integer = 1",
        "let wnull: integer? = null",
        "let written = {p0: wint, p1: wnull}",
        "let wobj: object? = {p0: 1}",
      );
    out.push("speaker vera { p0: 1 }");
    // declarations in a permuted order, each from an earlier member or a source
    const order = rows(k, (i) => i);
    if (r() < 0.5) order.reverse();
    const declared = [];
    for (const i of order) {
      const from =
        declared.length > 0 && r() < 0.6
          ? `a${pick(declared)}`
          : pick(["good", "bad", ...(list ? [] : ["written"])]);
      out.push(`let a${i} = ${from}`);
      declared.push(i);
    }
    const edges = [];
    if (topo === "ring" || topo === "chord" || topo === "tail" || topo === "links")
      edges.push(...rows(k, (i) => [(i + 1) % k, i]));
    if (topo === "reverse") edges.push(...rows(k, (i) => [i, (i + 1) % k]));
    if (topo === "chord") edges.push(...rows(k, (i) => [i, (i + 2) % k]));
    if (topo === "two-rings") {
      const half = Math.max(1, Math.floor(k / 2));
      const rest = k - half + 1;
      edges.push(
        ...rows(half, (i) => [(i + 1) % half, i]),
        ...rows(rest, (i) => [half - 1 + ((i + 1) % rest), half - 1 + i]),
      );
    }
    if (topo === "self") edges.push(...rows(k, (i) => [i, i]), ...rows(k - 1, (i) => [i + 1, i]));
    // a guarded copy, a duplicate copy
    const guardedAt = r() < 0.3 ? Math.floor(r() * edges.length) : -1;
    if (r() < 0.2 && edges.length > 0) edges.push(edges[0]);
    for (const [index, [to, from]] of edges.entries()) {
      if (index === guardedAt) out.push(`if a${from} != null {\n  a${to} = a${from}\n}`);
      else out.push(`a${to} = a${from}`);
    }
    // a copy back through places outside the ring
    if (topo === "tail") out.push(`let x = a${k - 1}`, "let y = x", "a0 = y");
    // feeds, own properties and readers per member
    for (let i = 0; i < k; i += 1) {
      const feed = topo === "links" && i > 0 ? "none" : pick(FEEDS);
      const v = {
        none: null,
        good: "good",
        bad: "bad",
        empty: list ? "[]" : "{}",
        host: "host",
        own: val(`${i}`),
        written: list ? null : "written",
        wobj: list ? null : "wobj",
        null: "null",
        speaker: list ? null : "vera",
        "other-place": `a${(i + 1) % k}`,
      }[feed];
      if (v !== null && v !== undefined) out.push(`a${i} = ${v}`);
      if (!list && r() < 0.3) out.push(`a${i}.p1 = ${pick(["2", '"y"', "null"])}`);
      if (list && r() < 0.3) out.push(`a${i}.add(${pick(["2", '"y"'])})`);
      if (r() < 0.5) out.push(list ? `say "\${a${i}.first}"` : `say "\${a${i}.p0}"`);
    }
    if (r() < 0.3)
      out.push(
        `let reader = a${Math.floor(r() * k)}`,
        list ? 'say "${reader.first}"' : 'say "${reader.p1}"',
      );
    return out.join("\n") + "\nexit\n";
  }
  families["cut"] = (n) => {
    const out = {};
    for (let seed = 0; seed < n; seed += 1) out[`s${seed}`] = cutCase(seed, 2 + (seed % 5));
    return out;
  };
  const typed = (k) =>
    `${rows(k, (i) => `let w${i}: integer = ${i}\nlet s${i}: string = "x"`).join("\n")}\n` +
    `let good = {${rows(k, (i) => `f${i}: w${i}`).join(", ")}}\nlet bad = {${rows(k, (i) => `f${i}: s${i}`).join(", ")}}\n`;
  families["written-ring"] = (k) =>
    `${typed(k)}let a0 = good\n${rows(k - 1, (i) => `let a${i + 1} = a${i}`).join("\n")}\na0 = a${k - 1}\na${k - 1} = bad\nexit`;
  families["single-stops"] = (k) => {
    const ring = (feed) => [
      `let a0 = ${feed}`,
      ...rows(k - 1, (i) => `let a${i + 1} = a${i}`),
      `a0 = a${k - 1}`,
    ];
    const tail = [`a${k - 1} = bad`, ...reads(k)];
    const head = ["let good = {p0: 1}", 'let bad = {p0: "x"}'];
    return {
      // a1's two stores both copy a0
      duplicate: [...head, ...ring("good"), "a1 = a0", ...tail, "exit"].join("\n"),
      // b's two stores reach the same stop through the links
      "two-copies-one-stop": [
        ...head,
        ...ring("good"),
        "let b = a1",
        "b = a2",
        "a0 = b",
        ...tail,
        "exit",
      ].join("\n"),
      // a guarded and an unguarded copy of one member
      "guarded-and-plain": [
        ...head,
        ...ring("good"),
        "let b = a1",
        "if a1.p0 is integer { b = a1 }",
        "a0 = b",
        ...tail,
        "exit",
      ].join("\n"),
      // a parameter no call reaches: its copy adds no entry
      uncalled: [
        ...head,
        "function f(x) {",
        ...ring("x").map((l) => `  ${l}`),
        `  a0 = good`,
        ...tail.map((l) => `  ${l}`),
        "}",
        "exit",
      ].join("\n"),
      // the same, called once (its argument exact)
      called: [
        ...head,
        "function f(x) {",
        ...ring("x").map((l) => `  ${l}`),
        ...tail.map((l) => `  ${l}`),
        "}",
        "f(good)",
        "exit",
      ].join("\n"),
    };
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(families)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];

export const cases = [
  [
    "original/1/__reference0/cut@8/s4",
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet host = hostValue\nlet wint: integer = 1\nlet wnull: integer? = null\nlet written = {p0: wint, p1: wnull}\nlet wobj: object? = {p0: 1}\nspeaker vera { p0: 1 }\nlet a5 = good\nlet a4 = a5\nlet a3 = written\nlet a2 = bad\nlet a1 = a4\nlet a0 = a1\na1 = a0\na2 = a1\na3 = a2\na4 = a3\na5 = a4\na0 = a5\na0 = a2\na1 = a3\na2 = a4\na3 = a5\na4 = a0\na5 = a1\na0 = host\na1 = written\nsay "${a1.p0}"\na2 = a3\nsay "${a2.p0}"\na4 = {}\na5 = a0\na5.p1 = null\nsay "${a5.p0}"\nlet reader = a2\nsay "${reader.p1}"\nexit\n',
  ],
  [
    "original/2/__reference0/cut@8/s5",
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet host = hostValue\nlet wint: integer = 1\nlet wnull: integer? = null\nlet written = {p0: wint, p1: wnull}\nlet wobj: object? = {p0: 1}\nspeaker vera { p0: 1 }\nlet a1 = bad\nlet a0 = a1\na1 = a0\na0 = a1\na0 = a0\na1 = a1\na1 = a0\na0.p1 = null\nsay "${a0.p0}"\na1 = host\nlet reader = a0\nsay "${reader.p1}"\nexit\n',
  ],
  [
    "original/3/__reference0/cut@8/s6",
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet host = hostValue\nlet wint: integer = 1\nlet wnull: integer? = null\nlet written = {p0: wint, p1: wnull}\nlet wobj: object? = {p0: 1}\nspeaker vera { p0: 1 }\nlet a2 = written\nlet a1 = a2\nlet a0 = a2\na1 = a0\na2 = a1\na0 = a2\na0 = a2\na1 = a0\na2 = a1\na0 = wobj\nsay "${a0.p0}"\na1 = a2\na1.p1 = "y"\na2 = null\na2.p1 = 2\nlet reader = a2\nsay "${reader.p1}"\nexit\n',
  ],
  [
    "original/4/__reference0/cut@8/s7",
    'let good = {p0: 1, p1: 1}\nlet bad = {p0: "x", p1: "x"}\nlet host = hostValue\nlet wint: integer = 1\nlet wnull: integer? = null\nlet written = {p0: wint, p1: wnull}\nlet wobj: object? = {p0: 1}\nspeaker vera { p0: 1 }\nlet a3 = good\nlet a2 = a3\nlet a1 = a2\nlet a0 = bad\na1 = a0\nif a1 != null {\n  a0 = a1\n}\na2 = a1\na3 = a2\na1 = a3\na0 = host\na0.p1 = null\na1 = {}\na1.p1 = "y"\nsay "${a1.p0}"\na2 = null\na3 = host\nsay "${a3.p0}"\nexit\n',
  ],
  [
    "original/5/original-driver/7",
    'let source = {p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1}\nlet other = {p0: 2, p1: 2, p2: 2, p3: 2, p4: 2, p5: 2}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\na0 = a5\na0 = a3\na1 = a4\na2 = a5\na3 = a0\na4 = a1\na5 = a2\na5 = other\nsay "${a5.p0}"\nsay "${a4.p0}"\nsay "${a3.p0}"\nsay "${a2.p0}"\nsay "${a1.p0}"\nsay "${a0.p0}"\nexit',
  ],
  [
    "original/6/original-driver/8",
    'let source = {p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1, p9: 1, p10: 1, p11: 1}\nlet other = {p0: 2, p1: 2, p2: 2, p3: 2, p4: 2, p5: 2, p6: 2, p7: 2, p8: 2, p9: 2, p10: 2, p11: 2}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\na0 = a11\na0 = a3\na1 = a4\na2 = a5\na3 = a6\na4 = a7\na5 = a8\na6 = a9\na7 = a10\na8 = a11\na9 = a0\na10 = a1\na11 = a2\na11 = other\nsay "${a11.p0}"\nsay "${a10.p0}"\nsay "${a9.p0}"\nsay "${a8.p0}"\nsay "${a7.p0}"\nsay "${a6.p0}"\nsay "${a5.p0}"\nsay "${a4.p0}"\nsay "${a3.p0}"\nsay "${a2.p0}"\nsay "${a1.p0}"\nsay "${a0.p0}"\nexit',
  ],
  [
    "original/7/original-driver/9",
    'let source = {p: 1, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\na0 = a5\na0.q = 2\na1.q = 2\na2.q = 2\na3.q = 2\na4.q = 2\na5.q = 2\nlet b0 = a0\nsay "${b0.p}"\nlet b1 = a1\nsay "${b1.p}"\nlet b2 = a2\nsay "${b2.p}"\nlet b3 = a3\nsay "${b3.p}"\nlet b4 = a4\nsay "${b4.p}"\nlet b5 = a5\nsay "${b5.p}"\nexit',
  ],
  [
    "original/8/original-driver/10",
    'let source = {p: 1, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\na0 = a11\na0.q = 2\na1.q = 2\na2.q = 2\na3.q = 2\na4.q = 2\na5.q = 2\na6.q = 2\na7.q = 2\na8.q = 2\na9.q = 2\na10.q = 2\na11.q = 2\nlet b0 = a0\nsay "${b0.p}"\nlet b1 = a1\nsay "${b1.p}"\nlet b2 = a2\nsay "${b2.p}"\nlet b3 = a3\nsay "${b3.p}"\nlet b4 = a4\nsay "${b4.p}"\nlet b5 = a5\nsay "${b5.p}"\nlet b6 = a6\nsay "${b6.p}"\nlet b7 = a7\nsay "${b7.p}"\nlet b8 = a8\nsay "${b8.p}"\nlet b9 = a9\nsay "${b9.p}"\nlet b10 = a10\nsay "${b10.p}"\nlet b11 = a11\nsay "${b11.p}"\nexit',
  ],
  [
    "original/9/original-driver/11",
    'let typed: integer? = 1\nlet source = {p: typed, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\na0 = a5\na0 = source\na1 = source\na2 = source\na3 = source\na4 = source\na5 = source\nsay "${a0.p}"\nsay "${a1.p}"\nsay "${a2.p}"\nsay "${a3.p}"\nsay "${a4.p}"\nsay "${a5.p}"\nexit',
  ],
  [
    "original/10/original-driver/12",
    'let typed: integer? = 1\nlet source = {p: typed, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\na0 = a11\na0 = source\na1 = source\na2 = source\na3 = source\na4 = source\na5 = source\na6 = source\na7 = source\na8 = source\na9 = source\na10 = source\na11 = source\nsay "${a0.p}"\nsay "${a1.p}"\nsay "${a2.p}"\nsay "${a3.p}"\nsay "${a4.p}"\nsay "${a5.p}"\nsay "${a6.p}"\nsay "${a7.p}"\nsay "${a8.p}"\nsay "${a9.p}"\nsay "${a10.p}"\nsay "${a11.p}"\nexit',
  ],
  [
    "original/11/original-driver/15",
    'let good = {p0: 1}\nlet other = {p0: 2}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\nlet a48 = a47\nlet a49 = a48\nlet a50 = a49\nlet a51 = a50\nlet a52 = a51\nlet a53 = a52\nlet a54 = a53\nlet a55 = a54\nlet a56 = a55\nlet a57 = a56\nlet a58 = a57\nlet a59 = a58\nlet a60 = a59\nlet a61 = a60\nlet a62 = a61\nlet a63 = a62\nlet a64 = a63\nlet a65 = a64\nlet a66 = a65\nlet a67 = a66\nlet a68 = a67\nlet a69 = a68\nlet a70 = a69\nlet a71 = a70\nlet a72 = a71\nlet a73 = a72\nlet a74 = a73\nlet a75 = a74\nlet a76 = a75\nlet a77 = a76\nlet a78 = a77\nlet a79 = a78\nlet a80 = a79\nlet a81 = a80\nlet a82 = a81\nlet a83 = a82\nlet a84 = a83\nlet a85 = a84\nlet a86 = a85\nlet a87 = a86\nlet a88 = a87\nlet a89 = a88\nlet a90 = a89\nlet a91 = a90\nlet a92 = a91\nlet a93 = a92\nlet a94 = a93\nlet a95 = a94\nlet a96 = a95\nlet a97 = a96\nlet a98 = a97\nlet a99 = a98\nlet a100 = a99\nlet a101 = a100\nlet a102 = a101\nlet a103 = a102\nlet a104 = a103\nlet a105 = a104\nlet a106 = a105\nlet a107 = a106\nlet a108 = a107\nlet a109 = a108\nlet a110 = a109\nlet a111 = a110\nlet a112 = a111\nlet a113 = a112\nlet a114 = a113\nlet a115 = a114\nlet a116 = a115\nlet a117 = a116\nlet a118 = a117\nlet a119 = a118\nlet a120 = a119\nlet a121 = a120\nlet a122 = a121\nlet a123 = a122\nlet a124 = a123\nlet a125 = a124\nlet a126 = a125\nlet a127 = a126\nlet a128 = a127\nlet a129 = a128\nlet a130 = a129\nlet a131 = a130\nlet a132 = a131\nlet a133 = a132\nlet a134 = a133\nlet a135 = a134\nlet a136 = a135\nlet a137 = a136\nlet a138 = a137\nlet a139 = a138\nlet a140 = a139\nlet a141 = a140\nlet a142 = a141\nlet a143 = a142\nlet a144 = a143\nlet a145 = a144\nlet a146 = a145\nlet a147 = a146\nlet a148 = a147\nlet a149 = a148\nlet a150 = a149\nlet a151 = a150\nlet a152 = a151\nlet a153 = a152\nlet a154 = a153\nlet a155 = a154\nlet a156 = a155\nlet a157 = a156\nlet a158 = a157\nlet a159 = a158\nlet a160 = a159\nlet a161 = a160\nlet a162 = a161\nlet a163 = a162\nlet a164 = a163\nlet a165 = a164\nlet a166 = a165\nlet a167 = a166\nlet a168 = a167\nlet a169 = a168\nlet a170 = a169\nlet a171 = a170\nlet a172 = a171\nlet a173 = a172\nlet a174 = a173\nlet a175 = a174\nlet a176 = a175\nlet a177 = a176\nlet a178 = a177\nlet a179 = a178\nlet a180 = a179\nlet a181 = a180\nlet a182 = a181\nlet a183 = a182\nlet a184 = a183\nlet a185 = a184\nlet a186 = a185\nlet a187 = a186\nlet a188 = a187\nlet a189 = a188\nlet a190 = a189\nlet a191 = a190\na0 = a191\na1 = other\na2 = other\na3 = other\na4 = other\na5 = other\na6 = other\na7 = other\na8 = other\na9 = other\na10 = other\na11 = other\na12 = other\na13 = other\na14 = other\na15 = other\na16 = other\na17 = other\na18 = other\na19 = other\na20 = other\na21 = other\na22 = other\na23 = other\na24 = other\na25 = other\na26 = other\na27 = other\na28 = other\na29 = other\na30 = other\na31 = other\na32 = other\na33 = other\na34 = other\na35 = other\na36 = other\na37 = other\na38 = other\na39 = other\na40 = other\na41 = other\na42 = other\na43 = other\na44 = other\na45 = other\na46 = other\na47 = other\na48 = other\na49 = other\na50 = other\na51 = other\na52 = other\na53 = other\na54 = other\na55 = other\na56 = other\na57 = other\na58 = other\na59 = other\na60 = other\na61 = other\na62 = other\na63 = other\na64 = other\na65 = other\na66 = other\na67 = other\na68 = other\na69 = other\na70 = other\na71 = other\na72 = other\na73 = other\na74 = other\na75 = other\na76 = other\na77 = other\na78 = other\na79 = other\na80 = other\na81 = other\na82 = other\na83 = other\na84 = other\na85 = other\na86 = other\na87 = other\na88 = other\na89 = other\na90 = other\na91 = other\na92 = other\na93 = other\na94 = other\na95 = other\na96 = other\na97 = other\na98 = other\na99 = other\na100 = other\na101 = other\na102 = other\na103 = other\na104 = other\na105 = other\na106 = other\na107 = other\na108 = other\na109 = other\na110 = other\na111 = other\na112 = other\na113 = other\na114 = other\na115 = other\na116 = other\na117 = other\na118 = other\na119 = other\na120 = other\na121 = other\na122 = other\na123 = other\na124 = other\na125 = other\na126 = other\na127 = other\na128 = other\na129 = other\na130 = other\na131 = other\na132 = other\na133 = other\na134 = other\na135 = other\na136 = other\na137 = other\na138 = other\na139 = other\na140 = other\na141 = other\na142 = other\na143 = other\na144 = other\na145 = other\na146 = other\na147 = other\na148 = other\na149 = other\na150 = other\na151 = other\na152 = other\na153 = other\na154 = other\na155 = other\na156 = other\na157 = other\na158 = other\na159 = other\na160 = other\na161 = other\na162 = other\na163 = other\na164 = other\na165 = other\na166 = other\na167 = other\na168 = other\na169 = other\na170 = other\na171 = other\na172 = other\na173 = other\na174 = other\na175 = other\na176 = other\na177 = other\na178 = other\na179 = other\na180 = other\na181 = other\na182 = other\na183 = other\na184 = other\na185 = other\na186 = other\na187 = other\na188 = other\na189 = other\na190 = other\na191 = other\nsay "${a0.p0}"\nsay "${a1.p0}"\nsay "${a2.p0}"\nsay "${a3.p0}"\nsay "${a4.p0}"\nsay "${a5.p0}"\nsay "${a6.p0}"\nsay "${a7.p0}"\nsay "${a8.p0}"\nsay "${a9.p0}"\nsay "${a10.p0}"\nsay "${a11.p0}"\nsay "${a12.p0}"\nsay "${a13.p0}"\nsay "${a14.p0}"\nsay "${a15.p0}"\nsay "${a16.p0}"\nsay "${a17.p0}"\nsay "${a18.p0}"\nsay "${a19.p0}"\nsay "${a20.p0}"\nsay "${a21.p0}"\nsay "${a22.p0}"\nsay "${a23.p0}"\nsay "${a24.p0}"\nsay "${a25.p0}"\nsay "${a26.p0}"\nsay "${a27.p0}"\nsay "${a28.p0}"\nsay "${a29.p0}"\nsay "${a30.p0}"\nsay "${a31.p0}"\nsay "${a32.p0}"\nsay "${a33.p0}"\nsay "${a34.p0}"\nsay "${a35.p0}"\nsay "${a36.p0}"\nsay "${a37.p0}"\nsay "${a38.p0}"\nsay "${a39.p0}"\nsay "${a40.p0}"\nsay "${a41.p0}"\nsay "${a42.p0}"\nsay "${a43.p0}"\nsay "${a44.p0}"\nsay "${a45.p0}"\nsay "${a46.p0}"\nsay "${a47.p0}"\nsay "${a48.p0}"\nsay "${a49.p0}"\nsay "${a50.p0}"\nsay "${a51.p0}"\nsay "${a52.p0}"\nsay "${a53.p0}"\nsay "${a54.p0}"\nsay "${a55.p0}"\nsay "${a56.p0}"\nsay "${a57.p0}"\nsay "${a58.p0}"\nsay "${a59.p0}"\nsay "${a60.p0}"\nsay "${a61.p0}"\nsay "${a62.p0}"\nsay "${a63.p0}"\nsay "${a64.p0}"\nsay "${a65.p0}"\nsay "${a66.p0}"\nsay "${a67.p0}"\nsay "${a68.p0}"\nsay "${a69.p0}"\nsay "${a70.p0}"\nsay "${a71.p0}"\nsay "${a72.p0}"\nsay "${a73.p0}"\nsay "${a74.p0}"\nsay "${a75.p0}"\nsay "${a76.p0}"\nsay "${a77.p0}"\nsay "${a78.p0}"\nsay "${a79.p0}"\nsay "${a80.p0}"\nsay "${a81.p0}"\nsay "${a82.p0}"\nsay "${a83.p0}"\nsay "${a84.p0}"\nsay "${a85.p0}"\nsay "${a86.p0}"\nsay "${a87.p0}"\nsay "${a88.p0}"\nsay "${a89.p0}"\nsay "${a90.p0}"\nsay "${a91.p0}"\nsay "${a92.p0}"\nsay "${a93.p0}"\nsay "${a94.p0}"\nsay "${a95.p0}"\nsay "${a96.p0}"\nsay "${a97.p0}"\nsay "${a98.p0}"\nsay "${a99.p0}"\nsay "${a100.p0}"\nsay "${a101.p0}"\nsay "${a102.p0}"\nsay "${a103.p0}"\nsay "${a104.p0}"\nsay "${a105.p0}"\nsay "${a106.p0}"\nsay "${a107.p0}"\nsay "${a108.p0}"\nsay "${a109.p0}"\nsay "${a110.p0}"\nsay "${a111.p0}"\nsay "${a112.p0}"\nsay "${a113.p0}"\nsay "${a114.p0}"\nsay "${a115.p0}"\nsay "${a116.p0}"\nsay "${a117.p0}"\nsay "${a118.p0}"\nsay "${a119.p0}"\nsay "${a120.p0}"\nsay "${a121.p0}"\nsay "${a122.p0}"\nsay "${a123.p0}"\nsay "${a124.p0}"\nsay "${a125.p0}"\nsay "${a126.p0}"\nsay "${a127.p0}"\nsay "${a128.p0}"\nsay "${a129.p0}"\nsay "${a130.p0}"\nsay "${a131.p0}"\nsay "${a132.p0}"\nsay "${a133.p0}"\nsay "${a134.p0}"\nsay "${a135.p0}"\nsay "${a136.p0}"\nsay "${a137.p0}"\nsay "${a138.p0}"\nsay "${a139.p0}"\nsay "${a140.p0}"\nsay "${a141.p0}"\nsay "${a142.p0}"\nsay "${a143.p0}"\nsay "${a144.p0}"\nsay "${a145.p0}"\nsay "${a146.p0}"\nsay "${a147.p0}"\nsay "${a148.p0}"\nsay "${a149.p0}"\nsay "${a150.p0}"\nsay "${a151.p0}"\nsay "${a152.p0}"\nsay "${a153.p0}"\nsay "${a154.p0}"\nsay "${a155.p0}"\nsay "${a156.p0}"\nsay "${a157.p0}"\nsay "${a158.p0}"\nsay "${a159.p0}"\nsay "${a160.p0}"\nsay "${a161.p0}"\nsay "${a162.p0}"\nsay "${a163.p0}"\nsay "${a164.p0}"\nsay "${a165.p0}"\nsay "${a166.p0}"\nsay "${a167.p0}"\nsay "${a168.p0}"\nsay "${a169.p0}"\nsay "${a170.p0}"\nsay "${a171.p0}"\nsay "${a172.p0}"\nsay "${a173.p0}"\nsay "${a174.p0}"\nsay "${a175.p0}"\nsay "${a176.p0}"\nsay "${a177.p0}"\nsay "${a178.p0}"\nsay "${a179.p0}"\nsay "${a180.p0}"\nsay "${a181.p0}"\nsay "${a182.p0}"\nsay "${a183.p0}"\nsay "${a184.p0}"\nsay "${a185.p0}"\nsay "${a186.p0}"\nsay "${a187.p0}"\nsay "${a188.p0}"\nsay "${a189.p0}"\nsay "${a190.p0}"\nsay "${a191.p0}"\nexit',
  ],
  [
    "original/12/original-driver/18",
    'let good = {p0: 1}\nlet other = {p0: "x"}\nlet a0 = good\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\nlet a48 = a47\nlet a49 = a48\nlet a50 = a49\nlet a51 = a50\nlet a52 = a51\nlet a53 = a52\nlet a54 = a53\nlet a55 = a54\nlet a56 = a55\nlet a57 = a56\nlet a58 = a57\nlet a59 = a58\nlet a60 = a59\nlet a61 = a60\nlet a62 = a61\nlet a63 = a62\nlet a64 = a63\nlet a65 = a64\nlet a66 = a65\nlet a67 = a66\nlet a68 = a67\nlet a69 = a68\nlet a70 = a69\nlet a71 = a70\nlet a72 = a71\nlet a73 = a72\nlet a74 = a73\nlet a75 = a74\nlet a76 = a75\nlet a77 = a76\nlet a78 = a77\nlet a79 = a78\nlet a80 = a79\nlet a81 = a80\nlet a82 = a81\nlet a83 = a82\nlet a84 = a83\nlet a85 = a84\nlet a86 = a85\nlet a87 = a86\nlet a88 = a87\nlet a89 = a88\nlet a90 = a89\nlet a91 = a90\nlet a92 = a91\nlet a93 = a92\nlet a94 = a93\nlet a95 = a94\nlet a96 = a95\nlet a97 = a96\nlet a98 = a97\nlet a99 = a98\nlet a100 = a99\nlet a101 = a100\nlet a102 = a101\nlet a103 = a102\nlet a104 = a103\nlet a105 = a104\nlet a106 = a105\nlet a107 = a106\nlet a108 = a107\nlet a109 = a108\nlet a110 = a109\nlet a111 = a110\nlet a112 = a111\nlet a113 = a112\nlet a114 = a113\nlet a115 = a114\nlet a116 = a115\nlet a117 = a116\nlet a118 = a117\nlet a119 = a118\nlet a120 = a119\nlet a121 = a120\nlet a122 = a121\nlet a123 = a122\nlet a124 = a123\nlet a125 = a124\nlet a126 = a125\nlet a127 = a126\nlet a128 = a127\nlet a129 = a128\nlet a130 = a129\nlet a131 = a130\nlet a132 = a131\nlet a133 = a132\nlet a134 = a133\nlet a135 = a134\nlet a136 = a135\nlet a137 = a136\nlet a138 = a137\nlet a139 = a138\nlet a140 = a139\nlet a141 = a140\nlet a142 = a141\nlet a143 = a142\nlet a144 = a143\nlet a145 = a144\nlet a146 = a145\nlet a147 = a146\nlet a148 = a147\nlet a149 = a148\nlet a150 = a149\nlet a151 = a150\nlet a152 = a151\nlet a153 = a152\nlet a154 = a153\nlet a155 = a154\nlet a156 = a155\nlet a157 = a156\nlet a158 = a157\nlet a159 = a158\nlet a160 = a159\nlet a161 = a160\nlet a162 = a161\nlet a163 = a162\nlet a164 = a163\nlet a165 = a164\nlet a166 = a165\nlet a167 = a166\nlet a168 = a167\nlet a169 = a168\nlet a170 = a169\nlet a171 = a170\nlet a172 = a171\nlet a173 = a172\nlet a174 = a173\nlet a175 = a174\nlet a176 = a175\nlet a177 = a176\nlet a178 = a177\nlet a179 = a178\nlet a180 = a179\nlet a181 = a180\nlet a182 = a181\nlet a183 = a182\nlet a184 = a183\nlet a185 = a184\nlet a186 = a185\nlet a187 = a186\nlet a188 = a187\nlet a189 = a188\nlet a190 = a189\nlet a191 = a190\na0 = a191\na1 = other\na2 = other\na3 = other\na4 = other\na5 = other\na6 = other\na7 = other\na8 = other\na9 = other\na10 = other\na11 = other\na12 = other\na13 = other\na14 = other\na15 = other\na16 = other\na17 = other\na18 = other\na19 = other\na20 = other\na21 = other\na22 = other\na23 = other\na24 = other\na25 = other\na26 = other\na27 = other\na28 = other\na29 = other\na30 = other\na31 = other\na32 = other\na33 = other\na34 = other\na35 = other\na36 = other\na37 = other\na38 = other\na39 = other\na40 = other\na41 = other\na42 = other\na43 = other\na44 = other\na45 = other\na46 = other\na47 = other\na48 = other\na49 = other\na50 = other\na51 = other\na52 = other\na53 = other\na54 = other\na55 = other\na56 = other\na57 = other\na58 = other\na59 = other\na60 = other\na61 = other\na62 = other\na63 = other\na64 = other\na65 = other\na66 = other\na67 = other\na68 = other\na69 = other\na70 = other\na71 = other\na72 = other\na73 = other\na74 = other\na75 = other\na76 = other\na77 = other\na78 = other\na79 = other\na80 = other\na81 = other\na82 = other\na83 = other\na84 = other\na85 = other\na86 = other\na87 = other\na88 = other\na89 = other\na90 = other\na91 = other\na92 = other\na93 = other\na94 = other\na95 = other\na96 = other\na97 = other\na98 = other\na99 = other\na100 = other\na101 = other\na102 = other\na103 = other\na104 = other\na105 = other\na106 = other\na107 = other\na108 = other\na109 = other\na110 = other\na111 = other\na112 = other\na113 = other\na114 = other\na115 = other\na116 = other\na117 = other\na118 = other\na119 = other\na120 = other\na121 = other\na122 = other\na123 = other\na124 = other\na125 = other\na126 = other\na127 = other\na128 = other\na129 = other\na130 = other\na131 = other\na132 = other\na133 = other\na134 = other\na135 = other\na136 = other\na137 = other\na138 = other\na139 = other\na140 = other\na141 = other\na142 = other\na143 = other\na144 = other\na145 = other\na146 = other\na147 = other\na148 = other\na149 = other\na150 = other\na151 = other\na152 = other\na153 = other\na154 = other\na155 = other\na156 = other\na157 = other\na158 = other\na159 = other\na160 = other\na161 = other\na162 = other\na163 = other\na164 = other\na165 = other\na166 = other\na167 = other\na168 = other\na169 = other\na170 = other\na171 = other\na172 = other\na173 = other\na174 = other\na175 = other\na176 = other\na177 = other\na178 = other\na179 = other\na180 = other\na181 = other\na182 = other\na183 = other\na184 = other\na185 = other\na186 = other\na187 = other\na188 = other\na189 = other\na190 = other\na191 = other\nsay "${a0.p0}"\nsay "${a1.p0}"\nsay "${a2.p0}"\nsay "${a3.p0}"\nsay "${a4.p0}"\nsay "${a5.p0}"\nsay "${a6.p0}"\nsay "${a7.p0}"\nsay "${a8.p0}"\nsay "${a9.p0}"\nsay "${a10.p0}"\nsay "${a11.p0}"\nsay "${a12.p0}"\nsay "${a13.p0}"\nsay "${a14.p0}"\nsay "${a15.p0}"\nsay "${a16.p0}"\nsay "${a17.p0}"\nsay "${a18.p0}"\nsay "${a19.p0}"\nsay "${a20.p0}"\nsay "${a21.p0}"\nsay "${a22.p0}"\nsay "${a23.p0}"\nsay "${a24.p0}"\nsay "${a25.p0}"\nsay "${a26.p0}"\nsay "${a27.p0}"\nsay "${a28.p0}"\nsay "${a29.p0}"\nsay "${a30.p0}"\nsay "${a31.p0}"\nsay "${a32.p0}"\nsay "${a33.p0}"\nsay "${a34.p0}"\nsay "${a35.p0}"\nsay "${a36.p0}"\nsay "${a37.p0}"\nsay "${a38.p0}"\nsay "${a39.p0}"\nsay "${a40.p0}"\nsay "${a41.p0}"\nsay "${a42.p0}"\nsay "${a43.p0}"\nsay "${a44.p0}"\nsay "${a45.p0}"\nsay "${a46.p0}"\nsay "${a47.p0}"\nsay "${a48.p0}"\nsay "${a49.p0}"\nsay "${a50.p0}"\nsay "${a51.p0}"\nsay "${a52.p0}"\nsay "${a53.p0}"\nsay "${a54.p0}"\nsay "${a55.p0}"\nsay "${a56.p0}"\nsay "${a57.p0}"\nsay "${a58.p0}"\nsay "${a59.p0}"\nsay "${a60.p0}"\nsay "${a61.p0}"\nsay "${a62.p0}"\nsay "${a63.p0}"\nsay "${a64.p0}"\nsay "${a65.p0}"\nsay "${a66.p0}"\nsay "${a67.p0}"\nsay "${a68.p0}"\nsay "${a69.p0}"\nsay "${a70.p0}"\nsay "${a71.p0}"\nsay "${a72.p0}"\nsay "${a73.p0}"\nsay "${a74.p0}"\nsay "${a75.p0}"\nsay "${a76.p0}"\nsay "${a77.p0}"\nsay "${a78.p0}"\nsay "${a79.p0}"\nsay "${a80.p0}"\nsay "${a81.p0}"\nsay "${a82.p0}"\nsay "${a83.p0}"\nsay "${a84.p0}"\nsay "${a85.p0}"\nsay "${a86.p0}"\nsay "${a87.p0}"\nsay "${a88.p0}"\nsay "${a89.p0}"\nsay "${a90.p0}"\nsay "${a91.p0}"\nsay "${a92.p0}"\nsay "${a93.p0}"\nsay "${a94.p0}"\nsay "${a95.p0}"\nsay "${a96.p0}"\nsay "${a97.p0}"\nsay "${a98.p0}"\nsay "${a99.p0}"\nsay "${a100.p0}"\nsay "${a101.p0}"\nsay "${a102.p0}"\nsay "${a103.p0}"\nsay "${a104.p0}"\nsay "${a105.p0}"\nsay "${a106.p0}"\nsay "${a107.p0}"\nsay "${a108.p0}"\nsay "${a109.p0}"\nsay "${a110.p0}"\nsay "${a111.p0}"\nsay "${a112.p0}"\nsay "${a113.p0}"\nsay "${a114.p0}"\nsay "${a115.p0}"\nsay "${a116.p0}"\nsay "${a117.p0}"\nsay "${a118.p0}"\nsay "${a119.p0}"\nsay "${a120.p0}"\nsay "${a121.p0}"\nsay "${a122.p0}"\nsay "${a123.p0}"\nsay "${a124.p0}"\nsay "${a125.p0}"\nsay "${a126.p0}"\nsay "${a127.p0}"\nsay "${a128.p0}"\nsay "${a129.p0}"\nsay "${a130.p0}"\nsay "${a131.p0}"\nsay "${a132.p0}"\nsay "${a133.p0}"\nsay "${a134.p0}"\nsay "${a135.p0}"\nsay "${a136.p0}"\nsay "${a137.p0}"\nsay "${a138.p0}"\nsay "${a139.p0}"\nsay "${a140.p0}"\nsay "${a141.p0}"\nsay "${a142.p0}"\nsay "${a143.p0}"\nsay "${a144.p0}"\nsay "${a145.p0}"\nsay "${a146.p0}"\nsay "${a147.p0}"\nsay "${a148.p0}"\nsay "${a149.p0}"\nsay "${a150.p0}"\nsay "${a151.p0}"\nsay "${a152.p0}"\nsay "${a153.p0}"\nsay "${a154.p0}"\nsay "${a155.p0}"\nsay "${a156.p0}"\nsay "${a157.p0}"\nsay "${a158.p0}"\nsay "${a159.p0}"\nsay "${a160.p0}"\nsay "${a161.p0}"\nsay "${a162.p0}"\nsay "${a163.p0}"\nsay "${a164.p0}"\nsay "${a165.p0}"\nsay "${a166.p0}"\nsay "${a167.p0}"\nsay "${a168.p0}"\nsay "${a169.p0}"\nsay "${a170.p0}"\nsay "${a171.p0}"\nsay "${a172.p0}"\nsay "${a173.p0}"\nsay "${a174.p0}"\nsay "${a175.p0}"\nsay "${a176.p0}"\nsay "${a177.p0}"\nsay "${a178.p0}"\nsay "${a179.p0}"\nsay "${a180.p0}"\nsay "${a181.p0}"\nsay "${a182.p0}"\nsay "${a183.p0}"\nsay "${a184.p0}"\nsay "${a185.p0}"\nsay "${a186.p0}"\nsay "${a187.p0}"\nsay "${a188.p0}"\nsay "${a189.p0}"\nsay "${a190.p0}"\nsay "${a191.p0}"\nexit',
  ],
  [
    "original/13/original-driver/22",
    'let source = {p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1, p9: 1, p10: 1, p11: 1, p12: 1, p13: 1, p14: 1, p15: 1, p16: 1, p17: 1, p18: 1, p19: 1, p20: 1, p21: 1, p22: 1, p23: 1}\nlet other = {p0: 2, p1: 2, p2: 2, p3: 2, p4: 2, p5: 2, p6: 2, p7: 2, p8: 2, p9: 2, p10: 2, p11: 2, p12: 2, p13: 2, p14: 2, p15: 2, p16: 2, p17: 2, p18: 2, p19: 2, p20: 2, p21: 2, p22: 2, p23: 2}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\na0 = a23\na0 = a3\na1 = a4\na2 = a5\na3 = a6\na4 = a7\na5 = a8\na6 = a9\na7 = a10\na8 = a11\na9 = a12\na10 = a13\na11 = a14\na12 = a15\na13 = a16\na14 = a17\na15 = a18\na16 = a19\na17 = a20\na18 = a21\na19 = a22\na20 = a23\na21 = a0\na22 = a1\na23 = a2\na23 = other\nsay "${a23.p0}"\nsay "${a22.p0}"\nsay "${a21.p0}"\nsay "${a20.p0}"\nsay "${a19.p0}"\nsay "${a18.p0}"\nsay "${a17.p0}"\nsay "${a16.p0}"\nsay "${a15.p0}"\nsay "${a14.p0}"\nsay "${a13.p0}"\nsay "${a12.p0}"\nsay "${a11.p0}"\nsay "${a10.p0}"\nsay "${a9.p0}"\nsay "${a8.p0}"\nsay "${a7.p0}"\nsay "${a6.p0}"\nsay "${a5.p0}"\nsay "${a4.p0}"\nsay "${a3.p0}"\nsay "${a2.p0}"\nsay "${a1.p0}"\nsay "${a0.p0}"\nexit',
  ],
  [
    "original/14/original-driver/23",
    'let source = {p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1, p9: 1, p10: 1, p11: 1, p12: 1, p13: 1, p14: 1, p15: 1, p16: 1, p17: 1, p18: 1, p19: 1, p20: 1, p21: 1, p22: 1, p23: 1, p24: 1, p25: 1, p26: 1, p27: 1, p28: 1, p29: 1, p30: 1, p31: 1, p32: 1, p33: 1, p34: 1, p35: 1, p36: 1, p37: 1, p38: 1, p39: 1, p40: 1, p41: 1, p42: 1, p43: 1, p44: 1, p45: 1, p46: 1, p47: 1}\nlet other = {p0: 2, p1: 2, p2: 2, p3: 2, p4: 2, p5: 2, p6: 2, p7: 2, p8: 2, p9: 2, p10: 2, p11: 2, p12: 2, p13: 2, p14: 2, p15: 2, p16: 2, p17: 2, p18: 2, p19: 2, p20: 2, p21: 2, p22: 2, p23: 2, p24: 2, p25: 2, p26: 2, p27: 2, p28: 2, p29: 2, p30: 2, p31: 2, p32: 2, p33: 2, p34: 2, p35: 2, p36: 2, p37: 2, p38: 2, p39: 2, p40: 2, p41: 2, p42: 2, p43: 2, p44: 2, p45: 2, p46: 2, p47: 2}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\na0 = a47\na0 = a3\na1 = a4\na2 = a5\na3 = a6\na4 = a7\na5 = a8\na6 = a9\na7 = a10\na8 = a11\na9 = a12\na10 = a13\na11 = a14\na12 = a15\na13 = a16\na14 = a17\na15 = a18\na16 = a19\na17 = a20\na18 = a21\na19 = a22\na20 = a23\na21 = a24\na22 = a25\na23 = a26\na24 = a27\na25 = a28\na26 = a29\na27 = a30\na28 = a31\na29 = a32\na30 = a33\na31 = a34\na32 = a35\na33 = a36\na34 = a37\na35 = a38\na36 = a39\na37 = a40\na38 = a41\na39 = a42\na40 = a43\na41 = a44\na42 = a45\na43 = a46\na44 = a47\na45 = a0\na46 = a1\na47 = a2\na47 = other\nsay "${a47.p0}"\nsay "${a46.p0}"\nsay "${a45.p0}"\nsay "${a44.p0}"\nsay "${a43.p0}"\nsay "${a42.p0}"\nsay "${a41.p0}"\nsay "${a40.p0}"\nsay "${a39.p0}"\nsay "${a38.p0}"\nsay "${a37.p0}"\nsay "${a36.p0}"\nsay "${a35.p0}"\nsay "${a34.p0}"\nsay "${a33.p0}"\nsay "${a32.p0}"\nsay "${a31.p0}"\nsay "${a30.p0}"\nsay "${a29.p0}"\nsay "${a28.p0}"\nsay "${a27.p0}"\nsay "${a26.p0}"\nsay "${a25.p0}"\nsay "${a24.p0}"\nsay "${a23.p0}"\nsay "${a22.p0}"\nsay "${a21.p0}"\nsay "${a20.p0}"\nsay "${a19.p0}"\nsay "${a18.p0}"\nsay "${a17.p0}"\nsay "${a16.p0}"\nsay "${a15.p0}"\nsay "${a14.p0}"\nsay "${a13.p0}"\nsay "${a12.p0}"\nsay "${a11.p0}"\nsay "${a10.p0}"\nsay "${a9.p0}"\nsay "${a8.p0}"\nsay "${a7.p0}"\nsay "${a6.p0}"\nsay "${a5.p0}"\nsay "${a4.p0}"\nsay "${a3.p0}"\nsay "${a2.p0}"\nsay "${a1.p0}"\nsay "${a0.p0}"\nexit',
  ],
  [
    "original/15/original-driver/24",
    'let source = {p0: 1, p1: 1, p2: 1, p3: 1, p4: 1, p5: 1, p6: 1, p7: 1, p8: 1, p9: 1, p10: 1, p11: 1, p12: 1, p13: 1, p14: 1, p15: 1, p16: 1, p17: 1, p18: 1, p19: 1, p20: 1, p21: 1, p22: 1, p23: 1, p24: 1, p25: 1, p26: 1, p27: 1, p28: 1, p29: 1, p30: 1, p31: 1, p32: 1, p33: 1, p34: 1, p35: 1, p36: 1, p37: 1, p38: 1, p39: 1, p40: 1, p41: 1, p42: 1, p43: 1, p44: 1, p45: 1, p46: 1, p47: 1, p48: 1, p49: 1, p50: 1, p51: 1, p52: 1, p53: 1, p54: 1, p55: 1, p56: 1, p57: 1, p58: 1, p59: 1, p60: 1, p61: 1, p62: 1, p63: 1, p64: 1, p65: 1, p66: 1, p67: 1, p68: 1, p69: 1, p70: 1, p71: 1, p72: 1, p73: 1, p74: 1, p75: 1, p76: 1, p77: 1, p78: 1, p79: 1, p80: 1, p81: 1, p82: 1, p83: 1, p84: 1, p85: 1, p86: 1, p87: 1, p88: 1, p89: 1, p90: 1, p91: 1, p92: 1, p93: 1, p94: 1, p95: 1}\nlet other = {p0: 2, p1: 2, p2: 2, p3: 2, p4: 2, p5: 2, p6: 2, p7: 2, p8: 2, p9: 2, p10: 2, p11: 2, p12: 2, p13: 2, p14: 2, p15: 2, p16: 2, p17: 2, p18: 2, p19: 2, p20: 2, p21: 2, p22: 2, p23: 2, p24: 2, p25: 2, p26: 2, p27: 2, p28: 2, p29: 2, p30: 2, p31: 2, p32: 2, p33: 2, p34: 2, p35: 2, p36: 2, p37: 2, p38: 2, p39: 2, p40: 2, p41: 2, p42: 2, p43: 2, p44: 2, p45: 2, p46: 2, p47: 2, p48: 2, p49: 2, p50: 2, p51: 2, p52: 2, p53: 2, p54: 2, p55: 2, p56: 2, p57: 2, p58: 2, p59: 2, p60: 2, p61: 2, p62: 2, p63: 2, p64: 2, p65: 2, p66: 2, p67: 2, p68: 2, p69: 2, p70: 2, p71: 2, p72: 2, p73: 2, p74: 2, p75: 2, p76: 2, p77: 2, p78: 2, p79: 2, p80: 2, p81: 2, p82: 2, p83: 2, p84: 2, p85: 2, p86: 2, p87: 2, p88: 2, p89: 2, p90: 2, p91: 2, p92: 2, p93: 2, p94: 2, p95: 2}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\nlet a48 = a47\nlet a49 = a48\nlet a50 = a49\nlet a51 = a50\nlet a52 = a51\nlet a53 = a52\nlet a54 = a53\nlet a55 = a54\nlet a56 = a55\nlet a57 = a56\nlet a58 = a57\nlet a59 = a58\nlet a60 = a59\nlet a61 = a60\nlet a62 = a61\nlet a63 = a62\nlet a64 = a63\nlet a65 = a64\nlet a66 = a65\nlet a67 = a66\nlet a68 = a67\nlet a69 = a68\nlet a70 = a69\nlet a71 = a70\nlet a72 = a71\nlet a73 = a72\nlet a74 = a73\nlet a75 = a74\nlet a76 = a75\nlet a77 = a76\nlet a78 = a77\nlet a79 = a78\nlet a80 = a79\nlet a81 = a80\nlet a82 = a81\nlet a83 = a82\nlet a84 = a83\nlet a85 = a84\nlet a86 = a85\nlet a87 = a86\nlet a88 = a87\nlet a89 = a88\nlet a90 = a89\nlet a91 = a90\nlet a92 = a91\nlet a93 = a92\nlet a94 = a93\nlet a95 = a94\na0 = a95\na0 = a3\na1 = a4\na2 = a5\na3 = a6\na4 = a7\na5 = a8\na6 = a9\na7 = a10\na8 = a11\na9 = a12\na10 = a13\na11 = a14\na12 = a15\na13 = a16\na14 = a17\na15 = a18\na16 = a19\na17 = a20\na18 = a21\na19 = a22\na20 = a23\na21 = a24\na22 = a25\na23 = a26\na24 = a27\na25 = a28\na26 = a29\na27 = a30\na28 = a31\na29 = a32\na30 = a33\na31 = a34\na32 = a35\na33 = a36\na34 = a37\na35 = a38\na36 = a39\na37 = a40\na38 = a41\na39 = a42\na40 = a43\na41 = a44\na42 = a45\na43 = a46\na44 = a47\na45 = a48\na46 = a49\na47 = a50\na48 = a51\na49 = a52\na50 = a53\na51 = a54\na52 = a55\na53 = a56\na54 = a57\na55 = a58\na56 = a59\na57 = a60\na58 = a61\na59 = a62\na60 = a63\na61 = a64\na62 = a65\na63 = a66\na64 = a67\na65 = a68\na66 = a69\na67 = a70\na68 = a71\na69 = a72\na70 = a73\na71 = a74\na72 = a75\na73 = a76\na74 = a77\na75 = a78\na76 = a79\na77 = a80\na78 = a81\na79 = a82\na80 = a83\na81 = a84\na82 = a85\na83 = a86\na84 = a87\na85 = a88\na86 = a89\na87 = a90\na88 = a91\na89 = a92\na90 = a93\na91 = a94\na92 = a95\na93 = a0\na94 = a1\na95 = a2\na95 = other\nsay "${a95.p0}"\nsay "${a94.p0}"\nsay "${a93.p0}"\nsay "${a92.p0}"\nsay "${a91.p0}"\nsay "${a90.p0}"\nsay "${a89.p0}"\nsay "${a88.p0}"\nsay "${a87.p0}"\nsay "${a86.p0}"\nsay "${a85.p0}"\nsay "${a84.p0}"\nsay "${a83.p0}"\nsay "${a82.p0}"\nsay "${a81.p0}"\nsay "${a80.p0}"\nsay "${a79.p0}"\nsay "${a78.p0}"\nsay "${a77.p0}"\nsay "${a76.p0}"\nsay "${a75.p0}"\nsay "${a74.p0}"\nsay "${a73.p0}"\nsay "${a72.p0}"\nsay "${a71.p0}"\nsay "${a70.p0}"\nsay "${a69.p0}"\nsay "${a68.p0}"\nsay "${a67.p0}"\nsay "${a66.p0}"\nsay "${a65.p0}"\nsay "${a64.p0}"\nsay "${a63.p0}"\nsay "${a62.p0}"\nsay "${a61.p0}"\nsay "${a60.p0}"\nsay "${a59.p0}"\nsay "${a58.p0}"\nsay "${a57.p0}"\nsay "${a56.p0}"\nsay "${a55.p0}"\nsay "${a54.p0}"\nsay "${a53.p0}"\nsay "${a52.p0}"\nsay "${a51.p0}"\nsay "${a50.p0}"\nsay "${a49.p0}"\nsay "${a48.p0}"\nsay "${a47.p0}"\nsay "${a46.p0}"\nsay "${a45.p0}"\nsay "${a44.p0}"\nsay "${a43.p0}"\nsay "${a42.p0}"\nsay "${a41.p0}"\nsay "${a40.p0}"\nsay "${a39.p0}"\nsay "${a38.p0}"\nsay "${a37.p0}"\nsay "${a36.p0}"\nsay "${a35.p0}"\nsay "${a34.p0}"\nsay "${a33.p0}"\nsay "${a32.p0}"\nsay "${a31.p0}"\nsay "${a30.p0}"\nsay "${a29.p0}"\nsay "${a28.p0}"\nsay "${a27.p0}"\nsay "${a26.p0}"\nsay "${a25.p0}"\nsay "${a24.p0}"\nsay "${a23.p0}"\nsay "${a22.p0}"\nsay "${a21.p0}"\nsay "${a20.p0}"\nsay "${a19.p0}"\nsay "${a18.p0}"\nsay "${a17.p0}"\nsay "${a16.p0}"\nsay "${a15.p0}"\nsay "${a14.p0}"\nsay "${a13.p0}"\nsay "${a12.p0}"\nsay "${a11.p0}"\nsay "${a10.p0}"\nsay "${a9.p0}"\nsay "${a8.p0}"\nsay "${a7.p0}"\nsay "${a6.p0}"\nsay "${a5.p0}"\nsay "${a4.p0}"\nsay "${a3.p0}"\nsay "${a2.p0}"\nsay "${a1.p0}"\nsay "${a0.p0}"\nexit',
  ],
  [
    "original/16/original-driver/25",
    'let source = {p: 1, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\na0 = a23\na0.q = 2\na1.q = 2\na2.q = 2\na3.q = 2\na4.q = 2\na5.q = 2\na6.q = 2\na7.q = 2\na8.q = 2\na9.q = 2\na10.q = 2\na11.q = 2\na12.q = 2\na13.q = 2\na14.q = 2\na15.q = 2\na16.q = 2\na17.q = 2\na18.q = 2\na19.q = 2\na20.q = 2\na21.q = 2\na22.q = 2\na23.q = 2\nlet b0 = a0\nsay "${b0.p}"\nlet b1 = a1\nsay "${b1.p}"\nlet b2 = a2\nsay "${b2.p}"\nlet b3 = a3\nsay "${b3.p}"\nlet b4 = a4\nsay "${b4.p}"\nlet b5 = a5\nsay "${b5.p}"\nlet b6 = a6\nsay "${b6.p}"\nlet b7 = a7\nsay "${b7.p}"\nlet b8 = a8\nsay "${b8.p}"\nlet b9 = a9\nsay "${b9.p}"\nlet b10 = a10\nsay "${b10.p}"\nlet b11 = a11\nsay "${b11.p}"\nlet b12 = a12\nsay "${b12.p}"\nlet b13 = a13\nsay "${b13.p}"\nlet b14 = a14\nsay "${b14.p}"\nlet b15 = a15\nsay "${b15.p}"\nlet b16 = a16\nsay "${b16.p}"\nlet b17 = a17\nsay "${b17.p}"\nlet b18 = a18\nsay "${b18.p}"\nlet b19 = a19\nsay "${b19.p}"\nlet b20 = a20\nsay "${b20.p}"\nlet b21 = a21\nsay "${b21.p}"\nlet b22 = a22\nsay "${b22.p}"\nlet b23 = a23\nsay "${b23.p}"\nexit',
  ],
  [
    "original/17/original-driver/26",
    'let source = {p: 1, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\na0 = a47\na0.q = 2\na1.q = 2\na2.q = 2\na3.q = 2\na4.q = 2\na5.q = 2\na6.q = 2\na7.q = 2\na8.q = 2\na9.q = 2\na10.q = 2\na11.q = 2\na12.q = 2\na13.q = 2\na14.q = 2\na15.q = 2\na16.q = 2\na17.q = 2\na18.q = 2\na19.q = 2\na20.q = 2\na21.q = 2\na22.q = 2\na23.q = 2\na24.q = 2\na25.q = 2\na26.q = 2\na27.q = 2\na28.q = 2\na29.q = 2\na30.q = 2\na31.q = 2\na32.q = 2\na33.q = 2\na34.q = 2\na35.q = 2\na36.q = 2\na37.q = 2\na38.q = 2\na39.q = 2\na40.q = 2\na41.q = 2\na42.q = 2\na43.q = 2\na44.q = 2\na45.q = 2\na46.q = 2\na47.q = 2\nlet b0 = a0\nsay "${b0.p}"\nlet b1 = a1\nsay "${b1.p}"\nlet b2 = a2\nsay "${b2.p}"\nlet b3 = a3\nsay "${b3.p}"\nlet b4 = a4\nsay "${b4.p}"\nlet b5 = a5\nsay "${b5.p}"\nlet b6 = a6\nsay "${b6.p}"\nlet b7 = a7\nsay "${b7.p}"\nlet b8 = a8\nsay "${b8.p}"\nlet b9 = a9\nsay "${b9.p}"\nlet b10 = a10\nsay "${b10.p}"\nlet b11 = a11\nsay "${b11.p}"\nlet b12 = a12\nsay "${b12.p}"\nlet b13 = a13\nsay "${b13.p}"\nlet b14 = a14\nsay "${b14.p}"\nlet b15 = a15\nsay "${b15.p}"\nlet b16 = a16\nsay "${b16.p}"\nlet b17 = a17\nsay "${b17.p}"\nlet b18 = a18\nsay "${b18.p}"\nlet b19 = a19\nsay "${b19.p}"\nlet b20 = a20\nsay "${b20.p}"\nlet b21 = a21\nsay "${b21.p}"\nlet b22 = a22\nsay "${b22.p}"\nlet b23 = a23\nsay "${b23.p}"\nlet b24 = a24\nsay "${b24.p}"\nlet b25 = a25\nsay "${b25.p}"\nlet b26 = a26\nsay "${b26.p}"\nlet b27 = a27\nsay "${b27.p}"\nlet b28 = a28\nsay "${b28.p}"\nlet b29 = a29\nsay "${b29.p}"\nlet b30 = a30\nsay "${b30.p}"\nlet b31 = a31\nsay "${b31.p}"\nlet b32 = a32\nsay "${b32.p}"\nlet b33 = a33\nsay "${b33.p}"\nlet b34 = a34\nsay "${b34.p}"\nlet b35 = a35\nsay "${b35.p}"\nlet b36 = a36\nsay "${b36.p}"\nlet b37 = a37\nsay "${b37.p}"\nlet b38 = a38\nsay "${b38.p}"\nlet b39 = a39\nsay "${b39.p}"\nlet b40 = a40\nsay "${b40.p}"\nlet b41 = a41\nsay "${b41.p}"\nlet b42 = a42\nsay "${b42.p}"\nlet b43 = a43\nsay "${b43.p}"\nlet b44 = a44\nsay "${b44.p}"\nlet b45 = a45\nsay "${b45.p}"\nlet b46 = a46\nsay "${b46.p}"\nlet b47 = a47\nsay "${b47.p}"\nexit',
  ],
  [
    "original/18/original-driver/27",
    'let source = {p: 1, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\nlet a48 = a47\nlet a49 = a48\nlet a50 = a49\nlet a51 = a50\nlet a52 = a51\nlet a53 = a52\nlet a54 = a53\nlet a55 = a54\nlet a56 = a55\nlet a57 = a56\nlet a58 = a57\nlet a59 = a58\nlet a60 = a59\nlet a61 = a60\nlet a62 = a61\nlet a63 = a62\nlet a64 = a63\nlet a65 = a64\nlet a66 = a65\nlet a67 = a66\nlet a68 = a67\nlet a69 = a68\nlet a70 = a69\nlet a71 = a70\nlet a72 = a71\nlet a73 = a72\nlet a74 = a73\nlet a75 = a74\nlet a76 = a75\nlet a77 = a76\nlet a78 = a77\nlet a79 = a78\nlet a80 = a79\nlet a81 = a80\nlet a82 = a81\nlet a83 = a82\nlet a84 = a83\nlet a85 = a84\nlet a86 = a85\nlet a87 = a86\nlet a88 = a87\nlet a89 = a88\nlet a90 = a89\nlet a91 = a90\nlet a92 = a91\nlet a93 = a92\nlet a94 = a93\nlet a95 = a94\na0 = a95\na0.q = 2\na1.q = 2\na2.q = 2\na3.q = 2\na4.q = 2\na5.q = 2\na6.q = 2\na7.q = 2\na8.q = 2\na9.q = 2\na10.q = 2\na11.q = 2\na12.q = 2\na13.q = 2\na14.q = 2\na15.q = 2\na16.q = 2\na17.q = 2\na18.q = 2\na19.q = 2\na20.q = 2\na21.q = 2\na22.q = 2\na23.q = 2\na24.q = 2\na25.q = 2\na26.q = 2\na27.q = 2\na28.q = 2\na29.q = 2\na30.q = 2\na31.q = 2\na32.q = 2\na33.q = 2\na34.q = 2\na35.q = 2\na36.q = 2\na37.q = 2\na38.q = 2\na39.q = 2\na40.q = 2\na41.q = 2\na42.q = 2\na43.q = 2\na44.q = 2\na45.q = 2\na46.q = 2\na47.q = 2\na48.q = 2\na49.q = 2\na50.q = 2\na51.q = 2\na52.q = 2\na53.q = 2\na54.q = 2\na55.q = 2\na56.q = 2\na57.q = 2\na58.q = 2\na59.q = 2\na60.q = 2\na61.q = 2\na62.q = 2\na63.q = 2\na64.q = 2\na65.q = 2\na66.q = 2\na67.q = 2\na68.q = 2\na69.q = 2\na70.q = 2\na71.q = 2\na72.q = 2\na73.q = 2\na74.q = 2\na75.q = 2\na76.q = 2\na77.q = 2\na78.q = 2\na79.q = 2\na80.q = 2\na81.q = 2\na82.q = 2\na83.q = 2\na84.q = 2\na85.q = 2\na86.q = 2\na87.q = 2\na88.q = 2\na89.q = 2\na90.q = 2\na91.q = 2\na92.q = 2\na93.q = 2\na94.q = 2\na95.q = 2\nlet b0 = a0\nsay "${b0.p}"\nlet b1 = a1\nsay "${b1.p}"\nlet b2 = a2\nsay "${b2.p}"\nlet b3 = a3\nsay "${b3.p}"\nlet b4 = a4\nsay "${b4.p}"\nlet b5 = a5\nsay "${b5.p}"\nlet b6 = a6\nsay "${b6.p}"\nlet b7 = a7\nsay "${b7.p}"\nlet b8 = a8\nsay "${b8.p}"\nlet b9 = a9\nsay "${b9.p}"\nlet b10 = a10\nsay "${b10.p}"\nlet b11 = a11\nsay "${b11.p}"\nlet b12 = a12\nsay "${b12.p}"\nlet b13 = a13\nsay "${b13.p}"\nlet b14 = a14\nsay "${b14.p}"\nlet b15 = a15\nsay "${b15.p}"\nlet b16 = a16\nsay "${b16.p}"\nlet b17 = a17\nsay "${b17.p}"\nlet b18 = a18\nsay "${b18.p}"\nlet b19 = a19\nsay "${b19.p}"\nlet b20 = a20\nsay "${b20.p}"\nlet b21 = a21\nsay "${b21.p}"\nlet b22 = a22\nsay "${b22.p}"\nlet b23 = a23\nsay "${b23.p}"\nlet b24 = a24\nsay "${b24.p}"\nlet b25 = a25\nsay "${b25.p}"\nlet b26 = a26\nsay "${b26.p}"\nlet b27 = a27\nsay "${b27.p}"\nlet b28 = a28\nsay "${b28.p}"\nlet b29 = a29\nsay "${b29.p}"\nlet b30 = a30\nsay "${b30.p}"\nlet b31 = a31\nsay "${b31.p}"\nlet b32 = a32\nsay "${b32.p}"\nlet b33 = a33\nsay "${b33.p}"\nlet b34 = a34\nsay "${b34.p}"\nlet b35 = a35\nsay "${b35.p}"\nlet b36 = a36\nsay "${b36.p}"\nlet b37 = a37\nsay "${b37.p}"\nlet b38 = a38\nsay "${b38.p}"\nlet b39 = a39\nsay "${b39.p}"\nlet b40 = a40\nsay "${b40.p}"\nlet b41 = a41\nsay "${b41.p}"\nlet b42 = a42\nsay "${b42.p}"\nlet b43 = a43\nsay "${b43.p}"\nlet b44 = a44\nsay "${b44.p}"\nlet b45 = a45\nsay "${b45.p}"\nlet b46 = a46\nsay "${b46.p}"\nlet b47 = a47\nsay "${b47.p}"\nlet b48 = a48\nsay "${b48.p}"\nlet b49 = a49\nsay "${b49.p}"\nlet b50 = a50\nsay "${b50.p}"\nlet b51 = a51\nsay "${b51.p}"\nlet b52 = a52\nsay "${b52.p}"\nlet b53 = a53\nsay "${b53.p}"\nlet b54 = a54\nsay "${b54.p}"\nlet b55 = a55\nsay "${b55.p}"\nlet b56 = a56\nsay "${b56.p}"\nlet b57 = a57\nsay "${b57.p}"\nlet b58 = a58\nsay "${b58.p}"\nlet b59 = a59\nsay "${b59.p}"\nlet b60 = a60\nsay "${b60.p}"\nlet b61 = a61\nsay "${b61.p}"\nlet b62 = a62\nsay "${b62.p}"\nlet b63 = a63\nsay "${b63.p}"\nlet b64 = a64\nsay "${b64.p}"\nlet b65 = a65\nsay "${b65.p}"\nlet b66 = a66\nsay "${b66.p}"\nlet b67 = a67\nsay "${b67.p}"\nlet b68 = a68\nsay "${b68.p}"\nlet b69 = a69\nsay "${b69.p}"\nlet b70 = a70\nsay "${b70.p}"\nlet b71 = a71\nsay "${b71.p}"\nlet b72 = a72\nsay "${b72.p}"\nlet b73 = a73\nsay "${b73.p}"\nlet b74 = a74\nsay "${b74.p}"\nlet b75 = a75\nsay "${b75.p}"\nlet b76 = a76\nsay "${b76.p}"\nlet b77 = a77\nsay "${b77.p}"\nlet b78 = a78\nsay "${b78.p}"\nlet b79 = a79\nsay "${b79.p}"\nlet b80 = a80\nsay "${b80.p}"\nlet b81 = a81\nsay "${b81.p}"\nlet b82 = a82\nsay "${b82.p}"\nlet b83 = a83\nsay "${b83.p}"\nlet b84 = a84\nsay "${b84.p}"\nlet b85 = a85\nsay "${b85.p}"\nlet b86 = a86\nsay "${b86.p}"\nlet b87 = a87\nsay "${b87.p}"\nlet b88 = a88\nsay "${b88.p}"\nlet b89 = a89\nsay "${b89.p}"\nlet b90 = a90\nsay "${b90.p}"\nlet b91 = a91\nsay "${b91.p}"\nlet b92 = a92\nsay "${b92.p}"\nlet b93 = a93\nsay "${b93.p}"\nlet b94 = a94\nsay "${b94.p}"\nlet b95 = a95\nsay "${b95.p}"\nexit',
  ],
  [
    "original/19/original-driver/28",
    'let typed: integer? = 1\nlet source = {p: typed, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\na0 = a23\na0 = source\na1 = source\na2 = source\na3 = source\na4 = source\na5 = source\na6 = source\na7 = source\na8 = source\na9 = source\na10 = source\na11 = source\na12 = source\na13 = source\na14 = source\na15 = source\na16 = source\na17 = source\na18 = source\na19 = source\na20 = source\na21 = source\na22 = source\na23 = source\nsay "${a0.p}"\nsay "${a1.p}"\nsay "${a2.p}"\nsay "${a3.p}"\nsay "${a4.p}"\nsay "${a5.p}"\nsay "${a6.p}"\nsay "${a7.p}"\nsay "${a8.p}"\nsay "${a9.p}"\nsay "${a10.p}"\nsay "${a11.p}"\nsay "${a12.p}"\nsay "${a13.p}"\nsay "${a14.p}"\nsay "${a15.p}"\nsay "${a16.p}"\nsay "${a17.p}"\nsay "${a18.p}"\nsay "${a19.p}"\nsay "${a20.p}"\nsay "${a21.p}"\nsay "${a22.p}"\nsay "${a23.p}"\nexit',
  ],
  [
    "original/20/original-driver/29",
    'let typed: integer? = 1\nlet source = {p: typed, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\na0 = a47\na0 = source\na1 = source\na2 = source\na3 = source\na4 = source\na5 = source\na6 = source\na7 = source\na8 = source\na9 = source\na10 = source\na11 = source\na12 = source\na13 = source\na14 = source\na15 = source\na16 = source\na17 = source\na18 = source\na19 = source\na20 = source\na21 = source\na22 = source\na23 = source\na24 = source\na25 = source\na26 = source\na27 = source\na28 = source\na29 = source\na30 = source\na31 = source\na32 = source\na33 = source\na34 = source\na35 = source\na36 = source\na37 = source\na38 = source\na39 = source\na40 = source\na41 = source\na42 = source\na43 = source\na44 = source\na45 = source\na46 = source\na47 = source\nsay "${a0.p}"\nsay "${a1.p}"\nsay "${a2.p}"\nsay "${a3.p}"\nsay "${a4.p}"\nsay "${a5.p}"\nsay "${a6.p}"\nsay "${a7.p}"\nsay "${a8.p}"\nsay "${a9.p}"\nsay "${a10.p}"\nsay "${a11.p}"\nsay "${a12.p}"\nsay "${a13.p}"\nsay "${a14.p}"\nsay "${a15.p}"\nsay "${a16.p}"\nsay "${a17.p}"\nsay "${a18.p}"\nsay "${a19.p}"\nsay "${a20.p}"\nsay "${a21.p}"\nsay "${a22.p}"\nsay "${a23.p}"\nsay "${a24.p}"\nsay "${a25.p}"\nsay "${a26.p}"\nsay "${a27.p}"\nsay "${a28.p}"\nsay "${a29.p}"\nsay "${a30.p}"\nsay "${a31.p}"\nsay "${a32.p}"\nsay "${a33.p}"\nsay "${a34.p}"\nsay "${a35.p}"\nsay "${a36.p}"\nsay "${a37.p}"\nsay "${a38.p}"\nsay "${a39.p}"\nsay "${a40.p}"\nsay "${a41.p}"\nsay "${a42.p}"\nsay "${a43.p}"\nsay "${a44.p}"\nsay "${a45.p}"\nsay "${a46.p}"\nsay "${a47.p}"\nexit',
  ],
  [
    "original/21/original-driver/30",
    'let typed: integer? = 1\nlet source = {p: typed, q: 1}\nlet a0 = source\nlet a1 = a0\nlet a2 = a1\nlet a3 = a2\nlet a4 = a3\nlet a5 = a4\nlet a6 = a5\nlet a7 = a6\nlet a8 = a7\nlet a9 = a8\nlet a10 = a9\nlet a11 = a10\nlet a12 = a11\nlet a13 = a12\nlet a14 = a13\nlet a15 = a14\nlet a16 = a15\nlet a17 = a16\nlet a18 = a17\nlet a19 = a18\nlet a20 = a19\nlet a21 = a20\nlet a22 = a21\nlet a23 = a22\nlet a24 = a23\nlet a25 = a24\nlet a26 = a25\nlet a27 = a26\nlet a28 = a27\nlet a29 = a28\nlet a30 = a29\nlet a31 = a30\nlet a32 = a31\nlet a33 = a32\nlet a34 = a33\nlet a35 = a34\nlet a36 = a35\nlet a37 = a36\nlet a38 = a37\nlet a39 = a38\nlet a40 = a39\nlet a41 = a40\nlet a42 = a41\nlet a43 = a42\nlet a44 = a43\nlet a45 = a44\nlet a46 = a45\nlet a47 = a46\nlet a48 = a47\nlet a49 = a48\nlet a50 = a49\nlet a51 = a50\nlet a52 = a51\nlet a53 = a52\nlet a54 = a53\nlet a55 = a54\nlet a56 = a55\nlet a57 = a56\nlet a58 = a57\nlet a59 = a58\nlet a60 = a59\nlet a61 = a60\nlet a62 = a61\nlet a63 = a62\nlet a64 = a63\nlet a65 = a64\nlet a66 = a65\nlet a67 = a66\nlet a68 = a67\nlet a69 = a68\nlet a70 = a69\nlet a71 = a70\nlet a72 = a71\nlet a73 = a72\nlet a74 = a73\nlet a75 = a74\nlet a76 = a75\nlet a77 = a76\nlet a78 = a77\nlet a79 = a78\nlet a80 = a79\nlet a81 = a80\nlet a82 = a81\nlet a83 = a82\nlet a84 = a83\nlet a85 = a84\nlet a86 = a85\nlet a87 = a86\nlet a88 = a87\nlet a89 = a88\nlet a90 = a89\nlet a91 = a90\nlet a92 = a91\nlet a93 = a92\nlet a94 = a93\nlet a95 = a94\na0 = a95\na0 = source\na1 = source\na2 = source\na3 = source\na4 = source\na5 = source\na6 = source\na7 = source\na8 = source\na9 = source\na10 = source\na11 = source\na12 = source\na13 = source\na14 = source\na15 = source\na16 = source\na17 = source\na18 = source\na19 = source\na20 = source\na21 = source\na22 = source\na23 = source\na24 = source\na25 = source\na26 = source\na27 = source\na28 = source\na29 = source\na30 = source\na31 = source\na32 = source\na33 = source\na34 = source\na35 = source\na36 = source\na37 = source\na38 = source\na39 = source\na40 = source\na41 = source\na42 = source\na43 = source\na44 = source\na45 = source\na46 = source\na47 = source\na48 = source\na49 = source\na50 = source\na51 = source\na52 = source\na53 = source\na54 = source\na55 = source\na56 = source\na57 = source\na58 = source\na59 = source\na60 = source\na61 = source\na62 = source\na63 = source\na64 = source\na65 = source\na66 = source\na67 = source\na68 = source\na69 = source\na70 = source\na71 = source\na72 = source\na73 = source\na74 = source\na75 = source\na76 = source\na77 = source\na78 = source\na79 = source\na80 = source\na81 = source\na82 = source\na83 = source\na84 = source\na85 = source\na86 = source\na87 = source\na88 = source\na89 = source\na90 = source\na91 = source\na92 = source\na93 = source\na94 = source\na95 = source\nsay "${a0.p}"\nsay "${a1.p}"\nsay "${a2.p}"\nsay "${a3.p}"\nsay "${a4.p}"\nsay "${a5.p}"\nsay "${a6.p}"\nsay "${a7.p}"\nsay "${a8.p}"\nsay "${a9.p}"\nsay "${a10.p}"\nsay "${a11.p}"\nsay "${a12.p}"\nsay "${a13.p}"\nsay "${a14.p}"\nsay "${a15.p}"\nsay "${a16.p}"\nsay "${a17.p}"\nsay "${a18.p}"\nsay "${a19.p}"\nsay "${a20.p}"\nsay "${a21.p}"\nsay "${a22.p}"\nsay "${a23.p}"\nsay "${a24.p}"\nsay "${a25.p}"\nsay "${a26.p}"\nsay "${a27.p}"\nsay "${a28.p}"\nsay "${a29.p}"\nsay "${a30.p}"\nsay "${a31.p}"\nsay "${a32.p}"\nsay "${a33.p}"\nsay "${a34.p}"\nsay "${a35.p}"\nsay "${a36.p}"\nsay "${a37.p}"\nsay "${a38.p}"\nsay "${a39.p}"\nsay "${a40.p}"\nsay "${a41.p}"\nsay "${a42.p}"\nsay "${a43.p}"\nsay "${a44.p}"\nsay "${a45.p}"\nsay "${a46.p}"\nsay "${a47.p}"\nsay "${a48.p}"\nsay "${a49.p}"\nsay "${a50.p}"\nsay "${a51.p}"\nsay "${a52.p}"\nsay "${a53.p}"\nsay "${a54.p}"\nsay "${a55.p}"\nsay "${a56.p}"\nsay "${a57.p}"\nsay "${a58.p}"\nsay "${a59.p}"\nsay "${a60.p}"\nsay "${a61.p}"\nsay "${a62.p}"\nsay "${a63.p}"\nsay "${a64.p}"\nsay "${a65.p}"\nsay "${a66.p}"\nsay "${a67.p}"\nsay "${a68.p}"\nsay "${a69.p}"\nsay "${a70.p}"\nsay "${a71.p}"\nsay "${a72.p}"\nsay "${a73.p}"\nsay "${a74.p}"\nsay "${a75.p}"\nsay "${a76.p}"\nsay "${a77.p}"\nsay "${a78.p}"\nsay "${a79.p}"\nsay "${a80.p}"\nsay "${a81.p}"\nsay "${a82.p}"\nsay "${a83.p}"\nsay "${a84.p}"\nsay "${a85.p}"\nsay "${a86.p}"\nsay "${a87.p}"\nsay "${a88.p}"\nsay "${a89.p}"\nsay "${a90.p}"\nsay "${a91.p}"\nsay "${a92.p}"\nsay "${a93.p}"\nsay "${a94.p}"\nsay "${a95.p}"\nexit',
  ],
];
