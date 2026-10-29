export const cases = [
  ["original-1", "let packet: integer | string | null = null\nsay packet * 7\nexit\n"],
  [
    "original-2",
    'let shelf: integer | string | null = null\nlet door: boolean | integer | null = null\nsay shelf + 11\nif door { say "open" }\nexit\n',
  ],
];

export const checks = ["publication"];
