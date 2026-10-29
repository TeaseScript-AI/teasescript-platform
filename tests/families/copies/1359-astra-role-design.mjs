// #1359, Astra's contract roles design review (R/astra-m4-contract-roles-design-review-evidence/probes/): the ten
// design shapes sample.mjs took (the first ten of design-shapes.mjs, all from order-shapes.mjs) at 8 and 16, as run.sh
// ran them in each tie mode.

// #1359's B1 family (Astra r1): m = k/8 peers of one class, each a k-long `max` chain (roles) or a k-option choice of
// host reads (leaves), read together in k lists in different orders and subsets; fixed order is the control.
const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
const peersOf = (k) => Math.max(2, Math.floor(k / 8));
const values = {
  role: (k) => `${"max(".repeat(k)}hostValue.n${many(k, (i) => `, ${i})`, "")}`,
  leaf: (k) => `askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.p${i}}`, ", ")}`,
};
// a deterministic shuffle of 0..m-1 for site i
const shuffled = (m, i) => {
  const out = Array.from({ length: m }, (_, j) => j);
  let seed = (i * 2654435761 + 12345) >>> 0;
  for (let j = m - 1; j > 0; j -= 1) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const at = seed % (j + 1);
    [out[j], out[at]] = [out[at], out[j]];
  }
  return out;
};
const forms = {
  fixed: (m) => Array.from({ length: m }, (_, j) => j),
  rotated: (m, i) => Array.from({ length: m }, (_, j) => (i + j) % m),
  permuted: (m, i) => shuffled(m, i),
  // a window of 2 to m peers from a rotating start: up to k distinct subsets
  subsets: (m, i) => Array.from({ length: 2 + ((i * 7) % (m - 1)) }, (_, j) => (i + j) % m),
  // three peers, a distinct set at each of up to m·(m-1) sites, rotated
  triples: (m, i) => {
    const a = i % m;
    const b = (a + 1 + (Math.floor(i / m) % (m - 1))) % m;
    const c = [(b + 1) % m, (b + 2) % m].find((j) => j !== a);
    return [a, b, c].map((_, j, all) => all[(i + j) % 3]);
  },
  // one set in two orders, alternating: its leaves joined through two intermediates
  twoOrders: (m, i) => Array.from({ length: m }, (_, j) => (i % 2 === 0 ? j : m - 1 - j)),
};
const program = (kind, form, k, prefix = "p") => {
  const m = peersOf(k);
  return [
    many(m, (j) => `let ${prefix}${j} = ${values[kind](k)}`),
    many(
      k,
      (i) =>
        `let xs${i} = [${forms[form](m, i)
          .map((j) => `${prefix}${j}`)
          .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
    ),
    "exit",
  ].join("\n");
};
const orderShapes = {};
for (const kind of Object.keys(values))
  for (const form of Object.keys(forms))
    orderShapes[`${kind}-${form}`] = (k) => program(kind, form, k);
// the peers reached through two alias levels (`let a = p`, `let b = a`), lists of the second, rotated
for (const kind of Object.keys(values))
  orderShapes[`${kind}-aliased`] = (k) => {
    const m = peersOf(k);
    return [
      many(m, (j) => `let p${j} = ${values[kind](k)}`),
      many(m, (j) => `let a${j} = p${j}\nlet b${j} = a${j}`),
      many(
        k,
        (i) =>
          `let xs${i} = [${forms
            .rotated(m, i)
            .map((j) => `b${j}`)
            .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit",
    ].join("\n");
  };
// peers whose roles read m aliases of one value, each peer in its own rotation: their other roles' writers differ
// (`RoleSource.others`), compared once per set of their sequences
for (const form of ["rotated", "permuted", "subsets", "triples", "fixed"])
  orderShapes[`alias-${form}`] = (k) => {
    const m = peersOf(k);
    const chain = (p) =>
      `${"max(".repeat(k)}x${p % m}${many(k, (r) => `, x${(p + r + 1) % m})`, "")}`;
    return [
      "let base = 1",
      many(m, (j) => `let x${j} = base`),
      many(m, (j) => `let p${j} = ${chain(j)}`),
      many(
        k,
        (i) =>
          `let xs${i} = [${forms[form](m, i)
            .map((j) => `p${j}`)
            .join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit",
    ].join("\n");
  };

// sample.mjs
export const shapes = Object.fromEntries(Object.entries(orderShapes).slice(0, 10));
export const sizes = [8, 16];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'ROLE_TIE_PROBE="$mode" /home/peter/opt/node-24.18/bin/node --import ./tie-hook.mjs ./spot.mjs /home/peter/work/i1357-r2/head-60dab8ff3 "$mode-sample.jsonl" shapes ./sample.mjs 8,16 2> "$mode-sample.stats"',
      "R/astra-m4-contract-roles-design-review-evidence/probes/run.sh:4",
    ],
  ],
  sources: 14,
  sha256: "43579d6e73649abb9fd76f5426aa020afacfb0d6020f14a1066b10ec437a6d21",
};
