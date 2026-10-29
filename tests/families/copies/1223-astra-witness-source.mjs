// #1223; Astra review.
export const cases = (() => {
  const source =
    'let parcel: object? = fromJson(hostValue, default: {score: 4}, files: false)\nsay "complete"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication"];
