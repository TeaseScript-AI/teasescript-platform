export const cases = [
  [
    "original-1",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nlet converted: duration = box.n\nexit\n',
  ],
  [
    "original-2",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nsay box.text.size\nexit\n',
  ],
  [
    "original-3",
    'let boxes = [{n: 2, items: [1], text: "hi"}, null]\nlet box = boxes[1]\nsay box.items + 2\nexit\n',
  ],
  ["original-4", "let box = {n: 2}\nlet converted: duration = box.n\nexit\n"],
];

export const checks = ["publication"];
