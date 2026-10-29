// #1165 / S8; Astra review: 1 fixed cases source cases.
const corpus = (() => {
  const cases = [
    "let value: integer? = hostValue\nif value != null { let local = value\nrepeat local {} }",
    "let value: integer[]? = hostValue\nif value != null { let local = {rows: value}\nsay local.rows.first }",
    "function use(v: integer?) { if v != null { let local = v\nrepeat local {} } }\nuse(3)\nuse(null)",
  ];
  return {
    cases: [
      [
        "let value: integer? = hostValue\nif value != null { let local = value\nrepeat local {} }",
        cases[1],
      ],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication", "stops"];
