/*
 * S6-CARRIERS §6's carrier witnesses, each a name, its program before its final `exit` and its exact record: the cells
 * test compares them in both orders, the sharing differential runs them (the cells test's comment lists what each is).
 */
export const CARRIER_WITNESSES: readonly (readonly [string, string, string])[] = (() => {
  const nested = "let raw = hostValue\nlet root = {nested: {f0: [1, raw][1], f1: [1, raw][1]}}\n";
  const copies = `
    D written-target warning 49:52 unknown
    D written-target warning 66:69 unknown
    C copy-type root.nested.f0 [integer] 49:52
    C copy-type root.nested.f1 [integer] 66:69
    B copy-type raw [unknown] 10:19`;
  const conditional = `outcome warning-runtime-check
    D written-target warning 31:75 later
    D written-target warning 66:69 unknown
    D integer-use warning 190:196 unknown
    D integer-use warning 207:213 unknown
    C copy-type root.nested.f0 [integer] 31:75
    C copy-type root.nested.f1 [integer] 66:69
    C integer-check box.f0 [integer] 190:196
    C integer-check box.f1 [integer] 207:213
    B copy-type raw [unknown] 10:19`;
  const use = "function use(r) {\n  let n: integer = r.f\n  return true\n}\n";
  const choices = (call: string): string =>
    `let root = {f: 1}\nfunction bump {\n  root.f = null\n}\nlet a = askChoice {text: "a", value: root.f}\n${call}` +
    'let b = askChoice {text: "b", value: root.f}\nrepeat a {}\nrepeat b {}\n';
  return [
    [
      "the across-function copy",
      "let raw = hostValue\nraw = 1\nlet root = {f: raw}\nlet box = {f: 0}\nbox = root\nfunction copy {\n  box = root\n}\ncopy()\nrepeat box.f {}\n",
      `outcome warning-runtime-check
      D written-target warning 10:19 later
      D written-target warning 100:104 unknown
      D integer-use warning 121:126 unknown
      C copy-type raw [integer] 10:19
      C copy-type box.f [integer] 100:104
      C integer-check box.f [integer] 121:126
      B copy-type raw [integer] 10:19`,
    ],
    [
      "the reversed copy",
      'let raw = hostValue\nraw = 1\nlet root = {f: raw}\nlet box = {f: null}\nfunction copy {\n  box = root\n}\ncopy()\nbox = root\nbox.f = "word"\nrepeat box.f {}\n',
      `outcome compile-error
      D written-target warning 10:19 later
      D written-target warning 92:96 later
      D written-target error 125:131 -
      C copy-type raw [integer] 10:19
      C copy-type box.f [integer] 92:96
      B copy-type raw [integer] 10:19`,
    ],
    [
      "a concatenation's host operand",
      'let out = ([1] + hostValue)[1]\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 17:26 unknown
      D operator warning 17:26 unknown
      C copy-type out [integer] 17:26
      C operand hostValue [list] 17:26
      B copy-type out [integer] 17:26`,
    ],
    [
      "a concatenation's host operand, a later store",
      'let out = ([1] + hostValue)[1]\nout = 1\nsay "AFTER"\n',
      `outcome warning-runtime-check
      D written-target warning 17:26 later
      D operator warning 17:26 unknown
      C copy-type out [integer] 17:26
      C operand hostValue [list] 17:26
      B copy-type out [integer] 17:26`,
    ],
    [
      "an otherwise's host operand",
      'let out = hostValue otherwise 1\nsay "AFTER"\n',
      "outcome valid\nB copy-type out [integer] 10:19",
    ],
    [
      "a choice's host option",
      'let out = askChoice 1, hostValue\nsay "AFTER"\n',
      "outcome valid\nB copy-type out [integer] 23:32",
    ],
    [
      "repeated projected copies",
      `${nested}let box = root.nested\nbox = root.nested\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check${copies}
      D integer-use warning 141:147 unknown
      D integer-use warning 158:164 unknown
      C integer-check box.f0 [integer] 141:147
      C integer-check box.f1 [integer] 158:164`,
    ],
    [
      "once-bound projected copies",
      `${nested}let stable = root.nested\nlet box = stable\nbox = stable\nbox = stable\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check${copies}
      D integer-use warning 151:157 unknown
      D integer-use warning 168:174 unknown
      C integer-check box.f0 [integer] 151:157
      C integer-check box.f1 [integer] 168:174`,
    ],
    [
      "projected copies around a store below them",
      `${nested}let box = root.nested\nbox = root.nested\nroot.nested.f0 = 1\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      `outcome warning-runtime-check
      D written-target warning 31:75 later
      D written-target warning 66:69 unknown
      D written-target warning 86:97 later
      D written-target warning 104:115 later
      D integer-use warning 177:183 unknown
      C copy-type root.nested.f0 [integer] 31:75
      C copy-type root.nested.f1 [integer] 66:69
      C copy-type box.f0 [integer] 86:97
      C copy-type box.f0 [integer] 104:115
      C integer-check box.f1 [integer] 177:183
      B copy-type raw [unknown] 10:19`,
    ],
    [
      "M1, the conditional store before the copies",
      `${nested}let box = {f0: null, f1: null}\nif raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      conditional,
    ],
    [
      "M1, the conditional store between the copies",
      `${nested}let box = {f0: null, f1: null}\nbox = root.nested\nif raw != null {\n  root.nested.f0 = 1\n}\nbox = root.nested\nrepeat box.f0 {}\nrepeat box.f1 {}\n`,
      conditional,
    ],
    [
      "F3, two choice reads around an effectful call",
      choices("bump()\n"),
      "outcome warning-runtime-check\nD integer-use warning 168:169 call\nC null-check b [integer] 168:169",
    ],
    ["F3, two choice reads, no call between", choices(""), "outcome valid"],
    [
      "F3, an argument under its operand's guard",
      `let root = {f: 2.5}\n${use}if root != null and use(root) {\n  say "yes"\n}\n`,
      "outcome warning-runtime-check\nD written-target warning 57:60 branch\nC copy-type n [integer] 57:60",
    ],
    [
      "F3, an argument under no guard",
      `let root = {f: 2.5}\n${use}if use(root) {\n  say "yes"\n}\n`,
      "outcome compile-error\nD written-target error 57:60 -",
    ],
    [
      "a named key read before and after a call storing to it, in one literal (TABLE r4.68 (1))",
      "global root = 1\nfunction bump {\n  root = 2.0\n  return 0\n}\nlet box = [root, bump(), root]\nrepeat box[2] {}\n",
      `outcome warning-runtime-check
      D integer-use warning 96:102 call
      C integer-check box.element [integer] 96:102`,
    ],
    [
      "a read after a call registering a handler that stores the key, in one literal (Codex r25 F1)",
      'let n = 1\nfunction register {\n  showPermanentButton "Change" { n = 1.5 }\n  return 0\n}\nlet xs = [n, register(), n]\nrepeat xs[2] {}\n',
      `outcome warning-runtime-check
      D integer-use warning 121:126 member
      C integer-check xs.element [integer] 121:126`,
    ],
    [
      "both reads after the registration (Codex r25 F1's control)",
      'let n = 1\nfunction register {\n  showPermanentButton "Change" { n = 1.5 }\n  return 0\n}\nregister()\nlet xs = [n, 0, n]\nrepeat xs[2] {}\n',
      `outcome warning-runtime-check
      D integer-use warning 123:128 member
      C integer-check xs.element [integer] 123:128`,
    ],
  ];
})();
