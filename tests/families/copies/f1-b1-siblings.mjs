// #1188's design r1: B1's siblings (`b1-siblings.mjs`: 27 forms, the plain or the landed store first), run by
// `b1.mjs b1-siblings.json` (/tmp/agent-work/o4-m4-f1/probe/; copy kept in desktop:~/work/evidence/1463/retained/).
export const cases = [
  [
    "small::b1-siblings::rejected-third/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet more={spare:2}\nlet a=[other,root,more]\nexit\n',
  ],
  [
    "small::b1-siblings::rejected-root-store/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nroot.spare=5\nlet other={spare:1}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::rejected-read-after/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\nlet x=a[0].spare\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-literal/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root]\nif hostValue == 1 { a=[other,root] }\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-field/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:hostValue}\nif other.spare == 1 { let a=[other,root] }\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-root/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nif hostValue == 1 { root.spare = "x" }\nlet other={spare:1}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-root/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet b=root\nlet other={spare:1}\nlet a=[other,b]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-chain/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet b=root\nlet c=b\nlet other={spare:1}\nlet a=[other,c]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-local/plain-first",
    'let t:string="ok"\nlet root={spare:t,extra:1}\nlet b=root\nb.extra=2\nlet other={spare:1}\nlet a=[other,b]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-other/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet c=other\nlet a=[c,root]\nexit\n',
  ],
  [
    "small::b1-siblings::projected/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet x={p:root}\nlet y={p:{spare:1}}\nlet a=[y.p,x.p]\nexit\n',
  ],
  [
    "small::b1-siblings::nested-literals/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[{p:other},{p:root}]\nexit\n',
  ],
  [
    "small::b1-siblings::nested-field/plain-first",
    'let t:string="ok"\nlet root={q:{spare:t}}\nlet other={q:{spare:1}}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::two-written/plain-first",
    'let t:string="ok"\nlet n:integer=1\nlet root={spare:t}\nlet other={spare:n}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::union-written/plain-first",
    'let t:integer|string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::union-written-int/plain-first",
    'let t:integer|string=1\nlet root={spare:t}\nlet other={spare:"x"}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::local-beside/plain-first",
    'let t:string="ok"\nlet n:integer=1\nlet root={spare:t}\nlet base={keep:n}\nlet b=base\nb.spare=1\nlet a=[b,root]\nexit\n',
  ],
  [
    "small::b1-siblings::local-beside-text/plain-first",
    'let t:integer|string=1\nlet n:integer=1\nlet root={spare:t}\nlet base={keep:n}\nlet b=base\nb.spare="y"\nlet other={spare:2}\nlet a=[other,b,root]\nexit\n',
  ],
  [
    "small::b1-siblings::call/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nfunction make {\nreturn {spare:1}\n}\nlet a=[make(),root]\nexit\n',
  ],
  [
    "small::b1-siblings::host/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet a=[hostValue,root]\nexit\n',
  ],
  [
    "small::b1-siblings::host-field/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:hostValue}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::plain-pair/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet o1={spare:1}\nlet o2={spare:"x"}\nlet a=[root]\na=[o1,o2]\nexit\n',
  ],
  [
    "small::b1-siblings::read-binding/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet v=1\nlet other={spare:v}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::same-type/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:"yes"}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::plain-roots/plain-first",
    'let t="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\nexit\n',
  ],
  [
    "small::b1-siblings::inline/plain-first",
    'let t:string="ok"\nlet root={spare:t}\nlet a=[{spare:1},root]\nexit\n',
  ],
  [
    "small::b1-siblings::rejected-third/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet more={spare:2}\nlet a=[root,other,more]\nexit\n',
  ],
  [
    "small::b1-siblings::rejected-root-store/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nroot.spare=5\nlet other={spare:1}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::rejected-read-after/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nlet x=a[0].spare\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-literal/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root]\nif hostValue == 1 { a=[root,other] }\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-field/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:hostValue}\nif other.spare == 1 { let a=[root,other] }\nexit\n',
  ],
  [
    "small::b1-siblings::guarded-root/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nif hostValue == 1 { root.spare = "x" }\nlet other={spare:1}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-root/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet b=root\nlet other={spare:1}\nlet a=[b,other]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-chain/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet b=root\nlet c=b\nlet other={spare:1}\nlet a=[c,other]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-local/landed-first",
    'let t:string="ok"\nlet root={spare:t,extra:1}\nlet b=root\nb.extra=2\nlet other={spare:1}\nlet a=[b,other]\nexit\n',
  ],
  [
    "small::b1-siblings::copied-other/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet c=other\nlet a=[root,c]\nexit\n',
  ],
  [
    "small::b1-siblings::projected/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet x={p:root}\nlet y={p:{spare:1}}\nlet a=[x.p,y.p]\nexit\n',
  ],
  [
    "small::b1-siblings::nested-literals/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[{p:root},{p:other}]\nexit\n',
  ],
  [
    "small::b1-siblings::nested-field/landed-first",
    'let t:string="ok"\nlet root={q:{spare:t}}\nlet other={q:{spare:1}}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::two-written/landed-first",
    'let t:string="ok"\nlet n:integer=1\nlet root={spare:t}\nlet other={spare:n}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::union-written/landed-first",
    'let t:integer|string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::union-written-int/landed-first",
    'let t:integer|string=1\nlet root={spare:t}\nlet other={spare:"x"}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::local-beside/landed-first",
    'let t:string="ok"\nlet n:integer=1\nlet root={spare:t}\nlet base={keep:n}\nlet b=base\nb.spare=1\nlet a=[root,b]\nexit\n',
  ],
  [
    "small::b1-siblings::local-beside-text/landed-first",
    'let t:integer|string=1\nlet n:integer=1\nlet root={spare:t}\nlet base={keep:n}\nlet b=base\nb.spare="y"\nlet other={spare:2}\nlet a=[root,b,other]\nexit\n',
  ],
  [
    "small::b1-siblings::call/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nfunction make {\nreturn {spare:1}\n}\nlet a=[root,make()]\nexit\n',
  ],
  [
    "small::b1-siblings::host/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet a=[root,hostValue]\nexit\n',
  ],
  [
    "small::b1-siblings::host-field/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:hostValue}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::plain-pair/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet o1={spare:1}\nlet o2={spare:"x"}\nlet a=[root]\na=[o2,o1]\nexit\n',
  ],
  [
    "small::b1-siblings::read-binding/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet v=1\nlet other={spare:v}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::same-type/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:"yes"}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::plain-roots/landed-first",
    'let t="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nexit\n',
  ],
  [
    "small::b1-siblings::inline/landed-first",
    'let t:string="ok"\nlet root={spare:t}\nlet a=[root,{spare:1}]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node b1.mjs b1-siblings.json $H/main-c1d $H/proto9",
      "/tmp/agent-work/o4-m4-i1188/design-r1.md:438",
    ],
  ],
  sources: 54,
  sha256: "4c927ad54dcf8153c175bdd6396db27f0aabb828d2b5b72648435d95dea03d94",
  dropped: [
    [
      "878ec4ca57bad06b5b3480564038b0903a9f1a40b8725c28234805784f32f7be",
      "the object type annotation 'let root:{spare:string}', which main does not parse (TSP021): experimental syntax in a case about a written root, not about the parse",
    ],
    [
      "bf65233a41f42f38f5eaa9d5726547a40044acbf4f78b88e454e4e3176992379",
      "the object type annotation 'let root:{spare:string}', which main does not parse (TSP021): experimental syntax in a case about a written root, not about the parse",
    ],
  ],
};
