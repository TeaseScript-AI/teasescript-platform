// #1241's review r2 (Astra): its own member, conversion and list cases and the forms it pasted into them, in the
// whole run and the `ONLY=key-` correction (R/astra-m4-i1241-review-r2/own.mjs, the forms as `own.json` and
// `keys.json` record them). r1's originals it read are r1's. A form with a compile error was only compiled, without
// globals.
export const cases = [
  ["18-own-historical-6", 'let bag = ["one"]\nbag.clear()\nsay bag.join()\nexit\n'],
  ["18-own-historical-9", "let bag = [1, 1.5]\nsay bag.join()\nexit\n"],
  ["18-own-historical-11", 'let bag = ["a", null]\nsay bag.join()\nexit\n'],
  ["18-own-historical-13", 'let txt = "a"\nsay txt.length\nexit\n'],
  ["18-own-historical-15", 'let txt = "a"\nlet n: integer = txt.length\nexit\n'],
  ["18-own-historical-19", 'let txt = "a"\nsay -(txt.length + 2)\nexit\n'],
  ["18-own-historical-22", 'let txt = "a"\nsay "answer=${txt.length + 2}"\nexit\n'],
  ["18-own-historical-24", 'let txt = "a"\nsay (txt.length + 2) * 3\nexit\n'],
  ["18-own-historical-29", 'let txt = "a"\nrepeat txt.length { say "once" }\nexit\n'],
  ["18-own-historical-34", 'let txt = " a "\nsay txt.trim()\nexit\n'],
  ["18-own-historical-36", 'let txt = " a "\nsay (txt.trim()).length\nexit\n'],
  ["18-own-historical-38", 'let txt = " a "\nsay "${txt.trim()}"\nexit\n'],
  ["18-own-historical-48", "let bag = [2]\nsay bag + ((4..6).toList())\nexit\n"],
  ["18-own-historical-50", "let bag = [2]\nlet xs: integer[] = bag + ((4..6).toList())\nexit\n"],
  ["18-own-historical-54", "let bag = [2]\nsay (bag + ((4..6).toList())).length\nexit\n"],
  ["18-own-historical-56", "let bag = [2]\nsay 1 + (bag + ((4..6).toList())).length\nexit\n"],
  ["18-own-historical-58", "\nlet v: duration = (-2) s\nsay v\nexit\n"],
  ["18-own-historical-60", "\nlet v: angle = (1 + 2) deg\nsay v\nexit\n"],
  ["18-own-historical-62", '\nlet v: date = toDate("2028-03-10")\nsay v\nexit\n'],
  ["18-own-historical-65", '\nlet v: time = toTime("18:30")\nsay v\nexit\n'],
  ["18-own-historical-67", '\nlet v: datetime = toDateTime("2028-03-10T18:30")\nsay v\nexit\n'],
  ["18-own-historical-69", 'let labels = ["a", null]\nsay (labels[1] otherwise "").length\nexit\n'],
  [
    "18-own-historical-71",
    'let labels = ["a", null]\nsay -(labels[1] otherwise "").length\nexit\n',
  ],
  [
    "18-own-historical-78",
    'let labels = ["a", null]\nfunction parseIt(input: string) { say toInteger(input, default: (labels[1] otherwise "").length) }\nparseIt("bad")\nexit\n',
  ],
  [
    "18-own-historical-81",
    'let labels = ["a", null]\nfunction take(p) { say p }\ntake((labels[1] otherwise "").length)\nexit\n',
  ],
  [
    "18-own-historical-83",
    'let labels = ["a", null]\nsay ((labels[1] otherwise "").length is integer)\nexit\n',
  ],
  [
    "18-own-historical-85",
    'let labels = ["a", null]\nlet n = (labels[1] otherwise "").length\nsay n\nexit\n',
  ],
  [
    "18-own-historical-87",
    "let flags = [true, null]\nsay ((flags[1] otherwise false) and true) is boolean\nexit\n",
  ],
  [
    "dict-missing:duration",
    'let d = dict{ok: 2}\nlet converted: duration = d["gone"]\nsay converted\nexit\n',
  ],
  [
    "dict-missing:angle",
    'let d = dict{ok: 2}\nlet converted: angle = d["gone"]\nsay converted\nexit\n',
  ],
  [
    "dict-missing:string",
    'let d = dict{ok: 2}\nlet converted: string = d["gone"]\nsay converted\nexit\n',
  ],
  [
    "dict-missing:object",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = ({n: d["gone"]}).n\nsay converted\nexit\n',
  ],
  [
    "dict-missing:list",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [d["gone"], 1].length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:set",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = set[d["gone"], 1].length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:dict-key",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = dict{["${d["gone"]}"]: 1}.length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:interpolation",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = "${d["gone"]}${1}".length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:ask-prompt",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("${d["gone"]}")\nsay converted\nexit\n',
  ],
  [
    "dict-missing:ask-prefill",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("Count", prefill: d["gone"])\nsay converted\nexit\n',
  ],
  [
    "dict-missing:say",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [say("${d["gone"]}", instant)].length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:button",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [(showButton "${d["gone"]}")].length\nsay converted\nexit\n',
  ],
  [
    "dict-missing:call",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = identity(d["gone"])\nsay converted\nexit\n',
  ],
  [
    "dict-present:duration",
    'let d = dict{ok: 2}\nlet converted: duration = d["ok"]\nsay converted\nexit\n',
  ],
  [
    "dict-present:angle",
    'let d = dict{ok: 2}\nlet converted: angle = d["ok"]\nsay converted\nexit\n',
  ],
  [
    "dict-present:string",
    'let d = dict{ok: 2}\nlet converted: string = d["ok"]\nsay converted\nexit\n',
  ],
  [
    "dict-present:object",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = ({n: d["ok"]}).n\nsay converted\nexit\n',
  ],
  [
    "dict-present:list",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [d["ok"], 1].length\nsay converted\nexit\n',
  ],
  [
    "dict-present:set",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = set[d["ok"], 1].length\nsay converted\nexit\n',
  ],
  [
    "dict-present:dict-key",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = dict{["${d["ok"]}"]: 1}.length\nsay converted\nexit\n',
  ],
  [
    "dict-present:interpolation",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = "${d["ok"]}${1}".length\nsay converted\nexit\n',
  ],
  [
    "dict-present:ask-prompt",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("${d["ok"]}")\nsay converted\nexit\n',
  ],
  [
    "dict-present:ask-prefill",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("Count", prefill: d["ok"])\nsay converted\nexit\n',
  ],
  [
    "dict-present:say",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [say("${d["ok"]}", instant)].length\nsay converted\nexit\n',
  ],
  [
    "dict-present:button",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = [(showButton "${d["ok"]}")].length\nsay converted\nexit\n',
  ],
  [
    "dict-present:call",
    'let d = dict{ok: 2}\nfunction identity(v: integer) { return v }\nlet converted: duration = identity(d["ok"])\nsay converted\nexit\n',
  ],
  [
    "index-missing:duration",
    "let ns = [2]\nlet converted: duration = ns[5]\nsay converted\nexit\n",
  ],
  ["index-missing:angle", "let ns = [2]\nlet converted: angle = ns[5]\nsay converted\nexit\n"],
  ["index-missing:string", "let ns = [2]\nlet converted: string = ns[5]\nsay converted\nexit\n"],
  [
    "index-missing:object",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = ({n: ns[5]}).n\nsay converted\nexit\n",
  ],
  [
    "index-missing:list",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [ns[5], 1].length\nsay converted\nexit\n",
  ],
  [
    "index-missing:set",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = set[ns[5], 1].length\nsay converted\nexit\n",
  ],
  [
    "index-missing:dict-key",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = dict{["${ns[5]}"]: 1}.length\nsay converted\nexit\n',
  ],
  [
    "index-missing:interpolation",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = "${ns[5]}${1}".length\nsay converted\nexit\n',
  ],
  [
    "index-missing:ask-prompt",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("${ns[5]}")\nsay converted\nexit\n',
  ],
  [
    "index-missing:ask-prefill",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("Count", prefill: ns[5])\nsay converted\nexit\n',
  ],
  [
    "index-missing:say",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [say("${ns[5]}", instant)].length\nsay converted\nexit\n',
  ],
  [
    "index-missing:button",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [(showButton "${ns[5]}")].length\nsay converted\nexit\n',
  ],
  [
    "index-missing:call",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = identity(ns[5])\nsay converted\nexit\n",
  ],
  [
    "index-present:duration",
    "let ns = [2]\nlet converted: duration = ns[0]\nsay converted\nexit\n",
  ],
  ["index-present:angle", "let ns = [2]\nlet converted: angle = ns[0]\nsay converted\nexit\n"],
  ["index-present:string", "let ns = [2]\nlet converted: string = ns[0]\nsay converted\nexit\n"],
  [
    "index-present:object",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = ({n: ns[0]}).n\nsay converted\nexit\n",
  ],
  [
    "index-present:list",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [ns[0], 1].length\nsay converted\nexit\n",
  ],
  [
    "index-present:set",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = set[ns[0], 1].length\nsay converted\nexit\n",
  ],
  [
    "index-present:dict-key",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = dict{["${ns[0]}"]: 1}.length\nsay converted\nexit\n',
  ],
  [
    "index-present:interpolation",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = "${ns[0]}${1}".length\nsay converted\nexit\n',
  ],
  [
    "index-present:ask-prompt",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("${ns[0]}")\nsay converted\nexit\n',
  ],
  [
    "index-present:ask-prefill",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = askInteger("Count", prefill: ns[0])\nsay converted\nexit\n',
  ],
  [
    "index-present:say",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [say("${ns[0]}", instant)].length\nsay converted\nexit\n',
  ],
  [
    "index-present:button",
    'let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = [(showButton "${ns[0]}")].length\nsay converted\nexit\n',
  ],
  [
    "index-present:call",
    "let ns = [2]\nfunction identity(v: integer) { return v }\nlet converted: duration = identity(ns[0])\nsay converted\nexit\n",
  ],
  ['dict-missing:ds["gone"] + 2say @', 'let ds = dict{ok: [1]}\nsay ds["gone"] + 2\nexit\n'],
  [
    'dict-missing:ds["gone"] + 2let val = @\nsay val',
    'let ds = dict{ok: [1]}\nlet val = ds["gone"] + 2\nsay val\nexit\n',
  ],
  ['dict-missing:2 + ds["gone"]say @', 'let ds = dict{ok: [1]}\nsay 2 + ds["gone"]\nexit\n'],
  [
    'dict-missing:2 + ds["gone"]let val = @\nsay val',
    'let ds = dict{ok: [1]}\nlet val = 2 + ds["gone"]\nsay val\nexit\n',
  ],
  ['dict-present:ds["ok"] + 2say @', 'let ds = dict{ok: [1]}\nsay ds["ok"] + 2\nexit\n'],
  [
    'dict-present:ds["ok"] + 2let val = @\nsay val',
    'let ds = dict{ok: [1]}\nlet val = ds["ok"] + 2\nsay val\nexit\n',
  ],
  ['dict-present:2 + ds["ok"]say @', 'let ds = dict{ok: [1]}\nsay 2 + ds["ok"]\nexit\n'],
  [
    'dict-present:2 + ds["ok"]let val = @\nsay val',
    'let ds = dict{ok: [1]}\nlet val = 2 + ds["ok"]\nsay val\nexit\n',
  ],
  ["index-missing:lists[7] + 2say @", "let lists = [[1]]\nsay lists[7] + 2\nexit\n"],
  [
    "index-missing:lists[7] + 2let val = @\nsay val",
    "let lists = [[1]]\nlet val = lists[7] + 2\nsay val\nexit\n",
  ],
  ["index-missing:2 + lists[7]say @", "let lists = [[1]]\nsay 2 + lists[7]\nexit\n"],
  [
    "index-missing:2 + lists[7]let val = @\nsay val",
    "let lists = [[1]]\nlet val = 2 + lists[7]\nsay val\nexit\n",
  ],
  ["index-present:lists[0] + 2say @", "let lists = [[1]]\nsay lists[0] + 2\nexit\n"],
  [
    "index-present:lists[0] + 2let val = @\nsay val",
    "let lists = [[1]]\nlet val = lists[0] + 2\nsay val\nexit\n",
  ],
  ["index-present:2 + lists[0]say @", "let lists = [[1]]\nsay 2 + lists[0]\nexit\n"],
  [
    "index-present:2 + lists[0]let val = @\nsay val",
    "let lists = [[1]]\nlet val = 2 + lists[0]\nsay val\nexit\n",
  ],
  ["dict-missing:size", 'let d = dict{ok: "hi"}\nsay d["gone"].size\nexit\n'],
  ["dict-missing:trim", 'let d = dict{ok: "hi"}\nsay d["gone"].trim\nexit\n'],
  ["dict-missing:length()", 'let d = dict{ok: "hi"}\nsay d["gone"].length()\nexit\n'],
  ["dict-present:size", 'let d = dict{ok: "hi"}\nsay d["ok"].size\nexit\n'],
  ["dict-present:trim", 'let d = dict{ok: "hi"}\nsay d["ok"].trim\nexit\n'],
  ["dict-present:length()", 'let d = dict{ok: "hi"}\nsay d["ok"].length()\nexit\n'],
  ["index-missing:size", 'let labels = ["hi"]\nsay labels[5].size\nexit\n'],
  ["index-missing:trim", 'let labels = ["hi"]\nsay labels[5].trim\nexit\n'],
  ["index-missing:length()", 'let labels = ["hi"]\nsay labels[5].length()\nexit\n'],
  ["index-present:size", 'let labels = ["hi"]\nsay labels[0].size\nexit\n'],
  ["index-present:trim", 'let labels = ["hi"]\nsay labels[0].trim\nexit\n'],
  ["index-present:length()", 'let labels = ["hi"]\nsay labels[0].length()\nexit\n'],
  ["index-null:repeat @ {}", "let ns: integer?[] = [2, null]\nrepeat ns[1] {}\nexit\n"],
  ["18-own-historical-184", "let ns: integer?[] = [2, null]\nrepeat ns[1] otherwise 0 {}\nexit\n"],
  ["index-null:say @ + 1", "let ns: integer?[] = [2, null]\nsay ns[1] + 1\nexit\n"],
  ["18-own-historical-186", "let ns: integer?[] = [2, null]\nsay (ns[1] otherwise 0) + 1\nexit\n"],
  [
    "index-null:let val: integer = @\nsay val",
    "let ns: integer?[] = [2, null]\nlet val: integer = ns[1]\nsay val\nexit\n",
  ],
  [
    "18-own-historical-188",
    "let ns: integer?[] = [2, null]\nlet val: integer = ns[1] otherwise 0\nsay val\nexit\n",
  ],
  [
    'index-null:let shown = say("${@ + 1}", instant)',
    'let ns: integer?[] = [2, null]\nlet shown = say("${ns[1] + 1}", instant)\nexit\n',
  ],
  [
    "18-own-historical-190",
    'let ns: integer?[] = [2, null]\nlet shown = say("${(ns[1] otherwise 0) + 1}", instant)\nexit\n',
  ],
  [
    'index-null:let response = askInteger("${@ + 1}")',
    'let ns: integer?[] = [2, null]\nlet response = askInteger("${ns[1] + 1}")\nexit\n',
  ],
  [
    "18-own-historical-192",
    'let ns: integer?[] = [2, null]\nlet response = askInteger("${(ns[1] otherwise 0) + 1}")\nexit\n',
  ],
  [
    'index-null:let pressed = showButton "${@ + 1}"',
    'let ns: integer?[] = [2, null]\nlet pressed = showButton "${ns[1] + 1}"\nexit\n',
  ],
  [
    "18-own-historical-194",
    'let ns: integer?[] = [2, null]\nlet pressed = showButton "${(ns[1] otherwise 0) + 1}"\nexit\n',
  ],
  [
    "index-null:function outer(v: integer) { say v }\nouter(@)",
    "let ns: integer?[] = [2, null]\nfunction outer(v: integer) { say v }\nouter(ns[1])\nexit\n",
  ],
  [
    "18-own-historical-196",
    "let ns: integer?[] = [2, null]\nfunction outer(v: integer) { say v }\nouter(ns[1] otherwise 0)\nexit\n",
  ],
  ["key-null:repeat @ {}", 'let ns: integer? dict = dict{ok: null}\nrepeat ns["ok"] {}\nexit\n'],
  ["key-null:say @ + 1", 'let ns: integer? dict = dict{ok: null}\nsay ns["ok"] + 1\nexit\n'],
  [
    "key-null:let val: integer = @\nsay val",
    'let ns: integer? dict = dict{ok: null}\nlet val: integer = ns["ok"]\nsay val\nexit\n',
  ],
  [
    'key-null:let shown = say("${@ + 1}", instant)',
    'let ns: integer? dict = dict{ok: null}\nlet shown = say("${ns["ok"] + 1}", instant)\nexit\n',
  ],
  [
    'key-null:let response = askInteger("${@ + 1}")',
    'let ns: integer? dict = dict{ok: null}\nlet response = askInteger("${ns["ok"] + 1}")\nexit\n',
  ],
  [
    'key-null:let pressed = showButton "${@ + 1}"',
    'let ns: integer? dict = dict{ok: null}\nlet pressed = showButton "${ns["ok"] + 1}"\nexit\n',
  ],
  [
    "key-null:function outer(v: integer) { say v }\nouter(@)",
    'let ns: integer? dict = dict{ok: null}\nfunction outer(v: integer) { say v }\nouter(ns["ok"])\nexit\n',
  ],
  ["index-absent:repeat @ {}", "let ns: integer?[] = [2, null]\nrepeat ns[9] {}\nexit\n"],
  [
    "18-own-historical-205",
    "let ns: integer?[] = [2, null]\nrepeat ns[9] otherwise 0 {}\nexit\n",
    [],
  ],
  ["index-absent:say @ + 1", "let ns: integer?[] = [2, null]\nsay ns[9] + 1\nexit\n"],
  [
    "18-own-historical-207",
    "let ns: integer?[] = [2, null]\nsay (ns[9] otherwise 0) + 1\nexit\n",
    [],
  ],
  [
    "index-absent:let val: integer = @\nsay val",
    "let ns: integer?[] = [2, null]\nlet val: integer = ns[9]\nsay val\nexit\n",
  ],
  [
    "18-own-historical-209",
    "let ns: integer?[] = [2, null]\nlet val: integer = ns[9] otherwise 0\nsay val\nexit\n",
    [],
  ],
  [
    'index-absent:let shown = say("${@ + 1}", instant)',
    'let ns: integer?[] = [2, null]\nlet shown = say("${ns[9] + 1}", instant)\nexit\n',
  ],
  [
    "18-own-historical-211",
    'let ns: integer?[] = [2, null]\nlet shown = say("${(ns[9] otherwise 0) + 1}", instant)\nexit\n',
    [],
  ],
  [
    'index-absent:let response = askInteger("${@ + 1}")',
    'let ns: integer?[] = [2, null]\nlet response = askInteger("${ns[9] + 1}")\nexit\n',
  ],
  [
    "18-own-historical-213",
    'let ns: integer?[] = [2, null]\nlet response = askInteger("${(ns[9] otherwise 0) + 1}")\nexit\n',
    [],
  ],
  [
    'index-absent:let pressed = showButton "${@ + 1}"',
    'let ns: integer?[] = [2, null]\nlet pressed = showButton "${ns[9] + 1}"\nexit\n',
  ],
  [
    "18-own-historical-215",
    'let ns: integer?[] = [2, null]\nlet pressed = showButton "${(ns[9] otherwise 0) + 1}"\nexit\n',
    [],
  ],
  [
    "index-absent:function outer(v: integer) { say v }\nouter(@)",
    "let ns: integer?[] = [2, null]\nfunction outer(v: integer) { say v }\nouter(ns[9])\nexit\n",
  ],
  [
    "18-own-historical-217",
    "let ns: integer?[] = [2, null]\nfunction outer(v: integer) { say v }\nouter(ns[9] otherwise 0)\nexit\n",
    [],
  ],
  [
    "key-absent:repeat @ {}",
    'let ns: integer? dict = dict{ok: null}\nrepeat ns["gone"] {}\nexit\n',
  ],
  ["key-absent:say @ + 1", 'let ns: integer? dict = dict{ok: null}\nsay ns["gone"] + 1\nexit\n'],
  [
    "key-absent:let val: integer = @\nsay val",
    'let ns: integer? dict = dict{ok: null}\nlet val: integer = ns["gone"]\nsay val\nexit\n',
  ],
  [
    'key-absent:let shown = say("${@ + 1}", instant)',
    'let ns: integer? dict = dict{ok: null}\nlet shown = say("${ns["gone"] + 1}", instant)\nexit\n',
  ],
  [
    'key-absent:let response = askInteger("${@ + 1}")',
    'let ns: integer? dict = dict{ok: null}\nlet response = askInteger("${ns["gone"] + 1}")\nexit\n',
  ],
  [
    'key-absent:let pressed = showButton "${@ + 1}"',
    'let ns: integer? dict = dict{ok: null}\nlet pressed = showButton "${ns["gone"] + 1}"\nexit\n',
  ],
  [
    "key-absent:function outer(v: integer) { say v }\nouter(@)",
    'let ns: integer? dict = dict{ok: null}\nfunction outer(v: integer) { say v }\nouter(ns["gone"])\nexit\n',
  ],
  [
    "null-property",
    "let boxes = [{n: 2}, null]\nlet box = boxes[1]\nlet converted: duration = box.n\nsay converted\nexit\n",
  ],
  [
    "18-own-historical-226",
    "let boxes = [{n: 2}, null]\nlet box = boxes[1]\nlet converted: duration = box.n s\nsay converted\nexit\n",
    [],
  ],
  [
    "18-own-historical-227",
    "let boxes = [{n: 2}, null]\nlet box = boxes[1]\nlet converted: duration = box otherwise ....n\nsay converted\nexit\n",
    [],
  ],
  [
    "missing-property",
    "let boxes = [{n: 2}, {other: 1}]\nlet box = boxes[1]\nlet converted: duration = box.n\nsay converted\nexit\n",
  ],
  [
    "null-list-property",
    "let bags = [{items: [1]}, null]\nlet bag = bags[1]\nsay bag.items + 2\nexit\n",
  ],
  [
    "18-own-historical-230",
    "let bags = [{items: [1]}, null]\nlet bag = bags[1]\nsay bag otherwise ....items + 2\nexit\n",
    [],
  ],
  [
    "18-own-historical-231",
    "let bags = [{items: [1]}, null]\nlet bag = bags[1]\nsay bag.items + [2]\nexit\n",
    [],
  ],
  [
    "18-own-historical-232",
    "let bags = [{items: [1]}, null]\nlet bag = bags[1]\nbag.items.add(2)\nsay bag.items\nexit\n",
    [],
  ],
  ["empty-last-list", "let bags = [[1]]\nbags.clear()\nsay bags.last + 2\nexit\n"],
  ["plain-number", "let n = 2\nlet converted: duration = n\nsay converted\nexit\n"],
  ["18-own-historical-235", "let n = 2\nlet converted: duration = n s\nsay converted\nexit\n"],
  ["plain-member", 'let t = "hi"\nsay t.size\nexit\n'],
  ["18-own-historical-237", 'let t = "hi"\nsay t.length\nexit\n'],
  ["plain-list", "let xs = [1]\nsay xs + 2\nexit\n"],
  ["18-own-historical-239", "let xs = [1]\nsay xs + [2]\nexit\n"],
  ["18-own-historical-240", "let xs = [1]\nxs.add(2)\nsay xs\nexit\n"],
  ["object-member", 'let obj = {text: "hi"}\nsay obj.text.size\nexit\n'],
  ["18-own-historical-242", 'let obj = {text: "hi"}\nsay obj.text.length\nexit\n'],
  ["plain-ask", '\nlet converted: duration = askInteger("Count")\nsay converted\nexit\n'],
  [
    "18-own-historical-244",
    '\nlet converted: duration = (askInteger("Count")) s\nsay converted\nexit\n',
  ],
  [
    "plain-say",
    '\nlet converted: duration = [say("hello", instant)].length\nsay converted\nexit\n',
  ],
  [
    "18-own-historical-246",
    '\nlet converted: duration = [say("hello", instant)].length s\nsay converted\nexit\n',
  ],
  ["plain-button", '\nlet converted: duration = [(showButton "Go")].length\nsay converted\nexit\n'],
  [
    "18-own-historical-248",
    '\nlet converted: duration = [(showButton "Go")].length s\nsay converted\nexit\n',
  ],
  [
    "key-null:repeat @ {}",
    'let ns: integer? dict = dict{ok: null, other: 2}\nrepeat ns["ok"] {}\nexit\n',
  ],
  [
    "18-keys-corrected-2",
    'let ns: integer? dict = dict{ok: null, other: 2}\nrepeat ns["ok"] otherwise 0 {}\nexit\n',
  ],
  [
    "key-null:say @ + 1",
    'let ns: integer? dict = dict{ok: null, other: 2}\nsay ns["ok"] + 1\nexit\n',
  ],
  [
    "18-keys-corrected-4",
    'let ns: integer? dict = dict{ok: null, other: 2}\nsay (ns["ok"] otherwise 0) + 1\nexit\n',
  ],
  [
    "key-null:let val: integer = @\nsay val",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet val: integer = ns["ok"]\nsay val\nexit\n',
  ],
  [
    "18-keys-corrected-6",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet val: integer = ns["ok"] otherwise 0\nsay val\nexit\n',
  ],
  [
    'key-null:let shown = say("${@ + 1}", instant)',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet shown = say("${ns["ok"] + 1}", instant)\nexit\n',
  ],
  [
    "18-keys-corrected-8",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet shown = say("${(ns["ok"] otherwise 0) + 1}", instant)\nexit\n',
  ],
  [
    'key-null:let response = askInteger("${@ + 1}")',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet response = askInteger("${ns["ok"] + 1}")\nexit\n',
  ],
  [
    "18-keys-corrected-10",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet response = askInteger("${(ns["ok"] otherwise 0) + 1}")\nexit\n',
  ],
  [
    'key-null:let pressed = showButton "${@ + 1}"',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet pressed = showButton "${ns["ok"] + 1}"\nexit\n',
  ],
  [
    "18-keys-corrected-12",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet pressed = showButton "${(ns["ok"] otherwise 0) + 1}"\nexit\n',
  ],
  [
    "key-null:function outer(v: integer) { say v }\nouter(@)",
    'let ns: integer? dict = dict{ok: null, other: 2}\nfunction outer(v: integer) { say v }\nouter(ns["ok"])\nexit\n',
  ],
  [
    "18-keys-corrected-14",
    'let ns: integer? dict = dict{ok: null, other: 2}\nfunction outer(v: integer) { say v }\nouter(ns["ok"] otherwise 0)\nexit\n',
  ],
  [
    "key-absent:repeat @ {}",
    'let ns: integer? dict = dict{ok: null, other: 2}\nrepeat ns["gone"] {}\nexit\n',
  ],
  [
    "18-keys-corrected-16",
    'let ns: integer? dict = dict{ok: null, other: 2}\nrepeat ns["gone"] otherwise 0 {}\nexit\n',
    [],
  ],
  [
    "key-absent:say @ + 1",
    'let ns: integer? dict = dict{ok: null, other: 2}\nsay ns["gone"] + 1\nexit\n',
  ],
  [
    "18-keys-corrected-18",
    'let ns: integer? dict = dict{ok: null, other: 2}\nsay (ns["gone"] otherwise 0) + 1\nexit\n',
    [],
  ],
  [
    "key-absent:let val: integer = @\nsay val",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet val: integer = ns["gone"]\nsay val\nexit\n',
  ],
  [
    "18-keys-corrected-20",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet val: integer = ns["gone"] otherwise 0\nsay val\nexit\n',
    [],
  ],
  [
    'key-absent:let shown = say("${@ + 1}", instant)',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet shown = say("${ns["gone"] + 1}", instant)\nexit\n',
  ],
  [
    "18-keys-corrected-22",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet shown = say("${(ns["gone"] otherwise 0) + 1}", instant)\nexit\n',
    [],
  ],
  [
    'key-absent:let response = askInteger("${@ + 1}")',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet response = askInteger("${ns["gone"] + 1}")\nexit\n',
  ],
  [
    "18-keys-corrected-24",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet response = askInteger("${(ns["gone"] otherwise 0) + 1}")\nexit\n',
    [],
  ],
  [
    'key-absent:let pressed = showButton "${@ + 1}"',
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet pressed = showButton "${ns["gone"] + 1}"\nexit\n',
  ],
  [
    "18-keys-corrected-26",
    'let ns: integer? dict = dict{ok: null, other: 2}\nlet pressed = showButton "${(ns["gone"] otherwise 0) + 1}"\nexit\n',
    [],
  ],
  [
    "key-absent:function outer(v: integer) { say v }\nouter(@)",
    'let ns: integer? dict = dict{ok: null, other: 2}\nfunction outer(v: integer) { say v }\nouter(ns["gone"])\nexit\n',
  ],
  [
    "18-keys-corrected-28",
    'let ns: integer? dict = dict{ok: null, other: 2}\nfunction outer(v: integer) { say v }\nouter(ns["gone"] otherwise 0)\nexit\n',
    [],
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node evidence/own.mjs",
      "R/astra-m4-i1241-review-r2/report.md:42, R/astra-m4-i1241-review-r2.md:42, R/astra-m4-i1241-review-r2/commands.json:25",
    ],
    [
      "ONLY=key- OUTPUT=keys node evidence/own.mjs",
      "R/astra-m4-i1241-review-r2/report.md:42, R/astra-m4-i1241-review-r2.md:42, R/astra-m4-i1241-review-r2/commands.json:33",
    ],
  ],
  sources: 202,
  sha256: "e9a5366a95582362c88e7ea681e31b27990d25d8bbb7e24efa78897f5c2eeec2",
};
