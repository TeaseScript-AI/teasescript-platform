// captured guarded-overlap; #1278, Astra review, round unrecorded (R/astra-m4-i1278-review-evidence/observe-same.mjs).
export const cases = [
  [
    "original-1",
    'let p = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit',
  ],
  [
    "original-2",
    'let p = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit',
  ],
  [
    "original-3",
    'let p = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit',
  ],
  [
    "original-4",
    'let p = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\np = {f: 1}\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit',
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node observe-same.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1278-review-evidence/observe-same.mjs",
    ],
  ],
  sources: 4,
  sha256: "edd5e12fe4f99663f5c9cf7e5fec5af4931e830c0e679ba3bdc0c5844a325e0e",
};
