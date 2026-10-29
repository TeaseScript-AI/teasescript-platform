// #1165 / S8; Astra review.
export const cases = (() => {
  const shapes = [
    [
      "direct",
      "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay quantity }\nexit",
      "quantity",
      [],
    ],
    [
      "literal-list",
      "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay [quantity] }\nexit",
      "[quantity]",
      ["element"],
    ],
    [
      "literal-object",
      "let quantity = 8.0\nif quantity is integer { quantity = 3.5\nlet observed: number = quantity\nsay {part: quantity} }\nexit",
      "{part: quantity}",
      ["part"],
    ],
    [
      "literal-union",
      "let quantity: integer | boolean = 3\nsay [quantity]\nexit",
      "[quantity]",
      ["element"],
    ],
    [
      "literal-nullable",
      "let quantity: integer? = 3\nsay {part: quantity}\nexit",
      "{part: quantity}",
      ["part"],
    ],
    ["copy", "let source = 8.0\nlet quantity = source\nsay quantity\nexit", "quantity", []],
    ["union", "let quantity: integer | boolean = 3\nsay quantity\nexit", "quantity", []],
    ["nullable", "let quantity: integer? = 3\nsay quantity\nexit", "quantity", []],
  ];
  return shapes.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
