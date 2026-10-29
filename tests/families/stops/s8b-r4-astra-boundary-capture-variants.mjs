// add, add-say and related fixed cases; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/boundary-capture.mjs).
export const cases = (() => {
  const variants = [
    ["add", "let total = hostValue + 8\nrepeat hostOther { say total }\nexit\n", 253],
    ["add-say", "let total = hostValue + 6\nsay total\nexit\n"],
    ["subtract", "let total = hostValue - 6\nsay total\nexit\n"],
    ["multiply", "let total = hostValue * 6\nsay total\nexit\n"],
    ["compare", "let total = hostValue > 6\nsay total\nexit\n"],
    ["written", "let total: number = hostValue + 6\nsay total\nexit\n"],
  ];
  return variants.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node boundary-capture.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r4-evidence/boundary-capture.mjs",
    ],
  ],
  sources: 6,
  sha256: "38179c7a6221d650a2057c893145a8d6369a772e9d05922d700719eea8f77374",
};
