// the forms #1241 r1's paste runs pasted, each compiled and, where it compiled, analysed; #1241, Astra r1
// (R/astra-m4-i1241-review/paste.mjs on the head, in full and sampled, and on a mutant that offers every form whatever
// fits). The cases it read from the repository's paste family (`pasteCases`, `tests/helpers/type-core-paste.ts`) are not
// copied; the programs it pasted from them are, as `paste-clean.json`, `paste-mutant.json` and `paste-clean-sample.json`
// record them. A form with a compile error was only compiled, without globals.
export const cases = [
  ["text size at say/t.length", 'let t = "hello"\nsay t.length\nexit\n'],
  ["text size at declaration/t.length", 'let t = "hello"\nlet v = t.length\nsay v\nexit\n'],
  [
    "text size at integer declaration/t.length",
    'let t = "hello"\nlet v: integer = t.length\nexit\n',
  ],
  ["text size at number declaration/t.length", 'let t = "hello"\nlet v: number = t.length\nexit\n'],
  ["text size at sum/t.length", 'let t = "hello"\nsay t.length + 1\nexit\n'],
  ["text size at product/t.length", 'let t = "hello"\nsay 2 * t.length\nexit\n'],
  ["text size at comparison/t.length", 'let t = "hello"\nsay t.length > 2\nexit\n'],
  [
    "text size at integer argument/t.length",
    'let t = "hello"\nfunction count(p: integer) {\n  say p\n}\ncount(t.length)\nexit\n',
  ],
  ["text size at interpolation/t.length", 'let t = "hello"\nsay "${t.length}"\nexit\n'],
  ["text size at count/t.length", 'let t = "hello"\nrepeat t.length {\n  say "x"\n}\nexit\n'],
  [
    "text size at range bound/t.length",
    'let t = "hello"\nfor i in 1..t.length {\n  say i\n}\nexit\n',
  ],
  [
    "text size at untyped argument/t.length",
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(t.length)\nexit\n',
  ],
  [
    "text size at untyped sum argument/t.length",
    'let t = "hello"\nfunction count(p) {\n  return p + 1\n}\nsay count(t.length)\nexit\n',
  ],
  ["text size at divisor/t.length", 'let t = "hello"\nsay 1 / t.length\nexit\n'],
  [
    "text size at interpolation divisor/t.length",
    'let t = "hello"\nsay 1 / toInteger("${t.length}", default: 1)\nexit\n',
  ],
  [
    "nested text size at say/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length\nexit\n',
  ],
  [
    "nested text size at declaration/box.label.length",
    'let box = {label: "hello"}\nlet v = box.label.length\nsay v\nexit\n',
  ],
  [
    "nested text size at integer declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: integer = box.label.length\nexit\n',
  ],
  [
    "nested text size at number declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: number = box.label.length\nexit\n',
  ],
  [
    "nested text size at sum/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length + 1\nexit\n',
  ],
  [
    "nested text size at product/box.label.length",
    'let box = {label: "hello"}\nsay 2 * box.label.length\nexit\n',
  ],
  [
    "nested text size at comparison/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length > 2\nexit\n',
  ],
  [
    "nested text size at integer argument/box.label.length",
    'let box = {label: "hello"}\nfunction count(p: integer) {\n  say p\n}\ncount(box.label.length)\nexit\n',
  ],
  [
    "nested text size at interpolation/box.label.length",
    'let box = {label: "hello"}\nsay "${box.label.length}"\nexit\n',
  ],
  [
    "nested text size at count/box.label.length",
    'let box = {label: "hello"}\nrepeat box.label.length {\n  say "x"\n}\nexit\n',
  ],
  [
    "nested text size at range bound/box.label.length",
    'let box = {label: "hello"}\nfor i in 1..box.label.length {\n  say i\n}\nexit\n',
  ],
  [
    "nested text size at untyped argument/box.label.length",
    'let box = {label: "hello"}\nfunction show(p) {\n  say p\n}\nshow(box.label.length)\nexit\n',
  ],
  [
    "nested text size at untyped sum argument/box.label.length",
    'let box = {label: "hello"}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.label.length)\nexit\n',
  ],
  [
    "nested text size at divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / box.label.length\nexit\n',
  ],
  [
    "nested text size at interpolation divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / toInteger("${box.label.length}", default: 1)\nexit\n',
  ],
  [
    "element text size at say/items[0].length",
    'let items = ["hello"]\nsay items[0].length\nexit\n',
  ],
  [
    "element text size at declaration/items[0].length",
    'let items = ["hello"]\nlet v = items[0].length\nsay v\nexit\n',
  ],
  [
    "element text size at integer declaration/items[0].length",
    'let items = ["hello"]\nlet v: integer = items[0].length\nexit\n',
  ],
  [
    "element text size at number declaration/items[0].length",
    'let items = ["hello"]\nlet v: number = items[0].length\nexit\n',
  ],
  [
    "element text size at sum/items[0].length",
    'let items = ["hello"]\nsay items[0].length + 1\nexit\n',
  ],
  [
    "element text size at product/items[0].length",
    'let items = ["hello"]\nsay 2 * items[0].length\nexit\n',
  ],
  [
    "element text size at comparison/items[0].length",
    'let items = ["hello"]\nsay items[0].length > 2\nexit\n',
  ],
  [
    "element text size at integer argument/items[0].length",
    'let items = ["hello"]\nfunction count(p: integer) {\n  say p\n}\ncount(items[0].length)\nexit\n',
  ],
  [
    "element text size at interpolation/items[0].length",
    'let items = ["hello"]\nsay "${items[0].length}"\nexit\n',
  ],
  [
    "element text size at count/items[0].length",
    'let items = ["hello"]\nrepeat items[0].length {\n  say "x"\n}\nexit\n',
  ],
  [
    "element text size at range bound/items[0].length",
    'let items = ["hello"]\nfor i in 1..items[0].length {\n  say i\n}\nexit\n',
  ],
  [
    "element text size at untyped argument/items[0].length",
    'let items = ["hello"]\nfunction show(p) {\n  say p\n}\nshow(items[0].length)\nexit\n',
  ],
  [
    "element text size at untyped sum argument/items[0].length",
    'let items = ["hello"]\nfunction count(p) {\n  return p + 1\n}\nsay count(items[0].length)\nexit\n',
  ],
  [
    "element text size at divisor/items[0].length",
    'let items = ["hello"]\nsay 1 / items[0].length\nexit\n',
  ],
  [
    "element text size at interpolation divisor/items[0].length",
    'let items = ["hello"]\nsay 1 / toInteger("${items[0].length}", default: 1)\nexit\n',
  ],
  ["text toUpperCase at say/t.uppercase()", 'let t = "hello"\nsay t.uppercase()\nexit\n'],
  [
    "text toUpperCase at declaration/t.uppercase()",
    'let t = "hello"\nlet v = t.uppercase()\nsay v\nexit\n',
  ],
  [
    "text toUpperCase at string declaration/t.uppercase()",
    'let t = "hello"\nlet v: string = t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at text store/t.uppercase()",
    'let t = "hello"\nlet v = "x"\nv = t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at text join/t.uppercase()",
    'let t = "hello"\nsay "a" + t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at text argument/t.uppercase()",
    'let t = "hello"\nfunction show(p: string) {\n  say p\n}\nshow(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at interpolation/t.uppercase()",
    'let t = "hello"\nsay "${t.uppercase()}"\nexit\n',
  ],
  [
    "text toUpperCase at receiver/t.uppercase()",
    'let t = "hello"\nsay t.uppercase().length\nexit\n',
  ],
  [
    "text toUpperCase at untyped argument/t.uppercase()",
    'let t = "hello"\nfunction show(p) {\n  say p\n}\nshow(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at untyped compound/t.uppercase()",
    'let t = "hello"\nlet v = t.uppercase()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "text toUpperCase at untyped compound argument/t.uppercase()",
    'let t = "hello"\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at untyped returned argument/t.uppercase()",
    'let t = "hello"\nfunction id(p) {\n  return p\n}\nlet w: string = id(t.uppercase())\nsay w\nexit\n',
  ],
  [
    "text toUpperCase at interpolation divisor/t.uppercase()",
    'let t = "hello"\nsay 1 / toInteger("${t.uppercase()}", default: 1)\nexit\n',
  ],
  ["text trim at say/t.trim()", 'let t = " hello "\nsay t.trim()\nexit\n'],
  ["text trim at declaration/t.trim()", 'let t = " hello "\nlet v = t.trim()\nsay v\nexit\n'],
  [
    "text trim at string declaration/t.trim()",
    'let t = " hello "\nlet v: string = t.trim()\nexit\n',
  ],
  ["text trim at text store/t.trim()", 'let t = " hello "\nlet v = "x"\nv = t.trim()\nexit\n'],
  ["text trim at text join/t.trim()", 'let t = " hello "\nsay "a" + t.trim()\nexit\n'],
  [
    "text trim at text argument/t.trim()",
    'let t = " hello "\nfunction show(p: string) {\n  say p\n}\nshow(t.trim())\nexit\n',
  ],
  ["text trim at interpolation/t.trim()", 'let t = " hello "\nsay "${t.trim()}"\nexit\n'],
  ["text trim at receiver/t.trim()", 'let t = " hello "\nsay t.trim().length\nexit\n'],
  [
    "text trim at untyped argument/t.trim()",
    'let t = " hello "\nfunction show(p) {\n  say p\n}\nshow(t.trim())\nexit\n',
  ],
  [
    "text trim at untyped returned argument/t.trim()",
    'let t = " hello "\nfunction id(p) {\n  return p\n}\nlet w: string = id(t.trim())\nsay w\nexit\n',
  ],
  [
    "text trim at interpolation divisor/t.trim()",
    'let t = " hello "\nsay 1 / toInteger("${t.trim()}", default: 1)\nexit\n',
  ],
  ["angle degrees at say/toDeg(a)", "let a = 90 deg\nsay toDeg(a)\nexit\n"],
  ["angle degrees at declaration/toDeg(a)", "let a = 90 deg\nlet v = toDeg(a)\nsay v\nexit\n"],
  [
    "angle degrees at number declaration/toDeg(a)",
    "let a = 90 deg\nlet v: number = toDeg(a)\nexit\n",
  ],
  ["angle degrees at sum/toDeg(a)", "let a = 90 deg\nsay toDeg(a) + 1\nexit\n"],
  ["angle degrees at product/toDeg(a)", "let a = 90 deg\nsay 2 * toDeg(a)\nexit\n"],
  ["angle degrees at comparison/toDeg(a)", "let a = 90 deg\nsay toDeg(a) > 2\nexit\n"],
  ["angle degrees at interpolation/toDeg(a)", 'let a = 90 deg\nsay "${toDeg(a)}"\nexit\n'],
  [
    "angle degrees at untyped argument/toDeg(a)",
    "let a = 90 deg\nfunction show(p) {\n  say p\n}\nshow(toDeg(a))\nexit\n",
  ],
  [
    "angle degrees at untyped sum argument/toDeg(a)",
    "let a = 90 deg\nfunction count(p) {\n  return p + 1\n}\nsay count(toDeg(a))\nexit\n",
  ],
  ["angle degrees at divisor/toDeg(a)", "let a = 90 deg\nsay 1 / toDeg(a)\nexit\n"],
  [
    "angle degrees at interpolation divisor/toDeg(a)",
    'let a = 90 deg\nsay 1 / toInteger("${toDeg(a)}", default: 1)\nexit\n',
  ],
  ["join of text at say/items.join()", 'let items = ["a"]\nsay items.join()\nexit\n'],
  [
    "join of text at declaration/items.join()",
    'let items = ["a"]\nlet v = items.join()\nsay v\nexit\n',
  ],
  [
    "join of text at string declaration/items.join()",
    'let items = ["a"]\nlet v: string = items.join()\nexit\n',
  ],
  [
    "join of text at text store/items.join()",
    'let items = ["a"]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of text at text join/items.join()", 'let items = ["a"]\nsay "a" + items.join()\nexit\n'],
  [
    "join of text at text argument/items.join()",
    'let items = ["a"]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n',
  ],
  [
    "join of text at interpolation/items.join()",
    'let items = ["a"]\nsay "${items.join()}"\nexit\n',
  ],
  ["join of text at receiver/items.join()", 'let items = ["a"]\nsay items.join().length\nexit\n'],
  [
    "join of text at untyped argument/items.join()",
    'let items = ["a"]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n',
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
    "nested join of text at declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v = box.items.join()\nsay v\nexit\n',
  ],
  [
    "nested join of text at string declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: string = box.items.join()\nexit\n',
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
    "nested join of text at text argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at interpolation/box.items.join()",
    'let box = {items: ["a"]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of text at receiver/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join().length\nexit\n',
  ],
  [
    "nested join of text at untyped argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at untyped returned argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n',
  ],
  [
    "nested join of text at interpolation divisor/box.items.join()",
    'let box = {items: ["a"]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  ["join of integer at say/items.join()", "let items = [1]\nsay items.join()\nexit\n"],
  [
    "join of integer at declaration/items.join()",
    "let items = [1]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "join of integer at string declaration/items.join()",
    "let items = [1]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of integer at text store/items.join()",
    'let items = [1]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of integer at text join/items.join()", 'let items = [1]\nsay "a" + items.join()\nexit\n'],
  [
    "join of integer at text argument/items.join()",
    "let items = [1]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of integer at interpolation/items.join()",
    'let items = [1]\nsay "${items.join()}"\nexit\n',
  ],
  ["join of integer at receiver/items.join()", "let items = [1]\nsay items.join().length\nexit\n"],
  [
    "join of integer at untyped argument/items.join()",
    "let items = [1]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
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
    "nested join of integer at declaration/box.items.join()",
    "let box = {items: [1]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of integer at string declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: string = box.items.join()\nexit\n",
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
    "nested join of integer at text argument/box.items.join()",
    "let box = {items: [1]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of integer at interpolation/box.items.join()",
    'let box = {items: [1]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of integer at receiver/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join().length\nexit\n",
  ],
  [
    "nested join of integer at untyped argument/box.items.join()",
    "let box = {items: [1]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of integer at untyped returned argument/box.items.join()",
    "let box = {items: [1]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of integer at interpolation divisor/box.items.join()",
    'let box = {items: [1]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  ["join of number at say/items.join()", "let items = [1.5]\nsay items.join()\nexit\n"],
  [
    "join of number at declaration/items.join()",
    "let items = [1.5]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "join of number at string declaration/items.join()",
    "let items = [1.5]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of number at text store/items.join()",
    'let items = [1.5]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  ["join of number at text join/items.join()", 'let items = [1.5]\nsay "a" + items.join()\nexit\n'],
  [
    "join of number at text argument/items.join()",
    "let items = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of number at interpolation/items.join()",
    'let items = [1.5]\nsay "${items.join()}"\nexit\n',
  ],
  ["join of number at receiver/items.join()", "let items = [1.5]\nsay items.join().length\nexit\n"],
  [
    "join of number at untyped argument/items.join()",
    "let items = [1.5]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
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
    "nested join of number at declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of number at string declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: string = box.items.join()\nexit\n",
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
    "nested join of number at text argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of number at interpolation/box.items.join()",
    'let box = {items: [1.5]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of number at receiver/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join().length\nexit\n",
  ],
  [
    "nested join of number at untyped argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of number at untyped returned argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of number at interpolation divisor/box.items.join()",
    'let box = {items: [1.5]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  ["join of boolean at say/items.join()", "let items = [true]\nsay items.join()\nexit\n"],
  [
    "join of boolean at declaration/items.join()",
    "let items = [true]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "join of boolean at string declaration/items.join()",
    "let items = [true]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of boolean at text store/items.join()",
    'let items = [true]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  [
    "join of boolean at text join/items.join()",
    'let items = [true]\nsay "a" + items.join()\nexit\n',
  ],
  [
    "join of boolean at text argument/items.join()",
    "let items = [true]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of boolean at interpolation/items.join()",
    'let items = [true]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of boolean at receiver/items.join()",
    "let items = [true]\nsay items.join().length\nexit\n",
  ],
  [
    "join of boolean at untyped argument/items.join()",
    "let items = [true]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
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
    "nested join of boolean at declaration/box.items.join()",
    "let box = {items: [true]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of boolean at string declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: string = box.items.join()\nexit\n",
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
    "nested join of boolean at text argument/box.items.join()",
    "let box = {items: [true]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of boolean at interpolation/box.items.join()",
    'let box = {items: [true]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of boolean at receiver/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join().length\nexit\n",
  ],
  [
    "nested join of boolean at untyped argument/box.items.join()",
    "let box = {items: [true]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of boolean at untyped returned argument/box.items.join()",
    "let box = {items: [true]}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.items.join())\nsay w\nexit\n",
  ],
  [
    "nested join of boolean at interpolation divisor/box.items.join()",
    'let box = {items: [true]}\nsay 1 / toInteger("${box.items.join()}", default: 1)\nexit\n',
  ],
  ["join of duration at say/items.join()", "let items = [1 s]\nsay items.join()\nexit\n"],
  [
    "join of duration at declaration/items.join()",
    "let items = [1 s]\nlet v = items.join()\nsay v\nexit\n",
  ],
  [
    "join of duration at string declaration/items.join()",
    "let items = [1 s]\nlet v: string = items.join()\nexit\n",
  ],
  [
    "join of duration at text store/items.join()",
    'let items = [1 s]\nlet v = "x"\nv = items.join()\nexit\n',
  ],
  [
    "join of duration at text join/items.join()",
    'let items = [1 s]\nsay "a" + items.join()\nexit\n',
  ],
  [
    "join of duration at text argument/items.join()",
    "let items = [1 s]\nfunction show(p: string) {\n  say p\n}\nshow(items.join())\nexit\n",
  ],
  [
    "join of duration at interpolation/items.join()",
    'let items = [1 s]\nsay "${items.join()}"\nexit\n',
  ],
  [
    "join of duration at receiver/items.join()",
    "let items = [1 s]\nsay items.join().length\nexit\n",
  ],
  [
    "join of duration at untyped argument/items.join()",
    "let items = [1 s]\nfunction show(p) {\n  say p\n}\nshow(items.join())\nexit\n",
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
    "nested join of duration at declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v = box.items.join()\nsay v\nexit\n",
  ],
  [
    "nested join of duration at string declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: string = box.items.join()\nexit\n",
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
    "nested join of duration at text argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction show(p: string) {\n  say p\n}\nshow(box.items.join())\nexit\n",
  ],
  [
    "nested join of duration at interpolation/box.items.join()",
    'let box = {items: [1 s]}\nsay "${box.items.join()}"\nexit\n',
  ],
  [
    "nested join of duration at receiver/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join().length\nexit\n",
  ],
  [
    "nested join of duration at untyped argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction show(p) {\n  say p\n}\nshow(box.items.join())\nexit\n",
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
    'list of text + text at declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v = xs + ["a"]\nsay v\nexit\n',
  ],
  [
    'list of text + text at declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v = xs\nsay v\nexit\n',
  ],
  [
    'list of text + text at string[] declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: string[] = xs + ["a"]\nexit\n',
  ],
  [
    'list of text + text at string[] declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: string[] = xs\nexit\n',
  ],
  [
    'list of text + text at receiver/(xs + ["a"])',
    'let xs = ["a"]\nsay ((xs + ["a"])).length\nexit\n',
  ],
  [
    'list of text + text at receiver/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay (xs).length\nexit\n',
  ],
  [
    'list of text + text at untyped argument/xs + ["a"]',
    'let xs = ["a"]\nfunction show(p) {\n  say p\n}\nshow(xs + ["a"])\nexit\n',
  ],
  [
    'list of text + text at untyped argument/xs.add("a")',
    'let xs = ["a"]\nfunction show(p) {\n  say p\n}\nxs.add("a")\nshow(xs)\nexit\n',
  ],
  ["list of integer + integer at say/xs + [1]", "let xs = [1]\nsay xs + [1]\nexit\n"],
  ["list of integer + integer at say/xs.add(1)", "let xs = [1]\nxs.add(1)\nsay xs\nexit\n"],
  [
    "list of integer + integer at declaration/xs + [1]",
    "let xs = [1]\nlet v = xs + [1]\nsay v\nexit\n",
  ],
  [
    "list of integer + integer at declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v = xs\nsay v\nexit\n",
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
    "list of integer + integer at receiver/(xs + [1])",
    "let xs = [1]\nsay ((xs + [1])).length\nexit\n",
  ],
  [
    "list of integer + integer at receiver/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nsay (xs).length\nexit\n",
  ],
  [
    "list of integer + integer at untyped argument/xs + [1]",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(xs + [1])\nexit\n",
  ],
  [
    "list of integer + integer at untyped argument/xs.add(1)",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
  ],
  ["integer + list of integer at say/[1] + xs", "let xs = [1]\nsay [1] + xs\nexit\n"],
  [
    "integer + list of integer at declaration/[1] + xs",
    "let xs = [1]\nlet v = [1] + xs\nsay v\nexit\n",
  ],
  [
    "integer + list of integer at integer[] declaration/[1] + xs",
    "let xs = [1]\nlet v: integer[] = [1] + xs\nexit\n",
  ],
  [
    "integer + list of integer at receiver/([1] + xs)",
    "let xs = [1]\nsay (([1] + xs)).length\nexit\n",
  ],
  [
    "integer + list of integer at untyped argument/[1] + xs",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow([1] + xs)\nexit\n",
  ],
  ["list of number + integer at say/xs + [1]", "let xs = [1.5]\nsay xs + [1]\nexit\n"],
  ["list of number + integer at say/xs.add(1)", "let xs = [1.5]\nxs.add(1)\nsay xs\nexit\n"],
  [
    "list of number + integer at declaration/xs + [1]",
    "let xs = [1.5]\nlet v = xs + [1]\nsay v\nexit\n",
  ],
  [
    "list of number + integer at declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v = xs\nsay v\nexit\n",
  ],
  [
    "list of number + integer at receiver/(xs + [1])",
    "let xs = [1.5]\nsay ((xs + [1])).length\nexit\n",
  ],
  [
    "list of number + integer at receiver/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nsay (xs).length\nexit\n",
  ],
  [
    "list of number + integer at untyped argument/xs + [1]",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow(xs + [1])\nexit\n",
  ],
  [
    "list of number + integer at untyped argument/xs.add(1)",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
  ],
  ["integer + list of number at say/[1] + xs", "let xs = [1.5]\nsay [1] + xs\nexit\n"],
  [
    "integer + list of number at declaration/[1] + xs",
    "let xs = [1.5]\nlet v = [1] + xs\nsay v\nexit\n",
  ],
  [
    "integer + list of number at receiver/([1] + xs)",
    "let xs = [1.5]\nsay (([1] + xs)).length\nexit\n",
  ],
  [
    "integer + list of number at untyped argument/[1] + xs",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow([1] + xs)\nexit\n",
  ],
  ["list of number + number at say/xs + [1.5]", "let xs = [1.5]\nsay xs + [1.5]\nexit\n"],
  ["list of number + number at say/xs.add(1.5)", "let xs = [1.5]\nxs.add(1.5)\nsay xs\nexit\n"],
  [
    "list of number + number at declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v = xs + [1.5]\nsay v\nexit\n",
  ],
  [
    "list of number + number at declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v = xs\nsay v\nexit\n",
  ],
  [
    "list of number + number at receiver/(xs + [1.5])",
    "let xs = [1.5]\nsay ((xs + [1.5])).length\nexit\n",
  ],
  [
    "list of number + number at receiver/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nsay (xs).length\nexit\n",
  ],
  [
    "list of number + number at untyped argument/xs + [1.5]",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow(xs + [1.5])\nexit\n",
  ],
  [
    "list of number + number at untyped argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nxs.add(1.5)\nshow(xs)\nexit\n",
  ],
  ["number + list of number at say/[1.5] + xs", "let xs = [1.5]\nsay [1.5] + xs\nexit\n"],
  [
    "number + list of number at declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v = [1.5] + xs\nsay v\nexit\n",
  ],
  [
    "number + list of number at receiver/([1.5] + xs)",
    "let xs = [1.5]\nsay (([1.5] + xs)).length\nexit\n",
  ],
  [
    "number + list of number at untyped argument/[1.5] + xs",
    "let xs = [1.5]\nfunction show(p) {\n  say p\n}\nshow([1.5] + xs)\nexit\n",
  ],
  ["list + range at say/(1..3).toList()", "let xs = [1]\nsay xs + ((1..3).toList())\nexit\n"],
  [
    "list + range at declaration/(1..3).toList()",
    "let xs = [1]\nlet v = xs + ((1..3).toList())\nsay v\nexit\n",
  ],
  [
    "list + range at integer[] declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer[] = xs + ((1..3).toList())\nexit\n",
  ],
  [
    "list + range at receiver/(1..3).toList()",
    "let xs = [1]\nsay (xs + ((1..3).toList())).length\nexit\n",
  ],
  [
    "list + range at untyped argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(xs + ((1..3).toList()))\nexit\n",
  ],
  ["range + list at say/(1..3).toList()", "let xs = [1]\nsay ((1..3).toList()) + xs\nexit\n"],
  [
    "range + list at declaration/(1..3).toList()",
    "let xs = [1]\nlet v = ((1..3).toList()) + xs\nsay v\nexit\n",
  ],
  [
    "range + list at integer[] declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer[] = ((1..3).toList()) + xs\nexit\n",
  ],
  [
    "range + list at receiver/(1..3).toList()",
    "let xs = [1]\nsay (((1..3).toList()) + xs).length\nexit\n",
  ],
  [
    "range + list at untyped argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p) {\n  say p\n}\nshow(((1..3).toList()) + xs)\nexit\n",
  ],
  [
    "null element at integer declaration/xs[1] otherwise 0",
    "let xs = [4, null]\nlet v: integer = xs[1] otherwise 0\nexit\n",
  ],
  [
    "null element at sum/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay (xs[1] otherwise 0) + 1\nexit\n",
  ],
  [
    "null element at product/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay 2 * (xs[1] otherwise 0)\nexit\n",
  ],
  [
    "null element at comparison/(xs[1] otherwise 0)",
    "let xs = [4, null]\nsay (xs[1] otherwise 0) > 2\nexit\n",
  ],
  [
    "null element at integer argument/xs[1] otherwise 0",
    "let xs = [4, null]\nfunction count(p: integer) {\n  say p\n}\ncount(xs[1] otherwise 0)\nexit\n",
  ],
  [
    "null element at count/xs[1] otherwise 0",
    'let xs = [4, null]\nrepeat xs[1] otherwise 0 {\n  say "x"\n}\nexit\n',
  ],
  [
    'null element\'s length at say/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nsay (xs[1] otherwise "").length\nexit\n',
  ],
  [
    'null element\'s length at integer declaration/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nlet v: integer = (xs[1] otherwise "").length\nexit\n',
  ],
  [
    'null element\'s length at sum/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nsay (xs[1] otherwise "").length + 1\nexit\n',
  ],
  [
    'null element\'s length at integer argument/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nfunction count(p: integer) {\n  say p\n}\ncount((xs[1] otherwise "").length)\nexit\n',
  ],
  [
    'null element\'s length at count/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nrepeat (xs[1] otherwise "").length {\n  say "x"\n}\nexit\n',
  ],
  [
    'null element\'s length at untyped argument/(xs[1] otherwise "")',
    'let xs = ["ab", null]\nfunction show(p) {\n  say p\n}\nshow((xs[1] otherwise "").length)\nexit\n',
  ],
  [
    "3 into duration declaration/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 3 s\nexit\n',
  ],
  [
    "n + 1 into duration declaration/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = (n + 1) s\nexit\n',
  ],
  [
    "-3 into duration declaration/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = (-3) s\nexit\n',
  ],
  [
    "1.5 into duration declaration/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 1.5 s\nexit\n',
  ],
  [
    "3 into duration assignment/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 1 s\np = 3 s\nexit\n',
  ],
  [
    "n + 1 into duration assignment/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 1 s\np = (n + 1) s\nexit\n',
  ],
  [
    "-3 into duration assignment/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 1 s\np = (-3) s\nexit\n',
  ],
  [
    "1.5 into duration assignment/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet p: duration = 1 s\np = 1.5 s\nexit\n',
  ],
  [
    "3 into property/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 s}\nbox.p = 3 s\nexit\n',
  ],
  [
    "n + 1 into property/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 s}\nbox.p = (n + 1) s\nexit\n',
  ],
  [
    "-3 into property/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 s}\nbox.p = (-3) s\nexit\n',
  ],
  [
    "1.5 into property/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 s}\nbox.p = 1.5 s\nexit\n',
  ],
  [
    "3 into duration element/3 s",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: duration[] = [1 s]\nps.add(3 s)\nexit\n',
  ],
  [
    "n + 1 into duration element/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: duration[] = [1 s]\nps.add((n + 1) s)\nexit\n',
  ],
  [
    "-3 into duration element/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: duration[] = [1 s]\nps.add((-3) s)\nexit\n',
  ],
  [
    "1.5 into duration element/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: duration[] = [1 s]\nps.add(1.5 s)\nexit\n',
  ],
  [
    "3 into duration argument/3 s",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: duration) {\n  say p\n}\nuse(3 s)\nexit\n',
  ],
  [
    "n + 1 into duration argument/(n + 1) s",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: duration) {\n  say p\n}\nuse((n + 1) s)\nexit\n',
  ],
  [
    "-3 into duration argument/(-3) s",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: duration) {\n  say p\n}\nuse((-3) s)\nexit\n',
  ],
  [
    "1.5 into duration argument/1.5 s",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: duration) {\n  say p\n}\nuse(1.5 s)\nexit\n',
  ],
  [
    "90 into angle declaration/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet p: angle = 90 deg\nexit\n',
  ],
  [
    "n into angle declaration/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet p: angle = n deg\nexit\n',
  ],
  [
    "90 into angle assignment/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet p: angle = 1 deg\np = 90 deg\nexit\n',
  ],
  [
    "n into angle assignment/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet p: angle = 1 deg\np = n deg\nexit\n',
  ],
  [
    "90 into property/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 deg}\nbox.p = 90 deg\nexit\n',
  ],
  [
    "n into property/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: 1 deg}\nbox.p = n deg\nexit\n',
  ],
  [
    "90 into angle element/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: angle[] = [1 deg]\nps.add(90 deg)\nexit\n',
  ],
  [
    "n into angle element/n deg",
    'let n = 2\nlet s = "2026-10-28"\nlet ps: angle[] = [1 deg]\nps.add(n deg)\nexit\n',
  ],
  [
    "90 into angle argument/90 deg",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: angle) {\n  say p\n}\nuse(90 deg)\nexit\n',
  ],
  [
    "n into angle argument/n deg",
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: angle) {\n  say p\n}\nuse(n deg)\nexit\n',
  ],
  [
    '"2026-10-28" into date declaration/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet p: date = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into date assignment/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet p: date = toDate("2026-01-01")\np = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into property/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: toDate("2026-01-01")}\nbox.p = toDate("2026-10-28")\nexit\n',
  ],
  [
    '"2026-10-28" into date argument/toDate("2026-10-28")',
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: date) {\n  say p\n}\nuse(toDate("2026-10-28"))\nexit\n',
  ],
  [
    '"10:30" into time declaration/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet p: time = toTime("10:30")\nexit\n',
  ],
  [
    '"10:30" into time assignment/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet p: time = toTime("10:00")\np = toTime("10:30")\nexit\n',
  ],
  [
    '"10:30" into property/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: toTime("10:00")}\nbox.p = toTime("10:30")\nexit\n',
  ],
  [
    '"10:30" into time argument/toTime("10:30")',
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: time) {\n  say p\n}\nuse(toTime("10:30"))\nexit\n',
  ],
  [
    'n into string declaration/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet p: string = "${n}"\nexit\n',
  ],
  [
    'n into string assignment/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet p: string = "x"\np = "${n}"\nexit\n',
  ],
  [
    'n into property/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nlet box = {p: "x"}\nbox.p = "${n}"\nexit\n',
  ],
  [
    'n into string argument/"${n}"',
    'let n = 2\nlet s = "2026-10-28"\nfunction use(p: string) {\n  say p\n}\nuse("${n}")\nexit\n',
  ],
  [
    "text size at string declaration/t.length",
    'let t = "hello"\nlet v: string = t.length\nexit\n',
    [],
  ],
  [
    "text size at boolean declaration/t.length",
    'let t = "hello"\nlet v: boolean = t.length\nexit\n',
    [],
  ],
  [
    "text size at string[] declaration/t.length",
    'let t = "hello"\nlet v: string[] = t.length\nexit\n',
    [],
  ],
  [
    "text size at integer[] declaration/t.length",
    'let t = "hello"\nlet v: integer[] = t.length\nexit\n',
    [],
  ],
  ["text size at text store/t.length", 'let t = "hello"\nlet v = "x"\nv = t.length\nexit\n', []],
  ["text size at text join/t.length", 'let t = "hello"\nsay "a" + t.length\nexit\n', []],
  ["text size at negation/t.length", 'let t = "hello"\nsay not t.length\nexit\n', []],
  ["text size at logic/t.length", 'let t = "hello"\nsay t.length and true\nexit\n', []],
  [
    "text size at text argument/t.length",
    'let t = "hello"\nfunction show(p: string) {\n  say p\n}\nshow(t.length)\nexit\n',
    [],
  ],
  ["text size at condition/t.length", 'let t = "hello"\nif t.length {\n  say "yes"\n}\nexit\n', []],
  ["text size at element/t.length", 'let t = "hello"\nlet ws = [t.length]\nsay ws.length\nexit\n'],
  ["text size at receiver/t.length", 'let t = "hello"\nsay t.length.length\nexit\n', []],
  ["text size at wait/t.length", 'let t = "hello"\nwait t.length\nexit\n', []],
  [
    "text size at iteration/t.length",
    'let t = "hello"\nfor v in t.length {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "text size at object store/t.length",
    'let t = "hello"\nlet o = {n: "x"}\no = t.length\nexit\n',
    [],
  ],
  [
    "text size at untyped variable's trim/t.length",
    'let t = "hello"\nlet v = t.length\nsay v.trim()\nexit\n',
    [],
  ],
  [
    "text size at untyped trim argument/t.length",
    'let t = "hello"\nfunction use(p) {\n  say p.trim()\n}\nuse(t.length)\nexit\n',
  ],
  [
    "text size at untyped compound/t.length",
    'let t = "hello"\nlet v = t.length\nv += "x"\nsay v\nexit\n',
    [],
  ],
  [
    "text size at untyped compound argument/t.length",
    'let t = "hello"\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.length)\nexit\n',
  ],
  [
    "text size at fallback/t.length",
    'let t = "hello"\nlet n: integer? = null\nsay n otherwise t.length\nexit\n',
  ],
  [
    "text size at default/t.length",
    'let t = "hello"\nlet ys = ["x"]\nsay ys.get(9, default: t.length)\nexit\n',
  ],
  [
    "text size at untyped returned argument/t.length",
    'let t = "hello"\nfunction id(p) {\n  return p\n}\nlet w: string = id(t.length)\nsay w\nexit\n',
  ],
  ["text size at literal divisor/t.length", 'let t = "hello"\nsay 1 / [t.length][0]\nexit\n'],
  ["text size at property divisor/t.length", 'let t = "hello"\nsay 1 / ({n: t.length}).n\nexit\n'],
  [
    "nested text size at string declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: string = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at boolean declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: boolean = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at string[] declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: string[] = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at integer[] declaration/box.label.length",
    'let box = {label: "hello"}\nlet v: integer[] = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at text store/box.label.length",
    'let box = {label: "hello"}\nlet v = "x"\nv = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at text join/box.label.length",
    'let box = {label: "hello"}\nsay "a" + box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at negation/box.label.length",
    'let box = {label: "hello"}\nsay not box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at logic/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length and true\nexit\n',
    [],
  ],
  [
    "nested text size at text argument/box.label.length",
    'let box = {label: "hello"}\nfunction show(p: string) {\n  say p\n}\nshow(box.label.length)\nexit\n',
    [],
  ],
  [
    "nested text size at condition/box.label.length",
    'let box = {label: "hello"}\nif box.label.length {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested text size at element/box.label.length",
    'let box = {label: "hello"}\nlet ws = [box.label.length]\nsay ws.length\nexit\n',
  ],
  [
    "nested text size at receiver/box.label.length",
    'let box = {label: "hello"}\nsay box.label.length.length\nexit\n',
    [],
  ],
  [
    "nested text size at wait/box.label.length",
    'let box = {label: "hello"}\nwait box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at iteration/box.label.length",
    'let box = {label: "hello"}\nfor v in box.label.length {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "nested text size at object store/box.label.length",
    'let box = {label: "hello"}\nlet o = {n: "x"}\no = box.label.length\nexit\n',
    [],
  ],
  [
    "nested text size at untyped variable's trim/box.label.length",
    'let box = {label: "hello"}\nlet v = box.label.length\nsay v.trim()\nexit\n',
    [],
  ],
  [
    "nested text size at untyped trim argument/box.label.length",
    'let box = {label: "hello"}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.label.length)\nexit\n',
  ],
  [
    "nested text size at untyped compound/box.label.length",
    'let box = {label: "hello"}\nlet v = box.label.length\nv += "x"\nsay v\nexit\n',
    [],
  ],
  [
    "nested text size at untyped compound argument/box.label.length",
    'let box = {label: "hello"}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.label.length)\nexit\n',
  ],
  [
    "nested text size at fallback/box.label.length",
    'let box = {label: "hello"}\nlet n: integer? = null\nsay n otherwise box.label.length\nexit\n',
  ],
  [
    "nested text size at default/box.label.length",
    'let box = {label: "hello"}\nlet ys = ["x"]\nsay ys.get(9, default: box.label.length)\nexit\n',
  ],
  [
    "nested text size at untyped returned argument/box.label.length",
    'let box = {label: "hello"}\nfunction id(p) {\n  return p\n}\nlet w: string = id(box.label.length)\nsay w\nexit\n',
  ],
  [
    "nested text size at literal divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / [box.label.length][0]\nexit\n',
  ],
  [
    "nested text size at property divisor/box.label.length",
    'let box = {label: "hello"}\nsay 1 / ({n: box.label.length}).n\nexit\n',
  ],
  [
    "element text size at string declaration/items[0].length",
    'let items = ["hello"]\nlet v: string = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at boolean declaration/items[0].length",
    'let items = ["hello"]\nlet v: boolean = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at string[] declaration/items[0].length",
    'let items = ["hello"]\nlet v: string[] = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at integer[] declaration/items[0].length",
    'let items = ["hello"]\nlet v: integer[] = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at text store/items[0].length",
    'let items = ["hello"]\nlet v = "x"\nv = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at text join/items[0].length",
    'let items = ["hello"]\nsay "a" + items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at negation/items[0].length",
    'let items = ["hello"]\nsay not items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at logic/items[0].length",
    'let items = ["hello"]\nsay items[0].length and true\nexit\n',
    [],
  ],
  [
    "element text size at text argument/items[0].length",
    'let items = ["hello"]\nfunction show(p: string) {\n  say p\n}\nshow(items[0].length)\nexit\n',
    [],
  ],
  [
    "element text size at condition/items[0].length",
    'let items = ["hello"]\nif items[0].length {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "element text size at element/items[0].length",
    'let items = ["hello"]\nlet ws = [items[0].length]\nsay ws.length\nexit\n',
  ],
  [
    "element text size at receiver/items[0].length",
    'let items = ["hello"]\nsay items[0].length.length\nexit\n',
    [],
  ],
  [
    "element text size at wait/items[0].length",
    'let items = ["hello"]\nwait items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at iteration/items[0].length",
    'let items = ["hello"]\nfor v in items[0].length {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "element text size at object store/items[0].length",
    'let items = ["hello"]\nlet o = {n: "x"}\no = items[0].length\nexit\n',
    [],
  ],
  [
    "element text size at untyped variable's trim/items[0].length",
    'let items = ["hello"]\nlet v = items[0].length\nsay v.trim()\nexit\n',
    [],
  ],
  [
    "element text size at untyped trim argument/items[0].length",
    'let items = ["hello"]\nfunction use(p) {\n  say p.trim()\n}\nuse(items[0].length)\nexit\n',
  ],
  [
    "element text size at untyped compound/items[0].length",
    'let items = ["hello"]\nlet v = items[0].length\nv += "x"\nsay v\nexit\n',
    [],
  ],
  [
    "element text size at untyped compound argument/items[0].length",
    'let items = ["hello"]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items[0].length)\nexit\n',
  ],
  [
    "element text size at fallback/items[0].length",
    'let items = ["hello"]\nlet n: integer? = null\nsay n otherwise items[0].length\nexit\n',
  ],
  [
    "element text size at default/items[0].length",
    'let items = ["hello"]\nlet ys = ["x"]\nsay ys.get(9, default: items[0].length)\nexit\n',
  ],
  [
    "element text size at untyped returned argument/items[0].length",
    'let items = ["hello"]\nfunction id(p) {\n  return p\n}\nlet w: string = id(items[0].length)\nsay w\nexit\n',
  ],
  [
    "element text size at literal divisor/items[0].length",
    'let items = ["hello"]\nsay 1 / [items[0].length][0]\nexit\n',
  ],
  [
    "element text size at property divisor/items[0].length",
    'let items = ["hello"]\nsay 1 / ({n: items[0].length}).n\nexit\n',
  ],
  [
    "text toUpperCase at integer declaration/t.uppercase()",
    'let t = "hello"\nlet v: integer = t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at number declaration/t.uppercase()",
    'let t = "hello"\nlet v: number = t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at boolean declaration/t.uppercase()",
    'let t = "hello"\nlet v: boolean = t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at string[] declaration/t.uppercase()",
    'let t = "hello"\nlet v: string[] = t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at integer[] declaration/t.uppercase()",
    'let t = "hello"\nlet v: integer[] = t.uppercase()\nexit\n',
    [],
  ],
  ["text toUpperCase at sum/t.uppercase()", 'let t = "hello"\nsay t.uppercase() + 1\nexit\n', []],
  [
    "text toUpperCase at product/t.uppercase()",
    'let t = "hello"\nsay 2 * t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at comparison/t.uppercase()",
    'let t = "hello"\nsay t.uppercase() > 2\nexit\n',
    [],
  ],
  [
    "text toUpperCase at negation/t.uppercase()",
    'let t = "hello"\nsay not t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at logic/t.uppercase()",
    'let t = "hello"\nsay t.uppercase() and true\nexit\n',
    [],
  ],
  [
    "text toUpperCase at integer argument/t.uppercase()",
    'let t = "hello"\nfunction count(p: integer) {\n  say p\n}\ncount(t.uppercase())\nexit\n',
    [],
  ],
  [
    "text toUpperCase at condition/t.uppercase()",
    'let t = "hello"\nif t.uppercase() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "text toUpperCase at element/t.uppercase()",
    'let t = "hello"\nlet ws = [t.uppercase()]\nsay ws.length\nexit\n',
  ],
  [
    "text toUpperCase at count/t.uppercase()",
    'let t = "hello"\nrepeat t.uppercase() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["text toUpperCase at wait/t.uppercase()", 'let t = "hello"\nwait t.uppercase()\nexit\n', []],
  [
    "text toUpperCase at iteration/t.uppercase()",
    'let t = "hello"\nfor v in t.uppercase() {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "text toUpperCase at range bound/t.uppercase()",
    'let t = "hello"\nfor i in 1..t.uppercase() {\n  say i\n}\nexit\n',
    [],
  ],
  [
    "text toUpperCase at object store/t.uppercase()",
    'let t = "hello"\nlet o = {n: "x"}\no = t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at untyped variable's trim/t.uppercase()",
    'let t = "hello"\nlet v = t.uppercase()\nsay v.trim()\nexit\n',
  ],
  [
    "text toUpperCase at untyped trim argument/t.uppercase()",
    'let t = "hello"\nfunction use(p) {\n  say p.trim()\n}\nuse(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at untyped sum argument/t.uppercase()",
    'let t = "hello"\nfunction count(p) {\n  return p + 1\n}\nsay count(t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at fallback/t.uppercase()",
    'let t = "hello"\nlet n: integer? = null\nsay n otherwise t.uppercase()\nexit\n',
  ],
  [
    "text toUpperCase at default/t.uppercase()",
    'let t = "hello"\nlet ys = ["x"]\nsay ys.get(9, default: t.uppercase())\nexit\n',
  ],
  [
    "text toUpperCase at divisor/t.uppercase()",
    'let t = "hello"\nsay 1 / t.uppercase()\nexit\n',
    [],
  ],
  [
    "text toUpperCase at literal divisor/t.uppercase()",
    'let t = "hello"\nsay 1 / [t.uppercase()][0]\nexit\n',
    [],
  ],
  [
    "text toUpperCase at property divisor/t.uppercase()",
    'let t = "hello"\nsay 1 / ({n: t.uppercase()}).n\nexit\n',
    [],
  ],
  [
    "text trim at integer declaration/t.trim()",
    'let t = " hello "\nlet v: integer = t.trim()\nexit\n',
    [],
  ],
  [
    "text trim at number declaration/t.trim()",
    'let t = " hello "\nlet v: number = t.trim()\nexit\n',
    [],
  ],
  [
    "text trim at boolean declaration/t.trim()",
    'let t = " hello "\nlet v: boolean = t.trim()\nexit\n',
    [],
  ],
  [
    "text trim at string[] declaration/t.trim()",
    'let t = " hello "\nlet v: string[] = t.trim()\nexit\n',
    [],
  ],
  [
    "text trim at integer[] declaration/t.trim()",
    'let t = " hello "\nlet v: integer[] = t.trim()\nexit\n',
    [],
  ],
  ["text trim at sum/t.trim()", 'let t = " hello "\nsay t.trim() + 1\nexit\n', []],
  ["text trim at product/t.trim()", 'let t = " hello "\nsay 2 * t.trim()\nexit\n', []],
  ["text trim at comparison/t.trim()", 'let t = " hello "\nsay t.trim() > 2\nexit\n', []],
  ["text trim at negation/t.trim()", 'let t = " hello "\nsay not t.trim()\nexit\n', []],
  ["text trim at logic/t.trim()", 'let t = " hello "\nsay t.trim() and true\nexit\n', []],
  [
    "text trim at integer argument/t.trim()",
    'let t = " hello "\nfunction count(p: integer) {\n  say p\n}\ncount(t.trim())\nexit\n',
    [],
  ],
  [
    "text trim at condition/t.trim()",
    'let t = " hello "\nif t.trim() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "text trim at element/t.trim()",
    'let t = " hello "\nlet ws = [t.trim()]\nsay ws.length\nexit\n',
  ],
  ["text trim at count/t.trim()", 'let t = " hello "\nrepeat t.trim() {\n  say "x"\n}\nexit\n', []],
  ["text trim at wait/t.trim()", 'let t = " hello "\nwait t.trim()\nexit\n', []],
  [
    "text trim at iteration/t.trim()",
    'let t = " hello "\nfor v in t.trim() {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "text trim at range bound/t.trim()",
    'let t = " hello "\nfor i in 1..t.trim() {\n  say i\n}\nexit\n',
    [],
  ],
  [
    "text trim at object store/t.trim()",
    'let t = " hello "\nlet o = {n: "x"}\no = t.trim()\nexit\n',
    [],
  ],
  [
    "text trim at untyped variable's trim/t.trim()",
    'let t = " hello "\nlet v = t.trim()\nsay v.trim()\nexit\n',
  ],
  [
    "text trim at untyped trim argument/t.trim()",
    'let t = " hello "\nfunction use(p) {\n  say p.trim()\n}\nuse(t.trim())\nexit\n',
  ],
  [
    "text trim at untyped sum argument/t.trim()",
    'let t = " hello "\nfunction count(p) {\n  return p + 1\n}\nsay count(t.trim())\nexit\n',
  ],
  [
    "text trim at untyped compound/t.trim()",
    'let t = " hello "\nlet v = t.trim()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "text trim at untyped compound argument/t.trim()",
    'let t = " hello "\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(t.trim())\nexit\n',
  ],
  [
    "text trim at fallback/t.trim()",
    'let t = " hello "\nlet n: integer? = null\nsay n otherwise t.trim()\nexit\n',
  ],
  [
    "text trim at default/t.trim()",
    'let t = " hello "\nlet ys = ["x"]\nsay ys.get(9, default: t.trim())\nexit\n',
  ],
  ["text trim at divisor/t.trim()", 'let t = " hello "\nsay 1 / t.trim()\nexit\n', []],
  ["text trim at literal divisor/t.trim()", 'let t = " hello "\nsay 1 / [t.trim()][0]\nexit\n', []],
  [
    "text trim at property divisor/t.trim()",
    'let t = " hello "\nsay 1 / ({n: t.trim()}).n\nexit\n',
    [],
  ],
  [
    "angle degrees at string declaration/toDeg(a)",
    "let a = 90 deg\nlet v: string = toDeg(a)\nexit\n",
    [],
  ],
  [
    "angle degrees at integer declaration/toDeg(a)",
    "let a = 90 deg\nlet v: integer = toDeg(a)\nexit\n",
    [],
  ],
  [
    "angle degrees at boolean declaration/toDeg(a)",
    "let a = 90 deg\nlet v: boolean = toDeg(a)\nexit\n",
    [],
  ],
  [
    "angle degrees at string[] declaration/toDeg(a)",
    "let a = 90 deg\nlet v: string[] = toDeg(a)\nexit\n",
    [],
  ],
  [
    "angle degrees at integer[] declaration/toDeg(a)",
    "let a = 90 deg\nlet v: integer[] = toDeg(a)\nexit\n",
    [],
  ],
  ["angle degrees at text store/toDeg(a)", 'let a = 90 deg\nlet v = "x"\nv = toDeg(a)\nexit\n', []],
  ["angle degrees at text join/toDeg(a)", 'let a = 90 deg\nsay "a" + toDeg(a)\nexit\n', []],
  ["angle degrees at negation/toDeg(a)", "let a = 90 deg\nsay not toDeg(a)\nexit\n", []],
  ["angle degrees at logic/toDeg(a)", "let a = 90 deg\nsay toDeg(a) and true\nexit\n", []],
  [
    "angle degrees at text argument/toDeg(a)",
    "let a = 90 deg\nfunction show(p: string) {\n  say p\n}\nshow(toDeg(a))\nexit\n",
    [],
  ],
  [
    "angle degrees at integer argument/toDeg(a)",
    "let a = 90 deg\nfunction count(p: integer) {\n  say p\n}\ncount(toDeg(a))\nexit\n",
    [],
  ],
  [
    "angle degrees at condition/toDeg(a)",
    'let a = 90 deg\nif toDeg(a) {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "angle degrees at element/toDeg(a)",
    "let a = 90 deg\nlet ws = [toDeg(a)]\nsay ws.length\nexit\n",
  ],
  ["angle degrees at receiver/toDeg(a)", "let a = 90 deg\nsay toDeg(a).length\nexit\n", []],
  [
    "angle degrees at count/toDeg(a)",
    'let a = 90 deg\nrepeat toDeg(a) {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["angle degrees at wait/toDeg(a)", "let a = 90 deg\nwait toDeg(a)\nexit\n", []],
  [
    "angle degrees at iteration/toDeg(a)",
    "let a = 90 deg\nfor v in toDeg(a) {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "angle degrees at range bound/toDeg(a)",
    "let a = 90 deg\nfor i in 1..toDeg(a) {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "angle degrees at object store/toDeg(a)",
    'let a = 90 deg\nlet o = {n: "x"}\no = toDeg(a)\nexit\n',
    [],
  ],
  [
    "angle degrees at untyped variable's trim/toDeg(a)",
    "let a = 90 deg\nlet v = toDeg(a)\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "angle degrees at untyped trim argument/toDeg(a)",
    "let a = 90 deg\nfunction use(p) {\n  say p.trim()\n}\nuse(toDeg(a))\nexit\n",
  ],
  [
    "angle degrees at untyped compound/toDeg(a)",
    'let a = 90 deg\nlet v = toDeg(a)\nv += "x"\nsay v\nexit\n',
    [],
  ],
  [
    "angle degrees at untyped compound argument/toDeg(a)",
    'let a = 90 deg\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(toDeg(a))\nexit\n',
  ],
  [
    "angle degrees at fallback/toDeg(a)",
    "let a = 90 deg\nlet n: integer? = null\nsay n otherwise toDeg(a)\nexit\n",
  ],
  [
    "angle degrees at default/toDeg(a)",
    'let a = 90 deg\nlet ys = ["x"]\nsay ys.get(9, default: toDeg(a))\nexit\n',
  ],
  [
    "angle degrees at untyped returned argument/toDeg(a)",
    "let a = 90 deg\nfunction id(p) {\n  return p\n}\nlet w: string = id(toDeg(a))\nsay w\nexit\n",
  ],
  ["angle degrees at literal divisor/toDeg(a)", "let a = 90 deg\nsay 1 / [toDeg(a)][0]\nexit\n"],
  [
    "angle degrees at property divisor/toDeg(a)",
    "let a = 90 deg\nsay 1 / ({n: toDeg(a)}).n\nexit\n",
  ],
  [
    "join of text at integer declaration/items.join()",
    'let items = ["a"]\nlet v: integer = items.join()\nexit\n',
    [],
  ],
  [
    "join of text at number declaration/items.join()",
    'let items = ["a"]\nlet v: number = items.join()\nexit\n',
    [],
  ],
  [
    "join of text at boolean declaration/items.join()",
    'let items = ["a"]\nlet v: boolean = items.join()\nexit\n',
    [],
  ],
  [
    "join of text at string[] declaration/items.join()",
    'let items = ["a"]\nlet v: string[] = items.join()\nexit\n',
    [],
  ],
  [
    "join of text at integer[] declaration/items.join()",
    'let items = ["a"]\nlet v: integer[] = items.join()\nexit\n',
    [],
  ],
  ["join of text at sum/items.join()", 'let items = ["a"]\nsay items.join() + 1\nexit\n', []],
  ["join of text at product/items.join()", 'let items = ["a"]\nsay 2 * items.join()\nexit\n', []],
  [
    "join of text at comparison/items.join()",
    'let items = ["a"]\nsay items.join() > 2\nexit\n',
    [],
  ],
  ["join of text at negation/items.join()", 'let items = ["a"]\nsay not items.join()\nexit\n', []],
  [
    "join of text at logic/items.join()",
    'let items = ["a"]\nsay items.join() and true\nexit\n',
    [],
  ],
  [
    "join of text at integer argument/items.join()",
    'let items = ["a"]\nfunction count(p: integer) {\n  say p\n}\ncount(items.join())\nexit\n',
    [],
  ],
  [
    "join of text at condition/items.join()",
    'let items = ["a"]\nif items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "join of text at element/items.join()",
    'let items = ["a"]\nlet ws = [items.join()]\nsay ws.length\nexit\n',
  ],
  [
    "join of text at count/items.join()",
    'let items = ["a"]\nrepeat items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["join of text at wait/items.join()", 'let items = ["a"]\nwait items.join()\nexit\n', []],
  [
    "join of text at iteration/items.join()",
    'let items = ["a"]\nfor v in items.join() {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "join of text at range bound/items.join()",
    'let items = ["a"]\nfor i in 1..items.join() {\n  say i\n}\nexit\n',
    [],
  ],
  [
    "join of text at object store/items.join()",
    'let items = ["a"]\nlet o = {n: "x"}\no = items.join()\nexit\n',
    [],
  ],
  [
    "join of text at untyped variable's trim/items.join()",
    'let items = ["a"]\nlet v = items.join()\nsay v.trim()\nexit\n',
  ],
  [
    "join of text at untyped trim argument/items.join()",
    'let items = ["a"]\nfunction use(p) {\n  say p.trim()\n}\nuse(items.join())\nexit\n',
  ],
  [
    "join of text at untyped sum argument/items.join()",
    'let items = ["a"]\nfunction count(p) {\n  return p + 1\n}\nsay count(items.join())\nexit\n',
  ],
  [
    "join of text at untyped compound/items.join()",
    'let items = ["a"]\nlet v = items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "join of text at untyped compound argument/items.join()",
    'let items = ["a"]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items.join())\nexit\n',
  ],
  [
    "join of text at fallback/items.join()",
    'let items = ["a"]\nlet n: integer? = null\nsay n otherwise items.join()\nexit\n',
  ],
  [
    "join of text at default/items.join()",
    'let items = ["a"]\nlet ys = ["x"]\nsay ys.get(9, default: items.join())\nexit\n',
  ],
  ["join of text at divisor/items.join()", 'let items = ["a"]\nsay 1 / items.join()\nexit\n', []],
  [
    "join of text at literal divisor/items.join()",
    'let items = ["a"]\nsay 1 / [items.join()][0]\nexit\n',
    [],
  ],
  [
    "join of text at property divisor/items.join()",
    'let items = ["a"]\nsay 1 / ({n: items.join()}).n\nexit\n',
    [],
  ],
  [
    "nested join of text at integer declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: integer = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at number declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: number = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at boolean declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: boolean = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at string[] declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: string[] = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at integer[] declaration/box.items.join()",
    'let box = {items: ["a"]}\nlet v: integer[] = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at sum/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join() + 1\nexit\n',
    [],
  ],
  [
    "nested join of text at product/box.items.join()",
    'let box = {items: ["a"]}\nsay 2 * box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at comparison/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join() > 2\nexit\n',
    [],
  ],
  [
    "nested join of text at negation/box.items.join()",
    'let box = {items: ["a"]}\nsay not box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at logic/box.items.join()",
    'let box = {items: ["a"]}\nsay box.items.join() and true\nexit\n',
    [],
  ],
  [
    "nested join of text at integer argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction count(p: integer) {\n  say p\n}\ncount(box.items.join())\nexit\n',
    [],
  ],
  [
    "nested join of text at condition/box.items.join()",
    'let box = {items: ["a"]}\nif box.items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested join of text at element/box.items.join()",
    'let box = {items: ["a"]}\nlet ws = [box.items.join()]\nsay ws.length\nexit\n',
  ],
  [
    "nested join of text at count/box.items.join()",
    'let box = {items: ["a"]}\nrepeat box.items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  [
    "nested join of text at wait/box.items.join()",
    'let box = {items: ["a"]}\nwait box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at iteration/box.items.join()",
    'let box = {items: ["a"]}\nfor v in box.items.join() {\n  say v\n}\nexit\n',
    [],
  ],
  [
    "nested join of text at range bound/box.items.join()",
    'let box = {items: ["a"]}\nfor i in 1..box.items.join() {\n  say i\n}\nexit\n',
    [],
  ],
  [
    "nested join of text at object store/box.items.join()",
    'let box = {items: ["a"]}\nlet o = {n: "x"}\no = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at untyped variable's trim/box.items.join()",
    'let box = {items: ["a"]}\nlet v = box.items.join()\nsay v.trim()\nexit\n',
  ],
  [
    "nested join of text at untyped trim argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at untyped sum argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at untyped compound/box.items.join()",
    'let box = {items: ["a"]}\nlet v = box.items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "nested join of text at untyped compound argument/box.items.join()",
    'let box = {items: ["a"]}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.items.join())\nexit\n',
  ],
  [
    "nested join of text at fallback/box.items.join()",
    'let box = {items: ["a"]}\nlet n: integer? = null\nsay n otherwise box.items.join()\nexit\n',
  ],
  [
    "nested join of text at default/box.items.join()",
    'let box = {items: ["a"]}\nlet ys = ["x"]\nsay ys.get(9, default: box.items.join())\nexit\n',
  ],
  [
    "nested join of text at divisor/box.items.join()",
    'let box = {items: ["a"]}\nsay 1 / box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of text at literal divisor/box.items.join()",
    'let box = {items: ["a"]}\nsay 1 / [box.items.join()][0]\nexit\n',
    [],
  ],
  [
    "nested join of text at property divisor/box.items.join()",
    'let box = {items: ["a"]}\nsay 1 / ({n: box.items.join()}).n\nexit\n',
    [],
  ],
  [
    "join of integer at integer declaration/items.join()",
    "let items = [1]\nlet v: integer = items.join()\nexit\n",
    [],
  ],
  [
    "join of integer at number declaration/items.join()",
    "let items = [1]\nlet v: number = items.join()\nexit\n",
    [],
  ],
  [
    "join of integer at boolean declaration/items.join()",
    "let items = [1]\nlet v: boolean = items.join()\nexit\n",
    [],
  ],
  [
    "join of integer at string[] declaration/items.join()",
    "let items = [1]\nlet v: string[] = items.join()\nexit\n",
    [],
  ],
  [
    "join of integer at integer[] declaration/items.join()",
    "let items = [1]\nlet v: integer[] = items.join()\nexit\n",
    [],
  ],
  ["join of integer at sum/items.join()", "let items = [1]\nsay items.join() + 1\nexit\n", []],
  ["join of integer at product/items.join()", "let items = [1]\nsay 2 * items.join()\nexit\n", []],
  [
    "join of integer at comparison/items.join()",
    "let items = [1]\nsay items.join() > 2\nexit\n",
    [],
  ],
  ["join of integer at negation/items.join()", "let items = [1]\nsay not items.join()\nexit\n", []],
  [
    "join of integer at logic/items.join()",
    "let items = [1]\nsay items.join() and true\nexit\n",
    [],
  ],
  [
    "join of integer at integer argument/items.join()",
    "let items = [1]\nfunction count(p: integer) {\n  say p\n}\ncount(items.join())\nexit\n",
    [],
  ],
  [
    "join of integer at condition/items.join()",
    'let items = [1]\nif items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "join of integer at element/items.join()",
    "let items = [1]\nlet ws = [items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "join of integer at count/items.join()",
    'let items = [1]\nrepeat items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["join of integer at wait/items.join()", "let items = [1]\nwait items.join()\nexit\n", []],
  [
    "join of integer at iteration/items.join()",
    "let items = [1]\nfor v in items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "join of integer at range bound/items.join()",
    "let items = [1]\nfor i in 1..items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "join of integer at object store/items.join()",
    'let items = [1]\nlet o = {n: "x"}\no = items.join()\nexit\n',
    [],
  ],
  [
    "join of integer at untyped variable's trim/items.join()",
    "let items = [1]\nlet v = items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "join of integer at untyped trim argument/items.join()",
    "let items = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse(items.join())\nexit\n",
  ],
  [
    "join of integer at untyped sum argument/items.join()",
    "let items = [1]\nfunction count(p) {\n  return p + 1\n}\nsay count(items.join())\nexit\n",
  ],
  [
    "join of integer at untyped compound/items.join()",
    'let items = [1]\nlet v = items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "join of integer at untyped compound argument/items.join()",
    'let items = [1]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items.join())\nexit\n',
  ],
  [
    "join of integer at fallback/items.join()",
    "let items = [1]\nlet n: integer? = null\nsay n otherwise items.join()\nexit\n",
  ],
  [
    "join of integer at default/items.join()",
    'let items = [1]\nlet ys = ["x"]\nsay ys.get(9, default: items.join())\nexit\n',
  ],
  ["join of integer at divisor/items.join()", "let items = [1]\nsay 1 / items.join()\nexit\n", []],
  [
    "join of integer at literal divisor/items.join()",
    "let items = [1]\nsay 1 / [items.join()][0]\nexit\n",
    [],
  ],
  [
    "join of integer at property divisor/items.join()",
    "let items = [1]\nsay 1 / ({n: items.join()}).n\nexit\n",
    [],
  ],
  [
    "nested join of integer at integer declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: integer = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at number declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: number = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at boolean declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: boolean = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at string[] declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: string[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at integer[] declaration/box.items.join()",
    "let box = {items: [1]}\nlet v: integer[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at sum/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join() + 1\nexit\n",
    [],
  ],
  [
    "nested join of integer at product/box.items.join()",
    "let box = {items: [1]}\nsay 2 * box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at comparison/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join() > 2\nexit\n",
    [],
  ],
  [
    "nested join of integer at negation/box.items.join()",
    "let box = {items: [1]}\nsay not box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at logic/box.items.join()",
    "let box = {items: [1]}\nsay box.items.join() and true\nexit\n",
    [],
  ],
  [
    "nested join of integer at integer argument/box.items.join()",
    "let box = {items: [1]}\nfunction count(p: integer) {\n  say p\n}\ncount(box.items.join())\nexit\n",
    [],
  ],
  [
    "nested join of integer at condition/box.items.join()",
    'let box = {items: [1]}\nif box.items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested join of integer at element/box.items.join()",
    "let box = {items: [1]}\nlet ws = [box.items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "nested join of integer at count/box.items.join()",
    'let box = {items: [1]}\nrepeat box.items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  [
    "nested join of integer at wait/box.items.join()",
    "let box = {items: [1]}\nwait box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at iteration/box.items.join()",
    "let box = {items: [1]}\nfor v in box.items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "nested join of integer at range bound/box.items.join()",
    "let box = {items: [1]}\nfor i in 1..box.items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "nested join of integer at object store/box.items.join()",
    'let box = {items: [1]}\nlet o = {n: "x"}\no = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of integer at untyped variable's trim/box.items.join()",
    "let box = {items: [1]}\nlet v = box.items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "nested join of integer at untyped trim argument/box.items.join()",
    "let box = {items: [1]}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.items.join())\nexit\n",
  ],
  [
    "nested join of integer at untyped sum argument/box.items.join()",
    "let box = {items: [1]}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.items.join())\nexit\n",
  ],
  [
    "nested join of integer at untyped compound/box.items.join()",
    'let box = {items: [1]}\nlet v = box.items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "nested join of integer at untyped compound argument/box.items.join()",
    'let box = {items: [1]}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.items.join())\nexit\n',
  ],
  [
    "nested join of integer at fallback/box.items.join()",
    "let box = {items: [1]}\nlet n: integer? = null\nsay n otherwise box.items.join()\nexit\n",
  ],
  [
    "nested join of integer at default/box.items.join()",
    'let box = {items: [1]}\nlet ys = ["x"]\nsay ys.get(9, default: box.items.join())\nexit\n',
  ],
  [
    "nested join of integer at divisor/box.items.join()",
    "let box = {items: [1]}\nsay 1 / box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of integer at literal divisor/box.items.join()",
    "let box = {items: [1]}\nsay 1 / [box.items.join()][0]\nexit\n",
    [],
  ],
  [
    "nested join of integer at property divisor/box.items.join()",
    "let box = {items: [1]}\nsay 1 / ({n: box.items.join()}).n\nexit\n",
    [],
  ],
  [
    "join of number at integer declaration/items.join()",
    "let items = [1.5]\nlet v: integer = items.join()\nexit\n",
    [],
  ],
  [
    "join of number at number declaration/items.join()",
    "let items = [1.5]\nlet v: number = items.join()\nexit\n",
    [],
  ],
  [
    "join of number at boolean declaration/items.join()",
    "let items = [1.5]\nlet v: boolean = items.join()\nexit\n",
    [],
  ],
  [
    "join of number at string[] declaration/items.join()",
    "let items = [1.5]\nlet v: string[] = items.join()\nexit\n",
    [],
  ],
  [
    "join of number at integer[] declaration/items.join()",
    "let items = [1.5]\nlet v: integer[] = items.join()\nexit\n",
    [],
  ],
  ["join of number at sum/items.join()", "let items = [1.5]\nsay items.join() + 1\nexit\n", []],
  ["join of number at product/items.join()", "let items = [1.5]\nsay 2 * items.join()\nexit\n", []],
  [
    "join of number at comparison/items.join()",
    "let items = [1.5]\nsay items.join() > 2\nexit\n",
    [],
  ],
  [
    "join of number at negation/items.join()",
    "let items = [1.5]\nsay not items.join()\nexit\n",
    [],
  ],
  [
    "join of number at logic/items.join()",
    "let items = [1.5]\nsay items.join() and true\nexit\n",
    [],
  ],
  [
    "join of number at integer argument/items.join()",
    "let items = [1.5]\nfunction count(p: integer) {\n  say p\n}\ncount(items.join())\nexit\n",
    [],
  ],
  [
    "join of number at condition/items.join()",
    'let items = [1.5]\nif items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "join of number at element/items.join()",
    "let items = [1.5]\nlet ws = [items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "join of number at count/items.join()",
    'let items = [1.5]\nrepeat items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["join of number at wait/items.join()", "let items = [1.5]\nwait items.join()\nexit\n", []],
  [
    "join of number at iteration/items.join()",
    "let items = [1.5]\nfor v in items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "join of number at range bound/items.join()",
    "let items = [1.5]\nfor i in 1..items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "join of number at object store/items.join()",
    'let items = [1.5]\nlet o = {n: "x"}\no = items.join()\nexit\n',
    [],
  ],
  [
    "join of number at untyped variable's trim/items.join()",
    "let items = [1.5]\nlet v = items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "join of number at untyped trim argument/items.join()",
    "let items = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nuse(items.join())\nexit\n",
  ],
  [
    "join of number at untyped sum argument/items.join()",
    "let items = [1.5]\nfunction count(p) {\n  return p + 1\n}\nsay count(items.join())\nexit\n",
  ],
  [
    "join of number at untyped compound/items.join()",
    'let items = [1.5]\nlet v = items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "join of number at untyped compound argument/items.join()",
    'let items = [1.5]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items.join())\nexit\n',
  ],
  [
    "join of number at fallback/items.join()",
    "let items = [1.5]\nlet n: integer? = null\nsay n otherwise items.join()\nexit\n",
  ],
  [
    "join of number at default/items.join()",
    'let items = [1.5]\nlet ys = ["x"]\nsay ys.get(9, default: items.join())\nexit\n',
  ],
  ["join of number at divisor/items.join()", "let items = [1.5]\nsay 1 / items.join()\nexit\n", []],
  [
    "join of number at literal divisor/items.join()",
    "let items = [1.5]\nsay 1 / [items.join()][0]\nexit\n",
    [],
  ],
  [
    "join of number at property divisor/items.join()",
    "let items = [1.5]\nsay 1 / ({n: items.join()}).n\nexit\n",
    [],
  ],
  [
    "nested join of number at integer declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: integer = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at number declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: number = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at boolean declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: boolean = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at string[] declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: string[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at integer[] declaration/box.items.join()",
    "let box = {items: [1.5]}\nlet v: integer[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at sum/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join() + 1\nexit\n",
    [],
  ],
  [
    "nested join of number at product/box.items.join()",
    "let box = {items: [1.5]}\nsay 2 * box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at comparison/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join() > 2\nexit\n",
    [],
  ],
  [
    "nested join of number at negation/box.items.join()",
    "let box = {items: [1.5]}\nsay not box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at logic/box.items.join()",
    "let box = {items: [1.5]}\nsay box.items.join() and true\nexit\n",
    [],
  ],
  [
    "nested join of number at integer argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction count(p: integer) {\n  say p\n}\ncount(box.items.join())\nexit\n",
    [],
  ],
  [
    "nested join of number at condition/box.items.join()",
    'let box = {items: [1.5]}\nif box.items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested join of number at element/box.items.join()",
    "let box = {items: [1.5]}\nlet ws = [box.items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "nested join of number at count/box.items.join()",
    'let box = {items: [1.5]}\nrepeat box.items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  [
    "nested join of number at wait/box.items.join()",
    "let box = {items: [1.5]}\nwait box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at iteration/box.items.join()",
    "let box = {items: [1.5]}\nfor v in box.items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "nested join of number at range bound/box.items.join()",
    "let box = {items: [1.5]}\nfor i in 1..box.items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "nested join of number at object store/box.items.join()",
    'let box = {items: [1.5]}\nlet o = {n: "x"}\no = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of number at untyped variable's trim/box.items.join()",
    "let box = {items: [1.5]}\nlet v = box.items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "nested join of number at untyped trim argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.items.join())\nexit\n",
  ],
  [
    "nested join of number at untyped sum argument/box.items.join()",
    "let box = {items: [1.5]}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.items.join())\nexit\n",
  ],
  [
    "nested join of number at untyped compound/box.items.join()",
    'let box = {items: [1.5]}\nlet v = box.items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "nested join of number at untyped compound argument/box.items.join()",
    'let box = {items: [1.5]}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.items.join())\nexit\n',
  ],
  [
    "nested join of number at fallback/box.items.join()",
    "let box = {items: [1.5]}\nlet n: integer? = null\nsay n otherwise box.items.join()\nexit\n",
  ],
  [
    "nested join of number at default/box.items.join()",
    'let box = {items: [1.5]}\nlet ys = ["x"]\nsay ys.get(9, default: box.items.join())\nexit\n',
  ],
  [
    "nested join of number at divisor/box.items.join()",
    "let box = {items: [1.5]}\nsay 1 / box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of number at literal divisor/box.items.join()",
    "let box = {items: [1.5]}\nsay 1 / [box.items.join()][0]\nexit\n",
    [],
  ],
  [
    "nested join of number at property divisor/box.items.join()",
    "let box = {items: [1.5]}\nsay 1 / ({n: box.items.join()}).n\nexit\n",
    [],
  ],
  [
    "join of boolean at integer declaration/items.join()",
    "let items = [true]\nlet v: integer = items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at number declaration/items.join()",
    "let items = [true]\nlet v: number = items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at boolean declaration/items.join()",
    "let items = [true]\nlet v: boolean = items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at string[] declaration/items.join()",
    "let items = [true]\nlet v: string[] = items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at integer[] declaration/items.join()",
    "let items = [true]\nlet v: integer[] = items.join()\nexit\n",
    [],
  ],
  ["join of boolean at sum/items.join()", "let items = [true]\nsay items.join() + 1\nexit\n", []],
  [
    "join of boolean at product/items.join()",
    "let items = [true]\nsay 2 * items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at comparison/items.join()",
    "let items = [true]\nsay items.join() > 2\nexit\n",
    [],
  ],
  [
    "join of boolean at negation/items.join()",
    "let items = [true]\nsay not items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at logic/items.join()",
    "let items = [true]\nsay items.join() and true\nexit\n",
    [],
  ],
  [
    "join of boolean at integer argument/items.join()",
    "let items = [true]\nfunction count(p: integer) {\n  say p\n}\ncount(items.join())\nexit\n",
    [],
  ],
  [
    "join of boolean at condition/items.join()",
    'let items = [true]\nif items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "join of boolean at element/items.join()",
    "let items = [true]\nlet ws = [items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "join of boolean at count/items.join()",
    'let items = [true]\nrepeat items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["join of boolean at wait/items.join()", "let items = [true]\nwait items.join()\nexit\n", []],
  [
    "join of boolean at iteration/items.join()",
    "let items = [true]\nfor v in items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "join of boolean at range bound/items.join()",
    "let items = [true]\nfor i in 1..items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "join of boolean at object store/items.join()",
    'let items = [true]\nlet o = {n: "x"}\no = items.join()\nexit\n',
    [],
  ],
  [
    "join of boolean at untyped variable's trim/items.join()",
    "let items = [true]\nlet v = items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "join of boolean at untyped trim argument/items.join()",
    "let items = [true]\nfunction use(p) {\n  say p.trim()\n}\nuse(items.join())\nexit\n",
  ],
  [
    "join of boolean at untyped sum argument/items.join()",
    "let items = [true]\nfunction count(p) {\n  return p + 1\n}\nsay count(items.join())\nexit\n",
  ],
  [
    "join of boolean at untyped compound/items.join()",
    'let items = [true]\nlet v = items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "join of boolean at untyped compound argument/items.join()",
    'let items = [true]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items.join())\nexit\n',
  ],
  [
    "join of boolean at fallback/items.join()",
    "let items = [true]\nlet n: integer? = null\nsay n otherwise items.join()\nexit\n",
  ],
  [
    "join of boolean at default/items.join()",
    'let items = [true]\nlet ys = ["x"]\nsay ys.get(9, default: items.join())\nexit\n',
  ],
  [
    "join of boolean at divisor/items.join()",
    "let items = [true]\nsay 1 / items.join()\nexit\n",
    [],
  ],
  [
    "join of boolean at literal divisor/items.join()",
    "let items = [true]\nsay 1 / [items.join()][0]\nexit\n",
    [],
  ],
  [
    "join of boolean at property divisor/items.join()",
    "let items = [true]\nsay 1 / ({n: items.join()}).n\nexit\n",
    [],
  ],
  [
    "nested join of boolean at integer declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: integer = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at number declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: number = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at boolean declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: boolean = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at string[] declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: string[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at integer[] declaration/box.items.join()",
    "let box = {items: [true]}\nlet v: integer[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at sum/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join() + 1\nexit\n",
    [],
  ],
  [
    "nested join of boolean at product/box.items.join()",
    "let box = {items: [true]}\nsay 2 * box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at comparison/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join() > 2\nexit\n",
    [],
  ],
  [
    "nested join of boolean at negation/box.items.join()",
    "let box = {items: [true]}\nsay not box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at logic/box.items.join()",
    "let box = {items: [true]}\nsay box.items.join() and true\nexit\n",
    [],
  ],
  [
    "nested join of boolean at integer argument/box.items.join()",
    "let box = {items: [true]}\nfunction count(p: integer) {\n  say p\n}\ncount(box.items.join())\nexit\n",
    [],
  ],
  [
    "nested join of boolean at condition/box.items.join()",
    'let box = {items: [true]}\nif box.items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested join of boolean at element/box.items.join()",
    "let box = {items: [true]}\nlet ws = [box.items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "nested join of boolean at count/box.items.join()",
    'let box = {items: [true]}\nrepeat box.items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  [
    "nested join of boolean at wait/box.items.join()",
    "let box = {items: [true]}\nwait box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at iteration/box.items.join()",
    "let box = {items: [true]}\nfor v in box.items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "nested join of boolean at range bound/box.items.join()",
    "let box = {items: [true]}\nfor i in 1..box.items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "nested join of boolean at object store/box.items.join()",
    'let box = {items: [true]}\nlet o = {n: "x"}\no = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of boolean at untyped variable's trim/box.items.join()",
    "let box = {items: [true]}\nlet v = box.items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "nested join of boolean at untyped trim argument/box.items.join()",
    "let box = {items: [true]}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.items.join())\nexit\n",
  ],
  [
    "nested join of boolean at untyped sum argument/box.items.join()",
    "let box = {items: [true]}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.items.join())\nexit\n",
  ],
  [
    "nested join of boolean at untyped compound/box.items.join()",
    'let box = {items: [true]}\nlet v = box.items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "nested join of boolean at untyped compound argument/box.items.join()",
    'let box = {items: [true]}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.items.join())\nexit\n',
  ],
  [
    "nested join of boolean at fallback/box.items.join()",
    "let box = {items: [true]}\nlet n: integer? = null\nsay n otherwise box.items.join()\nexit\n",
  ],
  [
    "nested join of boolean at default/box.items.join()",
    'let box = {items: [true]}\nlet ys = ["x"]\nsay ys.get(9, default: box.items.join())\nexit\n',
  ],
  [
    "nested join of boolean at divisor/box.items.join()",
    "let box = {items: [true]}\nsay 1 / box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of boolean at literal divisor/box.items.join()",
    "let box = {items: [true]}\nsay 1 / [box.items.join()][0]\nexit\n",
    [],
  ],
  [
    "nested join of boolean at property divisor/box.items.join()",
    "let box = {items: [true]}\nsay 1 / ({n: box.items.join()}).n\nexit\n",
    [],
  ],
  [
    "join of duration at integer declaration/items.join()",
    "let items = [1 s]\nlet v: integer = items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at number declaration/items.join()",
    "let items = [1 s]\nlet v: number = items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at boolean declaration/items.join()",
    "let items = [1 s]\nlet v: boolean = items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at string[] declaration/items.join()",
    "let items = [1 s]\nlet v: string[] = items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at integer[] declaration/items.join()",
    "let items = [1 s]\nlet v: integer[] = items.join()\nexit\n",
    [],
  ],
  ["join of duration at sum/items.join()", "let items = [1 s]\nsay items.join() + 1\nexit\n", []],
  [
    "join of duration at product/items.join()",
    "let items = [1 s]\nsay 2 * items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at comparison/items.join()",
    "let items = [1 s]\nsay items.join() > 2\nexit\n",
    [],
  ],
  [
    "join of duration at negation/items.join()",
    "let items = [1 s]\nsay not items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at logic/items.join()",
    "let items = [1 s]\nsay items.join() and true\nexit\n",
    [],
  ],
  [
    "join of duration at integer argument/items.join()",
    "let items = [1 s]\nfunction count(p: integer) {\n  say p\n}\ncount(items.join())\nexit\n",
    [],
  ],
  [
    "join of duration at condition/items.join()",
    'let items = [1 s]\nif items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "join of duration at element/items.join()",
    "let items = [1 s]\nlet ws = [items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "join of duration at count/items.join()",
    'let items = [1 s]\nrepeat items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  ["join of duration at wait/items.join()", "let items = [1 s]\nwait items.join()\nexit\n", []],
  [
    "join of duration at iteration/items.join()",
    "let items = [1 s]\nfor v in items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "join of duration at range bound/items.join()",
    "let items = [1 s]\nfor i in 1..items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "join of duration at object store/items.join()",
    'let items = [1 s]\nlet o = {n: "x"}\no = items.join()\nexit\n',
    [],
  ],
  [
    "join of duration at untyped variable's trim/items.join()",
    "let items = [1 s]\nlet v = items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "join of duration at untyped trim argument/items.join()",
    "let items = [1 s]\nfunction use(p) {\n  say p.trim()\n}\nuse(items.join())\nexit\n",
  ],
  [
    "join of duration at untyped sum argument/items.join()",
    "let items = [1 s]\nfunction count(p) {\n  return p + 1\n}\nsay count(items.join())\nexit\n",
  ],
  [
    "join of duration at untyped compound/items.join()",
    'let items = [1 s]\nlet v = items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "join of duration at untyped compound argument/items.join()",
    'let items = [1 s]\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(items.join())\nexit\n',
  ],
  [
    "join of duration at fallback/items.join()",
    "let items = [1 s]\nlet n: integer? = null\nsay n otherwise items.join()\nexit\n",
  ],
  [
    "join of duration at default/items.join()",
    'let items = [1 s]\nlet ys = ["x"]\nsay ys.get(9, default: items.join())\nexit\n',
  ],
  [
    "join of duration at divisor/items.join()",
    "let items = [1 s]\nsay 1 / items.join()\nexit\n",
    [],
  ],
  [
    "join of duration at literal divisor/items.join()",
    "let items = [1 s]\nsay 1 / [items.join()][0]\nexit\n",
    [],
  ],
  [
    "join of duration at property divisor/items.join()",
    "let items = [1 s]\nsay 1 / ({n: items.join()}).n\nexit\n",
    [],
  ],
  [
    "nested join of duration at integer declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: integer = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at number declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: number = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at boolean declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: boolean = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at string[] declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: string[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at integer[] declaration/box.items.join()",
    "let box = {items: [1 s]}\nlet v: integer[] = box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at sum/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join() + 1\nexit\n",
    [],
  ],
  [
    "nested join of duration at product/box.items.join()",
    "let box = {items: [1 s]}\nsay 2 * box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at comparison/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join() > 2\nexit\n",
    [],
  ],
  [
    "nested join of duration at negation/box.items.join()",
    "let box = {items: [1 s]}\nsay not box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at logic/box.items.join()",
    "let box = {items: [1 s]}\nsay box.items.join() and true\nexit\n",
    [],
  ],
  [
    "nested join of duration at integer argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction count(p: integer) {\n  say p\n}\ncount(box.items.join())\nexit\n",
    [],
  ],
  [
    "nested join of duration at condition/box.items.join()",
    'let box = {items: [1 s]}\nif box.items.join() {\n  say "yes"\n}\nexit\n',
    [],
  ],
  [
    "nested join of duration at element/box.items.join()",
    "let box = {items: [1 s]}\nlet ws = [box.items.join()]\nsay ws.length\nexit\n",
  ],
  [
    "nested join of duration at count/box.items.join()",
    'let box = {items: [1 s]}\nrepeat box.items.join() {\n  say "x"\n}\nexit\n',
    [],
  ],
  [
    "nested join of duration at wait/box.items.join()",
    "let box = {items: [1 s]}\nwait box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at iteration/box.items.join()",
    "let box = {items: [1 s]}\nfor v in box.items.join() {\n  say v\n}\nexit\n",
    [],
  ],
  [
    "nested join of duration at range bound/box.items.join()",
    "let box = {items: [1 s]}\nfor i in 1..box.items.join() {\n  say i\n}\nexit\n",
    [],
  ],
  [
    "nested join of duration at object store/box.items.join()",
    'let box = {items: [1 s]}\nlet o = {n: "x"}\no = box.items.join()\nexit\n',
    [],
  ],
  [
    "nested join of duration at untyped variable's trim/box.items.join()",
    "let box = {items: [1 s]}\nlet v = box.items.join()\nsay v.trim()\nexit\n",
  ],
  [
    "nested join of duration at untyped trim argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction use(p) {\n  say p.trim()\n}\nuse(box.items.join())\nexit\n",
  ],
  [
    "nested join of duration at untyped sum argument/box.items.join()",
    "let box = {items: [1 s]}\nfunction count(p) {\n  return p + 1\n}\nsay count(box.items.join())\nexit\n",
  ],
  [
    "nested join of duration at untyped compound/box.items.join()",
    'let box = {items: [1 s]}\nlet v = box.items.join()\nv += "x"\nsay v\nexit\n',
  ],
  [
    "nested join of duration at untyped compound argument/box.items.join()",
    'let box = {items: [1 s]}\nfunction f(p) {\n  p += "x"\n  say p\n}\nf(box.items.join())\nexit\n',
  ],
  [
    "nested join of duration at fallback/box.items.join()",
    "let box = {items: [1 s]}\nlet n: integer? = null\nsay n otherwise box.items.join()\nexit\n",
  ],
  [
    "nested join of duration at default/box.items.join()",
    'let box = {items: [1 s]}\nlet ys = ["x"]\nsay ys.get(9, default: box.items.join())\nexit\n',
  ],
  [
    "nested join of duration at divisor/box.items.join()",
    "let box = {items: [1 s]}\nsay 1 / box.items.join()\nexit\n",
    [],
  ],
  [
    "nested join of duration at literal divisor/box.items.join()",
    "let box = {items: [1 s]}\nsay 1 / [box.items.join()][0]\nexit\n",
    [],
  ],
  [
    "nested join of duration at property divisor/box.items.join()",
    "let box = {items: [1 s]}\nsay 1 / ({n: box.items.join()}).n\nexit\n",
    [],
  ],
  [
    'list of text + text at string declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: string = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at string declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: string = xs\nexit\n',
    [],
  ],
  [
    'list of text + text at integer declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: integer = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at integer declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: integer = xs\nexit\n',
    [],
  ],
  [
    'list of text + text at number declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: number = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at number declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: number = xs\nexit\n',
    [],
  ],
  [
    'list of text + text at boolean declaration/xs + ["a"]',
    'let xs = ["a"]\nlet v: boolean = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at boolean declaration/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v: boolean = xs\nexit\n',
    [],
  ],
  [
    'list of text + text at text store/xs + ["a"]',
    'let xs = ["a"]\nlet v = "x"\nv = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at text store/xs.add("a")',
    'let xs = ["a"]\nlet v = "x"\nxs.add("a")\nv = xs\nexit\n',
    [],
  ],
  ['list of text + text at sum/(xs + ["a"])', 'let xs = ["a"]\nsay ((xs + ["a"])) + 1\nexit\n', []],
  [
    'list of text + text at sum/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay (xs) + 1\nexit\n',
    [],
  ],
  [
    'list of text + text at product/(xs + ["a"])',
    'let xs = ["a"]\nsay 2 * ((xs + ["a"]))\nexit\n',
    [],
  ],
  [
    'list of text + text at product/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay 2 * (xs)\nexit\n',
    [],
  ],
  [
    'list of text + text at text join/(xs + ["a"])',
    'let xs = ["a"]\nsay "a" + ((xs + ["a"]))\nexit\n',
    [],
  ],
  [
    'list of text + text at text join/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay "a" + (xs)\nexit\n',
    [],
  ],
  [
    'list of text + text at text argument/xs + ["a"]',
    'let xs = ["a"]\nfunction show(p: string) {\n  say p\n}\nshow(xs + ["a"])\nexit\n',
    [],
  ],
  [
    'list of text + text at text argument/xs.add("a")',
    'let xs = ["a"]\nfunction show(p: string) {\n  say p\n}\nxs.add("a")\nshow(xs)\nexit\n',
    [],
  ],
  [
    'list of text + text at integer argument/xs + ["a"]',
    'let xs = ["a"]\nfunction count(p: integer) {\n  say p\n}\ncount(xs + ["a"])\nexit\n',
    [],
  ],
  [
    'list of text + text at integer argument/xs.add("a")',
    'let xs = ["a"]\nfunction count(p: integer) {\n  say p\n}\nxs.add("a")\ncount(xs)\nexit\n',
    [],
  ],
  [
    'list of text + text at object store/xs + ["a"]',
    'let xs = ["a"]\nlet o = {n: "x"}\no = xs + ["a"]\nexit\n',
    [],
  ],
  [
    'list of text + text at object store/xs.add("a")',
    'let xs = ["a"]\nlet o = {n: "x"}\nxs.add("a")\no = xs\nexit\n',
    [],
  ],
  [
    'list of text + text at untyped variable\'s trim/xs + ["a"]',
    'let xs = ["a"]\nlet v = xs + ["a"]\nsay v.trim()\nexit\n',
    [],
  ],
  [
    'list of text + text at untyped variable\'s trim/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nlet v = xs\nsay v.trim()\nexit\n',
    [],
  ],
  [
    'list of text + text at untyped trim argument/xs + ["a"]',
    'let xs = ["a"]\nfunction use(p) {\n  say p.trim()\n}\nuse(xs + ["a"])\nexit\n',
  ],
  [
    'list of text + text at untyped trim argument/xs.add("a")',
    'let xs = ["a"]\nfunction use(p) {\n  say p.trim()\n}\nxs.add("a")\nuse(xs)\nexit\n',
  ],
  [
    'list of text + text at untyped sum argument/xs + ["a"]',
    'let xs = ["a"]\nfunction count(p) {\n  return p + 1\n}\nsay count(xs + ["a"])\nexit\n',
  ],
  [
    'list of text + text at untyped sum argument/xs.add("a")',
    'let xs = ["a"]\nfunction count(p) {\n  return p + 1\n}\nxs.add("a")\nsay count(xs)\nexit\n',
  ],
  [
    'list of text + text at untyped returned argument/xs + ["a"]',
    'let xs = ["a"]\nfunction id(p) {\n  return p\n}\nlet w: string = id(xs + ["a"])\nsay w\nexit\n',
  ],
  [
    'list of text + text at untyped returned argument/xs.add("a")',
    'let xs = ["a"]\nfunction id(p) {\n  return p\n}\nxs.add("a")\nlet w: string = id(xs)\nsay w\nexit\n',
  ],
  [
    'list of text + text at divisor/(xs + ["a"])',
    'let xs = ["a"]\nsay 1 / ((xs + ["a"]))\nexit\n',
    [],
  ],
  [
    'list of text + text at divisor/xs.add("a")',
    'let xs = ["a"]\nxs.add("a")\nsay 1 / (xs)\nexit\n',
    [],
  ],
  [
    "list of integer + integer at string declaration/xs + [1]",
    "let xs = [1]\nlet v: string = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of integer + integer at string declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v: string = xs\nexit\n",
    [],
  ],
  [
    "list of integer + integer at integer declaration/xs + [1]",
    "let xs = [1]\nlet v: integer = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of integer + integer at integer declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v: integer = xs\nexit\n",
    [],
  ],
  [
    "list of integer + integer at number declaration/xs + [1]",
    "let xs = [1]\nlet v: number = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of integer + integer at number declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v: number = xs\nexit\n",
    [],
  ],
  [
    "list of integer + integer at boolean declaration/xs + [1]",
    "let xs = [1]\nlet v: boolean = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of integer + integer at boolean declaration/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v: boolean = xs\nexit\n",
    [],
  ],
  [
    "list of integer + integer at text store/xs + [1]",
    'let xs = [1]\nlet v = "x"\nv = xs + [1]\nexit\n',
    [],
  ],
  [
    "list of integer + integer at text store/xs.add(1)",
    'let xs = [1]\nlet v = "x"\nxs.add(1)\nv = xs\nexit\n',
    [],
  ],
  ["list of integer + integer at sum/(xs + [1])", "let xs = [1]\nsay ((xs + [1])) + 1\nexit\n", []],
  [
    "list of integer + integer at sum/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nsay (xs) + 1\nexit\n",
    [],
  ],
  [
    "list of integer + integer at product/(xs + [1])",
    "let xs = [1]\nsay 2 * ((xs + [1]))\nexit\n",
    [],
  ],
  [
    "list of integer + integer at product/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nsay 2 * (xs)\nexit\n",
    [],
  ],
  [
    "list of integer + integer at text join/(xs + [1])",
    'let xs = [1]\nsay "a" + ((xs + [1]))\nexit\n',
    [],
  ],
  [
    "list of integer + integer at text join/xs.add(1)",
    'let xs = [1]\nxs.add(1)\nsay "a" + (xs)\nexit\n',
    [],
  ],
  [
    "list of integer + integer at text argument/xs + [1]",
    "let xs = [1]\nfunction show(p: string) {\n  say p\n}\nshow(xs + [1])\nexit\n",
    [],
  ],
  [
    "list of integer + integer at text argument/xs.add(1)",
    "let xs = [1]\nfunction show(p: string) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
    [],
  ],
  [
    "list of integer + integer at integer argument/xs + [1]",
    "let xs = [1]\nfunction count(p: integer) {\n  say p\n}\ncount(xs + [1])\nexit\n",
    [],
  ],
  [
    "list of integer + integer at integer argument/xs.add(1)",
    "let xs = [1]\nfunction count(p: integer) {\n  say p\n}\nxs.add(1)\ncount(xs)\nexit\n",
    [],
  ],
  [
    "list of integer + integer at object store/xs + [1]",
    'let xs = [1]\nlet o = {n: "x"}\no = xs + [1]\nexit\n',
    [],
  ],
  [
    "list of integer + integer at object store/xs.add(1)",
    'let xs = [1]\nlet o = {n: "x"}\nxs.add(1)\no = xs\nexit\n',
    [],
  ],
  [
    "list of integer + integer at untyped variable's trim/xs + [1]",
    "let xs = [1]\nlet v = xs + [1]\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of integer + integer at untyped variable's trim/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nlet v = xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of integer + integer at untyped trim argument/xs + [1]",
    "let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse(xs + [1])\nexit\n",
  ],
  [
    "list of integer + integer at untyped trim argument/xs.add(1)",
    "let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nxs.add(1)\nuse(xs)\nexit\n",
  ],
  [
    "list of integer + integer at untyped sum argument/xs + [1]",
    "let xs = [1]\nfunction count(p) {\n  return p + 1\n}\nsay count(xs + [1])\nexit\n",
  ],
  [
    "list of integer + integer at untyped sum argument/xs.add(1)",
    "let xs = [1]\nfunction count(p) {\n  return p + 1\n}\nxs.add(1)\nsay count(xs)\nexit\n",
  ],
  [
    "list of integer + integer at untyped returned argument/xs + [1]",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id(xs + [1])\nsay w\nexit\n",
  ],
  [
    "list of integer + integer at untyped returned argument/xs.add(1)",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nxs.add(1)\nlet w: string = id(xs)\nsay w\nexit\n",
  ],
  [
    "list of integer + integer at divisor/(xs + [1])",
    "let xs = [1]\nsay 1 / ((xs + [1]))\nexit\n",
    [],
  ],
  [
    "list of integer + integer at divisor/xs.add(1)",
    "let xs = [1]\nxs.add(1)\nsay 1 / (xs)\nexit\n",
    [],
  ],
  [
    "integer + list of integer at string declaration/[1] + xs",
    "let xs = [1]\nlet v: string = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of integer at integer declaration/[1] + xs",
    "let xs = [1]\nlet v: integer = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of integer at number declaration/[1] + xs",
    "let xs = [1]\nlet v: number = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of integer at boolean declaration/[1] + xs",
    "let xs = [1]\nlet v: boolean = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of integer at text store/[1] + xs",
    'let xs = [1]\nlet v = "x"\nv = [1] + xs\nexit\n',
    [],
  ],
  ["integer + list of integer at sum/([1] + xs)", "let xs = [1]\nsay (([1] + xs)) + 1\nexit\n", []],
  [
    "integer + list of integer at product/([1] + xs)",
    "let xs = [1]\nsay 2 * (([1] + xs))\nexit\n",
    [],
  ],
  [
    "integer + list of integer at text join/([1] + xs)",
    'let xs = [1]\nsay "a" + (([1] + xs))\nexit\n',
    [],
  ],
  [
    "integer + list of integer at text argument/[1] + xs",
    "let xs = [1]\nfunction show(p: string) {\n  say p\n}\nshow([1] + xs)\nexit\n",
    [],
  ],
  [
    "integer + list of integer at integer argument/[1] + xs",
    "let xs = [1]\nfunction count(p: integer) {\n  say p\n}\ncount([1] + xs)\nexit\n",
    [],
  ],
  [
    "integer + list of integer at object store/[1] + xs",
    'let xs = [1]\nlet o = {n: "x"}\no = [1] + xs\nexit\n',
    [],
  ],
  [
    "integer + list of integer at untyped variable's trim/[1] + xs",
    "let xs = [1]\nlet v = [1] + xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "integer + list of integer at untyped trim argument/[1] + xs",
    "let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse([1] + xs)\nexit\n",
  ],
  [
    "integer + list of integer at untyped sum argument/[1] + xs",
    "let xs = [1]\nfunction count(p) {\n  return p + 1\n}\nsay count([1] + xs)\nexit\n",
  ],
  [
    "integer + list of integer at untyped returned argument/[1] + xs",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id([1] + xs)\nsay w\nexit\n",
  ],
  [
    "integer + list of integer at divisor/([1] + xs)",
    "let xs = [1]\nsay 1 / (([1] + xs))\nexit\n",
    [],
  ],
  [
    "list of number + integer at string declaration/xs + [1]",
    "let xs = [1.5]\nlet v: string = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of number + integer at string declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v: string = xs\nexit\n",
    [],
  ],
  [
    "list of number + integer at integer declaration/xs + [1]",
    "let xs = [1.5]\nlet v: integer = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of number + integer at integer declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v: integer = xs\nexit\n",
    [],
  ],
  [
    "list of number + integer at number declaration/xs + [1]",
    "let xs = [1.5]\nlet v: number = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of number + integer at number declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v: number = xs\nexit\n",
    [],
  ],
  [
    "list of number + integer at boolean declaration/xs + [1]",
    "let xs = [1.5]\nlet v: boolean = xs + [1]\nexit\n",
    [],
  ],
  [
    "list of number + integer at boolean declaration/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v: boolean = xs\nexit\n",
    [],
  ],
  [
    "list of number + integer at text store/xs + [1]",
    'let xs = [1.5]\nlet v = "x"\nv = xs + [1]\nexit\n',
    [],
  ],
  [
    "list of number + integer at text store/xs.add(1)",
    'let xs = [1.5]\nlet v = "x"\nxs.add(1)\nv = xs\nexit\n',
    [],
  ],
  [
    "list of number + integer at sum/(xs + [1])",
    "let xs = [1.5]\nsay ((xs + [1])) + 1\nexit\n",
    [],
  ],
  [
    "list of number + integer at sum/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nsay (xs) + 1\nexit\n",
    [],
  ],
  [
    "list of number + integer at product/(xs + [1])",
    "let xs = [1.5]\nsay 2 * ((xs + [1]))\nexit\n",
    [],
  ],
  [
    "list of number + integer at product/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nsay 2 * (xs)\nexit\n",
    [],
  ],
  [
    "list of number + integer at text join/(xs + [1])",
    'let xs = [1.5]\nsay "a" + ((xs + [1]))\nexit\n',
    [],
  ],
  [
    "list of number + integer at text join/xs.add(1)",
    'let xs = [1.5]\nxs.add(1)\nsay "a" + (xs)\nexit\n',
    [],
  ],
  [
    "list of number + integer at text argument/xs + [1]",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow(xs + [1])\nexit\n",
    [],
  ],
  [
    "list of number + integer at text argument/xs.add(1)",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nxs.add(1)\nshow(xs)\nexit\n",
    [],
  ],
  [
    "list of number + integer at integer argument/xs + [1]",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\ncount(xs + [1])\nexit\n",
    [],
  ],
  [
    "list of number + integer at integer argument/xs.add(1)",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\nxs.add(1)\ncount(xs)\nexit\n",
    [],
  ],
  [
    "list of number + integer at object store/xs + [1]",
    'let xs = [1.5]\nlet o = {n: "x"}\no = xs + [1]\nexit\n',
    [],
  ],
  [
    "list of number + integer at object store/xs.add(1)",
    'let xs = [1.5]\nlet o = {n: "x"}\nxs.add(1)\no = xs\nexit\n',
    [],
  ],
  [
    "list of number + integer at untyped variable's trim/xs + [1]",
    "let xs = [1.5]\nlet v = xs + [1]\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of number + integer at untyped variable's trim/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nlet v = xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of number + integer at untyped trim argument/xs + [1]",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nuse(xs + [1])\nexit\n",
  ],
  [
    "list of number + integer at untyped trim argument/xs.add(1)",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nxs.add(1)\nuse(xs)\nexit\n",
  ],
  [
    "list of number + integer at untyped sum argument/xs + [1]",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nsay count(xs + [1])\nexit\n",
  ],
  [
    "list of number + integer at untyped sum argument/xs.add(1)",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nxs.add(1)\nsay count(xs)\nexit\n",
  ],
  [
    "list of number + integer at untyped returned argument/xs + [1]",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nlet w: string = id(xs + [1])\nsay w\nexit\n",
  ],
  [
    "list of number + integer at untyped returned argument/xs.add(1)",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nxs.add(1)\nlet w: string = id(xs)\nsay w\nexit\n",
  ],
  [
    "list of number + integer at divisor/(xs + [1])",
    "let xs = [1.5]\nsay 1 / ((xs + [1]))\nexit\n",
    [],
  ],
  [
    "list of number + integer at divisor/xs.add(1)",
    "let xs = [1.5]\nxs.add(1)\nsay 1 / (xs)\nexit\n",
    [],
  ],
  [
    "integer + list of number at string declaration/[1] + xs",
    "let xs = [1.5]\nlet v: string = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of number at integer declaration/[1] + xs",
    "let xs = [1.5]\nlet v: integer = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of number at number declaration/[1] + xs",
    "let xs = [1.5]\nlet v: number = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of number at boolean declaration/[1] + xs",
    "let xs = [1.5]\nlet v: boolean = [1] + xs\nexit\n",
    [],
  ],
  [
    "integer + list of number at text store/[1] + xs",
    'let xs = [1.5]\nlet v = "x"\nv = [1] + xs\nexit\n',
    [],
  ],
  [
    "integer + list of number at sum/([1] + xs)",
    "let xs = [1.5]\nsay (([1] + xs)) + 1\nexit\n",
    [],
  ],
  [
    "integer + list of number at product/([1] + xs)",
    "let xs = [1.5]\nsay 2 * (([1] + xs))\nexit\n",
    [],
  ],
  [
    "integer + list of number at text join/([1] + xs)",
    'let xs = [1.5]\nsay "a" + (([1] + xs))\nexit\n',
    [],
  ],
  [
    "integer + list of number at text argument/[1] + xs",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow([1] + xs)\nexit\n",
    [],
  ],
  [
    "integer + list of number at integer argument/[1] + xs",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\ncount([1] + xs)\nexit\n",
    [],
  ],
  [
    "integer + list of number at object store/[1] + xs",
    'let xs = [1.5]\nlet o = {n: "x"}\no = [1] + xs\nexit\n',
    [],
  ],
  [
    "integer + list of number at untyped variable's trim/[1] + xs",
    "let xs = [1.5]\nlet v = [1] + xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "integer + list of number at untyped trim argument/[1] + xs",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nuse([1] + xs)\nexit\n",
  ],
  [
    "integer + list of number at untyped sum argument/[1] + xs",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nsay count([1] + xs)\nexit\n",
  ],
  [
    "integer + list of number at untyped returned argument/[1] + xs",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nlet w: string = id([1] + xs)\nsay w\nexit\n",
  ],
  [
    "integer + list of number at divisor/([1] + xs)",
    "let xs = [1.5]\nsay 1 / (([1] + xs))\nexit\n",
    [],
  ],
  [
    "list of number + number at string declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v: string = xs + [1.5]\nexit\n",
    [],
  ],
  [
    "list of number + number at string declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v: string = xs\nexit\n",
    [],
  ],
  [
    "list of number + number at integer declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v: integer = xs + [1.5]\nexit\n",
    [],
  ],
  [
    "list of number + number at integer declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v: integer = xs\nexit\n",
    [],
  ],
  [
    "list of number + number at number declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v: number = xs + [1.5]\nexit\n",
    [],
  ],
  [
    "list of number + number at number declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v: number = xs\nexit\n",
    [],
  ],
  [
    "list of number + number at boolean declaration/xs + [1.5]",
    "let xs = [1.5]\nlet v: boolean = xs + [1.5]\nexit\n",
    [],
  ],
  [
    "list of number + number at boolean declaration/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v: boolean = xs\nexit\n",
    [],
  ],
  [
    "list of number + number at text store/xs + [1.5]",
    'let xs = [1.5]\nlet v = "x"\nv = xs + [1.5]\nexit\n',
    [],
  ],
  [
    "list of number + number at text store/xs.add(1.5)",
    'let xs = [1.5]\nlet v = "x"\nxs.add(1.5)\nv = xs\nexit\n',
    [],
  ],
  [
    "list of number + number at sum/(xs + [1.5])",
    "let xs = [1.5]\nsay ((xs + [1.5])) + 1\nexit\n",
    [],
  ],
  [
    "list of number + number at sum/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nsay (xs) + 1\nexit\n",
    [],
  ],
  [
    "list of number + number at product/(xs + [1.5])",
    "let xs = [1.5]\nsay 2 * ((xs + [1.5]))\nexit\n",
    [],
  ],
  [
    "list of number + number at product/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nsay 2 * (xs)\nexit\n",
    [],
  ],
  [
    "list of number + number at text join/(xs + [1.5])",
    'let xs = [1.5]\nsay "a" + ((xs + [1.5]))\nexit\n',
    [],
  ],
  [
    "list of number + number at text join/xs.add(1.5)",
    'let xs = [1.5]\nxs.add(1.5)\nsay "a" + (xs)\nexit\n',
    [],
  ],
  [
    "list of number + number at text argument/xs + [1.5]",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow(xs + [1.5])\nexit\n",
    [],
  ],
  [
    "list of number + number at text argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nxs.add(1.5)\nshow(xs)\nexit\n",
    [],
  ],
  [
    "list of number + number at integer argument/xs + [1.5]",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\ncount(xs + [1.5])\nexit\n",
    [],
  ],
  [
    "list of number + number at integer argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\nxs.add(1.5)\ncount(xs)\nexit\n",
    [],
  ],
  [
    "list of number + number at object store/xs + [1.5]",
    'let xs = [1.5]\nlet o = {n: "x"}\no = xs + [1.5]\nexit\n',
    [],
  ],
  [
    "list of number + number at object store/xs.add(1.5)",
    'let xs = [1.5]\nlet o = {n: "x"}\nxs.add(1.5)\no = xs\nexit\n',
    [],
  ],
  [
    "list of number + number at untyped variable's trim/xs + [1.5]",
    "let xs = [1.5]\nlet v = xs + [1.5]\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of number + number at untyped variable's trim/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nlet v = xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list of number + number at untyped trim argument/xs + [1.5]",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nuse(xs + [1.5])\nexit\n",
  ],
  [
    "list of number + number at untyped trim argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nxs.add(1.5)\nuse(xs)\nexit\n",
  ],
  [
    "list of number + number at untyped sum argument/xs + [1.5]",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nsay count(xs + [1.5])\nexit\n",
  ],
  [
    "list of number + number at untyped sum argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nxs.add(1.5)\nsay count(xs)\nexit\n",
  ],
  [
    "list of number + number at untyped returned argument/xs + [1.5]",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nlet w: string = id(xs + [1.5])\nsay w\nexit\n",
  ],
  [
    "list of number + number at untyped returned argument/xs.add(1.5)",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nxs.add(1.5)\nlet w: string = id(xs)\nsay w\nexit\n",
  ],
  [
    "list of number + number at divisor/(xs + [1.5])",
    "let xs = [1.5]\nsay 1 / ((xs + [1.5]))\nexit\n",
    [],
  ],
  [
    "list of number + number at divisor/xs.add(1.5)",
    "let xs = [1.5]\nxs.add(1.5)\nsay 1 / (xs)\nexit\n",
    [],
  ],
  [
    "number + list of number at string declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v: string = [1.5] + xs\nexit\n",
    [],
  ],
  [
    "number + list of number at integer declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v: integer = [1.5] + xs\nexit\n",
    [],
  ],
  [
    "number + list of number at number declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v: number = [1.5] + xs\nexit\n",
    [],
  ],
  [
    "number + list of number at boolean declaration/[1.5] + xs",
    "let xs = [1.5]\nlet v: boolean = [1.5] + xs\nexit\n",
    [],
  ],
  [
    "number + list of number at text store/[1.5] + xs",
    'let xs = [1.5]\nlet v = "x"\nv = [1.5] + xs\nexit\n',
    [],
  ],
  [
    "number + list of number at sum/([1.5] + xs)",
    "let xs = [1.5]\nsay (([1.5] + xs)) + 1\nexit\n",
    [],
  ],
  [
    "number + list of number at product/([1.5] + xs)",
    "let xs = [1.5]\nsay 2 * (([1.5] + xs))\nexit\n",
    [],
  ],
  [
    "number + list of number at text join/([1.5] + xs)",
    'let xs = [1.5]\nsay "a" + (([1.5] + xs))\nexit\n',
    [],
  ],
  [
    "number + list of number at text argument/[1.5] + xs",
    "let xs = [1.5]\nfunction show(p: string) {\n  say p\n}\nshow([1.5] + xs)\nexit\n",
    [],
  ],
  [
    "number + list of number at integer argument/[1.5] + xs",
    "let xs = [1.5]\nfunction count(p: integer) {\n  say p\n}\ncount([1.5] + xs)\nexit\n",
    [],
  ],
  [
    "number + list of number at object store/[1.5] + xs",
    'let xs = [1.5]\nlet o = {n: "x"}\no = [1.5] + xs\nexit\n',
    [],
  ],
  [
    "number + list of number at untyped variable's trim/[1.5] + xs",
    "let xs = [1.5]\nlet v = [1.5] + xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "number + list of number at untyped trim argument/[1.5] + xs",
    "let xs = [1.5]\nfunction use(p) {\n  say p.trim()\n}\nuse([1.5] + xs)\nexit\n",
  ],
  [
    "number + list of number at untyped sum argument/[1.5] + xs",
    "let xs = [1.5]\nfunction count(p) {\n  return p + 1\n}\nsay count([1.5] + xs)\nexit\n",
  ],
  [
    "number + list of number at untyped returned argument/[1.5] + xs",
    "let xs = [1.5]\nfunction id(p) {\n  return p\n}\nlet w: string = id([1.5] + xs)\nsay w\nexit\n",
  ],
  [
    "number + list of number at divisor/([1.5] + xs)",
    "let xs = [1.5]\nsay 1 / (([1.5] + xs))\nexit\n",
    [],
  ],
  [
    "list + range at string declaration/(1..3).toList()",
    "let xs = [1]\nlet v: string = xs + ((1..3).toList())\nexit\n",
    [],
  ],
  [
    "list + range at integer declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer = xs + ((1..3).toList())\nexit\n",
    [],
  ],
  [
    "list + range at number declaration/(1..3).toList()",
    "let xs = [1]\nlet v: number = xs + ((1..3).toList())\nexit\n",
    [],
  ],
  [
    "list + range at boolean declaration/(1..3).toList()",
    "let xs = [1]\nlet v: boolean = xs + ((1..3).toList())\nexit\n",
    [],
  ],
  [
    "list + range at text store/(1..3).toList()",
    'let xs = [1]\nlet v = "x"\nv = xs + ((1..3).toList())\nexit\n',
    [],
  ],
  [
    "list + range at sum/(1..3).toList()",
    "let xs = [1]\nsay (xs + ((1..3).toList())) + 1\nexit\n",
    [],
  ],
  [
    "list + range at product/(1..3).toList()",
    "let xs = [1]\nsay 2 * (xs + ((1..3).toList()))\nexit\n",
    [],
  ],
  [
    "list + range at text join/(1..3).toList()",
    'let xs = [1]\nsay "a" + (xs + ((1..3).toList()))\nexit\n',
    [],
  ],
  [
    "list + range at text argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p: string) {\n  say p\n}\nshow(xs + ((1..3).toList()))\nexit\n",
    [],
  ],
  [
    "list + range at integer argument/(1..3).toList()",
    "let xs = [1]\nfunction count(p: integer) {\n  say p\n}\ncount(xs + ((1..3).toList()))\nexit\n",
    [],
  ],
  [
    "list + range at object store/(1..3).toList()",
    'let xs = [1]\nlet o = {n: "x"}\no = xs + ((1..3).toList())\nexit\n',
    [],
  ],
  [
    "list + range at untyped variable's trim/(1..3).toList()",
    "let xs = [1]\nlet v = xs + ((1..3).toList())\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "list + range at untyped trim argument/(1..3).toList()",
    "let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse(xs + ((1..3).toList()))\nexit\n",
  ],
  [
    "list + range at untyped sum argument/(1..3).toList()",
    "let xs = [1]\nfunction count(p) {\n  return p + 1\n}\nsay count(xs + ((1..3).toList()))\nexit\n",
  ],
  [
    "list + range at untyped returned argument/(1..3).toList()",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id(xs + ((1..3).toList()))\nsay w\nexit\n",
  ],
  [
    "list + range at divisor/(1..3).toList()",
    "let xs = [1]\nsay 1 / (xs + ((1..3).toList()))\nexit\n",
    [],
  ],
  [
    "range + list at string declaration/(1..3).toList()",
    "let xs = [1]\nlet v: string = ((1..3).toList()) + xs\nexit\n",
    [],
  ],
  [
    "range + list at integer declaration/(1..3).toList()",
    "let xs = [1]\nlet v: integer = ((1..3).toList()) + xs\nexit\n",
    [],
  ],
  [
    "range + list at number declaration/(1..3).toList()",
    "let xs = [1]\nlet v: number = ((1..3).toList()) + xs\nexit\n",
    [],
  ],
  [
    "range + list at boolean declaration/(1..3).toList()",
    "let xs = [1]\nlet v: boolean = ((1..3).toList()) + xs\nexit\n",
    [],
  ],
  [
    "range + list at text store/(1..3).toList()",
    'let xs = [1]\nlet v = "x"\nv = ((1..3).toList()) + xs\nexit\n',
    [],
  ],
  [
    "range + list at sum/(1..3).toList()",
    "let xs = [1]\nsay (((1..3).toList()) + xs) + 1\nexit\n",
    [],
  ],
  [
    "range + list at product/(1..3).toList()",
    "let xs = [1]\nsay 2 * (((1..3).toList()) + xs)\nexit\n",
    [],
  ],
  [
    "range + list at text join/(1..3).toList()",
    'let xs = [1]\nsay "a" + (((1..3).toList()) + xs)\nexit\n',
    [],
  ],
  [
    "range + list at text argument/(1..3).toList()",
    "let xs = [1]\nfunction show(p: string) {\n  say p\n}\nshow(((1..3).toList()) + xs)\nexit\n",
    [],
  ],
  [
    "range + list at integer argument/(1..3).toList()",
    "let xs = [1]\nfunction count(p: integer) {\n  say p\n}\ncount(((1..3).toList()) + xs)\nexit\n",
    [],
  ],
  [
    "range + list at object store/(1..3).toList()",
    'let xs = [1]\nlet o = {n: "x"}\no = ((1..3).toList()) + xs\nexit\n',
    [],
  ],
  [
    "range + list at untyped variable's trim/(1..3).toList()",
    "let xs = [1]\nlet v = ((1..3).toList()) + xs\nsay v.trim()\nexit\n",
    [],
  ],
  [
    "range + list at untyped trim argument/(1..3).toList()",
    "let xs = [1]\nfunction use(p) {\n  say p.trim()\n}\nuse(((1..3).toList()) + xs)\nexit\n",
  ],
  [
    "range + list at untyped sum argument/(1..3).toList()",
    "let xs = [1]\nfunction count(p) {\n  return p + 1\n}\nsay count(((1..3).toList()) + xs)\nexit\n",
  ],
  [
    "range + list at untyped returned argument/(1..3).toList()",
    "let xs = [1]\nfunction id(p) {\n  return p\n}\nlet w: string = id(((1..3).toList()) + xs)\nsay w\nexit\n",
  ],
  [
    "range + list at divisor/(1..3).toList()",
    "let xs = [1]\nsay 1 / (((1..3).toList()) + xs)\nexit\n",
    [],
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node paste.mjs head paste-clean.json", "R/astra-m4-i1241-review/paste-group.sh:5"],
    [
      "node paste.mjs mutant paste-mutant.json full mutant",
      "R/astra-m4-i1241-review/paste-group.sh:12",
    ],
    [
      "node paste.mjs head paste-clean-sample.json sample",
      "R/astra-m4-i1241-review/paste-group.sh:13",
    ],
  ],
  sources: 945,
  sha256: "d0c699b30f5b3d32d28d8504b80d826c339dba781c08e8e836eca7eecc319367",
};
