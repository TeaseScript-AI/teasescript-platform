// #1241's review r2 (Astra): the pasted forms of its own cases that ask an integer or show a button and passed, as
// own.json and keys.json record them (R/astra-m4-i1241-review-r2/interactions.mjs); compiled without globals.
export const cases = [
  [
    "072-0-1",
    'let ns: integer?[] = [2, null]\nlet response = askInteger("${(ns[1] otherwise 0) + 1}")\nexit\n',
  ],
  [
    "072-0-2",
    'let ns: integer?[] = [2, null]\nlet pressed = showButton "${(ns[1] otherwise 0) + 1}"\nexit\n',
  ],
  ["072-0-3", '\nlet converted: duration = (askInteger("Count")) s\nsay converted\nexit\n'],
  ["072-0-4", '\nlet converted: duration = [(showButton "Go")].length s\nsay converted\nexit\n'],
  [
    "072-0-5",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet response = askInteger("${(ns["ok"] otherwise 0) + 1}")\nexit\n',
  ],
  [
    "072-0-6",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet pressed = showButton "${(ns["ok"] otherwise 0) + 1}"\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "- `node evidence/interactions.mjs`: all **six** offered interaction forms resume to a halted script without failure; this includes the operation after the ask/button, not merely reaching a pause.",
      "R/astra-m4-i1241-review-r2/report.md:43",
    ],
    [
      "- `node evidence/interactions.mjs`: all **six** offered interaction forms resume to a halted script without failure; this includes the operation after the ask/button, not merely reaching a pause.",
      "R/astra-m4-i1241-review-r2.md:43",
    ],
  ],
  sources: 6,
  sha256: "e79674c439c4b05a88f13773727e9c4b37068a818c3d67e5bad08311ce59a451",
};
