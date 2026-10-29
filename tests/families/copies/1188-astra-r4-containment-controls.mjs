// reversed destinations and containment controls; #1188, astra-m4-i1188-design-recheck-r4-evidence, archived
// Python/shell evidence (R/astra-m4-i1188-design-recheck-r4-evidence/focus.py).
const generated = (() => {
  let domain, extra, first, intro, order, out, pair, shape, start, tail, union, wrapper, written;
  out = [];
  function add(name, ...lines) {
    out.push({ name: name, source: lines.join("\n") + "\nexit\n" });
  }
  for (domain of ["integer", "integer | string"]) {
    for (shape of ["direct", "projection", "dict", "property"]) {
      intro = [
        `let sample:${domain}=29`,
        "let parcel={weight:sample}",
        "let damaged=[{weight:false},parcel]",
      ];
      if (shape === "direct") {
        tail = ["let outcome=parcel", "outcome=damaged.first"];
      } else {
        if (shape === "projection") {
          intro = [
            `let sample:${domain}=29`,
            "let parcel={meta:{weight:sample}}",
            "let damaged=[{meta:{weight:false}},parcel]",
          ];
          tail = ["let outcome=parcel.meta", "outcome=damaged.first.meta"];
        } else {
          if (shape === "dict") {
            intro = [
              `let sample:${domain}=29`,
              "let parcel={weight:sample}",
              "let damaged=dict{a:{weight:false},b:parcel}",
            ];
            tail = ["let outcome=parcel", "outcome=damaged.values.first"];
          } else {
            tail = ["let outcome={slot:parcel}", "outcome.slot=damaged.first"];
          }
        }
      }
      add(`reversed/${domain}/${shape}`, ...intro, ...tail);
    }
  }
  for (written of ["integer", "integer | string"]) {
    for (order of [false, true]) {
      for (wrapper of [false, true]) {
        intro = [
          `let ix:${written}=7`,
          "let wide={v:ix}",
          "let peer={v:ix}",
          "let damaged=[{v:false},wide]",
        ];
        first = "damaged.first";
        if (wrapper) {
          intro.push(...["let box={value:damaged.first}", "let relay=box"]);
          first = "relay.value";
        }
        pair = order ? `${first},peer` : `peer,${first}`;
        add(`form2/${written}/${order}/${wrapper}`, ...intro, `let result=[${pair}]`);
      }
    }
  }
  for (union of ["integer | string", "integer | string | boolean", "number"]) {
    for (start of ["83", "false", '"live"']) {
      for (extra of ["83", "false", '"live"']) {
        add(
          `bare/${union}/${start}/${extra}`,
          `let written:${union}=83`,
          "let annotated={v:written,tag:1}",
          `let inside={v:${start},tag:false}`,
          "inside=annotated",
          "let outer=inside",
          `outer={v:${extra},tag:false}`,
          "let result=[inside,outer]",
        );
      }
    }
  }

  return out.map((c) => [c.name, c.source]);
})();
export const checks = ["publication"];

// The spellings its parity and mutation runs recorded (R/astra-m4-i1188-design-recheck-r4-evidence/parity.json,
// mutation.json) that its focus.json no longer holds.
const captured = [
  [
    "cycle/string/False/none/direct",
    'let lval:integer=37\nlet rval:string="r"\nlet a={cell:{v:lval},keep:0}\nlet b=a\na=b\nlet c={cell:{v:rval},keep:0}\nlet d=c\nc=d\na=d\nc=b\nlet outcome=[b,d]\nexit\n',
  ],
  [
    "cycle/string/False/none/record",
    'let lval:integer=37\nlet rval:string="r"\nlet a={cell:{v:lval},keep:0}\nlet b=a\na=b\nlet c={cell:{v:rval},keep:0}\nlet d=c\nc=d\na=d\nc=b\nlet capsule={left:{x:b},right:{x:d}}\nlet outcome=[capsule.left.x,capsule.right.x]\nexit\n',
  ],
  [
    "cycle/string/False/none/deadcell",
    'let lval:integer=37\nlet rval:string="r"\nlet a={cell:{v:lval},keep:0}\nlet b=a\na=b\nlet c={cell:{v:rval},keep:0}\nlet d=c\nc=d\na=d\nc=b\nlet dropped=[{cell:{v:false},keep:0},b]\nlet view={x:dropped.first}\nlet outcome=[view.x,d]\nexit\n',
  ],
  [
    "contain/narrow/integer | string/integer/False",
    "let wide:integer | string=53\nlet narrow:integer=53\nlet base={v:narrow}\nlet combined=base\ncombined={v:wide}\nlet outcome=[base,combined]\nexit\n",
  ],
  [
    "contain/narrow/integer | string/integer/True",
    "let wide:integer | string=53\nlet narrow:integer=53\nlet base={v:narrow}\nlet combined=base\ncombined={v:wide}\nlet outcome=[combined,base]\nexit\n",
  ],
  [
    "live/record/False/False/named",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet outcome=[matrix.first.tray.first.detail,payload.detail]\nexit\n",
  ],
  [
    "live/record/False/False/alias",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet equivalent=payload\nlet second=equivalent\nlet outcome=[matrix.first.tray.first.detail,second.detail]\nexit\n",
  ],
  [
    "live/record/False/False/fresh",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet outcome=[matrix.first.tray.first.detail,{v:atom}]\nexit\n",
  ],
  [
    "live/record/False/True/named",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet outcome=[matrix.first.tray.first.detail,payload.detail]\nexit\n',
  ],
  [
    "live/record/False/True/alias",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet equivalent=payload\nlet second=equivalent\nlet outcome=[matrix.first.tray.first.detail,second.detail]\nexit\n',
  ],
  [
    "live/record/False/True/fresh",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet outcome=[matrix.first.tray.first.detail,{v:atom}]\nexit\n',
  ],
  [
    "live/record/True/False/named",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet outcome=[payload.detail,matrix.first.tray.first.detail]\nexit\n",
  ],
  [
    "live/record/True/False/alias",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet equivalent=payload\nlet second=equivalent\nlet outcome=[second.detail,matrix.first.tray.first.detail]\nexit\n",
  ],
  [
    "live/record/True/False/fresh",
    "let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet outcome=[{v:atom},matrix.first.tray.first.detail]\nexit\n",
  ],
  [
    "live/record/True/True/named",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet outcome=[payload.detail,matrix.first.tray.first.detail]\nexit\n',
  ],
  [
    "live/record/True/True/alias",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet equivalent=payload\nlet second=equivalent\nlet outcome=[second.detail,matrix.first.tray.first.detail]\nexit\n',
  ],
  [
    "live/record/True/True/fresh",
    'let atom:integer | string=59\nlet payload={detail:{v:atom},spare:0}\nlet matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]\nlet unrelated=["unrelated",false]\nlet outcome=[{v:atom},matrix.first.tray.first.detail]\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 probe-queue.py focus full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:28",
    ],
    [
      "same cap and Node 24.18.0: `node compile.mjs <scratch> out/public.json`, exit 0. `out/public.json` distinguishes",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:57",
    ],
    [
      "python3 extra-queue.py parity",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:32",
    ],
    [
      "python3 extra-queue.py mutation",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:33",
    ],
  ],
  sources: 60,
  sha256: "191959512a390c338f9a37e6d40f9db30640b584541c9a01a9ea2d8f13055db4",
};
