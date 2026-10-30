// original wide, nested and related inputs; #1165 / S8, Astra review, r4 (R/astra-m4-s8b-r4-evidence/limits.mjs).
const corpus = (() => {
  const programs = [
    [
      "wide",
      `let raw = {${Array.from({ length: 96 }, (_, i) => `f${i}: ${i}`).join(",")}}\nlet alias = raw\nlet value: integer = hostValue\nexit\n`,
    ],
    [
      "nested",
      `let nested = ${"[".repeat(90)}3${"]".repeat(90)}\nlet copied = nested\nlet value: integer = hostValue\nexit\n`,
    ],
    ["readchain", `let v = hostValue\nlet next = v${".child".repeat(1150)}\nexit\n`],
    [
      "branches",
      `let maybe: integer? = null\n${Array.from({ length: 64 }, () => `if maybe != null { say maybe }`).join("\n")}\nexit\n`,
    ],
  ];
  return { cases: programs.map(([name, source]) => [name, source]) };
})();
export const cases = corpus.cases;

for (const input of [
  ["original/1/original-5", "let x: integer? = null\nif x != null { say x }\nexit\n"],
])
  cases.push(input);

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["ROOT=<checkout> node limits.mjs", "R/astra-m4-s8b-r4-evidence/README.md:16"]],
  sources: 5,
  sha256: "17e42d6e31e2048b13d2f4aba046e9cc1a91b47b0c4bd794d7ca6ce73338f876",
};
