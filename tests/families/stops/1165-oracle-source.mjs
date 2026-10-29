// #1165 S8 part 3, r7 retained builder/probe9 evidence.
export const cases = (() => {
  const source =
    "let n: integer = hostValue\nlet p: boolean = hostOther\nlet box = hostValue\nbox.score = 9\nsay n\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
