// #1188's design review r3 (Sol): its 40 dead-transit cases, as `dead-transit.json` holds them, run by `b1.mjs`
// (/tmp/agent-work/o4-m4-i1188/sol-r3/; copy kept in desktop:~/work/evidence/1463/retained/).
export const cases = [
  [
    "small::dead-transit::dead-transit/b,a/1/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:1}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:1}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:1}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet again=copy\nlet clean={f:1}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1.5/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:1.5}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1.5/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:1.5}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1.5/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:1.5}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/1.5/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet again=copy\nlet clean={f:1.5}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/b,a/"y"/direct',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:"y"}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/b,a/"y"/copy',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:"y"}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/b,a/"y"/nested',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:"y"}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/b,a/"y"/twice',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet again=copy\nlet clean={f:"y"}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/false/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:false}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/false/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:false}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/false/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:false}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/false/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet again=copy\nlet clean={f:false}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/null/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet clean={f:null}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/null/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet clean={f:null}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/null/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:null}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/b,a/null/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[b,a]\nlet copy=rejected\nlet again=copy\nlet clean={f:null}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet clean={f:1}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet clean={f:1}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:1}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet again=copy\nlet clean={f:1}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1.5/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet clean={f:1.5}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1.5/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet clean={f:1.5}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1.5/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:1.5}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/1.5/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet again=copy\nlet clean={f:1.5}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/a,b/"y"/direct',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet clean={f:"y"}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/a,b/"y"/copy',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet clean={f:"y"}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/a,b/"y"/nested',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:"y"}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    'small::dead-transit::dead-transit/a,b/"y"/twice',
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet again=copy\nlet clean={f:"y"}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/false/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet clean={f:false}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/false/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet clean={f:false}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/false/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:false}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/false/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet again=copy\nlet clean={f:false}\nlet outer=[again.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/null/direct",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet clean={f:null}\nlet outer=[rejected.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/null/copy",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet clean={f:null}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/null/nested",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet box={slot:rejected}\nlet copy=box.slot\nlet clean={f:null}\nlet outer=[copy.first,clean]\nexit\n',
  ],
  [
    "small::dead-transit::dead-transit/a,b/null/twice",
    'let t:integer=1\nlet a={f:t}\nlet b={f:"x"}\nlet rejected=[a,b]\nlet copy=rejected\nlet again=copy\nlet clean={f:null}\nlet outer=[again.first,clean]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node b1.mjs dead-transit.json <main> <pr1> <proto>",
      "/tmp/agent-work/o4-3a-lead-fable/m4/i1188/sol-r3.md:72",
    ],
  ],
  sources: 40,
  sha256: "cdf2d923256c19c8047518d4112e4fe2054196edbf5f6079b9864133e543e9bf",
};
