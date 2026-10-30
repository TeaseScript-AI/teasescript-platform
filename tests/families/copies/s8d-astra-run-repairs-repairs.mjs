// original diagnostic replacements applied to complete sources; Astra review, round unrecorded
// (R/astra-m4-s8d-review-evidence/run-repairs.mjs).
const generated = [
  ["union-variable", 'let season: integer | string = 4\nseason = "winter"\nsay season\nexit\n'],
  [
    "union-list",
    'let tickets: (integer | string)[] = [4]\ntickets.add("guest")\nsay tickets.length\nexit\n',
  ],
  [
    "union-dict",
    'let prices: (integer | string) dict = dict{tea: 4}\nprices["cake"] = "free"\nsay prices.length\nexit\n',
  ],
  [
    "shown-object",
    'let badge = {nested: {flag: true}, codes: [4], caption: "Visitor", rank: 7}\nsay "${badge.caption}"\nexit\n',
  ],
  [
    "shown-optional-property",
    'let badge = {caption: null, rank: 7}\nsay "${badge.caption}"\nexit\n',
  ],
  ["shown-set", 'let badges = set[4, 7]\nsay "${badges.toList().join()}"\nexit\n'],
  [
    "shown-mixed-shapes",
    'let badges = [{caption: "Visitor", rank: 7}, {rank: 8}]\nfor badge in badges { say "${badge.rank}" }\nexit\n',
  ],
  [
    "shown-property-changed",
    'let badge = {caption: "Visitor", rank: 7}\nlet other = {rank: 8}\nfunction change { badge = other }\nchange()\nsay "${badge.rank}"\nexit\n',
  ],
  ["condition-number", 'let distance = 17\nif distance > 0 { say "near" }\nexit\n'],
  ["condition-text", 'let caption = "near"\nif caption != "" { say caption }\nexit\n'],
  ["condition-list", 'let badges = [4, 7]\nif badges.length > 0 { say "badges" }\nexit\n'],
  ["key-number", 'let prices = dict{"-4": 7}\nsay prices["${-4}"]\nexit\n'],
  ["convert-text", "let badge = 47\nsay toString(badge).length\nexit\n"],
  ["convert-duration", "let gap = 4 s\nsay (gap * 3) / 1 millisecond\nexit\n"],
  [
    "convert-date-field",
    'let stamp = toAbsoluteDateTime("2025-05-17T09:30:00Z")\nsay (stamp + 9 s).toDateTime().month\nexit\n',
  ],
  ["date-add", 'say toDate("2025-05-17") + 4 calendar days\nexit\n'],
  [
    "datetime-add",
    'let stamp = toDateTime("2025-05-17T09:30:00")\nsay (stamp.toAbsoluteDateTime() + 9 s).toDateTime()\nexit\n',
  ],
  [
    "absolute-add",
    'let stamp = toAbsoluteDateTime("2025-05-17T09:30:00Z")\nsay (stamp.toDateTime() + 2 calendar months).toAbsoluteDateTime()\nexit\n',
  ],
  [
    "date-compare",
    'let birthday = toDate("2025-05-17")\nlet stamp = toDateTime("2025-05-18T09:30:00")\nsay birthday > toDate(stamp)\nexit\n',
  ],
  [
    "datetime-subtract",
    'let stamp = toDateTime("2025-05-17T09:30:00")\nsay toDate(stamp) - toDate(toDateTime("2025-05-16T08:00:00"))\nexit\n',
  ],
  ["speaker-method", 'speaker guide { title: "Guide" }\nsay guide.title\nexit\n'],
  [
    "null-arithmetic-flow",
    "let values: integer?[] = [null, 7]\nlet credit = values[0]\nsay (credit otherwise 0) * 4\nexit\n",
  ],
];

export const checks = ["publication"];

// The two repaired programs that name an undeclared value, as the review reports for the computed set and its
// fallback (R/astra-m4-s8d-review-evidence/run-repairs.mjs:13): an intended TSV002.
const captured = [
  ["shown-computed-set.tease", 'say "${value.toList().join()}"\nexit\n'],
  ["set-composed.tease", 'let badges: integer set? = null\nsay "${value.toList().join()}"\nexit\n'],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node run-repairs.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-review-evidence/run-repairs.mjs",
    ],
  ],
  sources: 24,
  sha256: "b8db259f7964b173992e36a184bc597596afc3d14e0abdd629f2e498f56c871b",
};
