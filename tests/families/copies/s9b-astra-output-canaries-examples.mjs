// Astra review.
export const cases = (() => {
  const examples = [
    {
      id: "ways",
      source:
        'speaker guide { firstName: "Ada" }\nlet count = 2\nif count is integer { guide.mood = "calm" }\nsay guide.mood\nexit',
      options: {},
      drop: (c) => ({ ...c, ways: { paths: new Map(), operands: new Map() } }),
    },
    {
      id: "storage",
      source: 'let score = load("score", default: 1)\nsave hostValue as "score"\nsay "after"\nexit',
      options: { globals: ["hostValue"] },
      drop: (c) => ({ ...c, storageTypes: [] }),
    },
    {
      id: "form",
      source: 'let answers = askForm fields: { amount: { type: "number", value: 1 } }\nexit',
      options: {},
      drop: (c) => ({ ...c, formShapes: new Map() }),
    },
    {
      id: "speaker",
      source: 'speaker guide { firstName: "Ada" }\nsay guide.mood\nguide.mood = "calm"\nexit',
      options: {},
      drop: (c) => ({ ...c, speakerFlow: { reads: new Map(), stores: new Map() } }),
    },
  ];
  return examples.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
