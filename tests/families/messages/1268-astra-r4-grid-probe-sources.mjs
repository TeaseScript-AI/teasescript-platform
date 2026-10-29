// #1268; Astra review: 1 fixed SOURCES source cases.
const corpus = (() => {
  const SOURCES = [
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
    "function f(n) {\n  let ms = [1, null]\n  let m = ms[1]\n  say m + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
    "let ms = [1, null]\nlet m = ms[1]\nlet v: integer = hostValue\nsay m + v\nexit\n",
    "function f(n) {\n  let ms = [1, null]\n  say ms[1] + 1\n  say n + 1\n  return 1\n}\nsay f(hostValue)\nexit\n",
    "let ms = [1, null]\nlet m = ms[1]\nfunction g(n) { return n }\nsay m + g(hostValue)\nexit\n",
  ];
  return {
    cases: [
      [
        "function f(n) {\n  let ms = [1, null]\n  say ms[1] + n\n  return 1\n}\nsay f(hostValue)\nexit\n",
        SOURCES[1],
      ],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];
