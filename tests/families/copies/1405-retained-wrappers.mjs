// #1405; builder/review archive.
export const sizes = [2, 4];
export const shapes = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const lines = (...x) => x.flat(Infinity).join("\n") + "\nexit\n";
  function nest(n, leaf, wrap) {
    let x = leaf;
    for (let i = 0; i < n; i++) x = wrap(x);
    return x;
  }
  const families = {};
  for (const leaf of ["seed", '"origin"']) {
    const tag = leaf === "seed" ? "variable" : "literal";
    families["nested-selection-" + tag] = (n) =>
      lines('let seed="origin"', `let out=${nest(n, leaf, (x) => `[${x},"other"][0]`)}`, "say out");
    families["nested-choice-" + tag] = (n) =>
      lines(
        'let seed="origin"',
        `let out=${nest(n - 1, "askChoice " + leaf, (x) => `askChoice [(${x}),"other"]`)}`,
        "say out",
      );
  }
  families["deep-wrapper-reads"] = (n) =>
    lines(
      "let typed:integer=1",
      "let root={f:typed,q:null}",
      rows(n, (i) => `let a${i}={q:${i ? `a${i - 1}` : "root"}}`),
      `let out=a${n - 1}.${rows(n, () => "q").join(".")}.f`,
    );
  for (const variant of [
    "empty",
    "empty-copy",
    "literal",
    "literal-copy-read",
    "unwritten-literal",
  ])
    families["typed-" + variant] = (n) =>
      lines(
        `let typed${variant === "unwritten-literal" ? "" : ":integer" + "[]".repeat(n)}=${variant.startsWith("empty") ? "[]" : "[".repeat(n) + "1" + "]".repeat(n)}`,
        variant === "empty-copy" || variant === "literal-copy-read" ? "let out=typed" : "",
        variant === "literal-copy-read" ? `let got=out${"[0]".repeat(n)}` : "",
      );
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(families)) {
    const sample = make(2);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
