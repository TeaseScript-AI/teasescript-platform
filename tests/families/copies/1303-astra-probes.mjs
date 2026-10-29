// #1303; Astra review.
export const cases = (() => {
  const cases = [];
  function add(id, body, reads = [], options = {}) {
    cases.push({ id, source: body + "\nexit\n", reads, ...options });
  }
  for (const member of ["first", "last", "random"]) {
    add(`direct-${member}`, `let xs: integer[] = hostValue\nlet out = xs.${member}`, [
      `xs.${member}`,
    ]);
    add(`test-${member}`, `let xs = hostValue\nif xs is integer[] {\nlet out = xs.${member}\n}`, [
      `xs.${member}`,
    ]);
    add(
      `nested-${member}`,
      `let rows: integer[][] = hostValue\nlet out = rows.${member}.${member}`,
      [`rows.${member}`, `rows.${member}.${member}`],
    );
    add(
      `dict-${member}`,
      `let rows: integer[] dict = hostValue\nlet xs = rows["chosen"]\nlet out = xs.${member}`,
      [`xs.${member}`],
    );
    add(
      `set-${member}`,
      `let rows: integer[] set = hostValue\nlet out = rows.${member}.${member}`,
      [`rows.${member}`, `rows.${member}.${member}`],
    );
    add(`store-${member}`, `let xs: integer[] = [1]\nxs = hostValue\nlet out = xs.${member}`, [
      `xs.${member}`,
    ]);
    add(`nonempty-${member}`, `let xs: integer[] = [1]\nlet out = xs.${member}`, [], {
      unchanged: true,
    });
    add(`host-element-${member}`, `let xs = [hostValue]\nlet out = xs.${member}`, [], {
      unchanged: true,
    });
  }
  add("dict-values", "let d: integer dict = hostValue\nlet xs = d.values\nlet out = xs.first", [
    "xs.first",
  ]);
  add("dict-keys", "let d: integer dict = hostValue\nlet xs = d.keys\nlet out = xs.random", [
    "xs.random",
  ]);
  add(
    "dict-values-nested",
    "let d: integer[] dict = hostValue\nlet xs = d.values.first\nlet out = xs.last",
    ["d.values.first", "xs.last"],
  );
  add(
    "gather-copy",
    "let xs: integer[] = hostValue\nlet wrapped = [xs]\nlet out = wrapped.first.last",
    ["wrapped.first.last"],
  );
  add(
    "property-copy",
    "let xs: integer[] = hostValue\nlet box = {bag: {items: xs}}\nlet copy = box\nlet out = copy.bag.items.random",
    ["copy.bag.items.random"],
  );
  add("property-store", "let box = {items: [1]}\nbox.items = hostValue\nlet out = box.items.last", [
    "box.items.last",
  ]);
  add(
    "host-property-written",
    "let raw = hostValue\nlet xs: integer[] = raw.items\nlet out = xs.first",
    ["xs.first"],
  );
  add(
    "host-deep-copy",
    "let a = hostValue\nlet b = a\nlet c = b\nlet xs: integer[] = c.items.rows[0]\nlet out = xs.random",
    ["xs.random"],
  );
  add(
    "get-inner",
    "let rows: integer[][] = hostValue\nlet xs = rows.get(0, default: [1])\nlet out = xs.first",
    ["xs.first"],
  );
  add("loop-set", "let rows: integer[] set = hostValue\nfor xs in rows {\nlet out = xs.random\n}", [
    "xs.random",
  ]);
  add(
    "loop-dict-values",
    "let rows: integer[] dict = hostValue\nfor xs in rows.values {\nlet out = xs.first\n}",
    ["xs.first"],
  );
  add(
    "loop-two-levels",
    "let rows: integer[][][] = hostValue\nfor group in rows {\nfor xs in group {\nlet out = xs.last\n}\n}",
    ["xs.last"],
  );
  add(
    "loop-tested",
    "let rows = hostValue\nif rows is integer[][] {\nfor xs in rows {\nlet out = xs.last\n}\n}",
    ["xs.last"],
  );
  add(
    "loop-writes",
    "let src: integer[] = hostValue\nlet xs: integer[] = []\nfor value in src { xs.add(value) }\nlet out = xs.random",
    ["xs.random"],
  );
  add(
    "parameter-projection",
    "function pick(rows: integer[][]) { return rows.first.last }\nlet out = pick(hostValue)",
    ["rows.first", "rows.first.last"],
  );
  add(
    "return-copy",
    "function identity(xs: integer[]) { return xs }\nlet values = identity(hostValue)\nlet out = values.first",
    ["values.first"],
  );
  add(
    "interpolation-copy",
    'let xs: string[] = hostValue\nlet box = {items: xs}\nsay "${box.items}"',
    ["box.items"],
  );
  add("interpolation-loop", 'let rows: string[][] = hostValue\nfor xs in rows {\nsay "${xs}"\n}', [
    "xs",
  ]);
  add("interpolation-store", 'let xs: string[] = ["ok"]\nxs = hostValue\nsay "${xs}"', ["xs"]);
  add("interpolation-parameter", 'function show(xs: string[]) { say "${xs}" }\nshow(hostValue)', [
    "xs",
  ]);
  add("typed-add", "let xs: integer[] = hostValue\nxs.add(1)\nlet out = xs.first", ["xs.first"]);
  add("empty-literal", "let xs: integer[] = []\nlet out = xs.first", ["xs.first"], {
    unchanged: true,
  });
  add("overwrite-literal", "let xs: integer[] = hostValue\nxs = [1]\nlet out = xs.first", [], {
    unchanged: true,
  });
  add("nonempty-inner", "let rows = [[hostValue]]\nlet out = rows.first.first", [], {
    unchanged: true,
  });
  add("loop-known", "let rows = [[1]]\nfor xs in rows { let out = xs.first }", [], {
    unchanged: true,
  });
  add("interpolation-known", 'let xs: string[] = hostValue\nxs = ["yes"]\nsay "${xs}"', [], {
    unchanged: true,
  });
  add(
    "opaque-store",
    'let text = "bbb"\nlet xs: string[] = []\nxs = text.findAll(/a/)\nlet out = xs.first',
    ["xs.first"],
    { unchanged: true },
  );
  add(
    "opaque-loop",
    'let text = "bbb"\nlet xs: string[] = []\nxs = text.findAll(/a/)\nlet ys: string[] = []\nfor value in xs { ys.add(value) }\nlet out = ys.first',
    ["ys.first"],
    { unchanged: true },
  );
  add(
    "json",
    "let xs: integer[] = fromJson(hostValue, default: [1])\nlet out = xs.random",
    ["xs.random"],
    { unchanged: true },
  );
  add(
    "load-literal",
    'let xs: integer[] = load("choice", default: [1])\nlet out = xs.random',
    ["xs.random"],
    { unchanged: true },
  );
  const key = "let key: string = hostValue\n";
  for (const gather of [false, true]) {
    const pre =
      key +
      (gather
        ? "let all = [load(key, default: {items: [1], n: 2}), load(key, default: {items: [2], n: 3})]\nlet raw = all.first\n"
        : "let raw = load(key, default: {items: [1], n: 2})\n");
    for (const rev of [false, true]) {
      const scalar = "let n: integer = raw.n";
      const list = "let xs: integer[] = raw.items\nlet out = xs.random";
      add(
        `computed-${gather}-${rev}`,
        pre + (rev ? list + "\n" + scalar : scalar + "\n" + list),
        ["xs.random"],
        { eight: true },
      );
    }
  }
  add(
    "computed-loop",
    key +
      "let raw = load(key, default: [[1]])\nfor row in raw {\nlet xs: integer[] = row\nlet out = xs.first\n}",
    ["xs.first"],
    { eight: true },
  );
  add(
    "computed-interpolation",
    key + 'let xs: string[] = load(key, default: ["yes"])\nsay "${xs}"',
    ["xs"],
    { eight: true },
  );
  add("gap-1320-list", 'let xs = hostValue\nif xs is string[] { say "${xs}" }', [], {
    unchanged: true,
    gap: true,
  });
  add("gap-1320-scalar", 'let xs = hostValue\nif xs is string { say "${xs}" }', [], {
    unchanged: true,
    gap: true,
  });
  add(
    "gap-1321-written",
    'let s = "bbb"\nlet xs: string[] = s.findAll(/a/)\nlet out = xs.first',
    [],
    { unchanged: true, gap: true },
  );
  add(
    "gap-1321-test",
    'let s = "bbb"\nlet xs = s.findAll(/a/)\nif xs is string[] { let out = xs.first }',
    [],
    { unchanged: true, gap: true },
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
