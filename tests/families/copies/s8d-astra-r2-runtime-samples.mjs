export const cases = [
  ["original-1", "repeat hostValue {}\nexit\n"],
  ["original-2", "say hostValue.last\nexit\n"],
  ["original-3", "let room: object = hostValue\nsay room.visits\nexit\n"],
  ["original-4", 'if hostValue { say "yes" }\nexit\n'],
  ["original-5", "say hostValue - 3\nexit\n"],
  ["original-6", "let ledger = dict{a: 1}\nsay ledger[hostValue]\nexit\n"],
  ["original-7", "for item in hostValue { say item }\nexit\n"],
  ["original-8", 'say "${hostValue}"\nexit\n'],
  ["original-9", "let limit: integer = hostValue\nsay limit\nexit\n"],
  ["original-10", "let count: integer? = null\nsay count otherwise hostValue\nexit\n"],
  ["original-11", "let scores = [2]\nsay scores.get(4, default: hostValue)\nexit\n"],
  [
    "original-12",
    'let room = {visits: 2}\nif hostValue { room = {title: "porch"} }\nsay room.visits\nexit\n',
  ],
  ["original-13", "let scores: integer[] = []\nsay scores.last\nexit\n"],
  ["original-14", "let count: integer? = null\nsay count + 3\nexit\n"],
  ["original-15", "say hostValue.weight\nexit\n"],
  ["original-16", "player.emblem = 21\nsay player.emblem\nexit\n"],
  ["original-17", "let receiver: object = hostValue\nreceiver.weight = 3\nexit\n"],
  ["original-18", 'let amount: integer = load("quota", default: 12)\nsay amount\nexit\n'],
  ["original-19", "hostValue.removeAt(0)\nexit\n"],
];

export const checks = ["publication"];
