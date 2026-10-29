// Astra review: 24 fixed cases source cases.
const corpus = (() => {
  const cases = [
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
  return {
    cases: [
      ["2", cases["0"]["2"]],
      ["2", cases["1"]["2"]],
      ["2", cases["2"]["2"]],
      ["2", cases["3"]["2"]],
      ["2", cases["4"]["2"]],
      ["2", cases["5"]["2"]],
      ["2", cases["6"]["2"]],
      ["2", cases["7"]["2"]],
      ["2", cases["8"]["2"]],
      ["2", cases["9"]["2"]],
      ["2", cases["10"]["2"]],
      ["2", cases["11"]["2"]],
      ["2", cases["12"]["2"]],
      ["2", cases["13"]["2"]],
      ["2", cases["14"]["2"]],
      ["2", cases["15"]["2"]],
      ["2", cases["16"]["2"]],
      ["2", cases["17"]["2"]],
      ["2", cases["18"]["2"]],
      ["2", cases["19"]["2"]],
      ["2", cases["20"]["2"]],
      ["2", cases["21"]["2"]],
      ["2", cases["22"]["2"]],
      ["2", cases["23"]["2"]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication"];
