// #1165 / S8; Astra review.
export const cases = (() => {
  const tail = '\nsay n\nrepeat 2 { say "AFTER" }\nexit\n';
  const programs = {
    scalar: 'let n = 1\nn = "wrong"' + tail,
    list: 'let n = [1]\nn = ["wrong"]' + tail,
    object: 'let n = {x: 1}\nn = {x: "wrong"}' + tail,
    nested: 'let n = {x: {y: 1}}\nn = {x: {y: "wrong"}}' + tail,
    decimal: "let n = 1\nn = 2.5" + tail,
    copy: 'let n = 1\nn = "wrong"\nlet m = n' + tail,
  };
  return Object.entries(programs);
})();
export const checks = ["publication", "stops"];
