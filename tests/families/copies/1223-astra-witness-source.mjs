// captured astra witness source input; #1223, Astra review, round unrecorded
// (R/astra-m4-i1223-review-evidence/witness.mjs).
const generated = [
  [
    "mixed-parse",
    "let parcel: object = fromJson(hostValue, default: {score: 4, meta: {ready: true}, steps: [1], spare: null}, files: false)\nsay parcel.score\nsay parcel.meta.ready\nexit\n",
  ],
  [
    "mixed-load",
    'let parcel: object = load("cache", default: {score: 4, meta: {ready: true}, steps: [1], spare: null})\nsay parcel.score\nsay parcel.meta.ready\nexit\n',
  ],
  [
    "optional-parse",
    'let parcel: object? = fromJson(hostValue, default: {score: 4, meta: {ready: true}}, files: false)\nsay "complete"\nexit\n',
  ],
  [
    "optional-load",
    'let parcel: object? = load("cache", default: {score: 4, meta: {ready: true}})\nsay "complete"\nexit\n',
  ],
  [
    "methodnames-parse",
    "let parcel: object = fromJson(hostValue, default: {toString: 4, constructor: 5, valueOf: true, __proto__: 6}, files: false)\nsay parcel.toString\nsay parcel.constructor\nexit\n",
  ],
  [
    "methodnames-load",
    'let parcel: object = load("cache", default: {toString: 4, constructor: 5, valueOf: true, __proto__: 6})\nsay parcel.toString\nsay parcel.constructor\nexit\n',
  ],
  [
    "list-object-parse",
    "let parcel: object[] = fromJson(hostValue, default: [{score: 4}], files: false)\nsay parcel[0].score\nexit\n",
  ],
  [
    "list-object-load",
    'let parcel: object[] = load("cache", default: [{score: 4}])\nsay parcel[0].score\nexit\n',
  ],
  [
    "nested-list-parse",
    "let parcel: object = fromJson(hostValue, default: {groups: [{score: 4}], tail: 2}, files: false)\nsay parcel.groups[0].score\nsay parcel.tail\nexit\n",
  ],
  [
    "nested-list-load",
    'let parcel: object = load("cache", default: {groups: [{score: 4}], tail: 2})\nsay parcel.groups[0].score\nsay parcel.tail\nexit\n',
  ],
  [
    "inferred-parse",
    "let parcel = fromJson(hostValue, default: {score: 4}, files: false)\nsay parcel.score\nexit\n",
  ],
  ["inferred-load", 'let parcel = load("cache", default: {score: 4})\nsay parcel.score\nexit\n'],
  [
    "empty-parse",
    "let parcel: object = fromJson(hostValue, default: {}, files: false)\nsay parcel.tail\nexit\n",
  ],
  ["empty-load", 'let parcel: object = load("cache", default: {})\nsay parcel.tail\nexit\n'],
];

export const checks = ["publication"];

// The literal JSON inputs and checkpoint source witness.mjs also compiled (R/astra-m4-i1223-review-evidence/witness.mjs).
const captured = [
  [
    "14",
    'let parcel: object = fromJson("{\\"score\\":\\"bad\\",\\"tail\\":18}", default: {score: 4}, files: false)\nsay parcel.score\nsay parcel.tail\nexit\n',
  ],
  [
    "15",
    'let parcel: object = fromJson("{\\"tail\\":18}", default: {score: 4}, files: false)\nsay parcel.score\nsay parcel.tail\nexit\n',
  ],
  [
    "16",
    'let parcel: object = fromJson("[0]", default: {score: 4}, files: false)\nsay parcel.score\nsay parcel.tail\nexit\n',
  ],
  [
    "__reference0",
    'let parcel: object? = fromJson(hostValue, default: {score: 4}, files: false)\nsay "complete"\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node witness.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1223-review-evidence/witness.mjs",
    ],
  ],
  sources: 18,
  sha256: "d3af860d24254354429d5331610073b344ea6b7c4b59145bd1725db406f9c7eb",
};
