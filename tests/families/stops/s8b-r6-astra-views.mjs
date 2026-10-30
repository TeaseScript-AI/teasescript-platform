// direct, literal-list and related fixed cases; #1165 / S8, Astra review, r6
// (R/astra-m4-s8b-r6-evidence/probe/views.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node /home/peter/work/astra-s8-r6/probe/"$kind".mjs "$name" "$mode"',
      "R/astra-m4-s8b-r6-evidence/job.sh:8",
    ],
  ],
  sources: 8,
  sha256: "035b63e4cf00be4a84cd9ba1907f6668378efa2dc913ca347e99e4444f591ae4",
};
