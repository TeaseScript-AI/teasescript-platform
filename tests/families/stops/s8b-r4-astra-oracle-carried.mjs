// #1165 / S8; Astra review.
export const cases = (() => {
  const carried =
    'let anchor = {score: 8}\nlet shadow = anchor\nlet invalid = {score: "text"}\nshadow = invalid\nsay shadow.score\nexit\n';
  return [["carried", carried]];
})();
export const checks = ["publication", "stops"];
