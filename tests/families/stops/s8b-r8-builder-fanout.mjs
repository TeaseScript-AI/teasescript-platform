// S8b's builder, review r8: deep-literal-scale's first typed-copies case, a list nested 4,096 deep holding 16,384
// references to one typed leaf (R/astra-m4-s8b-r8-evidence/builder/fanout.mjs).
export const cases = [
  [
    "fanout/4096",
    [
      "let leaf: integer = 1",
      "let value = " + "[".repeat(4096) + Array(16384).fill("leaf").join(",") + "]".repeat(4096),
      "exit",
    ].join("\n") + "\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node fanout.mjs 4096", "R/astra-m4-s8b-r8-evidence/builder/desktop-fanout.sh:9"]],
  sources: 1,
  sha256: "bf44f687ace99609ad7776ebbd8e82077ad28614c8bc2e82466fee739a2f9c93",
};
