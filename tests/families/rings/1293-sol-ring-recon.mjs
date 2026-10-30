// #1293 A2 / G5, Sol's reconstruction (R/sol-m4-admission-design-g5-r1-evidence/recon-shapes.mjs): the ring and alias
// shapes at the sizes its measurements recorded, the self-copy chain at 16 and 32 and the others at 64 and 128.
const shapes = (() => {
  const range = (n) => Array.from({ length: n }, (_, i) => i);
  const lines = (...xs) => xs.flat().join("\n") + "\nexit\n";
  const fields = (n, v = "typed") =>
    range(n)
      .map((i) => `f${i}:${v}`)
      .join(",");
  const originalShapes = {
    "ring-member-stores": (n) =>
      lines(
        "let typed:integer=1",
        `let root={${fields(n)},extra:1}`,
        range(n).map((i) => `let a${i}=${i ? `a${i - 1}` : "root"}\na${i}.f${i}=2`),
        `a0=a${n - 1}`,
      ),
    "ring-member-stores-width-2": (n) =>
      lines(
        "let typed:integer=1",
        `let root={${fields(2)},extra:1}`,
        range(n).map((i) => `let a${i}=${i ? `a${i - 1}` : "root"}\na${i}.f${i % 2}=2`),
        `a0=a${n - 1}`,
      ),
    "self-copy-chain": (n) =>
      lines(
        "let typed:integer=1",
        `let root={${fields(n)}}`,
        range(n).map((i) => `let a${i}=${i ? `a${i - 1}` : "root"}\na${i}.q=a${i}`),
      ),
    "deep-wrapper-reads": (n) =>
      lines(
        "let typed:integer=1",
        "let root={f:typed,q:null}",
        range(n).map((i) => `let a${i}={q:${i ? `a${i - 1}` : "root"}}`),
        `let out=a${n - 1}.${range(n)
          .map(() => "q")
          .join(".")}.f`,
      ),
    "gets-in-literal-unknown": (n) =>
      lines(
        "let raw = hostValue",
        `let root = {${range(n)
          .map((i) => `f${i}: [1, raw][1]`)
          .join(", ")}}`,
        "let xs = [root]",
        `let box = [${range(n)
          .map(() => "xs.get(0, default: root)")
          .join(", ")}]`,
        range(n).map((i) => `repeat box[0].f${i} {}`),
      ),
    "alias-choices-unknown": (n) =>
      lines(
        "let raw = hostValue",
        `let root = {${range(n)
          .map((i) => `f${i}: [1, raw][1]`)
          .join(", ")}}`,
        range(n).map((i) => `let alias${i} = root`),
        `let box = askChoice ${range(n)
          .map((i) => `{text: "${i}", value: alias${i}}`)
          .join(", ")}`,
        range(n).map((i) => `repeat box.f${i} {}`),
      ),
    "alias-gets-unknown": (n) =>
      lines(
        "let raw = hostValue",
        `let root = {${range(n)
          .map((i) => `f${i}: [1, raw][1]`)
          .join(", ")}}`,
        "let xs = [root]",
        range(n).map((i) => `let alias${i} = root`),
        range(n).map((i) => `let list${i} = xs`),
        `let box = [${range(n)
          .map((i) => `list${i}.get(0, default: alias${i})`)
          .join(", ")}]`,
        range(n).map((i) => `repeat box[0].f${i} {}`),
      ),
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(originalShapes)) {
    const sample = make(32);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const cases = Object.entries(shapes).flatMap(([name, make]) =>
  (name === "self-copy-chain" ? [16, 32] : [64, 128]).map((n) => [`${name}@${n}`, make(n)]),
);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "the reconstruction's measurements, one row per shape and its sizes (no command line kept)",
      "R/sol-m4-admission-design-g5-r1-evidence/historical-recon-counts.csv",
    ],
  ],
  sources: 14,
  sha256: "8ed01bba2ca57c24eb08eb62fdc749fa2701aa64811c2eb5922dce807c2a79d1",
};
