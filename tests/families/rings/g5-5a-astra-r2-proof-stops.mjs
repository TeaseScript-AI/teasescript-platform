// #1394 G5 5a Astra review / builder corpus.
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
