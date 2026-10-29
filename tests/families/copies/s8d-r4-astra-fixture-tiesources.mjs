// Astra review: 1 fixed tieSources source cases.
const corpus = (() => {
  const tieSources = [
    "let packet: integer | string | null = null\nsay packet * 7\nexit\n",
    'let shelf: integer | string | null = null\nlet door: boolean | integer | null = null\nsay shelf + 11\nif door { say "open" }\nexit\n',
  ];
  return {
    cases: [["let packet: integer | string | null = null\nsay packet * 7\nexit\n", tieSources[1]]],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication"];
