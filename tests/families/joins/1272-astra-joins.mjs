// #1272; Astra review.
export const cases = (() => {
  const joins = {
    literal: 'let result = [false] + ["word"]\nsay result.length',
    copy: 'let original = [false]\nlet copy = original\nlet result = copy + ["word"]\nsay result.length',
    compound: 'let left = [false]\nleft += ["word"]\nsay left.length',
    property: 'let box = {items: [false]}\nbox.items += ["word"]\nsay box.items.length',
    object: 'let box = {items: [false] + ["word"]}\nsay box.items.length',
    "literal-properties": 'let result = [{child:{n:3}}] + [{child:{n:"a"}}]\nsay result.length',
    "named-properties":
      'let left = [{n:3}]\nlet right = [{n:"a"}]\nlet result = left + right\nsay result[0].n + 2',
    "read-recovery": 'let left = [3]\nlet result = left + ["a"]\nsay result[0] + 2',
    "store-recovery": 'let left = [3]\nleft = left + ["a"]\nsay left[0] + 2',
    "later-error":
      'let left = [3]\nlet result = left + ["a"]\nlet check: string = result[0]\nlet wrong: integer = "second"',
    "later-element-store": 'let left = [3]\nlet result = left + ["a"]\nresult[0] = false',
    "nested-recovery": 'let left = [[3]]\nlet result = left + [["a"]]\nsay result[0][0] + 2',
    "two-errors": 'let result = [3] + ["a"] + [false]\nlet wrong: integer = "later"',
    "right-skipped": 'let result = [3] + (["a"] + [false])\nlet wrong: integer = "later"',
    "add-control": 'let left = [3]\nleft.add("a")',
    "union-method-deferred": 'let left = [3]\nlet result = left.union(["a"])\nsay result.length',
    "numeric-control": "let result = [3] + [2.5]\nsay result.length",
    "null-control": "let result = [3] + [null]\nsay result.length",
    "empty-control": "let result = [] + [false] + []\nsay result.length",
    "right-union-control":
      'let right: (integer | string)[] = ["a"]\nlet result = [3] + right\nsay result.length',
    "left-union-control":
      'let left: (integer | string)[] = [3]\nlet result = left + ["a"]\nsay result.length',
    "return-union":
      'function provide: (integer | boolean)[] { return [true] }\nlet result = provide() + ["a"]\nsay result.length',
    "own-compound":
      "let box = {first:{items:[3]}}\nbox.first.items += [2]\nsay box.first.items.length",
  };
  return Object.entries(joins);
})();
export const checks = ["publication"];
