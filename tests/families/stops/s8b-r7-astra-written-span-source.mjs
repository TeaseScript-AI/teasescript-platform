// 1 fixed r7 astra written span source input; #1165 / S8, Astra review, r7
// (R/astra-m4-s8b-r7-evidence/probe/written-span.mjs).
export const cases = (() => {
  const source = "let reading = 2.75\nlet samples: integer[] = [0]\nsamples = [reading]\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node /home/peter/work/astra-s8-r7/probe/written-span.mjs",
      "R/astra-m4-s8b-r7-evidence/scripts/controls.sh:8",
    ],
  ],
  sources: 1,
  sha256: "04f74697acdbfd90f66896188623289ac617d2587884864548ebc37386ad35cb",
};
