export const cases = [
  [
    "computed-choice-text",
    'let option = { text: [1] }\nlet answer = askChoice [option], "Back"\nexit\n',
  ],
  ["negative-index", "let scores = [4, 7]\nsay scores[-1]\nexit\n"],
  ["repeat-postcheck", 'repeat toInteger("-2") {}\nexit\n'],
  [
    "calendar-offset-binary",
    'let day = toDate("2026-08-11")\nday = day + (1 calendar day + 2 h)\nexit\n',
  ],
  ["wait-kind", "wait false\nexit\n"],
  ["repeat-negative", "repeat -2 {}\nexit\n"],
  ["computed-choice", 'let option = { value: 7 }\nlet answer = askChoice [option], "Back"\nexit\n'],
  ["form-shape", "let fields = { agreed: false }\nlet answer = askForm fields: fields\nexit\n"],
  ["calendar-fraction", "let span = 3 calendar days / 2\nexit\n"],
  ["calendar-family", "let answer = 2 calendar months > 50 calendar days\nexit\n"],
  ["calendar-offset", 'let day = toDate("2026-08-11")\nday += 1 calendar day + 2 h\nexit\n'],
  ["calendar-valid", "let span = 4 calendar days / 2\nexit\n"],
  ["dict-duplicate", 'let scores = dict { "red": 1, "red": 2 }\nexit\n'],
  [
    "speaker-before-store",
    'speaker guide { firstName: "Ada" }\nsay guide.mood\nguide.mood = "calm"\nexit\n',
  ],
  ["fallback-unused", "let n = 9\nsay n otherwise 2\nexit\n"],
  ["storage-null", 'let score = load("review-score", default: null)\nexit\n'],
  ["storage-schema", 'let score = load("review-score", default: 1)\nsay score\nexit\n'],
  ["discarded-copy", "[4, 7][0] = 3\nexit\n"],
  ["hash-kind", "let digest = hashText(7)\nexit\n"],
  ["iteration", "for entry in 3 {}\nexit\n"],
  [
    "record-choice",
    'let answer = askChoice { text: "A", value: { n: 1 } }, { text: "B", value: { n: 2 } }\nexit\n',
  ],
  ["json-nested", "let x = toJson({ item: 1..3 })\nexit\n"],
  ["sort-elements", "let xs = [{ n: 1 }, { n: 2 }]\nxs.sort()\nexit\n"],
  [
    "schema-declaration-order",
    'function earlier { let early: integer = load("pin", default: 0) }\nlet late: string = load("pin", default: "")\nexit\n',
  ],
];

export const checks = ["publication"];
