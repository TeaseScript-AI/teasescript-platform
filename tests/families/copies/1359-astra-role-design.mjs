// Astra review: size-dependent shapes source families.
export const sizes = [4, 8];
const corpus = (() => {
  const { shapes: orders } = (() => {
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
    return { shapes };
  })();
  const { shapes: ties } = (() => {
    const many = (n, f, separator = "\n") =>
      Array.from({ length: n }, (_, i) => f(i)).join(separator);
    function tied(k, form = "rotated", spacing = 4) {
      const m = Math.max(4, Math.floor(k / spacing));
      return [
        "let base = 1\nlet early = base\nlet late = base",
        many(
          m,
          (j) =>
            `let p${j} = ${"max(".repeat(k)}early${many(k, (r) => `, ${j !== 0 && r % m === j ? "late" : "early"})`, "")}`,
        ),
        many(k, (i) => {
          let order = Array.from({ length: m }, (_, j) => (form === "fixed" ? j : (i + j) % m));
          if (form === "repeated") order = order.flatMap((j) => [j, j]);
          return `let xs${i} = [${order.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`;
        }),
        "exit",
      ].join("\n");
    }
    const shapes = {
      "ties-rotated": (k) => tied(k),
      "ties-fixed": (k) => tied(k, "fixed"),
      "ties-repeated": (k) => tied(k, "repeated"),
      "ties-more-peers": (k) => tied(k, "rotated", 2),
    };
    return { shapes };
  })();
  const lines = (...s) => s.join("\n");
  const shapes = {
    ...orders,
    ...ties,
    nullFirst: () =>
      lines("let x = 1", "let a = x", "let b = x", "let c = [x, a, b]", "say c[0]", "exit"),
    fanTies: () =>
      lines(
        "let x = hostValue.n",
        "let a = x",
        "let b = x",
        "let c = [a + b, b + a]",
        "let n: integer = c[hostValue.i]",
        "exit",
      ),
    pathTies: () =>
      lines(
        'let x = {p: 1, q: "s"}',
        "let a = x",
        "let b = x",
        "let c = [b, a]",
        "say c[0].p",
        "say c[0].q",
        "exit",
      ),
    aliasObject: () =>
      lines(
        "let x = hostValue.a",
        "let a = x",
        "let b = x",
        "let c = [{p: a, q: b}, {p: b, q: a}]",
        "let n: integer = c[hostValue.i].p",
        "exit",
      ),
  };
  const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  shapes["choice-path-fanout"] = (k) =>
    lines(
      `let a = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`,
      many(k, (i) => `let n${i}: integer = a.p${i}`),
      "exit",
    );
  shapes["bound-choice-path-fanout"] = (k) =>
    lines(
      `let a = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`,
      `let b = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`, ", ")}`,
      "let xs = [a,b]",
      many(k, (i) => `let n${i}: integer = xs[hostValue.i].p${i}`),
      "exit",
    );
  return {
    shapes: {
      "role-fixed": (n) => shapes["role-fixed"](n),
      "role-rotated": (n) => shapes["role-rotated"](n),
      "role-permuted": (n) => shapes["role-permuted"](n),
      "role-subsets": (n) => shapes["role-subsets"](n),
      "role-triples": (n) => shapes["role-triples"](n),
      "role-twoOrders": (n) => shapes["role-twoOrders"](n),
      "leaf-fixed": (n) => shapes["leaf-fixed"](n),
      "leaf-rotated": (n) => shapes["leaf-rotated"](n),
      "leaf-permuted": (n) => shapes["leaf-permuted"](n),
      "leaf-subsets": (n) => shapes["leaf-subsets"](n),
      "leaf-triples": (n) => shapes["leaf-triples"](n),
      "leaf-twoOrders": (n) => shapes["leaf-twoOrders"](n),
      "role-aliased": (n) => shapes["role-aliased"](n),
      "leaf-aliased": (n) => shapes["leaf-aliased"](n),
      "alias-rotated": (n) => shapes["alias-rotated"](n),
      "alias-permuted": (n) => shapes["alias-permuted"](n),
      "alias-subsets": (n) => shapes["alias-subsets"](n),
      "alias-triples": (n) => shapes["alias-triples"](n),
      "alias-fixed": (n) => shapes["alias-fixed"](n),
      "ties-rotated": (n) => shapes["ties-rotated"](n),
      "ties-fixed": (n) => shapes["ties-fixed"](n),
      "ties-repeated": (n) => shapes["ties-repeated"](n),
      "ties-more-peers": (n) => shapes["ties-more-peers"](n),
      "choice-path-fanout": (n) => shapes["choice-path-fanout"](n),
      "bound-choice-path-fanout": (n) => shapes["bound-choice-path-fanout"](n),
    },
    cases: [
      ["nullFirst", shapes["nullFirst"]()],
      ["fanTies", shapes["fanTies"]()],
      ["pathTies", shapes["pathTies"]()],
      ["aliasObject", shapes["aliasObject"]()],
    ],
  };
})();
export const shapes = corpus.shapes;
export const cases = corpus.cases;
export const checks = ["publication"];
