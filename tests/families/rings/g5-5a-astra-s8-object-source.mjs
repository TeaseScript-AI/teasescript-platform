// 1 fixed 5a astra s8 object source input; #1394 G5 5a Astra review / builder corpus
// (R/astra-m4-g5-5a-review-evidence/s8-object.mjs).
export const cases = (() => {
  const source =
    [
      "let a0 = {p: 1}",
      "let a1 = a0",
      "let a2 = a1",
      "a0 = a2",
      ...Array.from({ length: 24 }, (_, i) => `a1 = {p: ${i + 2}}`),
      "a1 = {p: hostValue}",
      "let picked: integer = a1.p",
      "let relay = a1",
      "repeat {kept: a1}.kept.p {}",
      "repeat a1.p {}",
      "repeat relay.p {}",
      "exit",
    ].join("\n") + "\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node s8-object.mjs <s8-or-overlay-build> s8-object-<tree>-<mode>.json <mode>",
      "R/astra-m4-g5-5a-review-evidence/README.md:51",
    ],
  ],
  sources: 1,
  sha256: "6f80e936ae135cc5f83102c8f37c45987c671a9273545eef241fded93e92549c",
};
