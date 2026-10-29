// #1165 / S8, Astra r3 (R/astra-m4-s8b-r3-evidence/oracle-probe.mjs:10): two declarations of host values, whose
// diagnostics the probe reversed.
export const cases = [["s", "let first: integer=hostValue\nlet second: string=hostOther\nexit"]];
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node oracle-probe.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r3-evidence/oracle-probe.mjs",
    ],
  ],
  sources: 1,
  sha256: "f25cd9a8ccc310b71898ae55eed30c94947e74649d593481fe11cdadb9c0cd19",
};
