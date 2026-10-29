export const cases = [
  [
    "diff-landing-union",
    'let left = [3]\nlet result: (integer | string)[] = left + ["a"]\nsay result.length\nexit\n',
  ],
  [
    "diff-call-parameters",
    'function merge(a, b) { return a + b }\nlet result = merge([3], ["a"])\nsay result.length\nexit\n',
  ],
  ["diff-known-with-host", 'let result = [3, hostValue] + ["a"] + [4]\nsay result.length\nexit\n'],
  ["diff-right-site", 'let result = [3] + (["a"] + [4])\nsay result[0] + 2\nexit\n'],
  [
    "diff-right-name",
    'let tail = [3]\nlet result = [4] + (tail + ["a"])\nsay result.length\nexit\n',
  ],
  [
    "diff-right-written",
    'let tail: (integer | string)[] = [3]\nlet result = [4] + (tail + ["a"])\nsay result.length\nexit\n',
  ],
  [
    "diff-later-null",
    'let left = [3]\nlet result = left + ["a"] + [null]\nsay result.length\nexit\n',
  ],
  [
    "diff-external-number",
    'let left = [3, hostValue / 2]\nlet result = left + ["a"]\nsay result.length\nexit\n',
  ],
  ["diff-nested-fix", 'let left = [[3]]\nlet result = left + [["a"]]\nsay result.length\nexit\n'],
  ["join-literal", 'let result = [false] + ["word"]\nsay result.length\nexit\n'],
  [
    "join-copy",
    'let original = [false]\nlet copy = original\nlet result = copy + ["word"]\nsay result.length\nexit\n',
  ],
  ["join-compound", 'let left = [false]\nleft += ["word"]\nsay left.length\nexit\n'],
  [
    "join-property",
    'let box = {items: [false]}\nbox.items += ["word"]\nsay box.items.length\nexit\n',
  ],
  ["join-object", 'let box = {items: [false] + ["word"]}\nsay box.items.length\nexit\n'],
  [
    "join-literal-properties",
    'let result = [{child:{n:3}}] + [{child:{n:"a"}}]\nsay result.length\nexit\n',
  ],
  [
    "join-named-properties",
    'let left = [{n:3}]\nlet right = [{n:"a"}]\nlet result = left + right\nsay result[0].n + 2\nexit\n',
  ],
  ["join-read-recovery", 'let left = [3]\nlet result = left + ["a"]\nsay result[0] + 2\nexit\n'],
  ["join-store-recovery", 'let left = [3]\nleft = left + ["a"]\nsay left[0] + 2\nexit\n'],
  [
    "join-later-error",
    'let left = [3]\nlet result = left + ["a"]\nlet check: string = result[0]\nlet wrong: integer = "second"\nexit\n',
  ],
  [
    "join-later-element-store",
    'let left = [3]\nlet result = left + ["a"]\nresult[0] = false\nexit\n',
  ],
  [
    "join-nested-recovery",
    'let left = [[3]]\nlet result = left + [["a"]]\nsay result[0][0] + 2\nexit\n',
  ],
  ["join-two-errors", 'let result = [3] + ["a"] + [false]\nlet wrong: integer = "later"\nexit\n'],
  [
    "join-right-skipped",
    'let result = [3] + (["a"] + [false])\nlet wrong: integer = "later"\nexit\n',
  ],
  ["join-add-control", 'let left = [3]\nleft.add("a")\nexit\n'],
  [
    "join-union-method-deferred",
    'let left = [3]\nlet result = left.union(["a"])\nsay result.length\nexit\n',
  ],
  ["join-numeric-control", "let result = [3] + [2.5]\nsay result.length\nexit\n"],
  ["join-null-control", "let result = [3] + [null]\nsay result.length\nexit\n"],
  ["join-empty-control", "let result = [] + [false] + []\nsay result.length\nexit\n"],
  [
    "join-right-union-control",
    'let right: (integer | string)[] = ["a"]\nlet result = [3] + right\nsay result.length\nexit\n',
  ],
  [
    "join-left-union-control",
    'let left: (integer | string)[] = [3]\nlet result = left + ["a"]\nsay result.length\nexit\n',
  ],
  [
    "join-return-union",
    'function provide: (integer | boolean)[] { return [true] }\nlet result = provide() + ["a"]\nsay result.length\nexit\n',
  ],
  [
    "join-own-compound",
    "let box = {first:{items:[3]}}\nbox.first.items += [2]\nsay box.first.items.length\nexit\n",
  ],
  [
    'matrix-first-direct-"bad"',
    'let box = {first:{n:1}}\nsay "BEFORE"\nbox.first.n = "bad"\nsay box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-first-direct-hostValue",
    'let box = {first:{n:1}}\nsay "BEFORE"\nbox.first.n = hostValue\nsay box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-first-copied-"bad"',
    'let seed = {first:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.first.n = "bad"\nsay box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-first-copied-hostValue",
    'let seed = {first:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.first.n = hostValue\nsay box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-first-projected-"bad"',
    'let wrapper = {box:{first:{n:1}}}\nsay "BEFORE"\nwrapper.box.first.n = "bad"\nsay wrapper.box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-first-projected-hostValue",
    'let wrapper = {box:{first:{n:1}}}\nsay "BEFORE"\nwrapper.box.first.n = hostValue\nsay wrapper.box.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-first-indexed-"bad"',
    'let boxes = [{first:{n:1}}]\nsay "BEFORE"\nboxes[0].first.n = "bad"\nsay boxes[0].first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-first-indexed-hostValue",
    'let boxes = [{first:{n:1}}]\nsay "BEFORE"\nboxes[0].first.n = hostValue\nsay boxes[0].first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-three-"bad"',
    'let box = {first:{first:{first:{n:1}}}}\nsay "BEFORE"\nbox.first.first.first.n = "bad"\nsay box.first.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-three-hostValue",
    'let box = {first:{first:{first:{n:1}}}}\nsay "BEFORE"\nbox.first.first.first.n = hostValue\nsay box.first.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-alternate-"bad"',
    'let box = {first:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.first.ordinary.last.random.n = "bad"\nsay box.first.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-alternate-hostValue",
    'let box = {first:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.first.ordinary.last.random.n = hostValue\nsay box.first.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-list-"bad"',
    'let box = {first:[{first:{n:1}}]}\nsay "BEFORE"\nbox.first.first.first.n = "bad"\nsay box.first.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-list-hostValue",
    'let box = {first:[{first:{n:1}}]}\nsay "BEFORE"\nbox.first.first.first.n = hostValue\nsay box.first.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-indexed-"bad"',
    'let boxes = [{first:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].first.last.n = "bad"\nsay boxes[0].first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-indexed-hostValue",
    'let boxes = [{first:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].first.last.n = hostValue\nsay boxes[0].first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-copied-"bad"',
    'let seed = {first:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.first.last.n = "bad"\nsay box.first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-copied-hostValue",
    'let seed = {first:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.first.last.n = hostValue\nsay box.first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-first-projected-copy-"bad"',
    'let seed = {container:{first:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.first.last.n = "bad"\nsay box.first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-first-projected-copy-hostValue",
    'let seed = {container:{first:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.first.last.n = hostValue\nsay box.first.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "final-first",
    'let box = {first:1}\nsay "BEFORE"\nbox.first = hostValue\nsay box.first\nsay "AFTER"\nexit\n',
  ],
  [
    "list-first",
    'let boxes = [{n:1}]\nsay "BEFORE"\nboxes.first.n = hostValue\nsay boxes[0].n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-last-direct-"bad"',
    'let box = {last:{n:1}}\nsay "BEFORE"\nbox.last.n = "bad"\nsay box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-last-direct-hostValue",
    'let box = {last:{n:1}}\nsay "BEFORE"\nbox.last.n = hostValue\nsay box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-last-copied-"bad"',
    'let seed = {last:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.last.n = "bad"\nsay box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-last-copied-hostValue",
    'let seed = {last:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.last.n = hostValue\nsay box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-last-projected-"bad"',
    'let wrapper = {box:{last:{n:1}}}\nsay "BEFORE"\nwrapper.box.last.n = "bad"\nsay wrapper.box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-last-projected-hostValue",
    'let wrapper = {box:{last:{n:1}}}\nsay "BEFORE"\nwrapper.box.last.n = hostValue\nsay wrapper.box.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-last-indexed-"bad"',
    'let boxes = [{last:{n:1}}]\nsay "BEFORE"\nboxes[0].last.n = "bad"\nsay boxes[0].last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-last-indexed-hostValue",
    'let boxes = [{last:{n:1}}]\nsay "BEFORE"\nboxes[0].last.n = hostValue\nsay boxes[0].last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-three-"bad"',
    'let box = {last:{last:{last:{n:1}}}}\nsay "BEFORE"\nbox.last.last.last.n = "bad"\nsay box.last.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-three-hostValue",
    'let box = {last:{last:{last:{n:1}}}}\nsay "BEFORE"\nbox.last.last.last.n = hostValue\nsay box.last.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-alternate-"bad"',
    'let box = {last:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.last.ordinary.last.random.n = "bad"\nsay box.last.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-alternate-hostValue",
    'let box = {last:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.last.ordinary.last.random.n = hostValue\nsay box.last.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-list-"bad"',
    'let box = {last:[{first:{n:1}}]}\nsay "BEFORE"\nbox.last.first.first.n = "bad"\nsay box.last.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-list-hostValue",
    'let box = {last:[{first:{n:1}}]}\nsay "BEFORE"\nbox.last.first.first.n = hostValue\nsay box.last.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-indexed-"bad"',
    'let boxes = [{last:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].last.last.n = "bad"\nsay boxes[0].last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-indexed-hostValue",
    'let boxes = [{last:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].last.last.n = hostValue\nsay boxes[0].last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-copied-"bad"',
    'let seed = {last:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.last.last.n = "bad"\nsay box.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-copied-hostValue",
    'let seed = {last:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.last.last.n = hostValue\nsay box.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-last-projected-copy-"bad"',
    'let seed = {container:{last:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.last.last.n = "bad"\nsay box.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-last-projected-copy-hostValue",
    'let seed = {container:{last:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.last.last.n = hostValue\nsay box.last.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "final-last",
    'let box = {last:1}\nsay "BEFORE"\nbox.last = hostValue\nsay box.last\nsay "AFTER"\nexit\n',
  ],
  [
    "list-last",
    'let boxes = [{n:1}]\nsay "BEFORE"\nboxes.last.n = hostValue\nsay boxes[0].n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-random-direct-"bad"',
    'let box = {random:{n:1}}\nsay "BEFORE"\nbox.random.n = "bad"\nsay box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-random-direct-hostValue",
    'let box = {random:{n:1}}\nsay "BEFORE"\nbox.random.n = hostValue\nsay box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-random-copied-"bad"',
    'let seed = {random:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.random.n = "bad"\nsay box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-random-copied-hostValue",
    'let seed = {random:{n:1}}\nlet box = seed\nsay "BEFORE"\nbox.random.n = hostValue\nsay box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-random-projected-"bad"',
    'let wrapper = {box:{random:{n:1}}}\nsay "BEFORE"\nwrapper.box.random.n = "bad"\nsay wrapper.box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-random-projected-hostValue",
    'let wrapper = {box:{random:{n:1}}}\nsay "BEFORE"\nwrapper.box.random.n = hostValue\nsay wrapper.box.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'matrix-random-indexed-"bad"',
    'let boxes = [{random:{n:1}}]\nsay "BEFORE"\nboxes[0].random.n = "bad"\nsay boxes[0].random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "matrix-random-indexed-hostValue",
    'let boxes = [{random:{n:1}}]\nsay "BEFORE"\nboxes[0].random.n = hostValue\nsay boxes[0].random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-three-"bad"',
    'let box = {random:{random:{random:{n:1}}}}\nsay "BEFORE"\nbox.random.random.random.n = "bad"\nsay box.random.random.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-three-hostValue",
    'let box = {random:{random:{random:{n:1}}}}\nsay "BEFORE"\nbox.random.random.random.n = hostValue\nsay box.random.random.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-alternate-"bad"',
    'let box = {random:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.random.ordinary.last.random.n = "bad"\nsay box.random.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-alternate-hostValue",
    'let box = {random:{ordinary:{last:{random:{n:1}}}}}\nsay "BEFORE"\nbox.random.ordinary.last.random.n = hostValue\nsay box.random.ordinary.last.random.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-list-"bad"',
    'let box = {random:[{first:{n:1}}]}\nsay "BEFORE"\nbox.random.first.first.n = "bad"\nsay box.random.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-list-hostValue",
    'let box = {random:[{first:{n:1}}]}\nsay "BEFORE"\nbox.random.first.first.n = hostValue\nsay box.random.first.first.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-indexed-"bad"',
    'let boxes = [{random:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].random.last.n = "bad"\nsay boxes[0].random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-indexed-hostValue",
    'let boxes = [{random:{last:{n:1}}}]\nsay "BEFORE"\nboxes[0].random.last.n = hostValue\nsay boxes[0].random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-copied-"bad"',
    'let seed = {random:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.random.last.n = "bad"\nsay box.random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-copied-hostValue",
    'let seed = {random:{last:{n:1}}}\nlet box = seed\nsay "BEFORE"\nbox.random.last.n = hostValue\nsay box.random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    'deep-random-projected-copy-"bad"',
    'let seed = {container:{random:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.random.last.n = "bad"\nsay box.random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "deep-random-projected-copy-hostValue",
    'let seed = {container:{random:{last:{n:1}}}}\nlet box = seed.container\nsay "BEFORE"\nbox.random.last.n = hostValue\nsay box.random.last.n\nsay "AFTER"\nexit\n',
  ],
  [
    "final-random",
    'let box = {random:1}\nsay "BEFORE"\nbox.random = hostValue\nsay box.random\nsay "AFTER"\nexit\n',
  ],
  [
    "list-random",
    'let boxes = [{n:1}]\nsay "BEFORE"\nboxes.random.n = hostValue\nsay boxes[0].n\nsay "AFTER"\nexit\n',
  ],
  [
    "receiver-known-before-host",
    'let box = {first:{last:{random:{n:1}}}}\nbox.first.last = hostValue\nbox.first.last.random.n = "bad"\nexit\n',
  ],
  [
    "receiver-rejected",
    'let box = {first:{last:{random:{n:1}}}}\nbox.first.last = []\nbox.first.last.random.n = "bad"\nexit\n',
  ],
  [
    "receiver-null-chain",
    'let box = {first:null}\nbox.first = {last:null}\nbox.first.last = {random:null}\nbox.first.last.random = {n:1}\nbox.first.last.random.n = "bad"\nexit\n',
  ],
  [
    "receiver-null-copied",
    'let box = {first:null}\nbox.first = {last:null}\nbox.first.last = {n:1}\nlet copy = box\ncopy.first.last.n = "bad"\nexit\n',
  ],
  [
    "rejected-whole-object",
    'let box = {first:{n:1}}\nbox.first = [1]\nbox.first.n = "bad"\nexit\n',
  ],
  [
    "optional-receiver",
    'let box = {first:{n:1}}\nif hostValue { box = null }\nif box != null { box.first.n = "bad" }\nexit\n',
  ],
  ["advice-0-let", 'let start = [3]\nlet result = start + ["a"]\nsay result.length\nexit\n'],
  [
    "advice-0-default",
    'function mix(start = [3]) { return start + ["a"] }\nsay mix().length\nexit\n',
  ],
  ["advice-1-let", "let start = [true]\nlet result = start + [2.5]\nsay result.length\nexit\n"],
  [
    "advice-1-default",
    "function mix(start = [true]) { return start + [2.5] }\nsay mix().length\nexit\n",
  ],
  ["advice-2-let", 'let start = [1 s]\nlet result = start + ["a"]\nsay result.length\nexit\n'],
  [
    "advice-2-default",
    'function mix(start = [1 s]) { return start + ["a"] }\nsay mix().length\nexit\n',
  ],
  ["advice-3-let", "let start = [45 deg]\nlet result = start + [true]\nsay result.length\nexit\n"],
  [
    "advice-3-default",
    "function mix(start = [45 deg]) { return start + [true] }\nsay mix().length\nexit\n",
  ],
  ["advice-4-let", 'let start = [{n:1}]\nlet result = start + ["a"]\nsay result.length\nexit\n'],
  [
    "advice-4-default",
    'function mix(start = [{n:1}]) { return start + ["a"] }\nsay mix().length\nexit\n',
  ],
  [
    "advice-5-let",
    'let start = [[3], null]\nlet result = start + [["a"]]\nsay result.length\nexit\n',
  ],
  [
    "advice-5-default",
    'function mix(start = [[3], null]) { return start + [["a"]] }\nsay mix().length\nexit\n',
  ],
  [
    "advice-6-let",
    'let start = [[[3]], [null], null]\nlet result = start + [[["a"]]]\nsay result.length\nexit\n',
  ],
  [
    "advice-6-default",
    'function mix(start = [[[3]], [null], null]) { return start + [[["a"]]] }\nsay mix().length\nexit\n',
  ],
  [
    "advice-7-let",
    'let start = [3, hostValue / 2]\nlet result = start + ["a"]\nsay result.length\nexit\n',
  ],
  [
    "advice-7-default",
    'function mix(start = [3, hostValue / 2]) { return start + ["a"] }\nsay mix().length\nexit\n',
  ],
  [
    "advice-8-let",
    'let start = [[3, hostValue / 2]]\nlet result = start + [["a"]]\nsay result.length\nexit\n',
  ],
  [
    "advice-8-default",
    'function mix(start = [[3, hostValue / 2]]) { return start + [["a"]] }\nsay mix().length\nexit\n',
  ],
  [
    "advice-nullable",
    'let start: integer?[] = [3]\nlet result = start + ["a"]\nstart.add(null)\nsay result.length\nexit\n',
  ],
  [
    "advice-union",
    'let start: (integer | boolean)[] = [3]\nlet result = start + ["a"]\nstart.add(false)\nsay result.length\nexit\n',
  ],
  [
    "advice-later-number",
    'let start = [3]\nlet result = start + ["a"]\nstart.add(2.5)\nsay result.length\nexit\n',
  ],
  [
    "advice-later-null",
    'let start = [3]\nlet result = start + ["a"]\nstart.add(null)\nsay result.length\nexit\n',
  ],
  [
    "advice-destination-null",
    'let start = [3]\nlet result = start + ["a"]\nresult.add(null)\nsay result.length\nexit\n',
  ],
  [
    "advice-destination-number",
    'let start = [3]\nlet result = start + ["a"]\nresult.add(2.5)\nsay result.length\nexit\n',
  ],
];

export const checks = ["publication"];
