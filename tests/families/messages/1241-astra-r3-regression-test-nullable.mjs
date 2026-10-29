export const cases = [
  [
    "original-1",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = n + 1\nsay converted\nexit",
  ],
  [
    "original-2",
    "let ns = [2, null]\nlet n = ns[1]\nlet converted: duration = -n\nsay converted\nexit",
  ],
  [
    "original-3",
    "let choices = [{inner: {n: 2}}, null]\nlet box = choices[1]\nlet converted: duration = box.inner.n\nsay converted\nexit",
  ],
  ["original-4", "let n = 2\nlet converted: duration = n + 1\nsay converted\nexit"],
  ["original-5", "let ns = [2, null]\nlet n = ns[1]\nsay n + 1\nexit"],
];

export const checks = ["publication"];
