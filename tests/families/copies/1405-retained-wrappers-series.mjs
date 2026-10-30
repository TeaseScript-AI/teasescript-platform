// #1405, builder (desktop:~/work/evidence/1405/3627aa0f4/probe/families.mjs): the ten retained wrapper families at
// the sizes of the series run (run-evidence.sh).
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const lines = (...x) => x.flat(Infinity).join("\n") + "\nexit\n";
function nest(n, leaf, wrap) {
  let x = leaf;
  for (let i = 0; i < n; i++) x = wrap(x);
  return x;
}
export const families = {};
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
for (const variant of ["empty", "empty-copy", "literal", "literal-copy-read", "unwritten-literal"])
  families["typed-" + variant] = (n) =>
    lines(
      `let typed${variant === "unwritten-literal" ? "" : ":integer" + "[]".repeat(n)}=${variant.startsWith("empty") ? "[]" : "[".repeat(n) + "1" + "]".repeat(n)}`,
      variant === "empty-copy" || variant === "literal-copy-read" ? "let out=typed" : "",
      variant === "literal-copy-read" ? `let got=out${"[0]".repeat(n)}` : "",
    );

export const shapes = families;
export const sizes = [64, 128];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node $P/series.mjs $tree/dist $O/series-$label.jsonl 64,128 $F, F the ten families of line 10 (deep-wrapper-reads, nested-selection-variable, nested-choice-variable, nested-selection-literal, nested-choice-literal, typed-empty, typed-empty-copy, typed-literal, typed-literal-copy-read, typed-unwritten-literal)",
      "D/1405/3627aa0f4/probe/run-evidence.sh:11",
    ],
  ],
  sources: 20,
  sha256: "2383c72912bb94c1d52d72a32f84a4dc9eef90b7e25e109274c51a16544af949",
};
