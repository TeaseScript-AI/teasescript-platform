// original direct, mutate and related inputs; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8c-review-evidence/worker/top-level.mjs).
export const sizes = [32, 64, 128];
const corpus = (() => {
  const forms = {
    direct: (n) =>
      `function make {\nlet n0 = 1.5\n${Array.from({ length: n }, (_, i) => `let n${i + 1} = n${i}`).join("\n")}\nreturn n${n}\n}\nrepeat make() {}\nexit`,
    mutate: (n) =>
      `function make {\nlet n0 = 1.5\n${Array.from({ length: n }, (_, i) => `let n${i + 1} = n${i}`).join("\n")}\nlet saved = n${n}\nn${n} = 2\nreturn saved\n}\nrepeat make() {}\nexit`,
    returns: (n) =>
      `${Array.from({ length: n }, (_, i) => `function f${i} { return ${i ? "f" + (i - 1) + "()" : "1.5"} }`).join("\n")}\nrepeat f${n - 1}() {}\nexit`,
  };
  return {
    shapes: {
      direct: (n) => forms["direct"](n),
      mutate: (n) => forms["mutate"](n),
      returns: (n) => forms["returns"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "/home/peter/opt/node-24.18/bin/node top-level.mjs",
      "R/astra-m4-s8c-review-evidence/worker/sweeps.sh:6",
    ],
  ],
  sources: 9,
  sha256: "6159bb74c36b6642dd878c7fd3102e733b3e31839f948d26d8cf3a50b58e90f5",
};
