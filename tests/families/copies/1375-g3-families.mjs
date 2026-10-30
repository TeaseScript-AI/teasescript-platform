// the G3 retained families (Sol's reconnaissance generators): nested selections and choices of a variable or a literal,
// deep wrapper reads, and typed empty and literal lists, copied, read or unwritten; G3 part 1's case list at sizes 1 to
// 16 (R/astra-m4-g3-p1-review-evidence/builder-probe/families.mjs and combine-cases.mjs), run by its publication probe.
// The list's other parts are not copied: the repository's fixture and the #1188 and #1319 reviews' case files.
const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const lines = (...x) => x.flat(Infinity).join("\n") + "\nexit\n";
function nest(n, leaf, wrap) {
  let x = leaf;
  for (let i = 0; i < n; i++) x = wrap(x);
  return x;
}
export const shapes = {};
for (const leaf of ["seed", '"origin"']) {
  const tag = leaf === "seed" ? "variable" : "literal";
  shapes["nested-selection-" + tag] = (n) =>
    lines('let seed="origin"', `let out=${nest(n, leaf, (x) => `[${x},"other"][0]`)}`, "say out");
  shapes["nested-choice-" + tag] = (n) =>
    lines(
      'let seed="origin"',
      `let out=${nest(n - 1, "askChoice " + leaf, (x) => `askChoice [(${x}),"other"]`)}`,
      "say out",
    );
}
shapes["deep-wrapper-reads"] = (n) =>
  lines(
    "let typed:integer=1",
    "let root={f:typed,q:null}",
    rows(n, (i) => `let a${i}={q:${i ? `a${i - 1}` : "root"}}`),
    `let out=a${n - 1}.${rows(n, () => "q").join(".")}.f`,
  );
for (const variant of ["empty", "empty-copy", "literal", "literal-copy-read", "unwritten-literal"])
  shapes["typed-" + variant] = (n) =>
    lines(
      `let typed${variant === "unwritten-literal" ? "" : ":integer" + "[]".repeat(n)}=${variant.startsWith("empty") ? "[]" : "[".repeat(n) + "1" + "]".repeat(n)}`,
      variant === "empty-copy" || variant === "literal-copy-read" ? "let out=typed" : "",
      variant === "literal-copy-read" ? `let got=out${"[0]".repeat(n)}` : "",
    );

export const sizes = [1, 2, 3, 4, 5, 6, 8, 12, 16];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe/combine-cases.mjs cases.json all.json own.json fixture.json small.json",
      "R/astra-m4-g3-p1-review-evidence/BUILDER-README.md:11",
    ],
    [
      "node probe/publication.mjs <tree>/dist cases.json results/pub-<label>/<i>of8.jsonl <i>/8",
      "R/astra-m4-g3-p1-review-evidence/builder-probe/run-publication.sh:7",
    ],
  ],
  sources: 90,
  sha256: "1e52b62459c8992815f90ede30ff738fc4bb40ce3335165155f4f9a0d5ef056d",
};
