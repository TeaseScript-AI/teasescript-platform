// 1 fixed r4 astra mutation smoke source input; #1165 / S8, Astra review, r4
// (R/astra-m4-s8b-r4-evidence/mutation-smoke.mjs).
export const cases = (() => {
  const source =
    "let amount: integer = hostValue\nlet title: string = hostOther\nsay title\nexit\n";
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
      "R/astra-m4-s8b-r4-evidence/mutation-smoke.mjs",
    ],
  ],
  sources: 1,
  sha256: "347a48a2bd50f0d95baeddadb729775b624986af46cef6efb67edd2ef644bed2",
};
