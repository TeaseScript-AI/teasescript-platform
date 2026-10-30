// the forms #1310's paste family runs pasted, each analysed; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/pastefam.mjs, on the PR's trees c1 to c13).
// The cases it read from the repository's paste family (`pasteCases`, `tests/helpers/type-core-paste.ts`) are not
// copied; the programs it pasted from them are, as `pastedForms` pastes them on each run's head (the same 451 on all
// of them; every run's log that is kept has their counts). The first run on c1 (`c1-check.sh:13`) is not here: it ran on
// an uncommitted state of the paste helper, which no archive keeps.
export const cases = [
  ["text size at say/t.length", 'let t = "hello"\nsay t.length\nexit\n'],
  ["text size at number declaration/t.length", 'let t = "hello"\nlet v: number = t.length\nexit\n'],
  [
    "text size at integer argument/t.length",
    'let t = "hello"\nfunction count(p: integer) {\n  say p\n}\ncount(t.length)\nexit\n',
  ],
  [
    "text size at range bound/t.length",
    'let t = "hello"\nfor i in 1..t.length {\n  say i\n}\nexit\n',
  ],
  ["text size at nested product/t.length", 'let t = "hello"\nsay 2 * (3 * t.length)\nexit\n'],
  [
    "text size at ask prompt/t.length",
    'let t = "hello"\nlet asked = askInteger("${t.length + 1}")\nexit\n',
  ],
  [
    "nested text size at product/box.label.length",
    'let box = {label: "hello"}\nsay 2 * box.label.length\nexit\n',
  ],
  [
    "nested text size at interpolation/box.label.length",
    'let box = {label: "hello"}\nsay "${box.label.length}"\nexit\n',
  ],
  [
    "nested text size at interpolation divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / toInteger("${box.label.length}", default: 1)\nexit\n',
  ],
  [
    "nested text size at interpolated sum/box.label.length",
    'let box = {label: "hello"}\nsay "${box.label.length + 1}"\nexit\n',
  ],
  [
    "text toUpperCase at string declaration/t.uppercase()",
    'let t = "hello"\nlet v: string = t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at interpolation/t.uppercase()",
    'let t = "hello"\nsay "${t.uppercase()}"\nexit\n',
  ],
  [
    "text toUpperCase at untyped compound/t.uppercase()",
    'let t = "hello"\nlet v = t.uppercase()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "text toUpperCase at interpolation divisor/t.uppercase()",
    'let t = "hello"\nsay 1 / toInteger("${t.uppercase()}", default: 1)\nexit\n',
  ],
  [
    "text trim at string declaration/t.trim()",
    'let t = " hello "\nlet v: string = t.trim()\nexit\n',
  ],
  ["text trim at interpolation/t.trim()", 'let t = " hello "\nsay "${t.trim()}"\nexit\n'],
  [
    "text trim at untyped returned argument/t.trim()",
    'let t = " hello "\nfunction id(p) {\n  return p\n}\nlet w: string = id(t.trim())\nsay w\nexit\n',
  ],
  [
    "text trim at interpolation divisor/t.trim()",
    'let t = " hello "\nsay 1 / toInteger("${t.trim()}", default: 1)\nexit\n',
  ],
  ["angle degrees at product/toDeg(a)", "let a = 90 deg\nsay 2 * toDeg(a)\nexit\n"],
  ["angle degrees at interpolation/toDeg(a)", 'let a = 90 deg\nsay "${toDeg(a)}"\nexit\n'],
  [
    "angle degrees at interpolation divisor/toDeg(a)",
    'let a = 90 deg\nsay 1 / toInteger("${toDeg(a)}", default: 1)\nexit\n',
  ],
  ["angle degrees at interpolated sum/toDeg(a)", 'let a = 90 deg\nsay "${toDeg(a) + 1}"\nexit\n'],
  [
    "object's text size at product/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay 2 * fine.text.length\nexit\n',
  ],
  [
    "object's text size at interpolation/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay "${fine.text.length}"\nexit\n',
  ],
  [
    "object's text size at interpolation divisor/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay 1 / toInteger("${fine.text.length}", default: 1)\nexit\n',
  ],
  [
    "object's text size at interpolated sum/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay "${fine.text.length + 1}"\nexit\n',
  ],
  [
    "object's items + element at say/fine.items + [2]",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay fine.items + [2]\nexit\n',
  ],
  [
    "object's items + element at say/fine.items.add(2)",
    'let fine = {n: 2, text: "hello", items: [1]}\nfine.items.add(2)\nsay fine.items\nexit\n',
  ],
  [
    "object's items + element at receiver/(fine.items + [2])",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay ((fine.items + [2])).length\nexit\n',
  ],
  [
    "object's items + element at receiver/fine.items.add(2)",
    'let fine = {n: 2, text: "hello", items: [1]}\nfine.items.add(2)\nsay (fine.items).length\nexit\n',
  ],
  [
    "join of text at string declaration/items.join()",
    'let items = ["a"]\nlet v: string = items.join()\nexit\n',
  ],
  [
    "join of text at interpolation/items.join()",
    'let items = ["a"]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of text at untyped returned argument/items.join()",
    'let items = ["a"]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items.join())\nsay w\nexit\n',
  ],
  [
    "join of text at interpolation divisor/items.join()",
    'let items = ["a"]\nsay 1 / toInteger("${items.join()}", default: 1)\nexit\n',
  ],
  [
    "nested join of text at say/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join()\nexit\n',
  ],
  [
    "nested join of text at text store/box.items.join()",
    'let box = {items: ["a"]}\nlet v = "x"\nv = box.items.join()\nexit\n',
  ],
  [
    "nested join of text at text join/box.items.join()",
    'let box = {items: ["a"]}\nsay "a" + box.items.join()\nexit\n',
  ],
  [
    "nested join of text at receiver/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join().length\nexit\n',
  ],
  ["join of integer at say/items.join()", "let items = [1]\nsay items.join()\nexit\n"],
  [
    "join of integer at text store/items.join()",
    'let items = [1]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of integer at text join/items.join()", 'let items = [1]\nsay "a" + items.join()\nexit\n'],
  ["join of integer at receiver/items.join()", "let items = [1]\nsay items.join().length\nexit\n"],
  [
    "nested join of integer at string declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: string = box.items.join()\nexit\n",
  ],
  [
    "nested join of integer at interpolation/box.items.join()",
    'let box = {items: [1]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of integer at untyped returned argument/box.items.join()",
    "let box = {items: [1]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of integer at interpolation divisor/box.items.join()",
    'let box = {items: [1]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  [
    "join of number at string declaration/items.join()",
    "let items = [1.5]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of number at interpolation/items.join()",
    'let items = [1.5]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of number at untyped returned argument/items.join()",
    "let items = [1.5]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items.join())\nsay w\nexit\n",
  ],
  [
    "join of number at interpolation divisor/items.join()",
    'let items = [1.5]\nsay 1 / toInteger("${items.join()}", default: 1)\nexit\n',
  ],
  [
    "nested join of number at say/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join()\nexit\n",
  ],
  [
    "nested join of number at text store/box.items.join()",
    'let box = {items: [1.5]}\nlet v = "x"\nv = box.items.join()\nexit\n',
  ],
  [
    "nested join of number at text join/box.items.join()",
    'let box = {items: [1.5]}\nsay "a" + box.items.join()\nexit\n',
  ],
  [
    "nested join of number at receiver/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join().length\nexit\n",
  ],
  ["join of boolean at say/items.join()", "let items = [true]\nsay items.join()\nexit\n"],
  [
    "join of boolean at text store/items.join()",
    'let items = [true]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  [
    "join of boolean at text join/items.join()",
    'let items = [true]\nsay "a" + items.join()\nexit\n',
  ],
  [
    "join of boolean at receiver/items.join()",
    "let items = [true]\nsay items.join().length\nexit\n",
  ],
  [
    "nested join of boolean at string declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: string = box.items.join()\nexit\n",
  ],
  [
    "nested join of boolean at interpolation/box.items.join()",
    'let box = {items: [true]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of boolean at untyped returned argument/box.items.join()",
    "let box = {items: [true]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of boolean at interpolation divisor/box.items.join()",
    'let box = {items: [true]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  [
    "join of duration at string declaration/items.join()",
    "let items = [1 s]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of duration at interpolation/items.join()",
    'let items = [1 s]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of duration at untyped returned argument/items.join()",
    "let items = [1 s]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items.join())\nsay w\nexit\n",
  ],
  [
    "join of duration at interpolation divisor/items.join()",
    'let items = [1 s]\nsay 1 / toInteger("${items.join()}", default: 1)\nexit\n',
  ],
  [
    "nested join of duration at say/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join()\nexit\n",
  ],
  [
    "nested join of duration at text store/box.items.join()",
    'let box = {items: [1 s]}\nlet v = "x"\nv = box.items.join()\nexit\n',
  ],
  [
    "nested join of duration at text join/box.items.join()",
    'let box = {items: [1 s]}\nsay "a" + box.items.join()\nexit\n',
  ],
  [
    "nested join of duration at receiver/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join().length\nexit\n",
  ],
  [
    'list of text + text at string[] declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: string[] = xs + ["a"]\nexit\n',
  ],
  [
    'list of text + text at string[] declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: string[] = xs\nexit\n',
  ],
  ["integer + list of integer at say/[1] + xs", "let xs = [1]\nsay [1] + xs\nexit\n"],
  [
    "integer + list of integer at receiver/([1] + xs)",
    "let xs = [1]\nsay (([1] + xs)).length\nexit\n",
  ],
  ["integer + list of number at say/[1] + xs", "let xs = [1.5]\nsay [1] + xs\nexit\n"],
  [
    "integer + list of number at receiver/([1] + xs)",
    "let xs = [1.5]\nsay (([1] + xs)).length\nexit\n",
  ],
  ["number + list of number at say/[1.5] + xs", "let xs = [1.5]\nsay [1.5] + xs\nexit\n"],
  [
    "number + list of number at receiver/([1.5] + xs)",
    "let xs = [1.5]\nsay (([1.5] + xs)).length\nexit\n",
  ],
  ["range + list at say/(1..3).toList()", "let xs = [1]\nsay ((1..3).toList()) + xs\nexit\n"],
  [
    "range + list at receiver/(1..3).toList()",
    "let xs = [1]\nsay (((1..3).toList()) + xs).length\nexit\n",
  ],
  [
    "null element at product/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay 2 * (xs[1] otherwise 0)\nexit\n",
  ],
  [
    "null element at interpolated sum/(xs[1] otherwise 0)",
    'let xs = [4, null]\nsay "${(xs[1] otherwise 0) + 1}"\nexit\n',
  ],
  [
    "null value at integer declaration/x otherwise 0",
    "let x = [4, null].random\nlet v: integer = x otherwise 0\nexit\n",
  ],
  [
    "null value at integer argument/x otherwise 0",
    "let x = [4, null].random\nfunction count(p: integer) {\n  say p\n}\ncount(x otherwise 0)\nexit\n",
  ],
  [
    "null value at nested product/(x otherwise 0)",
    "let x = [4, null].random\nsay 2 * (3 * (x otherwise 0))\nexit\n",
  ],
  [
    "null value at ask prompt/(x otherwise 0)",
    'let x = [4, null].random\nlet asked = askInteger("${(x otherwise 0) + 1}")\nexit\n',
  ],
  [
    'null element\'s length at sum/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nsay (xs[1] otherwise "").length + 1\nexit\n',
  ],
  [
    'null value\'s length at say/(x otherwise "")',
    'let x = ["ab", null].random\nsay (x otherwise "").length\nexit\n',
  ],
  [
    'null value\'s length at count/(x otherwise "")',
    'let x = ["ab", null].random\nrepeat (x otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    'null property\'s length at sum/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nsay (holder.t otherwise "").length + 1\nexit\n',
  ],
  [
    'null dict value\'s length at say/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nsay (x otherwise "").length\nexit\n',
  ],
  [
    'null dict value\'s length at count/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nrepeat (x otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    'null ellipsis key\'s length at sum/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nsay (d["..."] otherwise "").length + 1\nexit\n',
  ],
  [
    "3 into duration declaration/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 3 s\nexit\n',
  ],
  [
    "fine.n into duration declaration/fine.n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = fine.n s\nexit\n',
  ],
  [
    '[say("Strokes: 0", instant)].length into duration declaration/[say("Strokes: 0", instant)].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = [say("Strokes: 0", instant)].length s\nexit\n',
  ],
  [
    "n + 1 into duration assignment/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = (n + 1) s\nexit\n',
  ],
  [
    "2 * (n * 3) into duration assignment/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = (2 * (n * 3)) s\nexit\n',
  ],
  [
    "-3 into property/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = (-3) s\nexit\n',
  ],
  [
    "({v: n + 1}).v into property/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = ({v: n + 1}).v s\nexit\n',
  ],
  [
    'askInteger("How many?") into property/(askInteger("How many?")) s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = (askInteger("How many?")) s\nexit\n',
  ],
  [
    '[(showButton "Continue")].length into property/[(showButton "Continue")].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = [(showButton "Continue")].length s\nexit\n',
  ],
  [
    "1.5 into duration element/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add(1.5 s)\nexit\n',
  ],
  [
    "({n: n}).n into duration element/({n: n}).n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add(({n: n}).n s)\nexit\n',
  ],
  [
    '"${n}".length into duration element/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add("${n}".length s)\nexit\n',
  ],
  [
    "3 into duration argument/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse(3 s)\nexit\n',
  ],
  [
    "fine.n into duration argument/fine.n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse(fine.n s)\nexit\n',
  ],
  [
    '[say("Strokes: 0", instant)].length into duration argument/[say("Strokes: 0", instant)].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse([say("Strokes: 0", instant)].length s)\nexit\n',
  ],
  [
    "n into angle declaration/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: angle = n deg\nexit\n',
  ],
  [
    "n into angle assignment/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: angle = 1 deg\np = n deg\nexit\n',
  ],
  [
    "n into property/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 deg}\nbox.p = n deg\nexit\n',
  ],
  [
    "n into angle element/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: angle[] = [1 deg]\nps.add(n deg)\nexit\n',
  ],
  [
    "n into angle argument/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: angle) {\n  say p\n}\nuse(n deg)\nexit\n',
  ],
  [
    'n + 1 into string declaration/"${n + 1}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "${n + 1}"\nexit\n',
  ],
  [
    'n into string assignment/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "x"\np = "${n}"\nexit\n',
  ],
  [
    'n + 1 into property/"${n + 1}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: "x"}\nbox.p = "${n + 1}"\nexit\n',
  ],
  [
    'n + 1 into string argument/"${n + 1}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: string) {\n  say p\n}\nuse("${n + 1}")\nexit\n',
  ],
  ["text size at declaration/t.length", 'let t = "hello"\nlet v = t.length\nsay v\nexit\n'],
  ["text size at sum/t.length", 'let t = "hello"\nsay t.length + 1\nexit\n'],
  ["text size at count/t.length", 'let t = "hello"\nrepeat t.length {\n  say "x"\n}\nexit\n'],
  [
    "text size at untyped sum argument/t.length",
    'let t = "hello"\nfunction count(p) {\n  return p + 1\n}\nsay count(t.length)\nexit\n',
  ],
  [
    "text size at button label/t.length",
    'let t = "hello"\nlet pressed = showButton "${t.length + 1}"\nexit\n',
  ],
  [
    "nested text size at integer declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: integer = box.label.length\nexit\n',
  ],
  [
    "nested text size at comparison/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length > 2\nexit\n',
  ],
  [
    "nested text size at untyped argument/box.label.length",
    'let box = {label: "hello"}\nfunction show(p) {\n  say p\n}\nshow(box.label.length)\nexit\n',
  ],
  [
    "nested text size at divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / box.label.length\nexit\n',
  ],
  [
    "nested text size at minus/box.label.length",
    'let box = {label: "hello"}\nsay -box.label.length\nexit\n',
  ],
  [
    "nested text size at say operand/box.label.length",
    'let box = {label: "hello"}\nlet shown = say("${box.label.length + 1}", instant)\nexit\n',
  ],
  [
    "text toUpperCase at text argument/t.uppercase()",
    'let t = "hello"\nfunction show(p: string) {\n  say p\n}\nshow(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at untyped argument/t.uppercase()",
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at untyped compound argument/t.uppercase()",
    'let t = "hello"\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.uppercase())\nexit\n',
  ],
  [
    "text trim at text argument/t.trim()",
    'let t = " hello "\nfunction show(p: string) {\n  say p\n}\nshow(t.trim())\nexit\n',
  ],
  [
    "text trim at untyped argument/t.trim()",
    'let t = " hello "\nfunction show(p) {\n  say p\n}\nshow(t.trim())\nexit\n',
  ],
  ["angle degrees at comparison/toDeg(a)", "let a = 90 deg\nsay toDeg(a) > 2\nexit\n"],
  [
    "angle degrees at untyped argument/toDeg(a)",
    "let a = 90 deg\nfunction show(p) {\n  say p\n}\nshow(toDeg(a))\nexit\n",
  ],
  ["angle degrees at divisor/toDeg(a)", "let a = 90 deg\nsay 1 / toDeg(a)\nexit\n"],
  ["angle degrees at minus/toDeg(a)", "let a = 90 deg\nsay -toDeg(a)\nexit\n"],
  [
    "angle degrees at say operand/toDeg(a)",
    'let a = 90 deg\nlet shown = say("${toDeg(a) + 1}", instant)\nexit\n',
  ],
  [
    "object's text size at integer declaration/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet v: integer = fine.text.length\nexit\n',
  ],
  [
    "object's text size at comparison/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay fine.text.length > 2\nexit\n',
  ],
  [
    "object's text size at untyped argument/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nfunction show(p) {\n  say p\n}\nshow(fine.text.length)\nexit\n',
  ],
  [
    "object's text size at divisor/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay 1 / fine.text.length\nexit\n',
  ],
  [
    "object's text size at minus/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay -fine.text.length\nexit\n',
  ],
  [
    "object's text size at say operand/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet shown = say("${fine.text.length + 1}", instant)\nexit\n',
  ],
  [
    "object's items + element at declaration/fine.items + [2]",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet v = fine.items + [2]\nsay v\nexit\n',
  ],
  [
    "object's items + element at declaration/fine.items.add(2)",
    'let fine = {n: 2, text: "hello", items: [1]}\nfine.items.add(2)\nlet v = fine.items\nsay v\nexit\n',
  ],
  [
    "join of text at text argument/items.join()",
    'let items = ["a"]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n',
  ],
  [
    "join of text at untyped argument/items.join()",
    'let items = ["a"]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n',
  ],
  [
    "nested join of text at declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v = box.items.join()\nsay v\nexit\n',
  ],
  [
    "join of integer at declaration/items.join()",
    "let items = [1]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of integer at text argument/box.items.join()",
    "let box = {items: [1]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of integer at untyped argument/box.items.join()",
    "let box = {items: [1]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "join of number at text argument/items.join()",
    "let items = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of number at untyped argument/items.join()",
    "let items = [1.5]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "nested join of number at declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "join of boolean at declaration/items.join()",
    "let items = [true]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of boolean at text argument/box.items.join()",
    "let box = {items: [true]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of boolean at untyped argument/box.items.join()",
    "let box = {items: [true]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "join of duration at text argument/items.join()",
    "let items = [1 s]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of duration at untyped argument/items.join()",
    "let items = [1 s]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "nested join of duration at declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    'list of text + text at untyped argument/xs + ["a"]',
    'let xs = ["a"]\nfunction show(p) {\n  say p\n}\nshow(xs + ["a"])\nexit\n',
  ],
  [
    'list of text + text at untyped argument/xs.add("a")',
    'let xs = ["a"]\nfunction show(p) {\n  say p\n}\nxs.add("a")\nshow(xs)\nexit\n',
  ],
  [
    "list of integer + integer at integer[] declaration/xs + [1]",
    "let xs = [1]\nlet v: integer[] = xs + [1]\nexit\n",
  ],
  [
    "list of integer + integer at integer[] declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v: integer[] = xs\nexit\n",
  ],
  [
    "list of integer + integer at untyped argument/xs + [1]",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(xs + [1])\nexit\n",
  ],
  [
    "list of integer + integer at untyped argument/xs.add(1)",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
  ],
  [
    "integer + list of integer at declaration/[1] + xs",
    "let xs = [1]\nlet v = [1] + xs\nsay v\nexit\n",
  ],
  [
    "list of number + integer at untyped argument/xs + [1]",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow(xs + [1])\nexit\n",
  ],
  [
    "list of number + integer at untyped argument/xs.add(1)",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
  ],
  [
    "integer + list of number at declaration/[1] + xs",
    "let xs = [1.5]\nlet v = [1] + xs\nsay v\nexit\n",
  ],
  [
    "list of number + number at untyped argument/xs + [1.5]",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow(xs + [1.5])\nexit\n",
  ],
  [
    "list of number + number at untyped argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nxs.add(1.5)\nshow(xs)\nexit\n",
  ],
  [
    "number + list of number at declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v = [1.5] + xs\nsay v\nexit\n",
  ],
  [
    "list + range at integer[] declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer[] = xs + ((1..3).toList())\nexit\n",
  ],
  [
    "list + range at untyped argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(xs + ((1..3).toList()))\nexit\n",
  ],
  [
    "range + list at declaration/(1..3).toList()",
    "let xs = [1]\nlet v = ((1..3).toList()) + xs\nsay v\nexit\n",
  ],
  [
    "null element at comparison/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay (xs[1] otherwise 0) > 2\nexit\n",
  ],
  [
    "null element at minus/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay -(xs[1] otherwise 0)\nexit\n",
  ],
  [
    "null element at say operand/(xs[1] otherwise 0)",
    'let xs = [4, null]\nlet shown = say("${(xs[1] otherwise 0) + 1}", instant)\nexit\n',
  ],
  [
    "null value at sum/(x otherwise 0)",
    "let x = [4, null].random\nsay (x otherwise 0) + 1\nexit\n",
  ],
  [
    "null value at count/x otherwise 0",
    'let x = [4, null].random\nrepeat x otherwise 0 {\n  say "x"\n}\nexit\n',
  ],
  [
    "null value at object contents/(x otherwise 0)",
    "let x = [4, null].random\nsay ({v: (x otherwise 0) + 1}).v\nexit\n",
  ],
  [
    "null value at button label/(x otherwise 0)",
    'let x = [4, null].random\nlet pressed = showButton "${(x otherwise 0) + 1}"\nexit\n',
  ],
  [
    'null element\'s length at integer argument/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nfunction count(p: integer) {\n  say p\n}\ncount((xs[1] otherwise "").length)\nexit\n',
  ],
  [
    'null value\'s length at integer declaration/(x otherwise "")',
    'let x = ["ab", null].random\nlet v: integer = (x otherwise "").length\nexit\n',
  ],
  [
    'null value\'s length at untyped argument/(x otherwise "")',
    'let x = ["ab", null].random\nfunction show(p) {\n  say p\n}\nshow((x otherwise "").length)\nexit\n',
  ],
  [
    'null property\'s length at integer argument/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nfunction count(p: integer) {\n  say p\n}\ncount((holder.t otherwise "").length)\nexit\n',
  ],
  [
    'null dict value\'s length at integer declaration/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nlet v: integer = (x otherwise "").length\nexit\n',
  ],
  [
    'null dict value\'s length at untyped argument/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nfunction show(p) {\n  say p\n}\nshow((x otherwise "").length)\nexit\n',
  ],
  [
    'null ellipsis key\'s length at integer argument/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nfunction count(p: integer) {\n  say p\n}\ncount((d["..."] otherwise "").length)\nexit\n',
  ],
  [
    "list of text + [1] at declaration/let v: (string | integer)[] = xs + [1]",
    'let xs = ["a"]\nlet v: (string | integer)[] = xs + [1]\nsay v\nexit\n',
  ],
  [
    "[1] + list of text at declaration/let v: (integer | string)[] = [1] + xs",
    'let xs = ["a"]\nlet v: (integer | string)[] = [1] + xs\nsay v\nexit\n',
  ],
  [
    'list of integer + ["x"] at declaration/let v: (integer | string)[] = xs + ["x"]',
    'let xs = [1]\nlet v: (integer | string)[] = xs + ["x"]\nsay v\nexit\n',
  ],
  [
    '["x"] + list of integer at declaration/let v: (string | integer)[] = ["x"] + xs',
    'let xs = [1]\nlet v: (string | integer)[] = ["x"] + xs\nsay v\nexit\n',
  ],
  [
    'list of number + ["x"] at declaration/let v: (number | string)[] = xs + ["x"]',
    'let xs = [1.5]\nlet v: (number | string)[] = xs + ["x"]\nsay v\nexit\n',
  ],
  [
    '["x"] + list of number at declaration/let v: (string | number)[] = ["x"] + xs',
    'let xs = [1.5]\nlet v: (string | number)[] = ["x"] + xs\nsay v\nexit\n',
  ],
  [
    'list of boolean + ["x"] at declaration/let v: (boolean | string)[] = xs + ["x"]',
    'let xs = [true]\nlet v: (boolean | string)[] = xs + ["x"]\nsay v\nexit\n',
  ],
  [
    '["x"] + list of boolean at declaration/let v: (string | boolean)[] = ["x"] + xs',
    'let xs = [true]\nlet v: (string | boolean)[] = ["x"] + xs\nsay v\nexit\n',
  ],
  [
    'list of duration + ["x"] at declaration/let v: (duration | string)[] = xs + ["x"]',
    'let xs = [1 s]\nlet v: (duration | string)[] = xs + ["x"]\nsay v\nexit\n',
  ],
  [
    '["x"] + list of duration at declaration/let v: (string | duration)[] = ["x"] + xs',
    'let xs = [1 s]\nlet v: (string | duration)[] = ["x"] + xs\nsay v\nexit\n',
  ],
  [
    'list of object + ["x"] at declaration/let v: (object | string)[] = xs + ["x"]',
    'let xs = [{n: 1}]\nlet v: (object | string)[] = xs + ["x"]\nsay v\nexit\n',
  ],
  [
    '["x"] + list of object at declaration/let v: (string | object)[] = ["x"] + xs',
    'let xs = [{n: 1}]\nlet v: (string | object)[] = ["x"] + xs\nsay v\nexit\n',
  ],
  [
    "n + 1 into duration declaration/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = (n + 1) s\nexit\n',
  ],
  [
    "2 * (n * 3) into duration declaration/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = (2 * (n * 3)) s\nexit\n',
  ],
  [
    "-3 into duration assignment/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = (-3) s\nexit\n',
  ],
  [
    "({v: n + 1}).v into duration assignment/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = ({v: n + 1}).v s\nexit\n',
  ],
  [
    'askInteger("How many?") into duration assignment/(askInteger("How many?")) s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = (askInteger("How many?")) s\nexit\n',
  ],
  [
    '[(showButton "Continue")].length into duration assignment/[(showButton "Continue")].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = [(showButton "Continue")].length s\nexit\n',
  ],
  [
    "1.5 into property/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = 1.5 s\nexit\n',
  ],
  [
    "({n: n}).n into property/({n: n}).n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = ({n: n}).n s\nexit\n',
  ],
  [
    '"${n}".length into property/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = "${n}".length s\nexit\n',
  ],
  [
    "3 into duration element/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add(3 s)\nexit\n',
  ],
  [
    "fine.n into duration element/fine.n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add(fine.n s)\nexit\n',
  ],
  [
    '[say("Strokes: 0", instant)].length into duration element/[say("Strokes: 0", instant)].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add([say("Strokes: 0", instant)].length s)\nexit\n',
  ],
  [
    "n + 1 into duration argument/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse((n + 1) s)\nexit\n',
  ],
  [
    "2 * (n * 3) into duration argument/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse((2 * (n * 3)) s)\nexit\n',
  ],
  [
    '"10:30" into time assignment/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: time = toTime("10:00")\np = toTime("10:30")\nexit\n',
  ],
  [
    '5 into string declaration/"${5}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "${5}"\nexit\n',
  ],
  [
    'true into string assignment/"${true}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "x"\np = "${true}"\nexit\n',
  ],
  [
    '5 into property/"${5}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: "x"}\nbox.p = "${5}"\nexit\n',
  ],
  [
    '5 into string argument/"${5}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: string) {\n  say p\n}\nuse("${5}")\nexit\n',
  ],
  ["text size at product/t.length", 'let t = "hello"\nsay 2 * t.length\nexit\n'],
  ["text size at interpolation/t.length", 'let t = "hello"\nsay "${t.length}"\nexit\n'],
  [
    "text size at interpolation divisor/t.length",
    'let t = "hello"\nsay 1 / toInteger("${t.length}", default: 1)\nexit\n',
  ],
  ["text size at interpolated sum/t.length", 'let t = "hello"\nsay "${t.length + 1}"\nexit\n'],
  [
    "nested text size at say/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length\nexit\n',
  ],
  [
    "nested text size at number declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: number = box.label.length\nexit\n',
  ],
  [
    "nested text size at integer argument/box.label.length",
    'let box = {label: "hello"}\nfunction count(p: integer) {\n  say p\n}\ncount(box.label.length)\nexit\n',
  ],
  [
    "nested text size at range bound/box.label.length",
    'let box = {label: "hello"}\nfor i in 1..box.label.length {\n  say i\n}\nexit\n',
  ],
  [
    "nested text size at nested product/box.label.length",
    'let box = {label: "hello"}\nsay 2 * (3 * box.label.length)\nexit\n',
  ],
  [
    "nested text size at ask prompt/box.label.length",
    'let box = {label: "hello"}\nlet asked = askInteger("${box.label.length + 1}")\nexit\n',
  ],
  ["text toUpperCase at say/t.uppercase()", 'let t = "hello"\nsay t.uppercase()\nexit\n'],
  [
    "text toUpperCase at text store/t.uppercase()",
    'let t = "hello"\nlet v = "x"\nv = t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at text join/t.uppercase()",
    'let t = "hello"\nsay "a" + t.uppercase()\nexit\n',
  ],
  ["text trim at say/t.trim()", 'let t = " hello "\nsay t.trim()\nexit\n'],
  ["text trim at text store/t.trim()", 'let t = " hello "\nlet v = "x"\nv = t.trim()\nexit\n'],
  ["text trim at text join/t.trim()", 'let t = " hello "\nsay "a" + t.trim()\nexit\n'],
  ["text trim at receiver/t.trim()", 'let t = " hello "\nsay t.trim().length\nexit\n'],
  ["angle degrees at say/toDeg(a)", "let a = 90 deg\nsay toDeg(a)\nexit\n"],
  [
    "angle degrees at number declaration/toDeg(a)",
    "let a = 90 deg\nlet v: number = toDeg(a)\nexit\n",
  ],
  ["angle degrees at nested product/toDeg(a)", "let a = 90 deg\nsay 2 * (3 * toDeg(a))\nexit\n"],
  [
    "angle degrees at ask prompt/toDeg(a)",
    'let a = 90 deg\nlet asked = askInteger("${toDeg(a) + 1}")\nexit\n',
  ],
  [
    "object's text size at say/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay fine.text.length\nexit\n',
  ],
  [
    "object's text size at number declaration/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet v: number = fine.text.length\nexit\n',
  ],
  [
    "object's text size at integer argument/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nfunction count(p: integer) {\n  say p\n}\ncount(fine.text.length)\nexit\n',
  ],
  [
    "object's text size at range bound/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nfor i in 1..fine.text.length {\n  say i\n}\nexit\n',
  ],
  [
    "object's text size at nested product/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay 2 * (3 * fine.text.length)\nexit\n',
  ],
  [
    "object's text size at ask prompt/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet asked = askInteger("${fine.text.length + 1}")\nexit\n',
  ],
  ["join of text at say/items.join()", 'let items = ["a"]\nsay items.join()\nexit\n'],
  [
    "join of text at text store/items.join()",
    'let items = ["a"]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of text at text join/items.join()", 'let items = ["a"]\nsay "a" + items.join()\nexit\n'],
  ["join of text at receiver/items.join()", 'let items = ["a"]\nsay items.join().length\nexit\n'],
  [
    "nested join of text at string declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: string = box.items.join()\nexit\n',
  ],
  [
    "nested join of text at interpolation/box.items.join()",
    'let box = {items: ["a"]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of text at untyped returned argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n',
  ],
  [
    "nested join of text at interpolation divisor/box.items.join()",
    'let box = {items: ["a"]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  [
    "join of integer at string declaration/items.join()",
    "let items = [1]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of integer at interpolation/items.join()",
    'let items = [1]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of integer at untyped returned argument/items.join()",
    "let items = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items.join())\nsay w\nexit\n",
  ],
  [
    "join of integer at interpolation divisor/items.join()",
    'let items = [1]\nsay 1 / toInteger("${items.join()}", default: 1)\nexit\n',
  ],
  [
    "nested join of integer at say/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join()\nexit\n",
  ],
  [
    "nested join of integer at text store/box.items.join()",
    'let box = {items: [1]}\nlet v = "x"\nv = box.items.join()\nexit\n',
  ],
  [
    "nested join of integer at text join/box.items.join()",
    'let box = {items: [1]}\nsay "a" + box.items.join()\nexit\n',
  ],
  [
    "nested join of integer at receiver/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join().length\nexit\n",
  ],
  ["join of number at say/items.join()", "let items = [1.5]\nsay items.join()\nexit\n"],
  [
    "join of number at text store/items.join()",
    'let items = [1.5]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of number at text join/items.join()", 'let items = [1.5]\nsay "a" + items.join()\nexit\n'],
  ["join of number at receiver/items.join()", "let items = [1.5]\nsay items.join().length\nexit\n"],
  [
    "nested join of number at string declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: string = box.items.join()\nexit\n",
  ],
  [
    "nested join of number at interpolation/box.items.join()",
    'let box = {items: [1.5]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of number at untyped returned argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of number at interpolation divisor/box.items.join()",
    'let box = {items: [1.5]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  [
    "join of boolean at string declaration/items.join()",
    "let items = [true]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of boolean at interpolation/items.join()",
    'let items = [true]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of boolean at untyped returned argument/items.join()",
    "let items = [true]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items.join())\nsay w\nexit\n",
  ],
  [
    "join of boolean at interpolation divisor/items.join()",
    'let items = [true]\nsay 1 / toInteger("${items.join()}", default: 1)\nexit\n',
  ],
  [
    "nested join of boolean at say/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join()\nexit\n",
  ],
  [
    "nested join of boolean at text store/box.items.join()",
    'let box = {items: [true]}\nlet v = "x"\nv = box.items.join()\nexit\n',
  ],
  [
    "nested join of boolean at text join/box.items.join()",
    'let box = {items: [true]}\nsay "a" + box.items.join()\nexit\n',
  ],
  [
    "nested join of boolean at receiver/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join().length\nexit\n",
  ],
  ["join of duration at say/items.join()", "let items = [1 s]\nsay items.join()\nexit\n"],
  [
    "join of duration at text store/items.join()",
    'let items = [1 s]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  [
    "join of duration at text join/items.join()",
    'let items = [1 s]\nsay "a" + items.join()\nexit\n',
  ],
  [
    "join of duration at receiver/items.join()",
    "let items = [1 s]\nsay items.join().length\nexit\n",
  ],
  [
    "nested join of duration at string declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: string = box.items.join()\nexit\n",
  ],
  [
    "nested join of duration at interpolation/box.items.join()",
    'let box = {items: [1 s]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of duration at untyped returned argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of duration at interpolation divisor/box.items.join()",
    'let box = {items: [1 s]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  ['list of text + text at say/xs + ["a"]', 'let xs = ["a"]\nsay xs + ["a"]\nexit\n'],
  ['list of text + text at say/xs.add("a")', 'let xs = ["a"]\nxs.add("a")\nsay xs\nexit\n'],
  [
    'list of text + text at receiver/(xs + ["a"])',
    'let xs = ["a"]\nsay ((xs + ["a"])).length\nexit\n',
  ],
  [
    'list of text + text at receiver/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay (xs).length\nexit\n',
  ],
  ["list of integer + integer at say/xs + [1]", "let xs = [1]\nsay xs + [1]\nexit\n"],
  ["list of integer + integer at say/xs.add(1)", "let xs = [1]\nxs.add(1)\nsay xs\nexit\n"],
  [
    "list of integer + integer at receiver/(xs + [1])",
    "let xs = [1]\nsay ((xs + [1])).length\nexit\n",
  ],
  [
    "list of integer + integer at receiver/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nsay (xs).length\nexit\n",
  ],
  ["list of number + integer at say/xs + [1]", "let xs = [1.5]\nsay xs + [1]\nexit\n"],
  ["list of number + integer at say/xs.add(1)", "let xs = [1.5]\nxs.add(1)\nsay xs\nexit\n"],
  [
    "list of number + integer at receiver/(xs + [1])",
    "let xs = [1.5]\nsay ((xs + [1])).length\nexit\n",
  ],
  [
    "list of number + integer at receiver/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nsay (xs).length\nexit\n",
  ],
  ["list of number + number at say/xs + [1.5]", "let xs = [1.5]\nsay xs + [1.5]\nexit\n"],
  ["list of number + number at say/xs.add(1.5)", "let xs = [1.5]\nxs.add(1.5)\nsay xs\nexit\n"],
  [
    "list of number + number at receiver/(xs + [1.5])",
    "let xs = [1.5]\nsay ((xs + [1.5])).length\nexit\n",
  ],
  [
    "list of number + number at receiver/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nsay (xs).length\nexit\n",
  ],
  ["list + range at say/(1..3).toList()", "let xs = [1]\nsay xs + ((1..3).toList())\nexit\n"],
  [
    "list + range at receiver/(1..3).toList()",
    "let xs = [1]\nsay (xs + ((1..3).toList())).length\nexit\n",
  ],
  [
    "null element at integer declaration/xs[1] otherwise 0",
    "let xs = [4, null]\nlet v: integer = xs[1] otherwise 0\nexit\n",
  ],
  [
    "null element at integer argument/xs[1] otherwise 0",
    "let xs = [4, null]\nfunction count(p: integer) {\n  say p\n}\ncount(xs[1] otherwise 0)\nexit\n",
  ],
  [
    "null element at nested product/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay 2 * (3 * (xs[1] otherwise 0))\nexit\n",
  ],
  [
    "null element at ask prompt/(xs[1] otherwise 0)",
    'let xs = [4, null]\nlet asked = askInteger("${(xs[1] otherwise 0) + 1}")\nexit\n',
  ],
  [
    "null value at product/(x otherwise 0)",
    "let x = [4, null].random\nsay 2 * (x otherwise 0)\nexit\n",
  ],
  [
    "null value at interpolated sum/(x otherwise 0)",
    'let x = [4, null].random\nsay "${(x otherwise 0) + 1}"\nexit\n',
  ],
  [
    'null element\'s length at say/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nsay (xs[1] otherwise "").length\nexit\n',
  ],
  [
    'null element\'s length at count/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nrepeat (xs[1] otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    'null value\'s length at sum/(x otherwise "")',
    'let x = ["ab", null].random\nsay (x otherwise "").length + 1\nexit\n',
  ],
  [
    'null property\'s length at say/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nsay (holder.t otherwise "").length\nexit\n',
  ],
  [
    'null property\'s length at count/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nrepeat (holder.t otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    'null dict value\'s length at sum/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nsay (x otherwise "").length + 1\nexit\n',
  ],
  [
    'null ellipsis key\'s length at say/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nsay (d["..."] otherwise "").length\nexit\n',
  ],
  [
    'null ellipsis key\'s length at count/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nrepeat (d["..."] otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    "list of text + [1] at string[] declaration/let v: (string | integer)[] = xs + [1]",
    'let xs = ["a"]\nlet v: (string | integer)[] = xs + [1]\nexit\n',
  ],
  [
    '["x"] + list of integer at string[] declaration/let v: (string | integer)[] = ["x"] + xs',
    'let xs = [1]\nlet v: (string | integer)[] = ["x"] + xs\nexit\n',
  ],
  [
    '["x"] + list of number at string[] declaration/let v: (string | number)[] = ["x"] + xs',
    'let xs = [1.5]\nlet v: (string | number)[] = ["x"] + xs\nexit\n',
  ],
  [
    '["x"] + list of boolean at string[] declaration/let v: (string | boolean)[] = ["x"] + xs',
    'let xs = [true]\nlet v: (string | boolean)[] = ["x"] + xs\nexit\n',
  ],
  [
    '["x"] + list of duration at string[] declaration/let v: (string | duration)[] = ["x"] + xs',
    'let xs = [1 s]\nlet v: (string | duration)[] = ["x"] + xs\nexit\n',
  ],
  [
    '["x"] + list of object at string[] declaration/let v: (string | object)[] = ["x"] + xs',
    'let xs = [{n: 1}]\nlet v: (string | object)[] = ["x"] + xs\nexit\n',
  ],
  [
    "-3 into duration declaration/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = (-3) s\nexit\n',
  ],
  [
    "({v: n + 1}).v into duration declaration/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = ({v: n + 1}).v s\nexit\n',
  ],
  [
    'askInteger("How many?") into duration declaration/(askInteger("How many?")) s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = (askInteger("How many?")) s\nexit\n',
  ],
  [
    '[(showButton "Continue")].length into duration declaration/[(showButton "Continue")].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = [(showButton "Continue")].length s\nexit\n',
  ],
  [
    "1.5 into duration assignment/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = 1.5 s\nexit\n',
  ],
  [
    "({n: n}).n into duration assignment/({n: n}).n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = ({n: n}).n s\nexit\n',
  ],
  [
    '"${n}".length into duration assignment/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = "${n}".length s\nexit\n',
  ],
  [
    "3 into property/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = 3 s\nexit\n',
  ],
  [
    "fine.n into property/fine.n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = fine.n s\nexit\n',
  ],
  [
    '[say("Strokes: 0", instant)].length into property/[say("Strokes: 0", instant)].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = [say("Strokes: 0", instant)].length s\nexit\n',
  ],
  [
    "n + 1 into duration element/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add((n + 1) s)\nexit\n',
  ],
  [
    "2 * (n * 3) into duration element/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add((2 * (n * 3)) s)\nexit\n',
  ],
  [
    "-3 into duration argument/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse((-3) s)\nexit\n',
  ],
  [
    "({v: n + 1}).v into duration argument/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse(({v: n + 1}).v s)\nexit\n',
  ],
  [
    'askInteger("How many?") into duration argument/(askInteger("How many?")) s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse((askInteger("How many?")) s)\nexit\n',
  ],
  [
    '[(showButton "Continue")].length into duration argument/[(showButton "Continue")].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse([(showButton "Continue")].length s)\nexit\n',
  ],
  [
    'n into string declaration/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "${n}"\nexit\n',
  ],
  [
    'n + 1 into string assignment/"${n + 1}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "x"\np = "${n + 1}"\nexit\n',
  ],
  [
    'n into property/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: "x"}\nbox.p = "${n}"\nexit\n',
  ],
  [
    'n into string argument/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: string) {\n  say p\n}\nuse("${n}")\nexit\n',
  ],
  [
    "text size at integer declaration/t.length",
    'let t = "hello"\nlet v: integer = t.length\nexit\n',
  ],
  ["text size at comparison/t.length", 'let t = "hello"\nsay t.length > 2\nexit\n'],
  [
    "text size at untyped argument/t.length",
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(t.length)\nexit\n',
  ],
  ["text size at divisor/t.length", 'let t = "hello"\nsay 1 / t.length\nexit\n'],
  ["text size at minus/t.length", 'let t = "hello"\nsay -t.length\nexit\n'],
  [
    "text size at say operand/t.length",
    'let t = "hello"\nlet shown = say("${t.length + 1}", instant)\nexit\n',
  ],
  [
    "nested text size at declaration/box.label.length",
    'let box = {label: "hello"}\nlet v = box.label.length\nsay v\nexit\n',
  ],
  [
    "nested text size at sum/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length + 1\nexit\n',
  ],
  [
    "nested text size at count/box.label.length",
    'let box = {label: "hello"}\nrepeat box.label.length {\n  say "x"\n}\nexit\n',
  ],
  [
    "nested text size at untyped sum argument/box.label.length",
    'let box = {label: "hello"}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.label.length)\nexit\n',
  ],
  [
    "nested text size at button label/box.label.length",
    'let box = {label: "hello"}\nlet pressed = showButton "${box.label.length + 1}"\nexit\n',
  ],
  [
    "text toUpperCase at declaration/t.uppercase()",
    'let t = "hello"\nlet v = t.uppercase()\nsay v\nexit\n',
  ],
  ["text trim at declaration/t.trim()", 'let t = " hello "\nlet v = t.trim()\nsay v\nexit\n'],
  ["angle degrees at declaration/toDeg(a)", "let a = 90 deg\nlet v = toDeg(a)\nsay v\nexit\n"],
  ["angle degrees at sum/toDeg(a)", "let a = 90 deg\nsay toDeg(a) + 1\nexit\n"],
  [
    "angle degrees at untyped sum argument/toDeg(a)",
    "let a = 90 deg\nfunction count(p) {\n  return p + 1\n}\nsay count(toDeg(a))\nexit\n",
  ],
  [
    "angle degrees at button label/toDeg(a)",
    'let a = 90 deg\nlet pressed = showButton "${toDeg(a) + 1}"\nexit\n',
  ],
  [
    "object's text size at declaration/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet v = fine.text.length\nsay v\nexit\n',
  ],
  [
    "object's text size at sum/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nsay fine.text.length + 1\nexit\n',
  ],
  [
    "object's text size at count/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nrepeat fine.text.length {\n  say "x"\n}\nexit\n',
  ],
  [
    "object's text size at untyped sum argument/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nfunction count(p) {\n  return p + 1\n}\nsay count(fine.text.length)\nexit\n',
  ],
  [
    "object's text size at button label/fine.text.length",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet pressed = showButton "${fine.text.length + 1}"\nexit\n',
  ],
  [
    "object's items + element at integer[] declaration/fine.items + [2]",
    'let fine = {n: 2, text: "hello", items: [1]}\nlet v: integer[] = fine.items + [2]\nexit\n',
  ],
  [
    "object's items + element at integer[] declaration/fine.items.add(2)",
    'let fine = {n: 2, text: "hello", items: [1]}\nfine.items.add(2)\nlet v: integer[] = fine.items\nexit\n',
  ],
  [
    "object's items + element at untyped argument/fine.items + [2]",
    'let fine = {n: 2, text: "hello", items: [1]}\nfunction show(p) {\n  say p\n}\nshow(fine.items + [2])\nexit\n',
  ],
  [
    "object's items + element at untyped argument/fine.items.add(2)",
    'let fine = {n: 2, text: "hello", items: [1]}\nfunction show(p) {\n  say p\n}\nfine.items.add(2)\nshow(fine.items)\nexit\n',
  ],
  [
    "join of text at declaration/items.join()",
    'let items = ["a"]\nlet v = items.join()\nsay v\nexit\n',
  ],
  [
    "nested join of text at text argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at untyped argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n',
  ],
  [
    "join of integer at text argument/items.join()",
    "let items = [1]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of integer at untyped argument/items.join()",
    "let items = [1]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "nested join of integer at declaration/box.items.join()",
    "let box = {items: [1]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "join of number at declaration/items.join()",
    "let items = [1.5]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of number at text argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of number at untyped argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "join of boolean at text argument/items.join()",
    "let items = [true]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of boolean at untyped argument/items.join()",
    "let items = [true]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "nested join of boolean at declaration/box.items.join()",
    "let box = {items: [true]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "join of duration at declaration/items.join()",
    "let items = [1 s]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of duration at text argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of duration at untyped argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    'list of text + text at declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v = xs + ["a"]\nsay v\nexit\n',
  ],
  [
    'list of text + text at declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v = xs\nsay v\nexit\n',
  ],
  [
    "list of integer + integer at declaration/xs + [1]",
    "let xs = [1]\nlet v = xs + [1]\nsay v\nexit\n",
  ],
  [
    "list of integer + integer at declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v = xs\nsay v\nexit\n",
  ],
  [
    "integer + list of integer at integer[] declaration/[1] + xs",
    "let xs = [1]\nlet v: integer[] = [1] + xs\nexit\n",
  ],
  [
    "integer + list of integer at untyped argument/[1] + xs",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow([1] + xs)\nexit\n",
  ],
  [
    "list of number + integer at declaration/xs + [1]",
    "let xs = [1.5]\nlet v = xs + [1]\nsay v\nexit\n",
  ],
  [
    "list of number + integer at declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v = xs\nsay v\nexit\n",
  ],
  [
    "integer + list of number at untyped argument/[1] + xs",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow([1] + xs)\nexit\n",
  ],
  [
    "list of number + number at declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v = xs + [1.5]\nsay v\nexit\n",
  ],
  [
    "list of number + number at declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v = xs\nsay v\nexit\n",
  ],
  [
    "number + list of number at untyped argument/[1.5] + xs",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow([1.5] + xs)\nexit\n",
  ],
  [
    "list + range at declaration/(1..3).toList()",
    "let xs = [1]\nlet v = xs + ((1..3).toList())\nsay v\nexit\n",
  ],
  [
    "range + list at integer[] declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer[] = ((1..3).toList()) + xs\nexit\n",
  ],
  [
    "range + list at untyped argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(((1..3).toList()) + xs)\nexit\n",
  ],
  [
    "null element at sum/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay (xs[1] otherwise 0) + 1\nexit\n",
  ],
  [
    "null element at count/xs[1] otherwise 0",
    'let xs = [4, null]\nrepeat xs[1] otherwise 0 {\n  say "x"\n}\nexit\n',
  ],
  [
    "null element at object contents/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay ({v: (xs[1] otherwise 0) + 1}).v\nexit\n",
  ],
  [
    "null element at button label/(xs[1] otherwise 0)",
    'let xs = [4, null]\nlet pressed = showButton "${(xs[1] otherwise 0) + 1}"\nexit\n',
  ],
  [
    "null value at comparison/(x otherwise 0)",
    "let x = [4, null].random\nsay (x otherwise 0) > 2\nexit\n",
  ],
  ["null value at minus/(x otherwise 0)", "let x = [4, null].random\nsay -(x otherwise 0)\nexit\n"],
  [
    "null value at say operand/(x otherwise 0)",
    'let x = [4, null].random\nlet shown = say("${(x otherwise 0) + 1}", instant)\nexit\n',
  ],
  [
    'null element\'s length at integer declaration/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nlet v: integer = (xs[1] otherwise "").length\nexit\n',
  ],
  [
    'null element\'s length at untyped argument/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nfunction show(p) {\n  say p\n}\nshow((xs[1] otherwise "").length)\nexit\n',
  ],
  [
    'null value\'s length at integer argument/(x otherwise "")',
    'let x = ["ab", null].random\nfunction count(p: integer) {\n  say p\n}\ncount((x otherwise "").length)\nexit\n',
  ],
  [
    'null property\'s length at integer declaration/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nlet v: integer = (holder.t otherwise "").length\nexit\n',
  ],
  [
    'null property\'s length at untyped argument/(holder.t otherwise "")',
    'let holder = {t: ["ab", null].random}\nfunction show(p) {\n  say p\n}\nshow((holder.t otherwise "").length)\nexit\n',
  ],
  [
    'null dict value\'s length at integer argument/(x otherwise "")',
    'let x = dict{a: "ab", b: null}.values.random\nfunction count(p: integer) {\n  say p\n}\ncount((x otherwise "").length)\nexit\n',
  ],
  [
    'null ellipsis key\'s length at integer declaration/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nlet v: integer = (d["..."] otherwise "").length\nexit\n',
  ],
  [
    'null ellipsis key\'s length at untyped argument/(d["..."] otherwise "")',
    'let d = dict{"...": "alpha", b: null}\nfunction show(p) {\n  say p\n}\nshow((d["..."] otherwise "").length)\nexit\n',
  ],
  [
    "[1] + list of text at integer[] declaration/let v: (integer | string)[] = [1] + xs",
    'let xs = ["a"]\nlet v: (integer | string)[] = [1] + xs\nexit\n',
  ],
  [
    'list of integer + ["x"] at integer[] declaration/let v: (integer | string)[] = xs + ["x"]',
    'let xs = [1]\nlet v: (integer | string)[] = xs + ["x"]\nexit\n',
  ],
  [
    "1.5 into duration declaration/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1.5 s\nexit\n',
  ],
  [
    "({n: n}).n into duration declaration/({n: n}).n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = ({n: n}).n s\nexit\n',
  ],
  [
    '"${n}".length into duration declaration/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = "${n}".length s\nexit\n',
  ],
  [
    "3 into duration assignment/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = 3 s\nexit\n',
  ],
  [
    "fine.n into duration assignment/fine.n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = fine.n s\nexit\n',
  ],
  [
    '[say("Strokes: 0", instant)].length into duration assignment/[say("Strokes: 0", instant)].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: duration = 1 s\np = [say("Strokes: 0", instant)].length s\nexit\n',
  ],
  [
    "n + 1 into property/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = (n + 1) s\nexit\n',
  ],
  [
    "2 * (n * 3) into property/(2 * (n * 3)) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 s}\nbox.p = (2 * (n * 3)) s\nexit\n',
  ],
  [
    "-3 into duration element/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add((-3) s)\nexit\n',
  ],
  [
    "({v: n + 1}).v into duration element/({v: n + 1}).v s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add(({v: n + 1}).v s)\nexit\n',
  ],
  [
    'askInteger("How many?") into duration element/(askInteger("How many?")) s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add((askInteger("How many?")) s)\nexit\n',
  ],
  [
    '[(showButton "Continue")].length into duration element/[(showButton "Continue")].length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: duration[] = [1 s]\nps.add([(showButton "Continue")].length s)\nexit\n',
  ],
  [
    "1.5 into duration argument/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse(1.5 s)\nexit\n',
  ],
  [
    "({n: n}).n into duration argument/({n: n}).n s",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse(({n: n}).n s)\nexit\n',
  ],
  [
    '"${n}".length into duration argument/"${n}".length s',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: duration) {\n  say p\n}\nuse("${n}".length s)\nexit\n',
  ],
  [
    "90 into angle declaration/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: angle = 90 deg\nexit\n',
  ],
  [
    "90 into angle assignment/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: angle = 1 deg\np = 90 deg\nexit\n',
  ],
  [
    "90 into property/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: 1 deg}\nbox.p = 90 deg\nexit\n',
  ],
  [
    "90 into angle element/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet ps: angle[] = [1 deg]\nps.add(90 deg)\nexit\n',
  ],
  [
    "90 into angle argument/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: angle) {\n  say p\n}\nuse(90 deg)\nexit\n',
  ],
  [
    '"2026-10-28" into date declaration/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: date = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into date assignment/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: date = toDate("2026-01-01")\np = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into property/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: toDate("2026-01-01")}\nbox.p = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into date argument/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: date) {\n  say p\n}\nuse(toDate("2026-10-28"))\nexit\n',
  ],
  [
    '"10:30" into time declaration/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: time = toTime("10:30")\nexit\n',
  ],
  [
    '"10:30" into property/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: toTime("10:00")}\nbox.p = toTime("10:30")\nexit\n',
  ],
  [
    '"10:30" into time argument/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: time) {\n  say p\n}\nuse(toTime("10:30"))\nexit\n',
  ],
  [
    'true into string declaration/"${true}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "${true}"\nexit\n',
  ],
  [
    '5 into string assignment/"${5}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet p: string = "x"\np = "${5}"\nexit\n',
  ],
  [
    'true into property/"${true}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nlet box = {p: "x"}\nbox.p = "${true}"\nexit\n',
  ],
  [
    'true into string argument/"${true}"',
    'let n = 2\nlet s = "2026-10-28"\nlet d = dict{found: 2}\nlet ns = [2]\nlet boxes = [{n: 2}, null]\nlet maybe = boxes[1]\nlet held = dict{a: {n: 2}, b: null}.values.random\nlet outer = {inner: boxes[1]}\nlet fine = {n: 2}\nlet maybeN = [2, null].random\nfunction use(p: string) {\n  say p\n}\nuse("${true}")\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node $W/tools/pastefam.mjs $W/c1 $O/paste2-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/c1-paste.sh:10",
    ],
    [
      "node $T/pastefam.mjs $W/c2 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-c2.sh:17",
    ],
    [
      "node $W/tools/pastefam.mjs $W/c2 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/c2-b1.sh:11",
    ],
    [
      "node $T/pastefam.mjs $W/c3 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-c3.sh:15",
    ],
    [
      "node $W/tools/pastefam.mjs $W/c3 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/c3-b1.sh:12",
    ],
    [
      "node $T/pastefam.mjs $W/c3 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c4.sh:15",
    ],
    [
      "node $T/pastefam.mjs $W/c9 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c9.sh:13",
    ],
    [
      "node $T/pastefam.mjs $W/c10 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c10.sh:11",
    ],
    [
      "node $T/pastefam.mjs $W/c11 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c11.sh:11",
    ],
    [
      "node $T/pastefam.mjs $W/c12 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c12.sh:11",
    ],
    [
      "node $T/pastefam.mjs $W/c13 $O/paste-$i.jsonl $i/4",
      "desktop:/home/peter/work/evidence/1310/8e9da29fbe8749ef191d98f088b98a86d3eee332/tools/queue-c13.sh:11",
    ],
  ],
  sources: 451,
  sha256: "5bdc92f466b7e8665fca2902425e0f9d3e77a41eddf6406a30f8eff8db8d2e7e",
};
