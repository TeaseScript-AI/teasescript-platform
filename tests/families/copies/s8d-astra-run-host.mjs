// Astra review.
export const cases = (() => {
  const object = (properties) => ({
    kind: "object",
    properties: Object.entries(properties).map(([name, value]) => ({ name, value })),
  });
  const cases = [
    [
      "typed-load-default",
      'let score: integer = load("review.score", default: 9)\nsay score\nexit\n',
      {},
      [{ key: "review.score", value: "seven" }],
    ],
    [
      "typed-load-record",
      'let badge = load("review.badge", default: {caption: "Visitor", rank: 7})\nsay badge.caption\nsay badge.rank\nexit\n',
      {},
      [{ key: "review.badge", value: object({ caption: 4, rank: "wrong" }) }],
    ],
    [
      "unknown-object-store",
      'let badge = hostValue\nbadge.rank = 7\nsay "after"\nexit\n',
      { hostValue: object({}) },
    ],
    [
      "unknown-object-store-good",
      "let badge = hostValue\nbadge.rank = 7\nsay badge.rank\nexit\n",
      { hostValue: object({ rank: 1 }) },
    ],
    [
      "unknown-object-read",
      "let badge = hostValue\nsay badge.rank\nexit\n",
      { hostValue: object({}) },
    ],
    [
      "unknown-count",
      'let rounds = hostValue\nrepeat rounds { say "tick" }\nexit\n',
      { hostValue: "seven" },
    ],
    [
      "unknown-null-count",
      'let rounds = hostValue\nrepeat rounds { say "tick" }\nexit\n',
      { hostValue: null },
    ],
    [
      "unknown-store",
      'let rounds: integer = hostValue\nsay "after"\nexit\n',
      { hostValue: "seven" },
    ],
    [
      "unknown-fallback",
      "let choices = [7, null]\nlet rounds = choices[1] otherwise hostValue\nsay rounds\nexit\n",
      { hostValue: "seven" },
    ],
    [
      "unknown-default",
      'let rounds = toInteger("wrong", default: hostValue)\nsay rounds\nexit\n',
      { hostValue: "seven" },
    ],
    [
      "unknown-condition",
      'let ready = hostValue\nif ready { say "yes" }\nexit\n',
      { hostValue: 7 },
    ],
    [
      "unknown-show",
      'let badge = hostValue\nsay "${badge}"\nexit\n',
      { hostValue: object({ rank: 7 }) },
    ],
    ["unknown-key", "let prices = dict{tea: 4}\nsay prices[hostValue]\nexit\n", { hostValue: 7 }],
    ["unknown-iterable", "for badge in hostValue { say badge }\nexit\n", { hostValue: 7 }],
    ["unknown-operation", "say hostValue * 7\nexit\n", { hostValue: "seven" }],
    [
      "empty-selection-host",
      "let badges: integer[] = hostValue\nsay badges.last\nexit\n",
      { hostValue: { kind: "list", items: [] } },
    ],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication"];
