// copies-nullable-40, copies-union-40 and related fixed cases; #1165 / S8, Astra review, r2
// (R/astra-m4-s8c-review-r2-evidence/worker/deep.mjs).
export const cases = (() => {
  const shapes = [];
  for (const k of [40, 80])
    for (const t of ["integer?", "(integer | string)"]) {
      const name = `copies-${t === "integer?" ? "nullable" : "union"}-${k}`;
      const source = [
        `let typed: ${t}${"[]".repeat(k)} = []`,
        "let one = typed",
        "let two = typed",
        ...Array.from({ length: k }, (_, i) => `${i % 2 ? "one" : "two"} = typed`),
        'say "DONE"',
        "exit",
      ].join("\n");
      shapes.push([name, source]);
    }
  for (const k of [72, 144]) {
    let a = "typed",
      b = '"ok"';
    for (let i = 0; i < k; i++) {
      a = `{branch: [${a}]}`;
      b = `{branch: [${b}]}`;
    }
    shapes.push([
      `branched-union-${k}`,
      `let typed: integer | string = 1\nlet xs = [${a}, ${b}]\nexit`,
    ]);
  }
  // each shape twice: the probe's run (api.mjs: hostValue and hostOther) and the base build's own request (hostValue)
  return shapes.flatMap(([name, source]) => [
    [name, source],
    [`${name}/probe`, source, ["hostValue", "hostOther"]],
  ]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node worker/deep.mjs", "R/astra-m4-s8c-review-r2-evidence/worker/run-deep.sh:3"]],
  sources: 12,
  sha256: "76eac9bcf8fb806fcd44ba46c3172160c94775b7e2a195247185252999c89e7a",
};
