// 1 fixed astra r5 mutation boundary input; 3a review, r5 (R/pr-3a-review-r5-files/astra/mutation-boundary.mjs).
export const cases = (() => {
  const source = 'let x = askChoice "a}|x|y|z", 1\nexit';
  return [["source", source]];
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node mutation-boundary.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-review-r5-files/astra/mutation-boundary.mjs",
    ],
  ],
  sources: 1,
  sha256: "e90d0c23ef67a9cee9f629c0006b5a5eaab682320dcb612eb08bf888b708e3b7",
};
