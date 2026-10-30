// G3 part 3's review (Astra): its 132 cases (cases.mjs) and the traced program its clean trace adds
// (R/astra-m4-g3-p3-review-evidence/clean-trace.mjs).
export const cases = [
  [
    "clean-trace-j0-input1",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input2",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input3",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input4",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input5",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input6",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input7",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input8",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input9",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input10",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input11",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input12",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input13",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input14",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input15",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input16",
    'let leaf: integer = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input17",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input18",
    "let leaf: integer = 3\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input19",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input20",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input21",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input22",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input23",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input24",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input25",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input26",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input27",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input28",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input29",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input30",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input31",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input32",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input33",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input34",
    'let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input35",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input36",
    "let leaf: integer? = null\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input37",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input38",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input39",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input40",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input41",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input42",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input43",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input44",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input45",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input46",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input47",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input48",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input49",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input50",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input51",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input52",
    'let leaf: integer | string = 3\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input53",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input54",
    "let leaf: integer | string = 3\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input55",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input56",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input57",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input58",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input59",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input60",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input61",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input62",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input63",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input64",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input65",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input66",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input67",
    "let leaf = hostValue\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input68",
    "let leaf = hostValue\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input69",
    "let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input70",
    'let leaf = hostValue\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input71",
    "let leaf = hostValue\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input72",
    "let leaf = hostValue\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input73",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input74",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input75",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input76",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input77",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input78",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input79",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input80",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input81",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input82",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input83",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input84",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input85",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input86",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input87",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input88",
    'let leaf: integer[] = [3]\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input89",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input90",
    "let leaf: integer[] = [3]\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input91",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input92",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet other = upper\nlet side = upper.right\nsay side\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input93",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = [upper, upper][0]\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input94",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet selected = upper otherwise {right: lower}\nlet result = selected.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input95",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nleaf = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input96",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = {cell: hostOther}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input97",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nroot.cell = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input98",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nupper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input99",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input100",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.left = 3\nlower.left = root\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input101",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif upper.right is object {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input102",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nif root.cell is integer {\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input103",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nif hostOther {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input104",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nrepeat 2 {\nlet lower = {left: root}\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\nroot.cell = hostOther\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input105",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nfunction touch { root.cell = hostOther }\nlet before = upper.right.left.cell\ntouch()\nlet result = upper.right.left.cell\nsay result\nexit\n",
  ],
  [
    "clean-trace-j0-input106",
    'let leaf = dict {one: 3}\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nshowPermanentButton "change" { lower.left = {cell: hostOther} }\nwait 1 s\nlet result = upper.right.left.cell\nsay result\nexit\n',
  ],
  [
    "clean-trace-j0-input107",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\nexit\n",
  ],
  [
    "clean-trace-j0-input108",
    "let leaf = dict {one: 3}\nlet root = {cell: leaf}\nfunction take(lower = {left: root}) {\nlet upper = {right: lower}\nlet result = upper.right.left.cell\nsay result\n}\ntake()\ntake({left: root})\nexit\n",
  ],
  [
    "clean-trace-j0-input109",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\ntree = {a:{b:{c:2}}}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input110",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nif tree is object {\nlet after = alias.q.a.b.c\nsay after\n}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input111",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nfunction change { tree = {a:{b:{c:2}}} }\nchange()\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input112",
    'let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nshowPermanentButton "change" { tree = {a:{b:{c:2}}} }\nwait 1 s\nlet after = alias.q.a.b.c\nsay after\nexit\n',
  ],
  [
    "clean-trace-j0-input113",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\ntree.a = {b:{c:2}}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input114",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nif tree.a is object {\nlet after = alias.q.a.b.c\nsay after\n}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input115",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nfunction change { tree.a = {b:{c:2}} }\nchange()\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input116",
    'let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nshowPermanentButton "change" { tree.a = {b:{c:2}} }\nwait 1 s\nlet after = alias.q.a.b.c\nsay after\nexit\n',
  ],
  [
    "clean-trace-j0-input117",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\ntree.a.b = {c:2}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input118",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nif tree.a.b is object {\nlet after = alias.q.a.b.c\nsay after\n}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input119",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nfunction change { tree.a.b = {c:2} }\nchange()\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input120",
    'let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nshowPermanentButton "change" { tree.a.b = {c:2} }\nwait 1 s\nlet after = alias.q.a.b.c\nsay after\nexit\n',
  ],
  [
    "clean-trace-j0-input121",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\ntree.a.b.c = 2\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input122",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nif tree.a.b.c is integer {\nlet after = alias.q.a.b.c\nsay after\n}\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input123",
    "let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nfunction change { tree.a.b.c = 2 }\nchange()\nlet after = alias.q.a.b.c\nsay after\nexit\n",
  ],
  [
    "clean-trace-j0-input124",
    'let tree = {a:{b:{c:1}}}\nlet alias = {q: tree}\nlet before = alias.q.a.b.c\nshowPermanentButton "change" { tree.a.b.c = 2 }\nwait 1 s\nlet after = alias.q.a.b.c\nsay after\nexit\n',
  ],
  [
    "clean-trace-j0-input125",
    "let root = {cell: 3}\nlet lower = {left: root}\nlet upper = {right: lower}\nlet answer = upper.right.left.cell\nsay answer\nexit\n",
  ],
  [
    "clean-trace-j0-input126",
    "let root = {cell: 3}\nlet lower = {left: root}\nlet upper: object = {right: lower}\nlet answer = upper.right.left.cell\nsay answer\nexit\n",
  ],
  [
    "clean-trace-j0-input127",
    'let a = [load("one", default: {v: 1}), {v: 2}]\nlet b = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input128",
    'let a = [load("one", default: {v: "text"}), {v: 2}]\nlet b = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input129",
    'let a = [load("one", default: {v: hostValue}), {v: 2}]\nlet b = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input130",
    'let a = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet b = [load("one", default: {v: 1}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input131",
    'let a = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet b = [load("one", default: {v: "text"}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input132",
    'let a = [fromJson(hostOther, default: {v: "other"}), {v: 2}]\nlet b = [load("one", default: {v: hostValue}), {v: 2}]\nlet box = {one: a, two: b}\nlet copied = box\nsay copied\nexit\n',
  ],
  [
    "clean-trace-j0-input133",
    "let seed:integer=1\nlet root={f:seed}\nlet a0={q:root}\nlet a1={q:a0}\nlet a2={q:a1}\nlet out=a2.q.q.q.f\nexit\n",
    ["hostValue"],
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node clean-trace.mjs /stub/out", "R/astra-m4-g3-p3-review-evidence/README.md:16"]],
  sources: 133,
  sha256: "b7f209c7763d12498fa8219d269544848a00af3443f174611cba0a339c36b9f5",
};
