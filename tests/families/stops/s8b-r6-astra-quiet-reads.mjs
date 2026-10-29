// #1165 / S8; Astra review: 4 fixed cases source cases.
const corpus = (() => {
  const cases = {
    number: [
      "let amount = 9.0\nif amount is integer { amount = 4.5\nlet accepted: number = amount\nsay accepted }\nexit",
      "amount",
    ],
    union: [
      "let option: integer | boolean = true\nlet accepted: integer | boolean = option\nsay accepted\nexit",
      "option",
    ],
    nullable: [
      "let option: integer? = null\noption = 2\nlet accepted: integer? = option\nsay accepted\nexit",
      "option",
    ],
    copy: [
      "let original = 9.0\nlet sample = original\nif sample is integer { sample = 1.5\nlet accepted: number = sample\nsay accepted }\nexit",
      "sample",
    ],
  };
  return {
    cases: [
      ["0", cases["number"]["0"]],
      ["0", cases["union"]["0"]],
      ["0", cases["nullable"]["0"]],
      ["0", cases["copy"]["0"]],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];
