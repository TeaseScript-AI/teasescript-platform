// #1165 / S8, Astra r3 (R/astra-m4-s8b-r3-evidence/oracle-probe.mjs:4): a property stored into a host value, whose
// plan the probe stripped of its `requireExisting` marks.
export const cases = [["source", 'let vessel = hostValue\nvessel.amount = 4\nsay "AFTER"\nexit']];
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node oracle-probe.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r3-evidence/oracle-probe.mjs",
    ],
  ],
  sources: 1,
  sha256: "390e78f785a4095fb265e92bad7ae4fb547587d6363261c6aa4663c3831fd789",
};
