// nested-ring-proof, index-ring-proof; #1394 G5 5a Astra review / builder corpus, r2
// (R/astra-m4-g5-5a-review-r2-evidence/proof-stop.mjs).
export const cases = (() => {
  const cases = [
    {
      name: "nested-ring-proof",
      source:
        'let seed = {q: {n: 1}}\nlet a = seed\nlet b = a\nlet c = b\na = c\nsay "${a.q.n}"\nsay "${b.q.n}"\nsay "${c.q.n}"\nexit\n',
      paths: ["q", "q.n"],
    },
    {
      name: "index-ring-proof",
      source:
        'let seed = [{q: [1]}]\nlet a = seed\nlet b = a\nlet c = b\na = c\nsay "${a[0].q[0]}"\nsay "${b[0].q[0]}"\nsay "${c[0].q[0]}"\nexit\n',
      paths: ["[0]", "[0].q", "[0].q[0]"],
    },
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node proof-stop.mjs", "R/astra-m4-g5-5a-review-r2-evidence/README.md:23"]],
  sources: 2,
  sha256: "a1fd5237222c60be7dbd1ec7b3495b1d7497a60080711ccef86a7e46889b9a55",
};
