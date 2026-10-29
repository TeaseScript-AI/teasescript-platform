// #1165 / S8; Astra review.
export const cases = (() => {
  const cases = [
    [
      "deep-selected-child",
      "let basket = [[2, 4], [6, 8]]\nsay [{leaf: basket.first.first}]\nexit",
    ],
    [
      "deep-selected-set",
      "let basket = [[2, 4], [6, 8]]\nsay {outer: set[basket.first.first]}\nexit",
    ],
    ["dict-selected-value", "let basket = [2, 4]\nsay dict{left: basket.first, right: 5}\nexit"],
    [
      "dict-nested-selection",
      "let basket = [[2, 4], [6, 8]]\nsay dict{left: {leaf: basket.first.first}}\nexit",
    ],
    ["loop-composed", "let basket = [2, 4]\nrepeat 2 { say {outer: [basket.first]} }\nexit"],
    [
      "loop-alias-composed",
      "let basket = [2, 4]\nlet mirror = basket\nrepeat 2 { say dict{leaf: mirror.first} }\nexit",
    ],
    [
      "function-return-alias",
      "function basket { return [2, 4] }\nlet mirror = basket()\nsay {outer: set[mirror.first]}\nexit",
    ],
    [
      "function-return-copy",
      "let basket = [2, 4]\nfunction copy { return basket }\nlet mirror = copy()\nsay dict{leaf: mirror.first}\nexit",
    ],
    [
      "argument-composed",
      "function show(value) { say value }\nlet basket = [2, 4]\nshow(dict{leaf: basket.first})\nexit",
    ],
    [
      "returned-composed",
      "let basket = [2, 4]\nfunction wrap { return {outer: [basket.first]} }\nsay wrap()\nexit",
    ],
    ["index-selected", "let basket = [[2, 4], [6, 8]]\nsay {outer: [basket[0][1]]}\nexit"],
    ["get-selected", "let basket = [2, 4]\nsay {outer: [basket.get(0, default: 6)]}\nexit"],
    ["typed-selected", "let basket: integer[] = [2, 4]\nsay dict{left: basket.first}\nexit"],
    ["host-sibling", "let basket = [2, 4]\nsay {outer: [basket.first, hostValue]}\nexit"],
    [
      "check-and-selection",
      "let basket = [2, 4]\nlet count: integer = hostValue\nsay dict{left: basket.first, right: count}\nexit",
    ],
    [
      "nullable-sibling",
      "let basket = [2, 4]\nlet count: integer? = null\nsay {outer: [basket.first, count]}\nexit",
    ],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
