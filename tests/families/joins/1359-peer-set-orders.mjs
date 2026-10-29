export const cases = (() => {
  // #1417; builder/review archive.
  const sizes = [16, 32];
  const shapes = (() => {
    const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
    const peersOf = (k) => Math.max(2, Math.floor(k / 8));
    const values = {
      role: (k) => `${"max(".repeat(k)}hostValue.n${many(k, (i) => `, ${i})`, "")}`,
      leaf: (k) => `askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.p${i}}`, ", ")}`,
    };
    const shuffled = (m, i) => {
      const out = Array.from({ length: m }, (_, j) => j);
      let seed = (i * 2654435761 + 12345) >>> 0;
      for (let j = m - 1; j > 0; j -= 1) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        const at = seed % (j + 1);
        [out[j], out[at]] = [out[at], out[j]];
      }
      return out;
    };
    const forms = {
      fixed: (m) => Array.from({ length: m }, (_, j) => j),
      rotated: (m, i) => Array.from({ length: m }, (_, j) => (i + j) % m),
      permuted: (m, i) => shuffled(m, i),
      // a window of 2 to m peers from a rotating start: up to k distinct subsets
      subsets: (m, i) => Array.from({ length: 2 + ((i * 7) % (m - 1)) }, (_, j) => (i + j) % m),
      // three peers, a distinct set at each of up to m·(m-1) sites, rotated
      triples: (m, i) => {
        const a = i % m;
        const b = (a + 1 + (Math.floor(i / m) % (m - 1))) % m;
        const c = [(b + 1) % m, (b + 2) % m].find((j) => j !== a);
        return [a, b, c].map((_, j, all) => all[(i + j) % 3]);
      },
      // one set in two orders, alternating: its leaves joined through two intermediates
      twoOrders: (m, i) => Array.from({ length: m }, (_, j) => (i % 2 === 0 ? j : m - 1 - j)),
    };
    const program = (kind, form, k, prefix = "p") => {
      const m = peersOf(k);
      return [
        many(m, (j) => `let ${prefix}${j} = ${values[kind](k)}`),
        many(
          k,
          (i) =>
            `let xs${i} = [${forms[form](m, i)
              .map((j) => `${prefix}${j}`)
              .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
        ),
        "exit",
      ].join("\n");
    };
    const shapes = {};
    for (const kind of Object.keys(values))
      for (const form of Object.keys(forms))
        shapes[`${kind}-${form}`] = (k) => program(kind, form, k);
    for (const kind of Object.keys(values))
      shapes[`${kind}-aliased`] = (k) => {
        const m = peersOf(k);
        return [
          many(m, (j) => `let p${j} = ${values[kind](k)}`),
          many(m, (j) => `let a${j} = p${j}\nlet b${j} = a${j}`),
          many(
            k,
            (i) =>
              `let xs${i} = [${forms
                .rotated(m, i)
                .map((j) => `b${j}`)
                .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n");
      };
    for (const form of ["rotated", "permuted", "subsets", "triples", "fixed"])
      shapes[`alias-${form}`] = (k) => {
        const m = peersOf(k);
        const chain = (p) =>
          `${"max(".repeat(k)}x${p % m}${many(k, (r) => `, x${(p + r + 1) % m})`, "")}`;
        return [
          "let base = 1",
          many(m, (j) => `let x${j} = base`),
          many(m, (j) => `let p${j} = ${chain(j)}`),
          many(
            k,
            (i) =>
              `let xs${i} = [${forms[form](m, i)
                .map((j) => `p${j}`)
                .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n");
      };
    const result = {};
    const leaf = (v) =>
      typeof v === "string" ||
      (Array.isArray(v) &&
        v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
    for (const [name, make] of Object.entries(shapes)) {
      const sample = make(16);
      if (leaf(sample)) result[name] = make;
      else
        for (const [variant, source] of Object.entries(sample))
          if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
    }
    return result;
  })();
  const checks = ["publication"];

  const selected = [];
  for (const [name, sizes] of [
    ["role-fixed", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["role-rotated", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["role-permuted", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["role-subsets", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["role-triples", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["role-twoOrders", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["leaf-fixed", [16, 32, 2, 3, 5, 9, 64]],
    ["leaf-rotated", [16, 32, 2, 3, 5, 9, 64]],
    ["leaf-permuted", [16, 32, 2, 3, 5, 9, 64]],
    ["leaf-subsets", [16, 32, 2, 3, 5, 9, 64]],
    ["leaf-triples", [16, 32, 2, 3, 5, 9, 64]],
    ["leaf-twoOrders", [16, 32, 2, 3, 5, 9, 64]],
    ["role-aliased", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["leaf-aliased", [16, 32, 2, 3, 5, 9, 64]],
    ["alias-rotated", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["alias-permuted", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["alias-subsets", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["alias-triples", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["alias-fixed", [16, 32, 2, 3, 5, 9, 64, 128]],
  ])
    for (const n of sizes) selected.push([name + "@" + n, shapes[name](n)]);
  return selected;
})();

export const checks = ["publication"];
