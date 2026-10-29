// 1 fixed mutation smoke source input; #1165 S8 part 3, r7 retained builder/probe9 evidence
// (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/mutation-smoke.mjs).
export const cases = (() => {
  const source = "let n: integer = hostValue\nlet flag: boolean = hostOther\nsay n\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node mutation-smoke.mjs (no command recorded: its run without arguments)",
      "D/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/mutation-smoke.mjs",
    ],
  ],
  sources: 1,
  sha256: "049da8a8eb91395ebf7c8c20b0fc54481ba94fc9239c47f7a27f69973891bab3",
};
