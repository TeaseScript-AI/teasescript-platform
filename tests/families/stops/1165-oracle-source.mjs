// 1 fixed oracle source input; #1165 S8 part 3, r7 retained builder/probe9 evidence
// (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/oracle.mjs).
export const cases = (() => {
  const source =
    "let n: integer = hostValue\nlet p: boolean = hostOther\nlet box = hostValue\nbox.score = 9\nsay n\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node oracle.mjs (no command recorded: its run without arguments)",
      "D/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/probe9/oracle.mjs",
    ],
  ],
  sources: 1,
  sha256: "e8d8e95c9782f701db97fff7277fa71745d51abde2eab720678d89ef457a5528",
};
