export const cases = [
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
