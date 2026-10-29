// Fixed compiler inputs from astra-m4-s8d-r4-evidence/applied.mjs.
const fixedCases = [
  ["inline-1", 'let badge = {tags: ["orchid"], count: 19}\nsay "${badge.count}"\nexit\n'],
  [
    "inline-2",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\nsay packet.guide.title\nexit\n',
  ],
  ["inline-3", 'let blossom: integer | string = 19\nblossom = "Iris"\nsay blossom\nexit\n'],
  [
    "inline-4",
    'let blossoms: (integer | string)[] = [19]\nblossoms.add("Iris")\nsay blossoms.last\nexit\n',
  ],
  [
    "inline-5",
    'let blossoms: (integer | string) dict = dict{a: 19}\nblossoms["b"] = "Iris"\nsay blossoms["b"]\nexit\n',
  ],
  ["inline-6", 'let petal = 19\nsay "Petals: ${petal + 3}"\nexit\n'],
  [
    "inline-7",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.orchid = 19\nsay "done"\nexit\n',
  ],
  [
    "inline-8",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.clear()\nexit\n',
  ],
  [
    "inline-9",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.clear()\nexit\n',
  ],
  [
    "inline-10",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.orchid = 19\nsay packet.guide.orchid\nexit\n',
  ],
];
export const cases = fixedCases;
export const checks = ["publication"];
