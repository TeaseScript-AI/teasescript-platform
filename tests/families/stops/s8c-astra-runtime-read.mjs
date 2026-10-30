// S8c's review (Astra): 25 value aliases from a 1.75 or 3 seed, a repeat and an overwrite
// (R/astra-m4-s8c-review-evidence/worker/runtime-read.mjs).
export const cases = [
  [
    "runtime-read-j0-input1",
    'let seed = 1.75\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nlet value18 = value17\nlet value19 = value18\nlet value20 = value19\nlet value21 = value20\nlet value22 = value21\nlet value23 = value22\nlet value24 = value23\nrepeat value24 {}\nvalue24 = 3\nsay "DONE"\nexit\n',
  ],
  [
    "runtime-read-j0-input2",
    'let seed = 3\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nlet value18 = value17\nlet value19 = value18\nlet value20 = value19\nlet value21 = value20\nlet value22 = value21\nlet value23 = value22\nlet value24 = value23\nrepeat value24 {}\nvalue24 = 3\nsay "DONE"\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node runtime-read.mjs", "R/astra-m4-s8c-review-evidence/README.md:17"]],
  sources: 2,
  sha256: "a789667bd4d5ba619dbb93c4356cfb5e1c8f44be21b1cdf518b53b3f48714d92",
};
