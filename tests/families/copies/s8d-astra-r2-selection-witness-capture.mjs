export const cases = [
  [
    "fixed-selection",
    "let groups: integer[][] = [[], [21]]\nif groups.random.length > 0 { say groups.random.last }\nexit\n",
  ],
  [
    "capture-selection",
    "let groups: integer[][] = [[], [21]]\nlet chosen = groups.random\nif chosen.length > 0 { say chosen.last }\nexit\n",
  ],
];

export const checks = ["publication"];
