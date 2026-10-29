// #1253; Astra review.
export const cases = (() => {
  const fileSource =
    'let parcel: object? = fromJson(hostValue, default: {meta: {score: 4}})\nsay "complete"\nexit\n';
  return [["fileSource", fileSource]];
})();
export const checks = ["publication"];
