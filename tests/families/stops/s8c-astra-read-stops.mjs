// S8c's review (Astra): a value chain at 18 and 42 with a repeat demand, independent or not
// (R/astra-m4-s8c-review-evidence/worker/read-stops.mjs).
export const cases = [
  ["087-0-1", "let seed = 1.75\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nrepeat value17 {}\nrepeat value17 {}\nvalue17 = 3\nsay \"DONE\"\nexit\n"],
  ["087-0-2", "let seed = 1.75\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nrepeat value17 {}\nlet independent = 2\nindependent = 0.25\nrepeat independent {}\nrepeat value17 {}\nvalue17 = 3\nsay \"DONE\"\nexit\n"],
  ["087-0-3", "let seed = 1.75\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nlet value18 = value17\nlet value19 = value18\nlet value20 = value19\nlet value21 = value20\nlet value22 = value21\nlet value23 = value22\nlet value24 = value23\nlet value25 = value24\nlet value26 = value25\nlet value27 = value26\nlet value28 = value27\nlet value29 = value28\nlet value30 = value29\nlet value31 = value30\nlet value32 = value31\nlet value33 = value32\nlet value34 = value33\nlet value35 = value34\nlet value36 = value35\nlet value37 = value36\nlet value38 = value37\nlet value39 = value38\nlet value40 = value39\nlet value41 = value40\nrepeat value41 {}\nrepeat value41 {}\nvalue41 = 3\nsay \"DONE\"\nexit\n"],
  ["087-0-4", "let seed = 1.75\nlet value0 = seed\nlet value1 = value0\nlet value2 = value1\nlet value3 = value2\nlet value4 = value3\nlet value5 = value4\nlet value6 = value5\nlet value7 = value6\nlet value8 = value7\nlet value9 = value8\nlet value10 = value9\nlet value11 = value10\nlet value12 = value11\nlet value13 = value12\nlet value14 = value13\nlet value15 = value14\nlet value16 = value15\nlet value17 = value16\nlet value18 = value17\nlet value19 = value18\nlet value20 = value19\nlet value21 = value20\nlet value22 = value21\nlet value23 = value22\nlet value24 = value23\nlet value25 = value24\nlet value26 = value25\nlet value27 = value26\nlet value28 = value27\nlet value29 = value28\nlet value30 = value29\nlet value31 = value30\nlet value32 = value31\nlet value33 = value32\nlet value34 = value33\nlet value35 = value34\nlet value36 = value35\nlet value37 = value36\nlet value38 = value37\nlet value39 = value38\nlet value40 = value39\nlet value41 = value40\nrepeat value41 {}\nlet independent = 2\nindependent = 0.25\nrepeat independent {}\nrepeat value41 {}\nvalue41 = 3\nsay \"DONE\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "| `node read-stops.mjs`; `node runtime-read.mjs` | later-demand, independent-proof, duplicate-check and runtime controls |",
      "R/astra-m4-s8c-review-evidence/README.md:17"
    ],
    [
      "SX_HEAVY_MEM=2G sx-queue add --name astra-s8c-read-stops -- timeout 180m /home/peter/opt/node-24.18/bin/node read-stops.mjs",
      "R/astra-m4-s8c-review-evidence/worker/last-checks.sh:3"
    ]
  ],
  "sources": 4,
  "sha256": "9d92d9dd5e8ae4ef83670ebfb307212bfa41a323626d87e260c7f69817e5ad79"
};
