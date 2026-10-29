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
