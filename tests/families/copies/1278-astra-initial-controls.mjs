// partial, added and related fixed cases; #1278, Astra review, round unrecorded
// (R/astra-m4-i1278-review-evidence/controls-initial.mjs).
export const cases = (() => {
  const sources = {
    partial:
      'let p={wanted:1}\nlet q={different:1}\nlet options=[{text:"a",value:p},{text:"b",value:q}]\nlet picked=askChoice options\nrepeat picked.wanted {}\nrepeat picked.wanted {}\nexit',
    added:
      'let p={wanted:1}\nlet q={different:1}\nq.wanted=2\nlet options=[{text:"a",value:p},{text:"b",value:q}]\nlet picked=askChoice options\nrepeat picked.wanted {}\nrepeat picked.wanted {}\nexit',
    ownWriter:
      'let options=[{text:"a",value:{f:1}},{text:"b",value:{f:2}},{text:"c",value:{f:3}}]\nlet picked=askChoice options\nsay picked.missing\nexit',
    original:
      'let payload={f:1}\nlet options=[{text:"a",value:payload},{text:"b",value:payload}]\nlet picked=askChoice options\nsay picked.missing\nexit',
  };
  return Object.entries(sources);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node controls-initial.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1278-review-evidence/controls-initial.mjs",
    ],
  ],
  sources: 4,
  sha256: "5dc1f62a9b4afa63377136c92ca167f243d6df6e35b7a746d5bbe8d186224c47",
};
