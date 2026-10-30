// S8c's review (Astra): its growth shapes, nested lists and objects, a typed parse and load default read to its depth, a
// typed leaf copied into a nest, a mixed spine and sibling copies, at the quick sizes 8 and 16 and the full sizes 64 to
// 256 (R/astra-m4-s8c-review-evidence/worker/growth.mjs).
const nest = (n, open, close, leaf) => open.repeat(n) + leaf + close.repeat(n);
const make = {
  list: (n) => `let layers = ${nest(n, "[", "]", "7")}\nsay "DONE"`,
  object: (n) => `let layers = ${nest(n, "{branch: ", "}", "7")}\nsay "DONE"`,
  typedParse: (n) =>
    `let layers = fromJson(hostValue, default: ${nest(n, "{branch: ", "}", "7")})\nsay layers${".branch".repeat(n)}`,
  typedLoad: (n) =>
    `let layers = load("state", default: ${nest(n, "{branch: ", "}", "7")})\nsay layers${".branch".repeat(n)}`,
  typedCopyLeaf: (n) => `let leaf: integer = 7\nlet layers = ${nest(n, "[", "]", "leaf")}\nsay "DONE"`,
  mixedSpine: (n) => {
    let v = "7";
    for (let i = 0; i < n; i++) v = i % 2 ? `{branch: ${v}, side: 2}` : `[${v}]`;
    return `let layers = ${v}\nsay "DONE"`;
  },
  siblingCopies: (n) => `let leaf: integer = 7\nlet layers = ${nest(n, "{side: leaf, branch: ", "}", "leaf")}\nsay "DONE"`,
};
export const shapes = Object.fromEntries(Object.entries(make).map(([name, f]) => [name, (n) => f(n) + "\nexit\n"]));

export const sizes = [8, 16, 64, 128, 256];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "SX_HEAVY_MEM=2G sx-queue add --name astra-s8c-growth-quick -- timeout 180m /home/peter/opt/node-24.18/bin/node growth.mjs walk quick",
      "R/astra-m4-s8c-review-evidence/worker/quick.sh:3"
    ],
    [
      "SX_HEAVY_MEM=2G sx-queue add --name astra-s8c-growth-head -- timeout 180m /home/peter/opt/node-24.18/bin/node growth.mjs walk",
      "R/astra-m4-s8c-review-evidence/worker/more.sh:3"
    ],
    [
      "SX_HEAVY_MEM=2G sx-queue add --name astra-s8c-growth-main -- timeout 180m /home/peter/opt/node-24.18/bin/node growth.mjs main",
      "R/astra-m4-s8c-review-evidence/worker/more.sh:4"
    ],
    [
      "env ONLY=typedParse,typedLoad node --import ./skip-unsettled-syntax.mjs growth.mjs walk",
      "R/astra-m4-s8c-review-evidence/README.md:23"
    ]
  ],
  "sources": 35,
  "sha256": "7aa58e4f428fe1c5da4523fe73f2a11bca9bc8a5645fed64b4b0f1f62486e2f5"
};
