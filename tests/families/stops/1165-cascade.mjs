// copies32, copies64 and related fixed cases; #1165 S8 part 3, r7 retained builder/probe9 evidence
// (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/matrix/cascade.mjs).
export const cases = (() => {
  const nest = (k, leaf) => "[".repeat(k) + leaf + "]".repeat(k);
  const copies = (k) =>
    [
      `let typed: integer${"[]".repeat(k)} = []`,
      "let out = typed",
      ...Array.from({ length: k }, () => "out = typed"),
      "exit",
    ].join("\n") + "\n";
  const shapes = {
    copies32: copies(32),
    copies64: copies(64),
    union300: `let typed: integer | string = 1\nlet xs = [${nest(300, "typed")}, ${nest(300, '"ok"')}]\nexit\n`,
  };
  return Object.entries(shapes);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node $g/matrix/cascade.mjs",
      "D/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/cascade.sh:4",
    ],
  ],
  sources: 3,
  sha256: "c1418f30aa792f137002abf8fd51cc2ebcb93c6307ac3e00139027f184dcbd80",
};
