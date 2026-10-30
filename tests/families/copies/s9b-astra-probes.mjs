// S9b, Astra plan review (R/astra-m4-s9b-plan-review-evidence/probes.mjs:10): its probes, each with the class it
// probes, compiled without host values.
const probes = [
  [
    "Kprime",
    "computed-choice-text",
    'let option = { text: [1] }\nlet answer = askChoice [option], "Back"\nexit',
  ],

  ["V", "negative-index", "let scores = [4, 7]\nsay scores[-1]\nexit"],

  ["K", "repeat-postcheck", 'repeat toInteger("-2") {}\nexit'],
  [
    "V",
    "calendar-offset-binary",
    'let day = toDate("2026-08-11")\nday = day + (1 calendar day + 2 h)\nexit',
  ],

  ["K", "wait-kind", "wait false\nexit"],
  ["K", "repeat-negative", "repeat -2 {}\nexit"],
  [
    "Kprime",
    "computed-choice",
    'let option = { value: 7 }\nlet answer = askChoice [option], "Back"\nexit',
  ],
  [
    "Kprime",
    "form-shape",
    "let fields = { agreed: false }\nlet answer = askForm fields: fields\nexit",
  ],
  ["V", "calendar-fraction", "let span = 3 calendar days / 2\nexit"],
  ["V", "calendar-family", "let answer = 2 calendar months > 50 calendar days\nexit"],
  ["V", "calendar-offset", 'let day = toDate("2026-08-11")\nday += 1 calendar day + 2 h\nexit'],
  ["V", "calendar-valid", "let span = 4 calendar days / 2\nexit"],
  ["S", "dict-duplicate", 'let scores = dict { "red": 1, "red": 2 }\nexit'],
  [
    "D",
    "speaker-before-store",
    'speaker guide { firstName: "Ada" }\nsay guide.mood\nguide.mood = "calm"\nexit',
  ],
  ["W", "fallback-unused", "let n = 9\nsay n otherwise 2\nexit"],
  ["T", "storage-null", 'let score = load("review-score", default: null)\nexit'],
  ["T", "storage-schema", 'let score = load("review-score", default: 1)\nsay score\nexit'],
  ["O", "discarded-copy", "[4, 7][0] = 3\nexit"],
  ["C13", "hash-kind", "let digest = hashText(7)\nexit"],
  ["C13", "iteration", "for entry in 3 {}\nexit"],
  [
    "Kprime",
    "record-choice",
    'let answer = askChoice { text: "A", value: { n: 1 } }, { text: "B", value: { n: 2 } }\nexit',
  ],
  ["V", "json-nested", "let x = toJson({ item: 1..3 })\nexit"],
  ["C13", "sort-elements", "let xs = [{ n: 1 }, { n: 2 }]\nxs.sort()\nexit"],
  [
    "O",
    "schema-declaration-order",
    'function earlier { let early: integer = load("pin", default: 0) }\nlet late: string = load("pin", default: "")\nexit',
  ],
];
export const cases = probes.map(([, name, source]) => [name, source]);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probes.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s9b-plan-review-evidence/probes.mjs",
    ],
  ],
  sources: 24,
  sha256: "14db9d0dad6f92ffeefdf93918b8b09a3baa3e1003ba8236ac497aa9bc48794f",
};
