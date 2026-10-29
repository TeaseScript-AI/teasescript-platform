export const cases = [
  [
    "original-1",
    'let chosen: number? = null\nlet bag = {chosen: chosen}\nlet alias = bag\nsay alias.chosen otherwise hostValue\nlet capacity: integer = hostValue\nlet doc = hostOther\ndoc.count = 6\nsay "READY"\nexit\n',
  ],
];

export const checks = ["publication", "stops"];
