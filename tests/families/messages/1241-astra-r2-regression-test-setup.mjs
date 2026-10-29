// #1241; Astra review.
export const cases = (() => {
  const setup = 'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\n';
  return [["setup", setup]];
})();
export const checks = ["publication"];
