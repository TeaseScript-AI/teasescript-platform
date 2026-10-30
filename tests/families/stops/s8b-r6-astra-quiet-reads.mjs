// 4 fixed r6 astra quiet reads inputs; #1165 / S8, Astra review, r6 (R/astra-m4-s8b-r6-evidence/probe/quiet-reads.mjs).
const corpus = (() => {
  const cases = {
    number: [
      "let amount = 9.0\nif amount is integer { amount = 4.5\nlet accepted: number = amount\nsay accepted }\nexit",
      "amount",
    ],
    union: [
      "let option: integer | boolean = true\nlet accepted: integer | boolean = option\nsay accepted\nexit",
      "option",
    ],
    nullable: [
      "let option: integer? = null\noption = 2\nlet accepted: integer? = option\nsay accepted\nexit",
      "option",
    ],
    copy: [
      "let original = 9.0\nlet sample = original\nif sample is integer { sample = 1.5\nlet accepted: number = sample\nsay accepted }\nexit",
      "sample",
    ],
  };
  return {
    cases: [
      ["0", cases["number"]["0"]],
      ["0", cases["union"]["0"]],
      ["0", cases["nullable"]["0"]],
      ["0", cases["copy"]["0"]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node /home/peter/work/astra-s8-r6/probe/"$kind".mjs "$name" "$mode"',
      "R/astra-m4-s8b-r6-evidence/job.sh:8",
    ],
  ],
  sources: 4,
  sha256: "7cdf5d63802745bb29c8fd3fa06c439ee88c609445c50bab6ce0a036409f25d8",
};
