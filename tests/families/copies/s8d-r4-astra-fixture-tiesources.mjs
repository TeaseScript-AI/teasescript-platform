// captured let packet: integer | string | null = null say packet * 7 exit ; Astra review, r4
// (R/astra-m4-s8d-r4-evidence/fixture.mjs).
export const cases = [
  ["original-1", "let packet: integer | string | null = null\nsay packet * 7\nexit\n"],
  [
    "original-2",
    'let shelf: integer | string | null = null\nlet door: boolean | integer | null = null\nsay shelf + 11\nif door { say "open" }\nexit\n',
  ],
];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node fixture.mjs <root>", "R/astra-m4-s8d-review-r4.md:76"]],
  sources: 2,
  sha256: "702b4c3858cc6d6934acad4c749962cd42bd7f72ec78f50599442d549e8024d1",
};
