// 1 fixed written projection input; #1405, builder/review archive, r180
// (desktop:~/work/evidence/1405/3627aa0f4/probe/r180.mjs).
export const cases = (() => {
  const source =
    [
      "let tally = 1",
      ...Array.from({ length: 60 }, (_, i) => `tally = ${i + 2}`),
      "tally = hostValue",
      "let pair = [tally]",
      "let count = 1",
      "count = 0.5",
      "repeat count {}",
      "repeat pair.first {}",
      "repeat tally {}",
      'say "DONE"',
      "exit",
    ].join("\n") + "\n";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node r180.mjs (no command recorded: its run without arguments)",
      "D/1405/3627aa0f4/probe/r180.mjs",
    ],
  ],
  sources: 1,
  sha256: "202972fe7a0e57aac8d25be0a8dbcf2c6f8a33439a426183d4f6ff016dc792e3",
};
