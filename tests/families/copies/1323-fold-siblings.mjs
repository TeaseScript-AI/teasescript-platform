// #1323: the 21 sibling sources of the HEAD 0 probes (`/tmp/agent-work/i1323/sib*.txt`, `nested.txt`, `m3.txt`):
// literals alike at a path stored in other orders than written, of other structures, holding some properties, wide,
// and nested in another; with the sharing on, F11's `missing` names what the sharing off names.
const sources = [
  "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:typed}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet c={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:1.5}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:2.5}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:2}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  'let typed:integer=17\nlet c={f0:"x"}\nlet b={f0:typed}\nlet a={f0:"y"}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n',
  "let typed:integer=17\nlet c={f0:[1]}\nlet b={f0:typed}\nlet a={f0:[2]}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:{g:1}}\nlet b={f0:typed}\nlet a={f0:{g:2}}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:1.5,f1:1}\nlet b={f0:typed}\nlet a={f0:1.5,f1:2}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:typed,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1}\nlet a={f0:1.5,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:2.5,p:2}\nlet b={f0:typed}\nlet a={f0:1.5,p:1}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nlet alias3=container\nalias3.p=typed\nexit\n",
  "let typed:integer=17\nlet c={f0:2.5,p:2}\nlet d={f0:typed,p:typed}\nlet b={f0:typed}\nlet a={f0:1.5,p:1}\nlet container=a\ncontainer=d\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nexit\n",
  "let typed:integer=17\nlet a={f0:1.5,k:[{f0:typed}][0]}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet a={f0:1.5,k:[{f0:typed}].get(0, default: {f0:typed})}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet a={f0:1.5,k:{f0:typed}}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5,k:[b][0]}\nlet container=a\ncontainer=a.k\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
  'let typed:integer=17\nlet c={f0:typed,p:1.5}\nlet b={f0:1.5,p:typed}\nlet a={f0:"x",p:2.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nexit\n',
];
export const cases = sources.map((source, index) => [`sibling-${index + 1}`, source]);
export const checks = ["publication"];
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "sx-job submit … --commit base=<main dff711474> --commit head=<#1323's head> --in job.sh --in fam.mjs -- bash job.sh",
      "~/work/evidence/i1323-fold-siblings/dff711474d398ba442470ddf221efbf7c385a7b4/job.sh",
    ],
  ],
  sources: 21,
  sha256: "adcef80fee862ada17fe62252699d7f63737978b9cb1d7cd06a0bcf8af3136d8",
};
