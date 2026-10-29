// #1253, Astra review (R/astra-m4-i1253-review-evidence/deep-files.mjs:12, :28): loaded file data, read through a
// written object type, and kept in an unnamed nested property while a named wrong value is repaired.
const source =
  "let parcel: object = fromJson(hostValue, default: {score: 4}, files: false)\nsay parcel.score\nexit\n";
const fileSource =
  'let parcel: object? = fromJson(hostValue, default: {meta: {score: 4}})\nsay "complete"\nexit\n';
export const cases = Object.entries({ source, fileSource });
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ['node deep-files.mjs "$root" head', "R/astra-m4-i1253-review-evidence/queue-initial.sh:7"],
    ['node deep-files.mjs "$root" base', "R/astra-m4-i1253-review-evidence/queue-initial.sh:8"],
    [
      'node deep-files.mjs "$root/recheck" head',
      "R/astra-m4-i1253-review-evidence/queue-recheck.sh:9",
    ],
  ],
  sources: 2,
  sha256: "2c6ba7365a84a3695108ab52474d3f3c3c7eae4861bce833add26bc9c331b264",
};
