const corpus = (() => {
  const permutations = (xs) =>
    xs.length === 0
      ? [[]]
      : xs.flatMap((x, i) => permutations(xs.filter((_, j) => i !== j)).map((t) => [x, ...t]));
  function cases() {
    const out = [];
    const add = (name, body) =>
      out.push({ name, files: [{ path: "main.tease", source: body + "\nexit\n" }] });
    for (const reverse of [false, true])
      add(
        `r1-${reverse ? "reverse" : "original"}`,
        `let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[${reverse ? "root,other" : "other,root"}]`,
      );
    const shapes = [
      [
        "mixed-fields",
        'let t:string="oak"\nlet n:integer=7\nlet a={p:t,q:1}\nlet b={p:3,q:n}\nlet c={p:"elm",unique:false}',
        ["a", "b", "c"],
      ],
      [
        "nested-middle",
        'let t:string="oak"\nlet a={box:{p:t,q:1}}\nlet b={box:{p:3,q:2}}\nlet c={box:{p:"elm",only:true}}',
        ["a", "b", "c"],
      ],
      [
        "copy-chain-locals",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet c0=root\nlet c1=c0\nc1.q=2\nlet c2=c1\nc2.only=true\nlet a={p:3,q:2}\nlet b={p:"elm"}',
        ["c2", "a", "b"],
      ],
      [
        "rejected-middle-store",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet a=root\na.p=9\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
      [
        "union",
        'let t:integer|string="oak"\nlet a={p:t,q:1}\nlet b={p:3}\nlet c={p:true,only:null}',
        ["a", "b", "c"],
      ],
      [
        "nullable",
        'let t:string?="oak"\nlet a={p:t}\nlet b={p:null,q:1}\nlet c={p:4}',
        ["a", "b", "c"],
      ],
      [
        "missing-field",
        'let t:string="oak"\nlet a={only:t}\nlet b={elsewhere:1}\nlet c={elsewhere:2}',
        ["a", "b", "c"],
      ],
      [
        "same-identity-locals",
        'let t:string="oak"\nlet root={p:t,q:null}\nlet a=root\na.q=2\nlet b=root\nb.q="elm"\nlet c=root',
        ["a", "b", "c"],
      ],
      [
        "projected",
        'let t:string="oak"\nlet root={box:{p:t},q:0}\nlet cp=root\nlet cp2=cp\ncp2.q=1\nlet a=cp2.box\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
      [
        "two-written",
        'let t:string="oak"\nlet n:integer=7\nlet a={p:t}\nlet b={p:n}\nlet c={p:"elm",single:1}',
        ["a", "b", "c"],
      ],
      [
        "plain-after-landing",
        'let t:string="oak"\nlet root={p:t}\nlet a={p:1}\nlet b={p:"elm"}\nlet c={q:1}\nlet xs=[root]',
        ["a", "b", "c"],
      ],
      [
        "guarded-copy",
        'let t:string="oak"\nlet root={p:t,q:1}\nlet cp=root\nif hostValue == 1 { cp.q=2 }\nlet a=cp\nlet b={p:3}\nlet c={p:"elm"}',
        ["a", "b", "c"],
      ],
    ];
    for (const [name, preamble, els] of shapes) {
      for (const perm of permutations(els)) {
        const body = `${preamble}\n${name === "plain-after-landing" ? "xs=" : "let xs="}[${perm.join(",")}]\nlet read=xs[0]`;
        add(`${name}-${perm.join("-")}`, body);
      }
      add(
        `${name}-guarded`,
        `${preamble}\n${name === "plain-after-landing" ? "" : "let xs=[]"}\nif hostValue == 1 { xs=[${els.join(",")}] }\nlet read=xs[0]`,
      );
      add(`${name}-nested`, `${preamble}\nlet nested=[[${els.join(",")}]]\nlet read=nested[0][0]`);
    }
    for (const value of ["hostValue", "maker()", "root.box", "root.box otherwise {p:3}"])
      for (const rev of [false, true]) {
        add(
          `opaque-${value}-${rev}`,
          `let t:string="oak"\nlet root={box:{p:t},q:1}\nfunction maker { return {p:2} }\nlet other=${value}\nlet xs=[${rev ? "other,root.box" : "root.box,other"}]\nlet r=xs[0].p`,
        );
      }
    for (const form of ["set", "dict"])
      for (const rev of [false, true]) {
        const a = rev ? "other" : "root",
          b = rev ? "root" : "other";
        add(
          `${form}-${rev}`,
          `let t:string="oak"\nlet root={p:t}\nlet other={p:2}\nlet xs=${form === "set" ? `set[${a},${b}]` : `dict{one:${a},two:${b}}`}`,
        );
      }
    out.push({
      name: "three-file",
      files: [
        { path: "z.tease", source: 'let t:string="z"\nlet r={p:t}\nlet a=[{p:1},r]\nexit\n' },
        { path: "main.tease", source: 'let t:string="m"\nlet r={p:t}\nlet a=[r,{p:1}]\nexit\n' },
        { path: "a.tease", source: 'let t:integer=2\nlet r={p:t}\nlet a=[r,{p:"a"}]\nexit\n' },
      ],
    });
    return out;
  }
  return { cases: Array.from(cases()).map(({ name, files }) => [name, files]) };
})();
export const cases = corpus.cases;

for (const input of [
  [
    "original/1/__reference1/forest-disjoint-deep@8",
    "let t:integer=1\nlet root={f0:{inner:{value:t}},f1:{inner:{value:t}},f2:{inner:{value:t}},f3:{inner:{value:t}},f4:{inner:{value:t}},f5:{inner:{value:t}},f6:{inner:{value:t}},f7:{inner:{value:t}},g0:{inner:{value:1}},g1:{inner:{value:1}},g2:{inner:{value:1}},g3:{inner:{value:1}},g4:{inner:{value:1}},g5:{inner:{value:1}},g6:{inner:{value:1}},g7:{inner:{value:1}}}\nlet a=root\nlet b=a\nb.g0.inner.value=2\nb.g1.inner.value=2\nb.g2.inner.value=2\nb.g3.inner.value=2\nb.g4.inner.value=2\nb.g5.inner.value=2\nb.g6.inner.value=2\nb.g7.inner.value=2\nlet r0=b.f0.inner.value\nlet r1=b.f1.inner.value\nlet r2=b.f2.inner.value\nlet r3=b.f3.inner.value\nlet r4=b.f4.inner.value\nlet r5=b.f5.inner.value\nlet r6=b.f6.inner.value\nlet r7=b.f7.inner.value\nexit",
  ],
  [
    "original/2/__reference1/forest-disjoint-deep@16",
    "let t:integer=1\nlet root={f0:{inner:{value:t}},f1:{inner:{value:t}},f2:{inner:{value:t}},f3:{inner:{value:t}},f4:{inner:{value:t}},f5:{inner:{value:t}},f6:{inner:{value:t}},f7:{inner:{value:t}},f8:{inner:{value:t}},f9:{inner:{value:t}},f10:{inner:{value:t}},f11:{inner:{value:t}},f12:{inner:{value:t}},f13:{inner:{value:t}},f14:{inner:{value:t}},f15:{inner:{value:t}},g0:{inner:{value:1}},g1:{inner:{value:1}},g2:{inner:{value:1}},g3:{inner:{value:1}},g4:{inner:{value:1}},g5:{inner:{value:1}},g6:{inner:{value:1}},g7:{inner:{value:1}},g8:{inner:{value:1}},g9:{inner:{value:1}},g10:{inner:{value:1}},g11:{inner:{value:1}},g12:{inner:{value:1}},g13:{inner:{value:1}},g14:{inner:{value:1}},g15:{inner:{value:1}}}\nlet a=root\nlet b=a\nb.g0.inner.value=2\nb.g1.inner.value=2\nb.g2.inner.value=2\nb.g3.inner.value=2\nb.g4.inner.value=2\nb.g5.inner.value=2\nb.g6.inner.value=2\nb.g7.inner.value=2\nb.g8.inner.value=2\nb.g9.inner.value=2\nb.g10.inner.value=2\nb.g11.inner.value=2\nb.g12.inner.value=2\nb.g13.inner.value=2\nb.g14.inner.value=2\nb.g15.inner.value=2\nlet r0=b.f0.inner.value\nlet r1=b.f1.inner.value\nlet r2=b.f2.inner.value\nlet r3=b.f3.inner.value\nlet r4=b.f4.inner.value\nlet r5=b.f5.inner.value\nlet r6=b.f6.inner.value\nlet r7=b.f7.inner.value\nlet r8=b.f8.inner.value\nlet r9=b.f9.inner.value\nlet r10=b.f10.inner.value\nlet r11=b.f11.inner.value\nlet r12=b.f12.inner.value\nlet r13=b.f13.inner.value\nlet r14=b.f14.inner.value\nlet r15=b.f15.inner.value\nexit",
  ],
  [
    "original/3/__reference1/forest-overlap-prefix@8",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1}}\nlet a=root\nlet b=a\nb.f0.right=2\nb.f1.right=2\nb.f2.right=2\nb.f3.right=2\nb.f4.right=2\nb.f5.right=2\nb.f6.right=2\nb.f7.right=2\nlet r0=b.f0.left\nlet r1=b.f1.left\nlet r2=b.f2.left\nlet r3=b.f3.left\nlet r4=b.f4.left\nlet r5=b.f5.left\nlet r6=b.f6.left\nlet r7=b.f7.left\nexit",
  ],
  [
    "original/4/__reference1/forest-overlap-prefix@16",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1},f8:{left:t,right:1},f9:{left:t,right:1},f10:{left:t,right:1},f11:{left:t,right:1},f12:{left:t,right:1},f13:{left:t,right:1},f14:{left:t,right:1},f15:{left:t,right:1}}\nlet a=root\nlet b=a\nb.f0.right=2\nb.f1.right=2\nb.f2.right=2\nb.f3.right=2\nb.f4.right=2\nb.f5.right=2\nb.f6.right=2\nb.f7.right=2\nb.f8.right=2\nb.f9.right=2\nb.f10.right=2\nb.f11.right=2\nb.f12.right=2\nb.f13.right=2\nb.f14.right=2\nb.f15.right=2\nlet r0=b.f0.left\nlet r1=b.f1.left\nlet r2=b.f2.left\nlet r3=b.f3.left\nlet r4=b.f4.left\nlet r5=b.f5.left\nlet r6=b.f6.left\nlet r7=b.f7.left\nlet r8=b.f8.left\nlet r9=b.f9.left\nlet r10=b.f10.left\nlet r11=b.f11.left\nlet r12=b.f12.left\nlet r13=b.f13.left\nlet r14=b.f14.left\nlet r15=b.f15.left\nexit",
  ],
  [
    "original/5/__reference1/forest-overlap-ancestor@8",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1}}\nlet a=root\nlet b=a\nb.f0.right=2\nb.f1.right=2\nb.f2.right=2\nb.f3.right=2\nb.f4.right=2\nb.f5.right=2\nb.f6.right=2\nb.f7.right=2\nlet r0=b.f0\nlet r1=b.f1\nlet r2=b.f2\nlet r3=b.f3\nlet r4=b.f4\nlet r5=b.f5\nlet r6=b.f6\nlet r7=b.f7\nexit",
  ],
  [
    "original/6/__reference1/forest-overlap-ancestor@16",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1},f8:{left:t,right:1},f9:{left:t,right:1},f10:{left:t,right:1},f11:{left:t,right:1},f12:{left:t,right:1},f13:{left:t,right:1},f14:{left:t,right:1},f15:{left:t,right:1}}\nlet a=root\nlet b=a\nb.f0.right=2\nb.f1.right=2\nb.f2.right=2\nb.f3.right=2\nb.f4.right=2\nb.f5.right=2\nb.f6.right=2\nb.f7.right=2\nb.f8.right=2\nb.f9.right=2\nb.f10.right=2\nb.f11.right=2\nb.f12.right=2\nb.f13.right=2\nb.f14.right=2\nb.f15.right=2\nlet r0=b.f0\nlet r1=b.f1\nlet r2=b.f2\nlet r3=b.f3\nlet r4=b.f4\nlet r5=b.f5\nlet r6=b.f6\nlet r7=b.f7\nlet r8=b.f8\nlet r9=b.f9\nlet r10=b.f10\nlet r11=b.f11\nlet r12=b.f12\nlet r13=b.f13\nlet r14=b.f14\nlet r15=b.f15\nexit",
  ],
  [
    "original/7/__reference1/forest-alternating-levels@8",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1}}\nlet a=root\na.f0.right=2\na.f1.right=2\na.f2.right=2\na.f3.right=2\na.f4.right=2\na.f5.right=2\na.f6.right=2\na.f7.right=2\nlet b=a\nb.f0.left=3\nb.f1.left=3\nb.f2.left=3\nb.f3.left=3\nb.f4.left=3\nb.f5.left=3\nb.f6.left=3\nb.f7.left=3\nlet r0=b.f0.left\nlet r1=b.f1.left\nlet r2=b.f2.left\nlet r3=b.f3.left\nlet r4=b.f4.left\nlet r5=b.f5.left\nlet r6=b.f6.left\nlet r7=b.f7.left\nexit",
  ],
  [
    "original/8/__reference1/forest-alternating-levels@16",
    "let t:integer=1\nlet root={f0:{left:t,right:1},f1:{left:t,right:1},f2:{left:t,right:1},f3:{left:t,right:1},f4:{left:t,right:1},f5:{left:t,right:1},f6:{left:t,right:1},f7:{left:t,right:1},f8:{left:t,right:1},f9:{left:t,right:1},f10:{left:t,right:1},f11:{left:t,right:1},f12:{left:t,right:1},f13:{left:t,right:1},f14:{left:t,right:1},f15:{left:t,right:1}}\nlet a=root\na.f0.right=2\na.f1.right=2\na.f2.right=2\na.f3.right=2\na.f4.right=2\na.f5.right=2\na.f6.right=2\na.f7.right=2\na.f8.right=2\na.f9.right=2\na.f10.right=2\na.f11.right=2\na.f12.right=2\na.f13.right=2\na.f14.right=2\na.f15.right=2\nlet b=a\nb.f0.left=3\nb.f1.left=3\nb.f2.left=3\nb.f3.left=3\nb.f4.left=3\nb.f5.left=3\nb.f6.left=3\nb.f7.left=3\nb.f8.left=3\nb.f9.left=3\nb.f10.left=3\nb.f11.left=3\nb.f12.left=3\nb.f13.left=3\nb.f14.left=3\nb.f15.left=3\nlet r0=b.f0.left\nlet r1=b.f1.left\nlet r2=b.f2.left\nlet r3=b.f3.left\nlet r4=b.f4.left\nlet r5=b.f5.left\nlet r6=b.f6.left\nlet r7=b.f7.left\nlet r8=b.f8.left\nlet r9=b.f9.left\nlet r10=b.f10.left\nlet r11=b.f11.left\nlet r12=b.f12.left\nlet r13=b.f13.left\nlet r14=b.f14.left\nlet r15=b.f15.left\nexit",
  ],
  [
    "original/9/__reference1/shared-literals-projected@8",
    "let t:integer=1\nlet root={box:{f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t}}\nlet other={box:{g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1}}\nlet a0=[root.box,other.box]\nlet a1=[root.box,other.box]\nlet a2=[root.box,other.box]\nlet a3=[root.box,other.box]\nlet a4=[root.box,other.box]\nlet a5=[root.box,other.box]\nlet a6=[root.box,other.box]\nlet a7=[root.box,other.box]\nexit",
  ],
  [
    "original/10/__reference1/shared-literals-projected@16",
    "let t:integer=1\nlet root={box:{f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t}}\nlet other={box:{g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1}}\nlet a0=[root.box,other.box]\nlet a1=[root.box,other.box]\nlet a2=[root.box,other.box]\nlet a3=[root.box,other.box]\nlet a4=[root.box,other.box]\nlet a5=[root.box,other.box]\nlet a6=[root.box,other.box]\nlet a7=[root.box,other.box]\nlet a8=[root.box,other.box]\nlet a9=[root.box,other.box]\nlet a10=[root.box,other.box]\nlet a11=[root.box,other.box]\nlet a12=[root.box,other.box]\nlet a13=[root.box,other.box]\nlet a14=[root.box,other.box]\nlet a15=[root.box,other.box]\nexit",
  ],
  [
    "original/11/__reference1/shared-locals-under-wrap@8",
    "let t:integer=1\nlet root={p:t}\nlet c0=root\nlet c1=c0\nc1.g0=1\nlet c2=c1\nc2.g1=1\nlet c3=c2\nc3.g2=1\nlet c4=c3\nc4.g3=1\nlet c5=c4\nc5.g4=1\nlet c6=c5\nc6.g5=1\nlet c7=c6\nc7.g6=1\nlet c8=c7\nc8.g7=1\nlet a0=[{v:c8},{v:{p:2}}]\nlet a1=[{v:c8},{v:{p:2}}]\nlet a2=[{v:c8},{v:{p:2}}]\nlet a3=[{v:c8},{v:{p:2}}]\nlet a4=[{v:c8},{v:{p:2}}]\nlet a5=[{v:c8},{v:{p:2}}]\nlet a6=[{v:c8},{v:{p:2}}]\nlet a7=[{v:c8},{v:{p:2}}]\nexit",
  ],
  [
    "original/12/__reference1/shared-locals-under-wrap@16",
    "let t:integer=1\nlet root={p:t}\nlet c0=root\nlet c1=c0\nc1.g0=1\nlet c2=c1\nc2.g1=1\nlet c3=c2\nc3.g2=1\nlet c4=c3\nc4.g3=1\nlet c5=c4\nc5.g4=1\nlet c6=c5\nc6.g5=1\nlet c7=c6\nc7.g6=1\nlet c8=c7\nc8.g7=1\nlet c9=c8\nc9.g8=1\nlet c10=c9\nc10.g9=1\nlet c11=c10\nc11.g10=1\nlet c12=c11\nc12.g11=1\nlet c13=c12\nc13.g12=1\nlet c14=c13\nc14.g13=1\nlet c15=c14\nc15.g14=1\nlet c16=c15\nc16.g15=1\nlet a0=[{v:c16},{v:{p:2}}]\nlet a1=[{v:c16},{v:{p:2}}]\nlet a2=[{v:c16},{v:{p:2}}]\nlet a3=[{v:c16},{v:{p:2}}]\nlet a4=[{v:c16},{v:{p:2}}]\nlet a5=[{v:c16},{v:{p:2}}]\nlet a6=[{v:c16},{v:{p:2}}]\nlet a7=[{v:c16},{v:{p:2}}]\nlet a8=[{v:c16},{v:{p:2}}]\nlet a9=[{v:c16},{v:{p:2}}]\nlet a10=[{v:c16},{v:{p:2}}]\nlet a11=[{v:c16},{v:{p:2}}]\nlet a12=[{v:c16},{v:{p:2}}]\nlet a13=[{v:c16},{v:{p:2}}]\nlet a14=[{v:c16},{v:{p:2}}]\nlet a15=[{v:c16},{v:{p:2}}]\nexit",
  ],
])
  cases.push(input);

export const checks = ["publication"];
