// repeated/field/field-store/deep setup programs at the original per-family sizes; #1165 / S8, Astra review, round
// unrecorded (R/astra-m4-s8c-review-evidence/builder/generators/tools/cheap-scale.mjs).
const shapes = {
  repeated: (n) => "let b = 1\n" + "b = 2\n".repeat(n) + "b = hostValue\n",
  fields: (n) =>
    "let b = {f0: 1}\n" +
    Array.from({ length: n }, (_, i) => `b = {f${i}: ${i}}\n`).join("") +
    "b = hostValue\n",
  fieldStores: (n) =>
    "let b = {f0: 1}\n" +
    Array.from({ length: n }, (_, i) => `b.f${i} = ${i}\n`).join("") +
    "b = hostValue\n",
  deep: (n) => `let b = ${"[".repeat(n)}1${"]".repeat(n)}\nb = hostValue\n`,
};

export const cases = Object.entries(shapes).flatMap(([name, make]) =>
  (name === "deep" ? [64, 128, 256] : [512, 1024, 2048]).map((n) => [
    name + "@" + n,
    make(n) + 'say "AFTER"\nexit\n',
  ]),
);

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node cheap-scale.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8c-review-evidence/builder/generators/tools/cheap-scale.mjs",
    ],
  ],
  sources: 12,
  sha256: "77c1098e748c4a841c9e5bc8d5da10121d6b5a697e409708e9888e3cdbf7594c",
};
