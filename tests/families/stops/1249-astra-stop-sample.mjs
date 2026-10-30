// #1249's review r1 (Astra): eight of its cases with an integer read of `hostOther` added before the exit
// (R/astra-m4-i1249-review-evidence/stop.mjs over its own cases.json).
export const cases = [
  [
    "67-default/1",
    'let source={a:{inside:{tone:1}},b:{inside:{tone:"bad"}}}\nlet result=[source.b,source.a]\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/2",
    'let first={inside:[{tone:1}]}\nlet second={inside:[{tone:"bad"}]}\nlet result=[first,second]\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/3",
    'let first={inside:{tone:1}}\nlet second={inside:{tone:"bad"}}\nlet result=first\nsay result.inside.tone\nresult=second\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/4",
    'let good={inside:{inside:{inside:{tone:1}}}}\nlet bad={inside:{inside:{inside:{tone:"bad"}}}}\nlet flag:boolean=hostValue\nlet a=bad\nlet b=good\nlet x=b\nlet y=x\ny=a\nb=y\na=b\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/5",
    'let good={inside:{tone:"bad"}}\nlet bad={inside:{tone:1}}\nlet flag:boolean=hostValue\nlet a=bad\nlet b=good\nlet relay=b\nrelay=a\nif flag { b=relay }\nif flag { a=b }\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/6",
    'let good={inside:{tone:1}}\nlet bad={inside:{tone:"bad"}}\nlet flag:boolean=hostValue\nlet a=good\nlet b=a\nlet c=b\na=c\nb={}\nc={}\na=bad\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/7",
    'let good={tone:"bad"}\nlet bad={tone:1}\nlet flag:boolean=hostValue\nlet a=good\nlet b=a\nlet c=b\na=c\nsay b.tone\nc=bad\nlet boundary:integer=hostOther\nexit\n',
  ],
  [
    "67-default/8",
    'let a={left:{right:{tone:1}}}\nlet bridge=a.left\na=bridge.right\nlet bad={tone:"bad"}\nlet other=a\nother=bad\nsay other.tone\nlet boundary:integer=hostOther\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node stop.mjs "$review_tree" out/stop-new.jsonl',
      "R/astra-m4-i1249-review-evidence/REPRODUCE.md:22",
    ],
  ],
  sources: 8,
  sha256: "5e40d67e3cdf04040c5ef0c47eb580d395a9dc6c2854e9c62324aa58d108be5e",
};
