// #1359 contract roles design review (Astra).
export const sizes = [4, 8];
export const shapes = (() => {
  const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  const rows = (...x) => x.join("\n");
  const subset = (m, i) => Array.from({ length: Math.max(2, m / 2) }, (_, j) => (i + j) % m);
  function matrix(k, variant) {
    const m = k,
      q = k;
    const value = (j, r) =>
      variant === "alias"
        ? `w${(j + r) % m}`
        : variant === "missing" && j === r
          ? null
          : variant === "null" && j === r
            ? "null"
            : `w${(j + r) % m}`;
    return rows(
      "let base = 1",
      many(m, (j) => `let w${j} = base`),
      many(
        m,
        (j) =>
          `let p${j} = {${Array.from({ length: q }, (_, r) => [r, value(j, r)])
            .filter(([, v]) => v !== null)
            .map(([r, v]) => `f${r}: ${v}`)
            .join(", ")}}`,
      ),
      many(k, (i) =>
        rows(
          `let xs${i} = [${subset(m, i)
            .map((j) => `p${j}`)
            .join(", ")}]`,
          many(q, (r) => `say xs${i}[hostValue.i].f${r}`),
        ),
      ),
      "exit",
    );
  }
  const shapes = {
    "path-subsets-differing-definitions": (k) => matrix(k, "alias"),
    "path-subsets-missing-properties": (k) => matrix(k, "missing"),
    "path-subsets-null-properties": (k) => matrix(k, "null"),
    "fan-and-leaf-subsets": (k) =>
      rows(
        many(k, (j) => `let p${j} = hostValue.f${j} + otherHost.f${j}`),
        many(
          k,
          (i) =>
            `let xs${i} = [${subset(k, i)
              .map((j) => `p${j}`)
              .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
        ),
        "exit",
      ),
    "guarded-alias-copies": (k) =>
      rows(
        "let base = hostValue.root",
        many(k, (j) => `let p${j} = base`),
        many(
          k,
          (i) =>
            `if p${i}.x is integer {\n  let xs${i} = [${subset(k, i)
              .map((j) => `p${j}`)
              .join(", ")}]\n  say xs${i}[hostValue.i].x\n}`,
        ),
        "exit",
      ),
    "choice-properties-order": (k) =>
      rows(
        many(
          k,
          (j) =>
            `let p${j} = askChoice {text:"a", value:{x:1,y:"s"}}, {text:"b", value:{x:"s",y:1}}, {text:"c", value:{x:null,y:null}}`,
        ),
        many(
          k,
          (i) =>
            `let xs${i} = [${subset(k, i)
              .map((j) => `p${j}`)
              .join(", ")}]\nsay xs${i}[hostValue.i].x\nsay xs${i}[hostValue.i].y`,
        ),
        "exit",
      ),
    "default-alias-properties": (k) =>
      rows(
        "let base = hostValue.root",
        many(k, (j) => `let p${j} = base.get("p", default: {x:${j}})`),
        many(
          k,
          (i) =>
            `let xs${i} = [${subset(k, i)
              .map((j) => `p${j}`)
              .join(", ")}]\nsay xs${i}[hostValue.i].x`,
        ),
        "exit",
      ),
    "repeated-peers-joined-prefixes": (k) =>
      rows(
        "let base = [hostValue.root]",
        many(k, (j) => `let p${j} = base + [${j}]`),
        many(
          k,
          (i) =>
            `let xs${i} = [${subset(k, i)
              .flatMap((j) => [`p${j}`, `p${j}`])
              .join(", ")}]\nsay xs${i}[hostValue.i][hostValue.i]`,
        ),
        "exit",
      ),
  };
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
