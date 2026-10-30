// U4a's review (Astra): its probes around a call and with different tests, and its sharing candidates
// (R/astra-m4-u4a-review/sharing-candidate.mjs over its own probes.json).
export const cases = [
  [
    "088-0-1",
    "let choice: boolean = hostValue\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }\nif xs is integer[] { let sink: integer = xs.first }\nexit\n",
  ],
  [
    "088-0-2",
    "let choice: boolean = hostValue\nlet xs: integer?[] = []\nif choice { xs = [null] }\nif xs is integer[] { let sink: integer = xs.first }\nexit\n",
  ],
  [
    "088-0-3",
    "let choice: boolean = hostValue\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }\nif xs.first != null { let sink: integer = xs.first }\nexit\n",
  ],
  [
    "088-0-4",
    "let choice: boolean = hostValue\nlet rows: integer?[][] = [[4], [7]]\nif choice { rows = [[null], [9]] }\nlet row = 0\nif rows is integer[][] { let sink: integer = rows[row + 1].first }\nexit\n",
  ],
  [
    "088-0-5",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }\nfunction spoil { xs = [null]\nreturn 0 }\nif xs is integer[] { let both: integer[] = [xs.first, spoil(), xs.first] }\nexit\n',
  ],
  [
    "088-0-6",
    'let choice = askBoolean "change?"\nlet xs: (integer | string | null)[] = [1]\nif choice { xs = ["s"] }\nif choice { xs = [null] }\nif xs is integer[] { let a: integer[] = [xs.first, xs.first] }\nif xs is string[] { let b: string[] = [xs.first, xs.first] }\nexit\n',
  ],
  [
    "088-0-7",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }\nfunction spoil { xs = [null]\nreturn 0 }\nif xs is integer[] { let both: integer[] = [xs.last, spoil(), xs.last] }\nexit\n',
  ],
  [
    "088-0-8",
    'let choice = askBoolean "change?"\nlet xs: (integer | string | null)[] = [1]\nif choice { xs = ["s"] }\nif choice { xs = [null] }\nif xs is integer[] { let a: integer[] = [xs.last, xs.last] }\nif xs is string[] { let b: string[] = [xs.last, xs.last] }\nexit\n',
  ],
  [
    "088-0-9",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }\nfunction spoil { xs = [null]\nreturn 0 }\nif xs is integer[] { let both: integer[] = [xs.random, spoil(), xs.random] }\nexit\n',
  ],
  [
    "088-0-10",
    'let choice = askBoolean "change?"\nlet xs: (integer | string | null)[] = [1]\nif choice { xs = ["s"] }\nif choice { xs = [null] }\nif xs is integer[] { let a: integer[] = [xs.random, xs.random] }\nif xs is string[] { let b: string[] = [xs.random, xs.random] }\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node ROOT/evidence/sharing-candidate.mjs ROOT", "R/astra-m4-u4a-review/REPRODUCE.md:17"],
  ],
  sources: 10,
  sha256: "1936efb9ae194f9a9cd9648ff827a5460745867bcb6f95b90f6f8b2ef2559728",
};
