// captured let leaf: integer=1 let root={n:leaf} let box={q:root} let outer={r:box} let last=outer.r.q.n exit ; #1405 /
// #1403 Astra review, round unrecorded (R/astra-m4-g3-p3-review-evidence/stops.mjs).
export const cases = [
  [
    "original-1",
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=outer.r.q.n\nexit\n",
  ],
  [
    "original-2",
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=[outer.r.q.n][0]\nexit\n",
  ],
  [
    "original-3",
    "let leaf: integer?=null\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=outer.r.q.n otherwise 2\nexit\n",
  ],
  [
    "original-4",
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nroot.n = hostValue\nlet last=outer.r.q.n\nexit\n",
  ],
  [
    "original-5",
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nbox.q = {n:2}\nlet other: integer=hostValue\nsay box.q.n\nexit\n",
  ],
  [
    "original-6",
    "let leaf:integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet copy=box\nlet check:integer=hostValue\nexit\n",
  ],
];

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node stops.mjs stops.json", "R/astra-m4-g3-p3-review-evidence/README.md:20"]],
  sources: 6,
  sha256: "e1424c1c73d8d22952ce636a421dd977c0cb71fd70285b0efc15019211530a58",
};
