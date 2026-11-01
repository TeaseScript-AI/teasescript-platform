// #1572: chains of list operations n terms deep read below their elements, each operation's contract at a path a
// demand of its own, never a native call per term (the verify's forms, agents.home.arpa:~/work/evidence/i1572/
// 9349674e857695084bbfe5584b130ad89196f52e/scripts/forms.mjs); before it a fresh process overflowed at about 900 terms.
const many = (n, term) => Array.from({ length: n }, (_, i) => term(i)).join("");
const eight = "{a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1}";
const read = (n, o, terms, last = "o", say = "say xs.length") =>
  `let o = [${o}]\nlet xs = ${terms(n - 1)}${last}\n${say}\nexit`;
export const shapes = {
  // #1384's reviewer's join: an object of eight properties between distinct literals
  "join-alt": (n) =>
    read(n, eight, (k) => many(k, (i) => (i % 2 === 0 ? "o + " : `[{p${i}: 1}] + `))),
  "join-read": (n) =>
    read(
      n,
      "{q: 1}",
      (k) => many(k, (i) => (i % 2 === 0 ? "o + " : `[{p${i}: 1}] + `)),
      "o",
      'say "${xs[0].q}"',
    ),
  "join-literals": (n) => read(n, "{q: 1}", (k) => many(k, (i) => `[{p${i}: 1}] + `)),
  "join-variables": (n) =>
    `${many(n, (i) => `let o${i} = [{p${i}: 1}]\n`)}let xs = ${Array.from({ length: n }, (_, i) => `o${i}`).join(" + ")}\nsay xs.length\nexit`,
  // one term repeated: a run the sharing collapses (`plusRepeatOf`), read whole without it
  "join-repeated": (n) => read(n, "{q: 1}", (k) => many(k, () => "o + ")),
  "join-parenthesized": (n) =>
    read(n, "{q: 1}", (k) => many(k, (i) => (i % 2 === 0 ? "(o) + " : `([{p${i}: 1}]) + `))),
  "join-right": (n) => read(n, "{q: 1}", (k) => "o + (".repeat(k), `o${")".repeat(n - 1)}`),
  otherwise: (n) =>
    read(n, "{q: 1}", (k) => many(k, (i) => `hostValue.l${i} otherwise `), "o", 'say "${xs[0].q}"'),
};
export const sizes = [1024, 2048, 4096];
export const checks = ["publication"];
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node <head>/tests/families/run.mjs <a folder holding 1572-deep-chains.mjs> <base> <head> --work joins-1572.work.jsonl --out joins-1572.differences.jsonl",
      "agents.home.arpa:~/work/evidence/i1572/families-row/families.sh:9",
    ],
  ],
  sources: 24,
  sha256: "9c3def5d17c9ef67f194a12ce5e13da8139a707631e90e563928b571e315720c",
};
