export const cases = [
  [
    "original-1",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "original-2",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-3",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-4",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "original-5",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-6",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-7",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal != "" { say "open" }\nexit\n',
  ],
  [
    "original-8",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "original-9",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "original-10",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-11",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-12",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-13",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-14",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-15",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-16",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[0].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-17",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove[pos + 0].petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-18",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = bloom().petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-19",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "original-20",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-21",
    'let value = 404\nlet grove = [{petal: 19}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-22",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal > 0 { say "open" }\nexit\n',
  ],
  [
    "original-23",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-24",
    'let value = 404\nlet grove = [{petal: 1.75}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue > 0 { say "open" }\nexit\n',
  ],
  [
    "original-25",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal != "" { say "open" }\nexit\n',
  ],
  [
    "original-26",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "original-27",
    'let value = 404\nlet grove = [{petal: "Orchid"}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue != "" { say "open" }\nexit\n',
  ],
  [
    "original-28",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-29",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-30",
    'let value = 404\nlet grove = [{petal: [19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-31",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-32",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-33",
    'let value = 404\nlet grove = [{petal: set[19]}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-34",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nif grove[pos].petal.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-35",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = grove.random.petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  [
    "original-36",
    'let value = 404\nlet grove = [{petal: dict{petal: 19}}]\nlet pos = 0\nfunction bloom { return grove[0] }\nlet petalValue = (grove[0]).petal\nif petalValue.length > 0 { say "open" }\nexit\n',
  ],
  ["original-37", 'let badge = {tags: ["orchid"], count: 19}\nsay "${badge.count}"\nexit\n'],
  [
    "original-38",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\nsay packet.guide.title\nexit\n',
  ],
  ["original-39", 'let blossom: integer | string = 19\nblossom = "Iris"\nsay blossom\nexit\n'],
  [
    "original-40",
    'let blossoms: (integer | string)[] = [19]\nblossoms.add("Iris")\nsay blossoms.last\nexit\n',
  ],
  [
    "original-41",
    'let blossoms: (integer | string) dict = dict{a: 19}\nblossoms["b"] = "Iris"\nsay blossoms["b"]\nexit\n',
  ],
  ["original-42", 'let petal = 19\nsay "Petals: ${petal + 3}"\nexit\n'],
  [
    "original-43",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.orchid = 19\nsay "done"\nexit\n',
  ],
  [
    "original-44",
    'let audience: speaker | object = player\nif [true, false].random { audience = {title: "Other"}\nsay "object" } else { say "speaker" }\naudience.clear()\nexit\n',
  ],
  [
    "original-45",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.clear()\nexit\n',
  ],
  [
    "original-46",
    'speaker guide { title: "Orchid" }\nlet packet = {guide: guide}\npacket.guide.orchid = 19\nsay packet.guide.orchid\nexit\n',
  ],
];

export const checks = ["publication"];
