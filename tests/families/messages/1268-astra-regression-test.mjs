export const cases = [
  ["original-1", 'let mood = 1\nmood = "happy"\nexit'],
  ["original-2", "let ns = [1, null]\nlet n = ns[1]\nsay n + 1\nexit"],
  ["pasted declaration with ellipsis", 'let mood: integer | string = ...\nmood = "happy"\nexit'],
  [
    "pasted guard with ellipsis",
    "let ns = [1, null]\nlet n = ns[1]\nif n != null { ... }\nsay n + 1\nexit",
  ],
];

export const checks = ["publication"];
