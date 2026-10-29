// #1165 S8 part 3, r7 retained builder/probe9 evidence.
export const cases = (() => {
  const source = "let n: integer = hostValue\nlet flag: boolean = hostOther\nsay n\nexit";
  return [["source", source]];
})();
export const checks = ["publication", "stops"];
