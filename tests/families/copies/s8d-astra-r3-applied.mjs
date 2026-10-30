// S8d's review r3 (Astra): the programs it compiled after applying each offered fix to its review cases
// (R/astra-m4-s8d-r3-evidence/applied.mjs over its review-0 and review-1 results); the originals it fixed are not
// compiled by this run.
export const cases = [
  [
    "applied-1",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample.title}"\nexit\n',
  ],
  [
    "applied-2",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position].title}"\nexit\n',
  ],
  [
    "applied-3",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0].values.join()}"\nexit\n',
  ],
  [
    "applied-4",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample.toList().join()}"\nexit\n',
  ],
  [
    "applied-5",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position].toList().join()}"\nexit\n',
  ],
  [
    "applied-6",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = "${sample}"\nsay caption\nexit\n',
  ],
  [
    "applied-7",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = "${rack[position]}"\nsay caption\nexit\n',
  ],
  [
    "applied-8",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels["${rack[0]}"]\nexit\n',
  ],
  [
    "applied-9",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay toString(sample).length\nexit\n',
  ],
  [
    "applied-10",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay toString(rack[position]).length\nexit\n',
  ],
  [
    "applied-11",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0] / 1 second\nexit\n',
  ],
  [
    "applied-12",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample.toDateTime().year\nexit\n',
  ],
  [
    "applied-13",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position].toDateTime().year\nexit\n',
  ],
  [
    "applied-14",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (rack[0].toDateTime() + 2 calendar days).toAbsoluteDateTime()\nexit\n',
  ],
  [
    "applied-15",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (sample.toAbsoluteDateTime() + 4 s).toDateTime()\nexit\n',
  ],
  [
    "applied-16",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (rack[position].toAbsoluteDateTime() + 4 s).toDateTime()\nexit\n',
  ],
  [
    "applied-17",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0] > 0 { say "selected" }\nexit\n',
  ],
  [
    "applied-18",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample != "" { say "selected" }\nexit\n',
  ],
  [
    "applied-19",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position] != "" { say "selected" }\nexit\n',
  ],
  [
    "applied-20",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0].length > 0 { say "selected" }\nexit\n',
  ],
  ["applied-21", 'let count = 8\nsay "Count: ${count + 3}"\nexit\n'],
  [
    "applied-22",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0].title}"\nexit\n',
  ],
  [
    "applied-23",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample.values.join()}"\nexit\n',
  ],
  [
    "applied-24",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position].values.join()}"\nexit\n',
  ],
  [
    "applied-25",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0].toList().join()}"\nexit\n',
  ],
  [
    "applied-26",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = "${rack[0]}"\nsay caption\nexit\n',
  ],
  [
    "applied-27",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels["${sample}"]\nexit\n',
  ],
  [
    "applied-28",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels["${rack[position]}"]\nexit\n',
  ],
  [
    "applied-29",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay toString(rack[0]).length\nexit\n',
  ],
  [
    "applied-30",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample / 1 second\nexit\n',
  ],
  [
    "applied-31",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position] / 1 second\nexit\n',
  ],
  [
    "applied-32",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0].toDateTime().year\nexit\n',
  ],
  [
    "applied-33",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (sample.toDateTime() + 2 calendar days).toAbsoluteDateTime()\nexit\n',
  ],
  [
    "applied-34",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (rack[position].toDateTime() + 2 calendar days).toAbsoluteDateTime()\nexit\n',
  ],
  [
    "applied-35",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay (rack[0].toAbsoluteDateTime() + 4 s).toDateTime()\nexit\n',
  ],
  [
    "applied-36",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample > 0 { say "selected" }\nexit\n',
  ],
  [
    "applied-37",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position] > 0 { say "selected" }\nexit\n',
  ],
  [
    "applied-38",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0] != "" { say "selected" }\nexit\n',
  ],
  [
    "applied-39",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample.length > 0 { say "selected" }\nexit\n',
  ],
  [
    "applied-40",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position].length > 0 { say "selected" }\nexit\n',
  ],
  ["applied-41", 'let marks = [8,9]\nsay "Count: ${marks.random}"\nexit\n'],
];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node applied.mjs <root>", "R/astra-m4-s8d-review-r3.md:66"]],
  sources: 41,
  sha256: "f9c8c4f5630db18a53583d4ec68dff4242330fa4b3ef661375d492604151ff0b",
};
