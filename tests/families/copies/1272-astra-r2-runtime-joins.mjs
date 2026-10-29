// #1272, Astra r2 (R/astra-m4-i1272-review-r2/runtime.mjs:9): three list joins the probe compiled and ran without host
// values.
const sources = [
  ["open", 'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nsay result.length\nexit\n'],
  ["null", "let nils: null[] = [null]\nlet result = [1] + nils\nsay result.length\nexit\n"],
  [
    "inferred",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nsay result.length\nexit\n',
  ],
];
export const cases = sources;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node runtime.mjs R/astra-m4-i1272-review-r2", "R/astra-m4-i1272-review-r2/commands.md:28"],
  ],
  sources: 3,
  sha256: "adb6ea5fecd69dcfa6ab7443d71fe415d6f5f5defbbd60c2dbdb153155a3d923",
};
