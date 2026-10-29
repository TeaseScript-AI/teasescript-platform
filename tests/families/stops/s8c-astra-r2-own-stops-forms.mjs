// #1165 / S8; Astra review.
export const cases = (() => {
  const forms = [
    [
      "object-list",
      "repeat {payload: [tally]}.payload.first {}",
      [["{payload: [tally]}.payload.first", "budget"]],
    ],
    [
      "list-object",
      "repeat [{payload: tally}].first.payload {}",
      [["[{payload: tally}].first.payload", "budget"]],
    ],
    [
      "composed-fallback",
      "repeat ({payload: tally}.payload otherwise 0) + 1 {}",
      [["({payload: tally}.payload otherwise 0) + 1", "budget"]],
    ],
    [
      "stored-projection",
      "let packed = {payload: [tally]}\nlet copied = packed\nrepeat copied.payload.first {}",
      [["copied.payload.first", "budget"]],
    ],
    [
      "positive-else",
      "if tally is integer { let yes: integer = tally } else { let no = tally }\nrepeat tally {}",
      [
        ["tally }", "integer"],
        ["tally }\nrepeat", "budget"],
        ["tally {}", "budget"],
      ],
    ],
    [
      "negative-else",
      "if tally is not integer { let no = tally } else { let yes: integer = tally }\nrepeat tally {}",
      [
        ["tally } else", "budget"],
        ["tally }\nrepeat", "integer"],
        ["tally {}", "budget"],
      ],
    ],
    [
      "guard-composition",
      "if tally is integer { let packed = {payload: [tally]}\nrepeat packed.payload.first {} }\nrepeat tally {}",
      [
        ["tally]}", "integer"],
        ["packed.payload.first", "integer"],
        ["tally {}", "budget"],
      ],
    ],
    [
      "two-demands",
      "let one: integer = tally\nlet two: integer = tally\nrepeat tally {}",
      [
        ["tally\nlet two", "budget"],
        ["tally\nrepeat", "budget"],
        ["tally {}", "budget"],
      ],
    ],
  ];
  return forms.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
