export const cases = [
  [
    "undefined@7",
    'let n = 1\nlet a = {f0: {leaf: 1}, f1: {leaf: 1}, f2: {leaf: 1}, f3: {leaf: 1}, f4: {leaf: 1}, f5: {leaf: 1}, f6: {leaf: 1}}\nlet b = {f0: {leaf: 2.5}, f1: {leaf: 1}, f2: {leaf: 1}, f3: {leaf: 2.5}, f4: {leaf: 1}, f5: {leaf: 1}, f6: {leaf: 2.5}}\nlet options = [{text: "0", value: b}, {text: "1", value: a}, {text: "2", value: b}, {text: "3", value: a}, {text: "4", value: b}, {text: "5", value: a}, {text: "6", value: b}]\nlet picked = askChoice options\nrepeat picked.f0.leaf {}\nrepeat picked.f1.leaf {}\nrepeat picked.f2.leaf {}\nrepeat picked.f3.leaf {}\nrepeat picked.f4.leaf {}\nrepeat picked.f5.leaf {}\nrepeat picked.f6.leaf {}\nexit',
  ],
  [
    "undefined@14",
    'let n = 1\nlet a = {f0: {leaf: 1}, f1: {leaf: 1}, f2: {leaf: 1}, f3: {leaf: 1}, f4: {leaf: 1}, f5: {leaf: 1}, f6: {leaf: 1}, f7: {leaf: 1}, f8: {leaf: 1}, f9: {leaf: 1}, f10: {leaf: 1}, f11: {leaf: 1}, f12: {leaf: 1}, f13: {leaf: 1}}\nlet b = {f0: {leaf: 2.5}, f1: {leaf: 1}, f2: {leaf: 1}, f3: {leaf: 2.5}, f4: {leaf: 1}, f5: {leaf: 1}, f6: {leaf: 2.5}, f7: {leaf: 1}, f8: {leaf: 1}, f9: {leaf: 2.5}, f10: {leaf: 1}, f11: {leaf: 1}, f12: {leaf: 2.5}, f13: {leaf: 1}}\nlet options = [{text: "0", value: b}, {text: "1", value: a}, {text: "2", value: b}, {text: "3", value: a}, {text: "4", value: b}, {text: "5", value: a}, {text: "6", value: b}, {text: "7", value: a}, {text: "8", value: b}, {text: "9", value: a}, {text: "10", value: b}, {text: "11", value: a}, {text: "12", value: b}, {text: "13", value: a}]\nlet picked = askChoice options\nrepeat picked.f0.leaf {}\nrepeat picked.f1.leaf {}\nrepeat picked.f2.leaf {}\nrepeat picked.f3.leaf {}\nrepeat picked.f4.leaf {}\nrepeat picked.f5.leaf {}\nrepeat picked.f6.leaf {}\nrepeat picked.f7.leaf {}\nrepeat picked.f8.leaf {}\nrepeat picked.f9.leaf {}\nrepeat picked.f10.leaf {}\nrepeat picked.f11.leaf {}\nrepeat picked.f12.leaf {}\nrepeat picked.f13.leaf {}\nexit',
  ],
];

export const checks = ["publication"];
