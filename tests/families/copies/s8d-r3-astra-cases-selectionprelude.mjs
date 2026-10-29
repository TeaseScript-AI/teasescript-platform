export const cases = [
  [
    "000",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample}"\nexit\n',
  ],
  [
    "001",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0]}"\nexit\n',
  ],
  [
    "002",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position]}"\nexit\n',
  ],
  [
    "003",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${((rack[0]))}"\nexit\n',
  ],
  [
    "004",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack.random}"\nexit\n',
  ],
  [
    "005",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${cabinet.rack.random}"\nexit\n',
  ],
  [
    "006",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${boxes.random.item}"\nexit\n',
  ],
  [
    "007",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position + 0]}"\nexit\n',
  ],
  [
    "008",
    'let value = "unrelated"\nlet sample = {tags: ["omitted"], title: "Harbor", count: 8}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${readSample()}"\nexit\n',
  ],
  [
    "009",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample}"\nexit\n',
  ],
  [
    "010",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0]}"\nexit\n',
  ],
  [
    "011",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position]}"\nexit\n',
  ],
  [
    "012",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${((rack[0]))}"\nexit\n',
  ],
  [
    "013",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack.random}"\nexit\n',
  ],
  [
    "014",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${cabinet.rack.random}"\nexit\n',
  ],
  [
    "015",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${boxes.random.item}"\nexit\n',
  ],
  [
    "016",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position + 0]}"\nexit\n',
  ],
  [
    "017",
    'let value = "unrelated"\nlet sample = dict{"a": 73}\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${readSample()}"\nexit\n',
  ],
  [
    "018",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample}"\nexit\n',
  ],
  [
    "019",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0]}"\nexit\n',
  ],
  [
    "020",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position]}"\nexit\n',
  ],
  [
    "021",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${((rack[0]))}"\nexit\n',
  ],
  [
    "022",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack.random}"\nexit\n',
  ],
  [
    "023",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${cabinet.rack.random}"\nexit\n',
  ],
  [
    "024",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${boxes.random.item}"\nexit\n',
  ],
  [
    "025",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position + 0]}"\nexit\n',
  ],
  [
    "026",
    'let value = "unrelated"\nlet sample = set[73, 91]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${readSample()}"\nexit\n',
  ],
  [
    "027",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${sample}"\nexit\n',
  ],
  [
    "028",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[0]}"\nexit\n',
  ],
  [
    "029",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position]}"\nexit\n',
  ],
  [
    "030",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${((rack[0]))}"\nexit\n',
  ],
  [
    "031",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack.random}"\nexit\n',
  ],
  [
    "032",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${cabinet.rack.random}"\nexit\n',
  ],
  [
    "033",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${boxes.random.item}"\nexit\n',
  ],
  [
    "034",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${rack[position + 0]}"\nexit\n',
  ],
  [
    "035",
    'let value = "unrelated"\nlet sample = [{name: "Harbor"}]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay "${readSample()}"\nexit\n',
  ],
  [
    "036",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = sample\nsay caption\nexit\n',
  ],
  [
    "037",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = rack[0]\nsay caption\nexit\n',
  ],
  [
    "038",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = rack[position]\nsay caption\nexit\n',
  ],
  [
    "039",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = ((rack[0]))\nsay caption\nexit\n',
  ],
  [
    "040",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = rack.random\nsay caption\nexit\n',
  ],
  [
    "041",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = cabinet.rack.random\nsay caption\nexit\n',
  ],
  [
    "042",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = boxes.random.item\nsay caption\nexit\n',
  ],
  [
    "043",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = rack[position + 0]\nsay caption\nexit\n',
  ],
  [
    "044",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet caption: string = readSample()\nsay caption\nexit\n',
  ],
  [
    "045",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[sample]\nexit\n',
  ],
  [
    "046",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[rack[0]]\nexit\n',
  ],
  [
    "047",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[rack[position]]\nexit\n',
  ],
  [
    "048",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[((rack[0]))]\nexit\n',
  ],
  [
    "049",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[rack.random]\nexit\n',
  ],
  [
    "050",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[cabinet.rack.random]\nexit\n',
  ],
  [
    "051",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[boxes.random.item]\nexit\n',
  ],
  [
    "052",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[rack[position + 0]]\nexit\n',
  ],
  [
    "053",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nlet labels = dict{"73": "Harbor"}\nsay labels[readSample()]\nexit\n',
  ],
  [
    "054",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample.length\nexit\n',
  ],
  [
    "055",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0].length\nexit\n',
  ],
  [
    "056",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position].length\nexit\n',
  ],
  [
    "057",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])).length\nexit\n',
  ],
  [
    "058",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random.length\nexit\n',
  ],
  [
    "059",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random.length\nexit\n',
  ],
  [
    "060",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item.length\nexit\n',
  ],
  [
    "061",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0].length\nexit\n',
  ],
  [
    "062",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample().length\nexit\n',
  ],
  [
    "063",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample.seconds\nexit\n',
  ],
  [
    "064",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0].seconds\nexit\n',
  ],
  [
    "065",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position].seconds\nexit\n',
  ],
  [
    "066",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])).seconds\nexit\n',
  ],
  [
    "067",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random.seconds\nexit\n',
  ],
  [
    "068",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random.seconds\nexit\n',
  ],
  [
    "069",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item.seconds\nexit\n',
  ],
  [
    "070",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0].seconds\nexit\n',
  ],
  [
    "071",
    'let value = "unrelated"\nlet sample = 4 s\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample().seconds\nexit\n',
  ],
  [
    "072",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample.year\nexit\n',
  ],
  [
    "073",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0].year\nexit\n',
  ],
  [
    "074",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position].year\nexit\n',
  ],
  [
    "075",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])).year\nexit\n',
  ],
  [
    "076",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random.year\nexit\n',
  ],
  [
    "077",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random.year\nexit\n',
  ],
  [
    "078",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item.year\nexit\n',
  ],
  [
    "079",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0].year\nexit\n',
  ],
  [
    "080",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample().year\nexit\n',
  ],
  [
    "081",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample + 2 calendar days\nexit\n',
  ],
  [
    "082",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0] + 2 calendar days\nexit\n',
  ],
  [
    "083",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position] + 2 calendar days\nexit\n',
  ],
  [
    "084",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])) + 2 calendar days\nexit\n',
  ],
  [
    "085",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random + 2 calendar days\nexit\n',
  ],
  [
    "086",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random + 2 calendar days\nexit\n',
  ],
  [
    "087",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item + 2 calendar days\nexit\n',
  ],
  [
    "088",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0] + 2 calendar days\nexit\n',
  ],
  [
    "089",
    'let value = "unrelated"\nlet sample = toAbsoluteDateTime("2028-03-04T12:00:00Z")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample() + 2 calendar days\nexit\n',
  ],
  [
    "090",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample + 4 s\nexit\n',
  ],
  [
    "091",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0] + 4 s\nexit\n',
  ],
  [
    "092",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position] + 4 s\nexit\n',
  ],
  [
    "093",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])) + 4 s\nexit\n',
  ],
  [
    "094",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random + 4 s\nexit\n',
  ],
  [
    "095",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random + 4 s\nexit\n',
  ],
  [
    "096",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item + 4 s\nexit\n',
  ],
  [
    "097",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0] + 4 s\nexit\n',
  ],
  [
    "098",
    'let value = "unrelated"\nlet sample = toDateTime("2028-03-04T12:00:00")\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample() + 4 s\nexit\n',
  ],
  [
    "099",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample { say "selected" }\nexit\n',
  ],
  [
    "100",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0] { say "selected" }\nexit\n',
  ],
  [
    "101",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position] { say "selected" }\nexit\n',
  ],
  [
    "102",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif ((rack[0])) { say "selected" }\nexit\n',
  ],
  [
    "103",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack.random { say "selected" }\nexit\n',
  ],
  [
    "104",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif cabinet.rack.random { say "selected" }\nexit\n',
  ],
  [
    "105",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif boxes.random.item { say "selected" }\nexit\n',
  ],
  [
    "106",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position + 0] { say "selected" }\nexit\n',
  ],
  [
    "107",
    'let value = "unrelated"\nlet sample = 73\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif readSample() { say "selected" }\nexit\n',
  ],
  [
    "108",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample { say "selected" }\nexit\n',
  ],
  [
    "109",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0] { say "selected" }\nexit\n',
  ],
  [
    "110",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position] { say "selected" }\nexit\n',
  ],
  [
    "111",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif ((rack[0])) { say "selected" }\nexit\n',
  ],
  [
    "112",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack.random { say "selected" }\nexit\n',
  ],
  [
    "113",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif cabinet.rack.random { say "selected" }\nexit\n',
  ],
  [
    "114",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif boxes.random.item { say "selected" }\nexit\n',
  ],
  [
    "115",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position + 0] { say "selected" }\nexit\n',
  ],
  [
    "116",
    'let value = "unrelated"\nlet sample = "Harbor"\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif readSample() { say "selected" }\nexit\n',
  ],
  [
    "117",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif sample { say "selected" }\nexit\n',
  ],
  [
    "118",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[0] { say "selected" }\nexit\n',
  ],
  [
    "119",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position] { say "selected" }\nexit\n',
  ],
  [
    "120",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif ((rack[0])) { say "selected" }\nexit\n',
  ],
  [
    "121",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack.random { say "selected" }\nexit\n',
  ],
  [
    "122",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif cabinet.rack.random { say "selected" }\nexit\n',
  ],
  [
    "123",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif boxes.random.item { say "selected" }\nexit\n',
  ],
  [
    "124",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif rack[position + 0] { say "selected" }\nexit\n',
  ],
  [
    "125",
    'let value = "unrelated"\nlet sample = [73]\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nif readSample() { say "selected" }\nexit\n',
  ],
  [
    "126",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay sample.rank\nexit\n',
  ],
  [
    "127",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[0].rank\nexit\n',
  ],
  [
    "128",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position].rank\nexit\n',
  ],
  [
    "129",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay ((rack[0])).rank\nexit\n',
  ],
  [
    "130",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack.random.rank\nexit\n',
  ],
  [
    "131",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay cabinet.rack.random.rank\nexit\n',
  ],
  [
    "132",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay boxes.random.item.rank\nexit\n',
  ],
  [
    "133",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay rack[position + 0].rank\nexit\n',
  ],
  [
    "134",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsay readSample().rank\nexit\n',
  ],
  [
    "135",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nsample.add(1)\nexit\n',
  ],
  [
    "136",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nrack[0].add(1)\nexit\n',
  ],
  [
    "137",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nrack[position].add(1)\nexit\n',
  ],
  [
    "138",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\n((rack[0])).add(1)\nexit\n',
  ],
  [
    "139",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nrack.random.add(1)\nexit\n',
  ],
  [
    "140",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\ncabinet.rack.random.add(1)\nexit\n',
  ],
  [
    "141",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nboxes.random.item.add(1)\nexit\n',
  ],
  [
    "142",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nrack[position + 0].add(1)\nexit\n',
  ],
  [
    "143",
    'let value = "unrelated"\nlet sample = player\nlet rack = [sample]\nlet cabinet = {rack: rack}\nlet boxes = [{item: sample}]\nlet position = 0\nfunction readSample { return rack[0] }\nreadSample().add(1)\nexit\n',
  ],
  [
    "144",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets.random.first\nexit\n",
  ],
  [
    "145",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay containers.random.bin.last.first\nexit\n",
  ],
  [
    "146",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay cabinet.shelves.random.first\nexit\n",
  ],
  [
    "147",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets[slots.random].first\nexit\n",
  ],
  [
    "148",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets[offset - 0].first\nexit\n",
  ],
  [
    "149",
    'let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets[toInteger("1")].first\nexit\n',
  ],
  [
    "150",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay readSample().first\nexit\n",
  ],
  [
    "151",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets.removeLast().first\nexit\n",
  ],
  [
    "152",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets[1].first\nexit\n",
  ],
  [
    "153",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets[offset].first\nexit\n",
  ],
  [
    "154",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay (baskets[1]).first\nexit\n",
  ],
  [
    "155",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay (baskets)[1].first\nexit\n",
  ],
  [
    "156",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay [baskets][0].last.first\nexit\n",
  ],
  [
    "157",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay [73].first\nexit\n",
  ],
  [
    "158",
    'let lookup = dict{"anchor\\"point": [73], "empty": []}\nsay lookup[ "anchor\\"point" ].first\nexit\n',
  ],
  [
    "159",
    'let lookup = dict{"cost$net": [73], "empty": []}\nsay lookup[ "cost$net" ].first\nexit\n',
  ],
  [
    "160",
    'let lookup = dict{"esc\\\\ape": [73], "empty": []}\nsay lookup[ "esc\\\\ape" ].first\nexit\n',
  ],
  [
    "161",
    'let lookup = dict{"has space": [73], "empty": []}\nsay lookup[ "has space" ].first\nexit\n',
  ],
  [
    "162",
    'let value = "untouched"\nlet baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay baskets.random.first\nsay value\nexit\n',
  ],
  [
    "163",
    "let baskets: integer[][] = [[], [73]]\nlet cabinet = {shelves: baskets}\nlet containers = [{bin: baskets}]\nlet slots = [0, 1]\nlet offset = 1\nfunction readSample { return baskets.random }\nsay (baskets /* retain */ .random).first\nexit\n",
  ],
  [
    "164",
    'let value = "untouched"\nlet maybe: integer? = null\nlet row = [maybe]\nrepeat row[0] {}\nsay value\nexit\n',
  ],
  [
    "165",
    'let value = "untouched"\nlet row: (integer | string)[] = ["words", 3]\nrepeat row[0] {}\nsay value\nexit\n',
  ],
  ["166", "let items: integer[] = []\nsay items.first\nexit\n"],
  ["167", "player.rank = 73\nsay player.rank\nexit\n"],
  ["168", "say player.firstName\nexit\n"],
  ["169", 'let marks = [8,9]\nsay "Count: " + marks.random\nexit\n'],
  ["170", 'let count = 8\nsay "Count: " + (count + 3)\nexit\n'],
  ["171", 'let count = 8\nsay "Count: " + (count /* comment */ + 3)\nexit\n'],
];

export const checks = ["publication"];
