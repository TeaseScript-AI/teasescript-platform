export const cases = [
  [
    "definition-reproduction",
    'let p = {f: 1}\np = {f: 2}\np = {f: 3}\np = {f: 4}\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit\n',
  ],
];

export const checks = ["publication"];
