export const cases = [
  [
    "original-1",
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-2",
    "function f(n) {\n  let ms = [1, null]\n  let m = ms[1]\n  say m + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-3",
    "let ms = [1, null]\nlet m = ms[1]\nlet v: integer = hostValue\nsay m + v\nexit\n",
  ],
  [
    "original-4",
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + 1\n  say n + 1\n  return 1\n}\nsay f(hostValue)\nexit\n",
  ],
  [
    "original-5",
    "let ms = [1, null]\nlet m = ms[1]\nfunction g(n) { return n }\nsay m + g(hostValue)\nexit\n",
  ],
];

export const checks = ["publication", "stops"];
