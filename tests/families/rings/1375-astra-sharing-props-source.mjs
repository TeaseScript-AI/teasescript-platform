// 1 fixed astra sharing props source input; #1375 Astra review r1
// (R/astra-m4-g3-p1-review-evidence/builder-probe/sharing-props.mjs).
export const cases = (() => {
  const source =
    'let item = {v0: 1}\nif askBoolean("Fraction?") { item.v0 = 1.5 }\nitem.v0 = 1\nlet archive = [{data: item}, {data: item}]\nlet out: integer = archive.first.data.v0\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node sharing-props.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-g3-p1-review-evidence/builder-probe/sharing-props.mjs",
    ],
  ],
  sources: 1,
  sha256: "797a11c82979aa5a0f10a41df64a7661682a50c689eed138641a453b15f6e0df",
};
