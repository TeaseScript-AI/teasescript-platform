// G3 part 1's review (Astra): its additional, choice and valued-choice cases, as `additional.json`, `choices.json` and
// `valued-choices.json` hold them, run by the builder's publication probe (R/astra-m4-g3-p1-review-evidence/). Its own
// cases (`own.json`) are `1375-astra-nested-carriers`'s; the spot cases it sampled are the builder's.
export const cases = [
  ["nullable-list-copy-own-syntax-corrected", "let src: integer?[] = [1, null]\nlet box = {q: [src]}\nlet copy = box.q[0]\ncopy.add(2)\nsay copy[0]\nexit\n"],
  ["nested-1-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: 1}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\nsay copy\nexit\n"],
  ["nested-rejected-1-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: 1}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-1-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: 1}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\nsay copy\nexit\n"],
  ["nested-rejected-1-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: 1}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-1-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: 1}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\nsay copy\nexit\n"],
  ["nested-rejected-1-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: 1}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-seed-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: seed}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\nsay copy\nexit\n"],
  ["nested-rejected-seed-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: seed}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-seed-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: seed}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\nsay copy\nexit\n"],
  ["nested-rejected-seed-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: seed}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-seed-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: seed}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\nsay copy\nexit\n"],
  ["nested-rejected-seed-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: seed}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-hostValue-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: hostValue}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\nsay copy\nexit\n"],
  ["nested-rejected-hostValue-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: hostValue}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-hostValue-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: hostValue}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\nsay copy\nexit\n"],
  ["nested-rejected-hostValue-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: hostValue}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-hostValue-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: hostValue}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\nsay copy\nexit\n"],
  ["nested-rejected-hostValue-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: hostValue}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-null-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: null}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\nsay copy\nexit\n"],
  ["nested-rejected-null-2-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: null}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet copy = part1\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-null-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: null}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\nsay copy\nexit\n"],
  ["nested-rejected-null-3-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: null}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet copy = part2\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["nested-null-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: null}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\nsay copy\nexit\n"],
  ["nested-rejected-null-5-choice-staged", "let seed: integer = 1\nlet tree = [{q: [{q: [{q: [{q: [{q: null}]}]}]}]}]\nlet part0 = (askChoice tree).q\nlet part1 = (askChoice part0).q\nlet part2 = (askChoice part1).q\nlet part3 = (askChoice part2).q\nlet part4 = (askChoice part3).q\nlet copy = part4\ncopy = \"wrong\"\nsay copy\nexit\n"],
  ["valued-choice-1-2-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\nsay copy\nexit\n"],
  ["valued-choice-1-2-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-1-3-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\nsay copy\nexit\n"],
  ["valued-choice-1-3-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-1-5-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\nsay copy\nexit\n"],
  ["valued-choice-1-5-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: 1}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-seed-2-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\nsay copy\nexit\n"],
  ["valued-choice-seed-2-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-seed-3-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\nsay copy\nexit\n"],
  ["valued-choice-seed-3-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-seed-5-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\nsay copy\nexit\n"],
  ["valued-choice-seed-5-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: seed}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-hostValue-2-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\nsay copy\nexit\n"],
  ["valued-choice-hostValue-2-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-hostValue-3-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\nsay copy\nexit\n"],
  ["valued-choice-hostValue-3-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-hostValue-5-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\nsay copy\nexit\n"],
  ["valued-choice-hostValue-5-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: hostValue}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-null-2-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\nsay copy\nexit\n"],
  ["valued-choice-null-2-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet copy = step1\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-null-3-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\nsay copy\nexit\n"],
  ["valued-choice-null-3-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet copy = step2\ncopy = \"bad\"\nsay copy\nexit\n"],
  ["valued-choice-null-5-False", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\nsay copy\nexit\n"],
  ["valued-choice-null-5-True", "let seed: integer = 1\nlet tree = [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: [{text: \"Pick\", value: {q: null}}]}}]}}]}}]}}]\nlet step0 = (askChoice tree).q\nlet step1 = (askChoice step0).q\nlet step2 = (askChoice step1).q\nlet step3 = (askChoice step2).q\nlet step4 = (askChoice step3).q\nlet copy = step4\ncopy = \"bad\"\nsay copy\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node builder-probe/publication.mjs <tree>/dist <cases.json> <output.jsonl>",
      "R/astra-m4-g3-p1-review-evidence/README.md:20, R/astra-m4-g3-p1-review-evidence/README.md:21"
    ]
  ],
  "sources": 73,
  "sha256": "664e0d4949a9a84bf2c784bd57bc94dc8c342e0b73f8eaa3554772f075b9874b",
  "dropped": [
    [
      "41dc44da92ee9a940d21f1baf0be7449056726593bfbdc134af9291f6b08106c",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "864125a670be37ecfdb5b40a614489d452bdf76ad0ac12533727f9c4bbbb0532",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "e6f74cf70ddbabedfe91f98133ae56df53cc7e55d9435f1342498bc971db21db",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "16cb0e80392d9ef3c4b0fc7989e5c6af5639f1355bff9625f2a9b48a9a7e176e",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "ac190967bd1c7a8db6628ccc558c2053428dca35cc302f93338e2113fb74cf1b",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "f4e0b676f4653c30e2e2ae8bd519d7ba20b952ab557c838e2b4fe3c5da43d916",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "b580fded78b7bfe108c2d67ed94ad3246c6249981ccf2fc125c30cbb893743ed",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "599cdf9a5438857e98a768ec3b1645b6e6a14c5bd15d3c744bcba38c53cb69c0",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "0a409d4ad414b8a2ec28cc679f96aa96e2cae85ab91a0181f2c9210dec6c7b97",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "16d1edc1d72aeecdc5a92cbf0f88ae64311a74e90fe46046f0e6de93c2c6c2d3",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "47de444477aee041ea9358322a1531332183eb252918c5814a76c5453960af0c",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "965bf7d4a4b40329e6a1fc833f2a33bb25cf3181bf59025c9a8e8c4d38d156ae",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "61742553bc189fac5ff43a3456fa0c8c562a113270d168a1cf093fd35e8ab96a",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "6cdcccef4abe3285fce6d98180dde498da62c4eb77178b0669cc81012f76b1d1",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "cf729e1768a97afb29e5973da6f62e0bef591bac30f80801f5ea46f28c09e80e",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "5aa34b9796424f3a2d47a290bb4af237484798421f87569737c5d5cff475c671",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "a23a2f808a3a204826b21cec66278146fd894d77b539f83f0372b2b92e20fd8f",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "a85152517bed5793cd28f12af09ff2a6fa761b26721f01127c91cfe9b52cdbdd",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "a8d567ae55fcf30f533ef4f0fab1635e2631d5ff82113a35088c38786851a20b",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "ede2bfdde3c824e809d337c54329915c0ae67396ea6815fb62c480286f62428f",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "f909b2ea2cdd8d4e77f1888078fd8524db753893fe8a22c5cef57694c65bd43b",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "54a5b5d893715aae216e39d70c10afdf061757a70a1a9d4128e511e690e175ee",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "d55ae89a56ab86e6e43ee40c2d090fb5bc23d9d94a947c37595b5fb1ccdebf43",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ],
    [
      "085d92f68a440be7dbbb95eaea7a0255e4bc5833bf53ef996770d4cf41cef871",
      "Unsupported syntax in an acknowledged invalid generator attempt, not the intended type-error condition. Main rejects TSP032."
    ]
  ]
};
