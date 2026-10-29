// #1394 G5 5a Astra review / builder corpus.
export const cases = (() => {
  const { families: families } = (() => {
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
    return { families };
  })();
  const pick = (name, k) => {
    const [family, variant] = name.split("/");
    const made = families[family](k);
    return typeof made === "string" ? made : made[variant];
  };
  const shapes = [
    ["i1339-many-fed/conflict-read", 4],
    ["i1339-chord/quiet-read", 4],
    ["ring-member-stores", 4],
    ["a2-axis-same", 4],
    ["single-stops/two-copies-one-stop", 3],
    ["single-stops/uncalled", 3],
  ].map(([name, k]) => ({ name: `${name}-${k}`, source: pick(name, k) }));
  return shapes.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];
