// nested-port, indexed-port and related fixed cases; #1394 G5 5a Astra review / builder corpus, r2
// (R/astra-m4-g5-5a-review-r2-evidence/own.mjs).
export const cases = (() => {
  const edits = (place, n) =>
    Array.from({ length: n }, (_, i) => `${place} = ${i + 2} + ${i + 3}`).join("\n");
  const cases = [
    {
      name: "nested-port",
      source: `let seed = {branch: {n: 1}, bag: [{n: 2}]}\nlet a = seed\nlet b = a\nlet c = b\na = c\n${edits("b.branch.n", 13)}\nlet outside = c\nif outside.branch != null {\n repeat outside.branch.n {}\n say "\${a.bag.first.n}"\n}\nsay "\${b.branch.n}"\nexit\n`,
    },
    {
      name: "indexed-port",
      source: `let seed = [{n: 1}]\nlet a = seed\nlet b = a\nlet c = b\na = c\nb.add({n: 2})\n${edits("c[0].n", 11)}\nlet outside = b\nrepeat outside.first.n {}\nsay "\${a[0].n}"\nsay "\${c.first.n}"\nexit\n`,
    },
    {
      name: "two-components",
      source: `let seed = {branch: {n: 1}}\nlet a = seed\nlet b = a\na = b\nlet c = {branch: {n: 3}}\nlet d = c\nlet e = d\nc = e\n${edits("a.branch.n", 8)}\n${edits("d.branch.n", 9)}\nlet left = b\nlet right = e\nrepeat left.branch.n {}\nrepeat right.branch.n {}\nsay "\${b.branch.n}"\nsay "\${e.branch.n}"\nexit\n`,
    },
  ];
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node own.mjs", "R/astra-m4-g5-5a-review-r2-evidence/README.md:22"]],
  sources: 3,
  sha256: "e65bff2dbab84e2fb331191c73a72488414a63433ec1a8f7106ef4fa569ebb20",
};
