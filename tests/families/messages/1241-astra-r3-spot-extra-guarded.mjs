// #1241; Astra review.
export const cases = (() => {
  const guarded =
    "let choices = [{n: 2}, null]\nlet box = choices[0]\nif box != null {\nlet converted: duration = box.n s\nsay converted\n}\nexit";
  return [["guarded", guarded]];
})();
export const checks = ["publication"];
