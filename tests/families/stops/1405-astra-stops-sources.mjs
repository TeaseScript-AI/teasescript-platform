// Astra review: 1 fixed sources source cases.
const corpus = (() => {
  const sources = [
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=outer.r.q.n\nexit\n",
    "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=[outer.r.q.n][0]\nexit\n",
    "let leaf: integer?=null\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=outer.r.q.n otherwise 2\nexit\n",
  ];
  return {
    cases: [
      [
        "let leaf: integer=1\nlet root={n:leaf}\nlet box={q:root}\nlet outer={r:box}\nlet last=outer.r.q.n\nexit\n",
        sources[1],
      ],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];
