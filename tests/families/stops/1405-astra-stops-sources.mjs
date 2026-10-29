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
