export const cases = [
  [
    "original-1",
    'let u: (boolean | string)[] = [true]\nlet result = (u + [false]) + ["tail"]\nexit\n',
  ],
  [
    "original-2",
    'let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-3",
    'let u: (boolean | string)[] = [true]\nlet result = ["tail"] + (u + [false])\nexit\n',
  ],
  [
    "original-4",
    'let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-5",
    'let u: (boolean | string)[] = [true]\nlet result = [] + ((u + [false]) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-6",
    'let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-7",
    'let u: (boolean | string)[] = [true]\nlet result = (u + [false])\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-8",
    'let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-9", "let u: (boolean | string)[] = [true]\nlet result = (u + [false]) + [2]\nexit\n"],
  [
    "original-10",
    "let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = held + [2]\nexit\n",
  ],
  ["original-11", "let u: (boolean | string)[] = [true]\nlet result = [2] + (u + [false])\nexit\n"],
  [
    "original-12",
    "let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-13",
    "let u: (boolean | string)[] = [true]\nlet result = [] + ((u + [false]) + ([2] + []))\nexit\n",
  ],
  [
    "original-14",
    "let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-15",
    "let u: (boolean | string)[] = [true]\nlet result = (u + [false])\nresult += [2]\nexit\n",
  ],
  [
    "original-16",
    "let u: (boolean | string)[] = [true]\nlet held = u + [false]\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-17",
    'let u: (boolean | string)[] = [true]\nlet result = ([false] + u) + ["tail"]\nexit\n',
  ],
  [
    "original-18",
    'let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-19",
    'let u: (boolean | string)[] = [true]\nlet result = ["tail"] + ([false] + u)\nexit\n',
  ],
  [
    "original-20",
    'let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-21",
    'let u: (boolean | string)[] = [true]\nlet result = [] + (([false] + u) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-22",
    'let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-23",
    'let u: (boolean | string)[] = [true]\nlet result = ([false] + u)\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-24",
    'let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-25", "let u: (boolean | string)[] = [true]\nlet result = ([false] + u) + [2]\nexit\n"],
  [
    "original-26",
    "let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = held + [2]\nexit\n",
  ],
  ["original-27", "let u: (boolean | string)[] = [true]\nlet result = [2] + ([false] + u)\nexit\n"],
  [
    "original-28",
    "let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-29",
    "let u: (boolean | string)[] = [true]\nlet result = [] + (([false] + u) + ([2] + []))\nexit\n",
  ],
  [
    "original-30",
    "let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-31",
    "let u: (boolean | string)[] = [true]\nlet result = ([false] + u)\nresult += [2]\nexit\n",
  ],
  [
    "original-32",
    "let u: (boolean | string)[] = [true]\nlet held = [false] + u\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-33",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = (clone + [false]) + ["tail"]\nexit\n',
  ],
  [
    "original-34",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-35",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ["tail"] + (clone + [false])\nexit\n',
  ],
  [
    "original-36",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-37",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [] + ((clone + [false]) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-38",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-39",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = (clone + [false])\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-40",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-41",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = (clone + [false]) + [2]\nexit\n",
  ],
  [
    "original-42",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-43",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [2] + (clone + [false])\nexit\n",
  ],
  [
    "original-44",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-45",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [] + ((clone + [false]) + ([2] + []))\nexit\n",
  ],
  [
    "original-46",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-47",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = (clone + [false])\nresult += [2]\nexit\n",
  ],
  [
    "original-48",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = clone + [false]\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-49",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ([false] + clone) + ["tail"]\nexit\n',
  ],
  [
    "original-50",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-51",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ["tail"] + ([false] + clone)\nexit\n',
  ],
  [
    "original-52",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-53",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [] + (([false] + clone) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-54",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-55",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ([false] + clone)\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-56",
    'let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-57",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ([false] + clone) + [2]\nexit\n",
  ],
  [
    "original-58",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-59",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [2] + ([false] + clone)\nexit\n",
  ],
  [
    "original-60",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-61",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = [] + (([false] + clone) + ([2] + []))\nexit\n",
  ],
  [
    "original-62",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-63",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet result = ([false] + clone)\nresult += [2]\nexit\n",
  ],
  [
    "original-64",
    "let u: (boolean | string)[] = [true]\nlet clone = u\nlet held = [false] + clone\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-65",
    'function make: (boolean | string)[] { return [true] }\nlet result = (make() + [false]) + ["tail"]\nexit\n',
  ],
  [
    "original-66",
    'function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-67",
    'function make: (boolean | string)[] { return [true] }\nlet result = ["tail"] + (make() + [false])\nexit\n',
  ],
  [
    "original-68",
    'function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-69",
    'function make: (boolean | string)[] { return [true] }\nlet result = [] + ((make() + [false]) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-70",
    'function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-71",
    'function make: (boolean | string)[] { return [true] }\nlet result = (make() + [false])\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-72",
    'function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-73",
    "function make: (boolean | string)[] { return [true] }\nlet result = (make() + [false]) + [2]\nexit\n",
  ],
  [
    "original-74",
    "function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-75",
    "function make: (boolean | string)[] { return [true] }\nlet result = [2] + (make() + [false])\nexit\n",
  ],
  [
    "original-76",
    "function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-77",
    "function make: (boolean | string)[] { return [true] }\nlet result = [] + ((make() + [false]) + ([2] + []))\nexit\n",
  ],
  [
    "original-78",
    "function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-79",
    "function make: (boolean | string)[] { return [true] }\nlet result = (make() + [false])\nresult += [2]\nexit\n",
  ],
  [
    "original-80",
    "function make: (boolean | string)[] { return [true] }\nlet held = make() + [false]\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-81",
    'function make: (boolean | string)[] { return [true] }\nlet result = ([false] + make()) + ["tail"]\nexit\n',
  ],
  [
    "original-82",
    'function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-83",
    'function make: (boolean | string)[] { return [true] }\nlet result = ["tail"] + ([false] + make())\nexit\n',
  ],
  [
    "original-84",
    'function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-85",
    'function make: (boolean | string)[] { return [true] }\nlet result = [] + (([false] + make()) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-86",
    'function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-87",
    'function make: (boolean | string)[] { return [true] }\nlet result = ([false] + make())\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-88",
    'function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-89",
    "function make: (boolean | string)[] { return [true] }\nlet result = ([false] + make()) + [2]\nexit\n",
  ],
  [
    "original-90",
    "function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-91",
    "function make: (boolean | string)[] { return [true] }\nlet result = [2] + ([false] + make())\nexit\n",
  ],
  [
    "original-92",
    "function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-93",
    "function make: (boolean | string)[] { return [true] }\nlet result = [] + (([false] + make()) + ([2] + []))\nexit\n",
  ],
  [
    "original-94",
    "function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-95",
    "function make: (boolean | string)[] { return [true] }\nlet result = ([false] + make())\nresult += [2]\nexit\n",
  ],
  [
    "original-96",
    "function make: (boolean | string)[] { return [true] }\nlet held = [false] + make()\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-97",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false]) + ["tail"]\nexit\n',
  ],
  [
    "original-98",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-99",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ["tail"] + (make() + [false])\nexit\n',
  ],
  [
    "original-100",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-101",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [] + ((make() + [false]) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-102",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-103",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false])\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-104",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-105",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false]) + [2]\nexit\n",
  ],
  [
    "original-106",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-107",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [2] + (make() + [false])\nexit\n",
  ],
  [
    "original-108",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-109",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [] + ((make() + [false]) + ([2] + []))\nexit\n",
  ],
  [
    "original-110",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-111",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false])\nresult += [2]\nexit\n",
  ],
  [
    "original-112",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-113",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ([false] + make()) + ["tail"]\nexit\n',
  ],
  [
    "original-114",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-115",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ["tail"] + ([false] + make())\nexit\n',
  ],
  [
    "original-116",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-117",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [] + (([false] + make()) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-118",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-119",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ([false] + make())\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-120",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-121",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ([false] + make()) + [2]\nexit\n",
  ],
  [
    "original-122",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = held + [2]\nexit\n",
  ],
  [
    "original-123",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [2] + ([false] + make())\nexit\n",
  ],
  [
    "original-124",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = [2] + held\nexit\n",
  ],
  [
    "original-125",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = [] + (([false] + make()) + ([2] + []))\nexit\n",
  ],
  [
    "original-126",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = [] + (held + ([2] + []))\nexit\n",
  ],
  [
    "original-127",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = ([false] + make())\nresult += [2]\nexit\n",
  ],
  [
    "original-128",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = [false] + make()\nlet result = held\nresult += [2]\nexit\n",
  ],
  [
    "original-129",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = (box.values + [3]) + [2.5]\nexit\n",
  ],
  [
    "original-130",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = held + [2.5]\nexit\n",
  ],
  [
    "original-131",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [2.5] + (box.values + [3])\nexit\n",
  ],
  [
    "original-132",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = [2.5] + held\nexit\n",
  ],
  [
    "original-133",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [] + ((box.values + [3]) + ([2.5] + []))\nexit\n",
  ],
  [
    "original-134",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = [] + (held + ([2.5] + []))\nexit\n",
  ],
  [
    "original-135",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = (box.values + [3])\nresult += [2.5]\nexit\n",
  ],
  [
    "original-136",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = held\nresult += [2.5]\nexit\n",
  ],
  [
    "original-137",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = (box.values + [3]) + ["tail"]\nexit\n',
  ],
  [
    "original-138",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-139",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ["tail"] + (box.values + [3])\nexit\n',
  ],
  [
    "original-140",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-141",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [] + ((box.values + [3]) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-142",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-143",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = (box.values + [3])\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-144",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = box.values + [3]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-145",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ([3] + box.values) + [2.5]\nexit\n",
  ],
  [
    "original-146",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = held + [2.5]\nexit\n",
  ],
  [
    "original-147",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [2.5] + ([3] + box.values)\nexit\n",
  ],
  [
    "original-148",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = [2.5] + held\nexit\n",
  ],
  [
    "original-149",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [] + (([3] + box.values) + ([2.5] + []))\nexit\n",
  ],
  [
    "original-150",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = [] + (held + ([2.5] + []))\nexit\n",
  ],
  [
    "original-151",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ([3] + box.values)\nresult += [2.5]\nexit\n",
  ],
  [
    "original-152",
    "let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = held\nresult += [2.5]\nexit\n",
  ],
  [
    "original-153",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ([3] + box.values) + ["tail"]\nexit\n',
  ],
  [
    "original-154",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "original-155",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ["tail"] + ([3] + box.values)\nexit\n',
  ],
  [
    "original-156",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = ["tail"] + held\nexit\n',
  ],
  [
    "original-157",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = [] + (([3] + box.values) + (["tail"] + []))\nexit\n',
  ],
  [
    "original-158",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  [
    "original-159",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet result = ([3] + box.values)\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-160",
    'let box = {values: [1]}\nbox.values.add(1.5)\nlet held = [3] + box.values\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-161", "let box = [[1]]\nlet result = (box[0] + [2]) + [3]\nexit\n"],
  ["original-162", "let box = [[1]]\nlet held = box[0] + [2]\nlet result = held + [3]\nexit\n"],
  ["original-163", "let box = [[1]]\nlet result = [3] + (box[0] + [2])\nexit\n"],
  ["original-164", "let box = [[1]]\nlet held = box[0] + [2]\nlet result = [3] + held\nexit\n"],
  ["original-165", "let box = [[1]]\nlet result = [] + ((box[0] + [2]) + ([3] + []))\nexit\n"],
  [
    "original-166",
    "let box = [[1]]\nlet held = box[0] + [2]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-167", "let box = [[1]]\nlet result = (box[0] + [2])\nresult += [3]\nexit\n"],
  [
    "original-168",
    "let box = [[1]]\nlet held = box[0] + [2]\nlet result = held\nresult += [3]\nexit\n",
  ],
  ["original-169", 'let box = [[1]]\nlet result = (box[0] + [2]) + ["tail"]\nexit\n'],
  [
    "original-170",
    'let box = [[1]]\nlet held = box[0] + [2]\nlet result = held + ["tail"]\nexit\n',
  ],
  ["original-171", 'let box = [[1]]\nlet result = ["tail"] + (box[0] + [2])\nexit\n'],
  [
    "original-172",
    'let box = [[1]]\nlet held = box[0] + [2]\nlet result = ["tail"] + held\nexit\n',
  ],
  ["original-173", 'let box = [[1]]\nlet result = [] + ((box[0] + [2]) + (["tail"] + []))\nexit\n'],
  [
    "original-174",
    'let box = [[1]]\nlet held = box[0] + [2]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-175", 'let box = [[1]]\nlet result = (box[0] + [2])\nresult += ["tail"]\nexit\n'],
  [
    "original-176",
    'let box = [[1]]\nlet held = box[0] + [2]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-177", "let box = [[1]]\nlet result = ([2] + box[0]) + [3]\nexit\n"],
  ["original-178", "let box = [[1]]\nlet held = [2] + box[0]\nlet result = held + [3]\nexit\n"],
  ["original-179", "let box = [[1]]\nlet result = [3] + ([2] + box[0])\nexit\n"],
  ["original-180", "let box = [[1]]\nlet held = [2] + box[0]\nlet result = [3] + held\nexit\n"],
  ["original-181", "let box = [[1]]\nlet result = [] + (([2] + box[0]) + ([3] + []))\nexit\n"],
  [
    "original-182",
    "let box = [[1]]\nlet held = [2] + box[0]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-183", "let box = [[1]]\nlet result = ([2] + box[0])\nresult += [3]\nexit\n"],
  [
    "original-184",
    "let box = [[1]]\nlet held = [2] + box[0]\nlet result = held\nresult += [3]\nexit\n",
  ],
  ["original-185", 'let box = [[1]]\nlet result = ([2] + box[0]) + ["tail"]\nexit\n'],
  [
    "original-186",
    'let box = [[1]]\nlet held = [2] + box[0]\nlet result = held + ["tail"]\nexit\n',
  ],
  ["original-187", 'let box = [[1]]\nlet result = ["tail"] + ([2] + box[0])\nexit\n'],
  [
    "original-188",
    'let box = [[1]]\nlet held = [2] + box[0]\nlet result = ["tail"] + held\nexit\n',
  ],
  ["original-189", 'let box = [[1]]\nlet result = [] + (([2] + box[0]) + (["tail"] + []))\nexit\n'],
  [
    "original-190",
    'let box = [[1]]\nlet held = [2] + box[0]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-191", 'let box = [[1]]\nlet result = ([2] + box[0])\nresult += ["tail"]\nexit\n'],
  [
    "original-192",
    'let box = [[1]]\nlet held = [2] + box[0]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-193",
    'let u: (integer | string | null)[] = [null]\nlet result = (u + [1,null]) + ["tail",null]\nexit\n',
  ],
  [
    "original-194",
    'let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = held + ["tail",null]\nexit\n',
  ],
  [
    "original-195",
    'let u: (integer | string | null)[] = [null]\nlet result = ["tail",null] + (u + [1,null])\nexit\n',
  ],
  [
    "original-196",
    'let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = ["tail",null] + held\nexit\n',
  ],
  [
    "original-197",
    'let u: (integer | string | null)[] = [null]\nlet result = [] + ((u + [1,null]) + (["tail",null] + []))\nexit\n',
  ],
  [
    "original-198",
    'let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = [] + (held + (["tail",null] + []))\nexit\n',
  ],
  [
    "original-199",
    'let u: (integer | string | null)[] = [null]\nlet result = (u + [1,null])\nresult += ["tail",null]\nexit\n',
  ],
  [
    "original-200",
    'let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = held\nresult += ["tail",null]\nexit\n',
  ],
  [
    "original-201",
    "let u: (integer | string | null)[] = [null]\nlet result = (u + [1,null]) + [true,null]\nexit\n",
  ],
  [
    "original-202",
    "let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = held + [true,null]\nexit\n",
  ],
  [
    "original-203",
    "let u: (integer | string | null)[] = [null]\nlet result = [true,null] + (u + [1,null])\nexit\n",
  ],
  [
    "original-204",
    "let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = [true,null] + held\nexit\n",
  ],
  [
    "original-205",
    "let u: (integer | string | null)[] = [null]\nlet result = [] + ((u + [1,null]) + ([true,null] + []))\nexit\n",
  ],
  [
    "original-206",
    "let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = [] + (held + ([true,null] + []))\nexit\n",
  ],
  [
    "original-207",
    "let u: (integer | string | null)[] = [null]\nlet result = (u + [1,null])\nresult += [true,null]\nexit\n",
  ],
  [
    "original-208",
    "let u: (integer | string | null)[] = [null]\nlet held = u + [1,null]\nlet result = held\nresult += [true,null]\nexit\n",
  ],
  [
    "original-209",
    'let u: (integer | string | null)[] = [null]\nlet result = ([1,null] + u) + ["tail",null]\nexit\n',
  ],
  [
    "original-210",
    'let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = held + ["tail",null]\nexit\n',
  ],
  [
    "original-211",
    'let u: (integer | string | null)[] = [null]\nlet result = ["tail",null] + ([1,null] + u)\nexit\n',
  ],
  [
    "original-212",
    'let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = ["tail",null] + held\nexit\n',
  ],
  [
    "original-213",
    'let u: (integer | string | null)[] = [null]\nlet result = [] + (([1,null] + u) + (["tail",null] + []))\nexit\n',
  ],
  [
    "original-214",
    'let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = [] + (held + (["tail",null] + []))\nexit\n',
  ],
  [
    "original-215",
    'let u: (integer | string | null)[] = [null]\nlet result = ([1,null] + u)\nresult += ["tail",null]\nexit\n',
  ],
  [
    "original-216",
    'let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = held\nresult += ["tail",null]\nexit\n',
  ],
  [
    "original-217",
    "let u: (integer | string | null)[] = [null]\nlet result = ([1,null] + u) + [true,null]\nexit\n",
  ],
  [
    "original-218",
    "let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = held + [true,null]\nexit\n",
  ],
  [
    "original-219",
    "let u: (integer | string | null)[] = [null]\nlet result = [true,null] + ([1,null] + u)\nexit\n",
  ],
  [
    "original-220",
    "let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = [true,null] + held\nexit\n",
  ],
  [
    "original-221",
    "let u: (integer | string | null)[] = [null]\nlet result = [] + (([1,null] + u) + ([true,null] + []))\nexit\n",
  ],
  [
    "original-222",
    "let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = [] + (held + ([true,null] + []))\nexit\n",
  ],
  [
    "original-223",
    "let u: (integer | string | null)[] = [null]\nlet result = ([1,null] + u)\nresult += [true,null]\nexit\n",
  ],
  [
    "original-224",
    "let u: (integer | string | null)[] = [null]\nlet held = [1,null] + u\nlet result = held\nresult += [true,null]\nexit\n",
  ],
  [
    "original-225",
    'let u: (boolean | string)[][] = [[true]]\nlet result = (u + [[false]]) + [["tail"]]\nexit\n',
  ],
  [
    "original-226",
    'let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = held + [["tail"]]\nexit\n',
  ],
  [
    "original-227",
    'let u: (boolean | string)[][] = [[true]]\nlet result = [["tail"]] + (u + [[false]])\nexit\n',
  ],
  [
    "original-228",
    'let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = [["tail"]] + held\nexit\n',
  ],
  [
    "original-229",
    'let u: (boolean | string)[][] = [[true]]\nlet result = [] + ((u + [[false]]) + ([["tail"]] + []))\nexit\n',
  ],
  [
    "original-230",
    'let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = [] + (held + ([["tail"]] + []))\nexit\n',
  ],
  [
    "original-231",
    'let u: (boolean | string)[][] = [[true]]\nlet result = (u + [[false]])\nresult += [["tail"]]\nexit\n',
  ],
  [
    "original-232",
    'let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = held\nresult += [["tail"]]\nexit\n',
  ],
  [
    "original-233",
    "let u: (boolean | string)[][] = [[true]]\nlet result = (u + [[false]]) + [[2]]\nexit\n",
  ],
  [
    "original-234",
    "let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = held + [[2]]\nexit\n",
  ],
  [
    "original-235",
    "let u: (boolean | string)[][] = [[true]]\nlet result = [[2]] + (u + [[false]])\nexit\n",
  ],
  [
    "original-236",
    "let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = [[2]] + held\nexit\n",
  ],
  [
    "original-237",
    "let u: (boolean | string)[][] = [[true]]\nlet result = [] + ((u + [[false]]) + ([[2]] + []))\nexit\n",
  ],
  [
    "original-238",
    "let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = [] + (held + ([[2]] + []))\nexit\n",
  ],
  [
    "original-239",
    "let u: (boolean | string)[][] = [[true]]\nlet result = (u + [[false]])\nresult += [[2]]\nexit\n",
  ],
  [
    "original-240",
    "let u: (boolean | string)[][] = [[true]]\nlet held = u + [[false]]\nlet result = held\nresult += [[2]]\nexit\n",
  ],
  [
    "original-241",
    'let u: (boolean | string)[][] = [[true]]\nlet result = ([[false]] + u) + [["tail"]]\nexit\n',
  ],
  [
    "original-242",
    'let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = held + [["tail"]]\nexit\n',
  ],
  [
    "original-243",
    'let u: (boolean | string)[][] = [[true]]\nlet result = [["tail"]] + ([[false]] + u)\nexit\n',
  ],
  [
    "original-244",
    'let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = [["tail"]] + held\nexit\n',
  ],
  [
    "original-245",
    'let u: (boolean | string)[][] = [[true]]\nlet result = [] + (([[false]] + u) + ([["tail"]] + []))\nexit\n',
  ],
  [
    "original-246",
    'let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = [] + (held + ([["tail"]] + []))\nexit\n',
  ],
  [
    "original-247",
    'let u: (boolean | string)[][] = [[true]]\nlet result = ([[false]] + u)\nresult += [["tail"]]\nexit\n',
  ],
  [
    "original-248",
    'let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = held\nresult += [["tail"]]\nexit\n',
  ],
  [
    "original-249",
    "let u: (boolean | string)[][] = [[true]]\nlet result = ([[false]] + u) + [[2]]\nexit\n",
  ],
  [
    "original-250",
    "let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = held + [[2]]\nexit\n",
  ],
  [
    "original-251",
    "let u: (boolean | string)[][] = [[true]]\nlet result = [[2]] + ([[false]] + u)\nexit\n",
  ],
  [
    "original-252",
    "let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = [[2]] + held\nexit\n",
  ],
  [
    "original-253",
    "let u: (boolean | string)[][] = [[true]]\nlet result = [] + (([[false]] + u) + ([[2]] + []))\nexit\n",
  ],
  [
    "original-254",
    "let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = [] + (held + ([[2]] + []))\nexit\n",
  ],
  [
    "original-255",
    "let u: (boolean | string)[][] = [[true]]\nlet result = ([[false]] + u)\nresult += [[2]]\nexit\n",
  ],
  [
    "original-256",
    "let u: (boolean | string)[][] = [[true]]\nlet held = [[false]] + u\nlet result = held\nresult += [[2]]\nexit\n",
  ],
  [
    "original-257",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = (u + [[false],null]) + [["tail",null]]\nexit\n',
  ],
  [
    "original-258",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = held + [["tail",null]]\nexit\n',
  ],
  [
    "original-259",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [["tail",null]] + (u + [[false],null])\nexit\n',
  ],
  [
    "original-260",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = [["tail",null]] + held\nexit\n',
  ],
  [
    "original-261",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [] + ((u + [[false],null]) + ([["tail",null]] + []))\nexit\n',
  ],
  [
    "original-262",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = [] + (held + ([["tail",null]] + []))\nexit\n',
  ],
  [
    "original-263",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = (u + [[false],null])\nresult += [["tail",null]]\nexit\n',
  ],
  [
    "original-264",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = held\nresult += [["tail",null]]\nexit\n',
  ],
  [
    "original-265",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = (u + [[false],null]) + [[2]]\nexit\n",
  ],
  [
    "original-266",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = held + [[2]]\nexit\n",
  ],
  [
    "original-267",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [[2]] + (u + [[false],null])\nexit\n",
  ],
  [
    "original-268",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = [[2]] + held\nexit\n",
  ],
  [
    "original-269",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [] + ((u + [[false],null]) + ([[2]] + []))\nexit\n",
  ],
  [
    "original-270",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = [] + (held + ([[2]] + []))\nexit\n",
  ],
  [
    "original-271",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = (u + [[false],null])\nresult += [[2]]\nexit\n",
  ],
  [
    "original-272",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = u + [[false],null]\nlet result = held\nresult += [[2]]\nexit\n",
  ],
  [
    "original-273",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = ([[false],null] + u) + [["tail",null]]\nexit\n',
  ],
  [
    "original-274",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = held + [["tail",null]]\nexit\n',
  ],
  [
    "original-275",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [["tail",null]] + ([[false],null] + u)\nexit\n',
  ],
  [
    "original-276",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = [["tail",null]] + held\nexit\n',
  ],
  [
    "original-277",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [] + (([[false],null] + u) + ([["tail",null]] + []))\nexit\n',
  ],
  [
    "original-278",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = [] + (held + ([["tail",null]] + []))\nexit\n',
  ],
  [
    "original-279",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = ([[false],null] + u)\nresult += [["tail",null]]\nexit\n',
  ],
  [
    "original-280",
    'let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = held\nresult += [["tail",null]]\nexit\n',
  ],
  [
    "original-281",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = ([[false],null] + u) + [[2]]\nexit\n",
  ],
  [
    "original-282",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = held + [[2]]\nexit\n",
  ],
  [
    "original-283",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [[2]] + ([[false],null] + u)\nexit\n",
  ],
  [
    "original-284",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = [[2]] + held\nexit\n",
  ],
  [
    "original-285",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = [] + (([[false],null] + u) + ([[2]] + []))\nexit\n",
  ],
  [
    "original-286",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = [] + (held + ([[2]] + []))\nexit\n",
  ],
  [
    "original-287",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet result = ([[false],null] + u)\nresult += [[2]]\nexit\n",
  ],
  [
    "original-288",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\nlet held = [[false],null] + u\nlet result = held\nresult += [[2]]\nexit\n",
  ],
  ["original-289", "let result = ([hostValue, 1] + [2]) + [3]\nexit\n"],
  ["original-290", "let held = [hostValue, 1] + [2]\nlet result = held + [3]\nexit\n"],
  ["original-291", "let result = [3] + ([hostValue, 1] + [2])\nexit\n"],
  ["original-292", "let held = [hostValue, 1] + [2]\nlet result = [3] + held\nexit\n"],
  ["original-293", "let result = [] + (([hostValue, 1] + [2]) + ([3] + []))\nexit\n"],
  [
    "original-294",
    "let held = [hostValue, 1] + [2]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-295", "let result = ([hostValue, 1] + [2])\nresult += [3]\nexit\n"],
  ["original-296", "let held = [hostValue, 1] + [2]\nlet result = held\nresult += [3]\nexit\n"],
  ["original-297", 'let result = ([hostValue, 1] + [2]) + ["tail"]\nexit\n'],
  ["original-298", 'let held = [hostValue, 1] + [2]\nlet result = held + ["tail"]\nexit\n'],
  ["original-299", 'let result = ["tail"] + ([hostValue, 1] + [2])\nexit\n'],
  ["original-300", 'let held = [hostValue, 1] + [2]\nlet result = ["tail"] + held\nexit\n'],
  ["original-301", 'let result = [] + (([hostValue, 1] + [2]) + (["tail"] + []))\nexit\n'],
  [
    "original-302",
    'let held = [hostValue, 1] + [2]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-303", 'let result = ([hostValue, 1] + [2])\nresult += ["tail"]\nexit\n'],
  [
    "original-304",
    'let held = [hostValue, 1] + [2]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-305", "let result = ([2] + [hostValue, 1]) + [3]\nexit\n"],
  ["original-306", "let held = [2] + [hostValue, 1]\nlet result = held + [3]\nexit\n"],
  ["original-307", "let result = [3] + ([2] + [hostValue, 1])\nexit\n"],
  ["original-308", "let held = [2] + [hostValue, 1]\nlet result = [3] + held\nexit\n"],
  ["original-309", "let result = [] + (([2] + [hostValue, 1]) + ([3] + []))\nexit\n"],
  [
    "original-310",
    "let held = [2] + [hostValue, 1]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-311", "let result = ([2] + [hostValue, 1])\nresult += [3]\nexit\n"],
  ["original-312", "let held = [2] + [hostValue, 1]\nlet result = held\nresult += [3]\nexit\n"],
  ["original-313", 'let result = ([2] + [hostValue, 1]) + ["tail"]\nexit\n'],
  ["original-314", 'let held = [2] + [hostValue, 1]\nlet result = held + ["tail"]\nexit\n'],
  ["original-315", 'let result = ["tail"] + ([2] + [hostValue, 1])\nexit\n'],
  ["original-316", 'let held = [2] + [hostValue, 1]\nlet result = ["tail"] + held\nexit\n'],
  ["original-317", 'let result = [] + (([2] + [hostValue, 1]) + (["tail"] + []))\nexit\n'],
  [
    "original-318",
    'let held = [2] + [hostValue, 1]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-319", 'let result = ([2] + [hostValue, 1])\nresult += ["tail"]\nexit\n'],
  [
    "original-320",
    'let held = [2] + [hostValue, 1]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-321", "let result = ([1, hostValue] + [2]) + [3]\nexit\n"],
  ["original-322", "let held = [1, hostValue] + [2]\nlet result = held + [3]\nexit\n"],
  ["original-323", "let result = [3] + ([1, hostValue] + [2])\nexit\n"],
  ["original-324", "let held = [1, hostValue] + [2]\nlet result = [3] + held\nexit\n"],
  ["original-325", "let result = [] + (([1, hostValue] + [2]) + ([3] + []))\nexit\n"],
  [
    "original-326",
    "let held = [1, hostValue] + [2]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-327", "let result = ([1, hostValue] + [2])\nresult += [3]\nexit\n"],
  ["original-328", "let held = [1, hostValue] + [2]\nlet result = held\nresult += [3]\nexit\n"],
  ["original-329", 'let result = ([1, hostValue] + [2]) + ["tail"]\nexit\n'],
  ["original-330", 'let held = [1, hostValue] + [2]\nlet result = held + ["tail"]\nexit\n'],
  ["original-331", 'let result = ["tail"] + ([1, hostValue] + [2])\nexit\n'],
  ["original-332", 'let held = [1, hostValue] + [2]\nlet result = ["tail"] + held\nexit\n'],
  ["original-333", 'let result = [] + (([1, hostValue] + [2]) + (["tail"] + []))\nexit\n'],
  [
    "original-334",
    'let held = [1, hostValue] + [2]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-335", 'let result = ([1, hostValue] + [2])\nresult += ["tail"]\nexit\n'],
  [
    "original-336",
    'let held = [1, hostValue] + [2]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-337", "let result = ([2] + [1, hostValue]) + [3]\nexit\n"],
  ["original-338", "let held = [2] + [1, hostValue]\nlet result = held + [3]\nexit\n"],
  ["original-339", "let result = [3] + ([2] + [1, hostValue])\nexit\n"],
  ["original-340", "let held = [2] + [1, hostValue]\nlet result = [3] + held\nexit\n"],
  ["original-341", "let result = [] + (([2] + [1, hostValue]) + ([3] + []))\nexit\n"],
  [
    "original-342",
    "let held = [2] + [1, hostValue]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-343", "let result = ([2] + [1, hostValue])\nresult += [3]\nexit\n"],
  ["original-344", "let held = [2] + [1, hostValue]\nlet result = held\nresult += [3]\nexit\n"],
  ["original-345", 'let result = ([2] + [1, hostValue]) + ["tail"]\nexit\n'],
  ["original-346", 'let held = [2] + [1, hostValue]\nlet result = held + ["tail"]\nexit\n'],
  ["original-347", 'let result = ["tail"] + ([2] + [1, hostValue])\nexit\n'],
  ["original-348", 'let held = [2] + [1, hostValue]\nlet result = ["tail"] + held\nexit\n'],
  ["original-349", 'let result = [] + (([2] + [1, hostValue]) + (["tail"] + []))\nexit\n'],
  [
    "original-350",
    'let held = [2] + [1, hostValue]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-351", 'let result = ([2] + [1, hostValue])\nresult += ["tail"]\nexit\n'],
  [
    "original-352",
    'let held = [2] + [1, hostValue]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-353", "let u: list = [1]\nlet result = (u + [2]) + [3]\nexit\n"],
  ["original-354", "let u: list = [1]\nlet held = u + [2]\nlet result = held + [3]\nexit\n"],
  ["original-355", "let u: list = [1]\nlet result = [3] + (u + [2])\nexit\n"],
  ["original-356", "let u: list = [1]\nlet held = u + [2]\nlet result = [3] + held\nexit\n"],
  ["original-357", "let u: list = [1]\nlet result = [] + ((u + [2]) + ([3] + []))\nexit\n"],
  [
    "original-358",
    "let u: list = [1]\nlet held = u + [2]\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-359", "let u: list = [1]\nlet result = (u + [2])\nresult += [3]\nexit\n"],
  [
    "original-360",
    "let u: list = [1]\nlet held = u + [2]\nlet result = held\nresult += [3]\nexit\n",
  ],
  ["original-361", 'let u: list = [1]\nlet result = (u + [2]) + ["tail"]\nexit\n'],
  ["original-362", 'let u: list = [1]\nlet held = u + [2]\nlet result = held + ["tail"]\nexit\n'],
  ["original-363", 'let u: list = [1]\nlet result = ["tail"] + (u + [2])\nexit\n'],
  ["original-364", 'let u: list = [1]\nlet held = u + [2]\nlet result = ["tail"] + held\nexit\n'],
  ["original-365", 'let u: list = [1]\nlet result = [] + ((u + [2]) + (["tail"] + []))\nexit\n'],
  [
    "original-366",
    'let u: list = [1]\nlet held = u + [2]\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-367", 'let u: list = [1]\nlet result = (u + [2])\nresult += ["tail"]\nexit\n'],
  [
    "original-368",
    'let u: list = [1]\nlet held = u + [2]\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  ["original-369", "let u: list = [1]\nlet result = ([2] + u) + [3]\nexit\n"],
  ["original-370", "let u: list = [1]\nlet held = [2] + u\nlet result = held + [3]\nexit\n"],
  ["original-371", "let u: list = [1]\nlet result = [3] + ([2] + u)\nexit\n"],
  ["original-372", "let u: list = [1]\nlet held = [2] + u\nlet result = [3] + held\nexit\n"],
  ["original-373", "let u: list = [1]\nlet result = [] + (([2] + u) + ([3] + []))\nexit\n"],
  [
    "original-374",
    "let u: list = [1]\nlet held = [2] + u\nlet result = [] + (held + ([3] + []))\nexit\n",
  ],
  ["original-375", "let u: list = [1]\nlet result = ([2] + u)\nresult += [3]\nexit\n"],
  [
    "original-376",
    "let u: list = [1]\nlet held = [2] + u\nlet result = held\nresult += [3]\nexit\n",
  ],
  ["original-377", 'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nexit\n'],
  ["original-378", 'let u: list = [1]\nlet held = [2] + u\nlet result = held + ["tail"]\nexit\n'],
  ["original-379", 'let u: list = [1]\nlet result = ["tail"] + ([2] + u)\nexit\n'],
  ["original-380", 'let u: list = [1]\nlet held = [2] + u\nlet result = ["tail"] + held\nexit\n'],
  ["original-381", 'let u: list = [1]\nlet result = [] + (([2] + u) + (["tail"] + []))\nexit\n'],
  [
    "original-382",
    'let u: list = [1]\nlet held = [2] + u\nlet result = [] + (held + (["tail"] + []))\nexit\n',
  ],
  ["original-383", 'let u: list = [1]\nlet result = ([2] + u)\nresult += ["tail"]\nexit\n'],
  [
    "original-384",
    'let u: list = [1]\nlet held = [2] + u\nlet result = held\nresult += ["tail"]\nexit\n',
  ],
  [
    "original-385",
    "let a: (integer | string)[] = [1]\nlet b: (integer | boolean)[] = [1]\nlet x = a\nlet y = b\nlet z = (x + y) + [true]\nexit\n",
  ],
  [
    "original-386",
    'let box = {last: {items: [1,null]}}\nbox.last.items += [2]\nbox.last.items += ["bad",null]\nbox.last.items += [true]\nexit\n',
  ],
  ["original-387", 'let result = ([1,hostValue / 3] + [2]) + ["bad"]\nexit\n'],
  ["original-388", 'let held = [1,hostValue / 3]\nlet result = (held + [2]) + ["bad"]\nexit\n'],
  ["original-389", 'let result = [{p: {q: 1}}] + ([{p: {q: "bad"}}] + [])\nexit\n'],
  ["original-390", 'let xs = [[null, 1], null]\nxs += [["bad",null]]\nexit\n'],
  [
    "original-391",
    "let u: (boolean | string)[] = [true]\nlet result = ([false] + u) + [2]\nresult[0] = 3\nexit\n",
  ],
];

export const checks = ["publication"];
