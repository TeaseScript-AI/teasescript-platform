// #1357, Astra review: peers fed by deep `max` roles or wide `askChoice` leaves, read through lists of them in a fixed
// order (R/astra-m4-i1357-review-evidence/vps/fixed-order.mjs).
const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
const forms = {
  roles: (n) => `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`,
  leaves: (n) => `askChoice ${many(n, (i) => `{text:"${i}", value:hostValue.p${i}}`, ", ")}`,
};

export const sizes = [64, 128]; // the recorded growth run's k and its doubling
export const shapes = Object.fromEntries(
  Object.entries(forms).map(([name, expr]) => [
    name,
    (n) => {
      const peers = Math.max(2, Math.floor(n / 8));
      return [
        many(peers, (i) => `let p${i} = ${expr(n)}`),
        many(
          n,
          (i) =>
            `let xs${i} = [${many(peers, (j) => `p${j}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
        ),
        "exit",
      ].join("\n");
    },
  ]),
);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> R/astra-m4-i1357-review-evidence/vps/fixed-order.mjs all 64 src,rev literalUnits,mergeItems,checks,invSteps",
      "R/astra-m4-i1357-review-evidence/vps/fixed-order.jsonl:1 (its result's header)",
    ],
  ],
  sources: 4,
  sha256: "39fd77c8f8866438e7f7053b4b8c069e6e248f8500763454255118bc2fa2d1c2",
};
