export const cases = [
  [
    "original-1",
    "let value: integer? = hostValue\nif value != null { let local = value\nrepeat local {} }\nexit",
  ],
  [
    "original-2",
    "let value: integer[]? = hostValue\nif value != null { let local = {rows: value}\nsay local.rows.first }\nexit",
  ],
  [
    "original-3",
    "function use(v: integer?) { if v != null { let local = v\nrepeat local {} } }\nuse(3)\nuse(null)\nexit",
  ],
];

export const checks = ["publication", "stops"];
