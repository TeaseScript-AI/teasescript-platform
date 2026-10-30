// #1188's builder, round 4: the witness sets w1, w2 and w3 (`cases/w1.json` to `w3.json`), each analysed by
// `probe/keptseq.mjs` (/tmp/agent-work/o4-m4-i1188-r4/probe/run-w1.sh and cases/; copies kept in
// desktop:~/work/evidence/1463/retained/).
export const cases = [
  [
    "w1::r1-union",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide]\nexit\n",
  ],
  [
    "w1::r1-plain",
    'let unit:integer=7\nlet wide={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide]\nexit\n',
  ],
  [
    "w1::r1-other-record",
    'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide2]\nexit\n',
  ],
  [
    "w1::r1-other-literal",
    'let unit:integer=7\nlet wide={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,{f:5}]\nexit\n',
  ],
  [
    "w1::r1-fixed-inner",
    'let unit:integer=7\nlet wide={f:unit}\nlet inner=[{f:"bad"},{f:"ok"}]\nlet result=[inner.first,wide]\nexit\n',
  ],
  [
    "w1::ring",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet landing=a\nlanding=b\nlet mirror=landing\nlet transit=mirror\nmirror=transit\nlet result=[b,transit]\nexit\n",
  ],
  [
    "w2::p/other-inferred-record",
    'let unit:integer=7\nlet wide={f:unit}\nlet wide3={f:5}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide3]\nexit\n',
  ],
  [
    "w2::p/other-written-reversed",
    'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[wide2,inner.first]\nexit\n',
  ],
  [
    "w2::p/no-rejection-written",
    'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},{f:"bad"}]\nlet result=[inner.first,wide2]\nexit\n',
  ],
  [
    "w2::u/other-written-record",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide2]\nexit\n",
  ],
  [
    "w2::u/other-inferred-record",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet wide3={f:5}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide3]\nexit\n",
  ],
  [
    "w2::u/other-literal",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,{f:5}]\nexit\n",
  ],
  [
    "w2::u/other-written-reversed",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},wide]\nlet result=[wide2,inner.first]\nexit\n",
  ],
  [
    "w2::u/no-rejection-written",
    "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},{f:true}]\nlet result=[inner.first,wide2]\nexit\n",
  ],
  [
    "w3::ring-fed",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlanding=b\nlet mirror=landing\nlet transit=mirror\nmirror=transit\nlet result=[b,transit]\nexit\n",
  ],
  [
    "w3::ring-fed-3",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlanding=b\nlet m1=landing\nlet m2=m1\nlet m3=m2\nm1=m3\nlet result=[b,m3]\nexit\n",
  ],
  [
    "w3::ring-fed-read",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlanding=b\nlet mirror=landing\nlet transit=mirror\nmirror=transit\nlet result=[{g:b.f},{g:transit.f}]\nexit\n",
  ],
  [
    "w3::ring-whole",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlanding=b\nlet mirror=landing\nlet transit=c\nmirror=transit\ntransit=mirror\nlet result=[b,transit]\nexit\n",
  ],
  [
    "w3::ring-whole-direct",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet mirror=a\nlet transit=c\nmirror=transit\ntransit=mirror\nmirror=b\nlet result=[b,transit]\nexit\n",
  ],
  [
    "w3::ring-fed-direct",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet mirror=a\nlet transit=mirror\nmirror=transit\nmirror=b\nlet result=[b,transit]\nexit\n",
  ],
  [
    "w3::ring-fed-place",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlanding=b\nlet mirror=landing\nlet transit=mirror\nmirror=transit\nlet out=transit\nout=b\nexit\n",
  ],
  [
    "w3::ring-whole-place",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet mirror=a\nlet transit=c\nmirror=transit\ntransit=mirror\nmirror=b\nlet out=transit\nout=b\nexit\n",
  ],
  [
    "w3::ring-control",
    "let small:integer=7\nlet a={f:small}\nlet b={f:1.25}\nlet c={f:small}\nlet landing=a\nlet mirror=landing\nlet transit=mirror\nmirror=transit\nlet result=[b,transit]\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SX_HEAVY_MEM=4G SX_HEAVY_SWAP=0 sx-heavy timeout 600 node probe/keptseq.mjs $PWD/$tree ~/work/o4-m4-i1188-r4/cases/$set.json ~/work/o4-m4-i1188-r4/out/$set-$tree.jsonl > ~/work/o4-m4-i1188-r4/out/$set-$tree.log 2>&1",
      "/tmp/agent-work/o4-m4-i1188-r4/probe/run-w1.sh:7",
    ],
  ],
  sources: 23,
  sha256: "550cf195825a8ae116908f76d72c9d4e13bd05ffa81e44082341989bf8872de5",
};
