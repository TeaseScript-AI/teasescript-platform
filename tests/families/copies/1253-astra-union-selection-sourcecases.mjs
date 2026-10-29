// #1253; Astra review: 1 fixed sourceCases source cases.
const corpus = (() => {
  const sourceCases = [
    'let parcel: integer dict? = fromJson(hostValue, default: null, files: false)\nsay "complete"\nexit',
    'let parcel = fromJson(hostValue, default: dict {"a": 1}, files: false)\nsay "complete"\nexit',
  ];
  return {
    cases: [
      [
        'let parcel: integer dict? = fromJson(hostValue, default: null, files: false)\nsay "complete"\nexit',
        sourceCases[1],
      ],
    ],
  };
})();
export const cases = corpus.cases;
export const checks = ["publication"];
