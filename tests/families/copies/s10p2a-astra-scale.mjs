// S10 part 2a's review (Astra): k nullable integer subjects, a reset function, conditional null writes, k guarded reset
// calls and k switch demands, at k = 64 to 1,024 (R/astra-m4-s10p2a-review/scale.mjs, run by scale-series.mjs).
function source(k) {
  const lines = ['let bypass = askBoolean "skip reset?"'];
  for (let i = 0; i < k; i++) lines.push(`let subject${i}: integer? = 12`);
  lines.push("function resetAll {");
  for (let i = 0; i < k; i++) lines.push(`subject${i} = 12`);
  lines.push("}", "if bypass {");
  for (let i = 0; i < k; i++) lines.push(`subject${i} = (null) otherwise null`);
  lines.push("}");
  for (let i = 0; i < k; i++) lines.push("if not bypass { resetAll() }");
  for (let i = 0; i < k; i++)
    lines.push(
      `switch subject${i} { case 12.0 { repeat subject${i} {} } default { repeat subject${i} {} } }`,
    );
  lines.push("exit");
  return lines.join("\n") + "\n";
}
export const shapes = { scale: source };

export const sizes = [64, 128, 256, 512, 1024];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "scale-series / 4G / 900 / node <root>/scale-series.mjs",
      "R/astra-m4-s10p2a-review/commands.txt:25",
    ],
  ],
  sources: 5,
  sha256: "0e2ea718fbfd1ce195d8e49a40c1e9cc60e3c3679a553b17b793eb95653a2ea7",
};
