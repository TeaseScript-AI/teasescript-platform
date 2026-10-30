// F1, Astra review (R/astra-m4-f1-review-evidence/cases.mjs): forward and local projections, their work shapes and the
// programs of its auxiliary drivers.
export const sizes = [8, 16, 64, 128]; // probe.mjs's recorded work runs (work-small-0, work-0, work-1)
const outputs = (() => {
  const rows = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const source = (...lines) => lines.flat(Infinity).join("\n") + "\nexit\n";
  const fields = (n, value = "t", prefix = "f") =>
    rows(n, (i) => `${prefix}${i}:${value}`).join(",");
  function cases() {
    const all = [];
    const add = (name, text) => all.push({ name, files: [{ path: "main.tease", source: text }] });
    const types = [
      ["integer", "7"],
      ["integer?", "null"],
      ["integer | string", "7"],
      ["string", '"ok"'],
      ["null", "null"],
    ];
    const values = ["8", "2.5", '"bad"', "null", "hostValue"];
    const shapes = {
      "forward-projection": (v) => [
        "let box={left:root}",
        "let twin={right:box.left}",
        "let a=twin.right",
        `a.nest.n=${v}`,
        "let out={selected:a.nest}",
        "repeat out.selected.n {}",
      ],
      "local-above": (v) => [
        "let a=root",
        "let b=a",
        `a.nest={n:${v},keep:1}`,
        "let c={p:a}",
        "let d=c.p",
        "let out=[b,d]",
        "repeat out[0].nest.n {}",
      ],
      "local-below": (v) => [
        "let a=root",
        `a.nest.n=${v}`,
        "let b=a",
        "b.n=8",
        "let c={p:b}",
        "let out=[root,c.p]",
        "repeat out[0].nest.n {}",
      ],
      "two-root-forward": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let left={a:root}",
        "let right={b:other}",
        "let a=left.a",
        "let b=right.b",
        "a=b",
        "let out=a",
        "repeat out.nest.n {}",
      ],
      "whole-cycle-local": (v) => [
        "let a=root",
        "let b=a",
        "let c=b",
        "b=c",
        "a=b",
        `c.nest.n=${v}`,
        "let out={p:a}",
        "repeat out.p.nest.n {}",
      ],
      "path-cycle-local": (v) => [
        "let a=root",
        "let wrap={slot:a}",
        "a=wrap.slot",
        `wrap.slot.nest.n=${v}`,
        "let out=wrap.slot",
        "repeat out.nest.n {}",
      ],
      "two-fed-cycle": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=root",
        "let b=a",
        "a=b",
        "b=other",
        "let out=[a,b]",
        "repeat out[0].n {}",
      ],
      "guarded-replacement": (v) => [
        "let a=root",
        `if hostValue != null { a.nest.n=${v} }`,
        "let b={x:a}",
        "let c=b.x",
        "if c != null { let out=[root,c]\nrepeat out[0].nest.n {} }",
      ],
      "guarded-join": (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=root",
        "if other != null { a=other }",
        "let b=a",
        "repeat b.n {}",
      ],
      "snapshot-local": (v) => [
        "let a=root",
        "let old=a.nest",
        `a.nest.n=${v}`,
        "let fresh=a.nest",
        "let out=[old,fresh]",
        "repeat out[0].n {}",
      ],
      "list-copy": (v) => [
        "let a=[root]",
        "let b=a",
        `b[0].nest.n=${v}`,
        "let c={list:b}",
        "let out=c.list",
        "repeat out[0].nest.n {}",
      ],
      "local-then-landing": (v) => [
        `let plain={n:1,nest:{n:1,keep:1},spare:1}`,
        "let a=plain",
        `a.nest.n=${v}`,
        "let b=a",
        "let out=root",
        "out=b",
        "repeat out.nest.n {}",
      ],
      duplicates: (v) => [
        `let other={n:${v},nest:{n:${v},keep:1},spare:1}`,
        "let a=[root,root,other,root]",
        "let b=[root,other,root,root]",
        "let out=[a,b]",
        "repeat out[0][0].n {}",
      ],
      defaults: (v) => [
        `function make(arg=root) { let a=arg\na.nest.n=${v}\nreturn a }`,
        "let out=make()",
        "repeat out.nest.n {}",
      ],
      "default-null-word": (v) => [
        "function make(arg=null) { let a=arg\na=root\nreturn a }",
        "let out=make()",
        `out.nest.n=${v}`,
        "let z=out.nest.n otherwise 1",
        "repeat z {}",
      ],
      "read-operation": (v) => [
        "let a=root",
        "let b={p:a}",
        `b.p.nest.n=${v}`,
        "let out=[b.p,root].get(0, default: root)",
        "repeat out.nest.n {}",
      ],
    };
    for (const [type, init] of types)
      for (const value of values)
        for (const [name, shape] of Object.entries(shapes)) {
          add(
            `${name}/${type}/${value}`,
            source(
              `let t:${type}=${init}`,
              "let root={n:t,nest:{n:t,keep:1},spare:t}",
              shape(value),
            ),
          );
        }
    for (const count of [2, 3, 5])
      for (const plain of [false, true]) {
        const refs = rows(count, (i) => `r${i}`);
        add(
          `dedup/${count}/${plain}`,
          source(
            "let t:integer=1",
            rows(count, (i) => `let r${i}={same:t,nest:{same:t}}`),
            "let raw={same:1,nest:{same:hostValue}}",
            `let a=[${[...refs, ...refs, ...(plain ? ["raw"] : [])].join(",")}]`,
            `let b=[${[...refs, ...(plain ? ["raw"] : [])].reverse().join(",")}]`,
            "repeat a[0].nest.same {}",
            "repeat b[0].nest.same {}",
          ),
        );
      }
    all.push({
      name: "project-file-order",
      files: [
        { path: "z.tease", source: source("let z:integer=hostValue", "repeat hostValue {}") },
        { path: "a.tease", source: source("let a:integer=hostValue", "repeat hostValue {}") },
        { path: "main.tease", source: source("let m:integer=hostValue", "repeat hostValue {}") },
      ],
    });
    return all;
  }
  const workShapes = {
    "forest-disjoint-stores": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)},${fields(n, "1", "g")}}`,
        "let a=root",
        rows(n, (i) => `a.g${i}=2`),
        rows(n, (i) => `let c${i}=a.f${i}`),
      ),
    "forest-nested-projections": (n) =>
      source(
        "let t:integer=1",
        `let root={${rows(n, (i) => `f${i}:{leaf:t}`).join(",")},${fields(n, "1", "g")}}`,
        "let a=root",
        rows(n, (i) => `a.g${i}=2`),
        rows(n, (i) => `let c${i}={p:a.f${i}}\nlet d${i}=[c${i}.p,root.f${i}]`),
      ),
    "diamond-local-fit": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        rows(
          n,
          (i) =>
            `let a${i}=root\na${i}.f${i}=2\nlet b${i}={slot:a${i}}\nlet c${i}=[b${i}.slot,root]`,
        ),
      ),
    "guarded-whole-chain": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        "let a0=root",
        rows(n - 1, (i) => `let a${i + 1}=a${i}\nif hostValue != null { a${i + 1}=root }`),
      ),
    "projected-twice-disjoint": (n) =>
      source(
        "let t:integer=1",
        rows(n, (i) => `let r${i}={left:{f${i}:t},right:{f${i}:t}}`),
        `let a=[${rows(n, (i) => `r${i}.left`).join(",")}]`,
        `let b=[${rows(n, (i) => `r${i}.right`).join(",")}]`,
      ),
    // Required reproductions of r8's disclosed notes, separate from independent cases above.
    "r8-prefix-paths": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        rows(n, (i) => rows(2, (j) => `let c${i}_${j}={p${i}:root,z:root}`)),
      ),
    "r8-mix-landed": (n) =>
      source(
        "let t:integer=1",
        rows(n, (i) => `let r${i}={f${i}:t}`),
        `let wide={${fields(n)}}`,
        `let a=[${rows(n, (i) => `r${i}`).join(",")},wide]`,
        `let b=[${rows(n, (i) => `r${i}`).join(",")}]`,
      ),
    "r8-direct-locals-misfits": (n) =>
      source(
        "let t:integer=1",
        `let root={${fields(n)}}`,
        `let plain={${fields(n, "1")}}`,
        rows(n, (i) => [
          `let local${i}=plain`,
          `local${i}.f${i}="bad"`,
          `let c${i}=root`,
          `c${i}=local${i}`,
        ]),
      ),
  };
  const __fixedG171_0 = cases();
  const cases0 = (() => {
    return __fixedG171_0.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
  })();
  const shapes1 = (() => {
    return {
      "forest-disjoint-stores": (n) => workShapes["forest-disjoint-stores"](n),
      "forest-nested-projections": (n) => workShapes["forest-nested-projections"](n),
      "diamond-local-fit": (n) => workShapes["diamond-local-fit"](n),
      "guarded-whole-chain": (n) => workShapes["guarded-whole-chain"](n),
      "projected-twice-disjoint": (n) => workShapes["projected-twice-disjoint"](n),
      "r8-prefix-paths": (n) => workShapes["r8-prefix-paths"](n),
      "r8-mix-landed": (n) => workShapes["r8-mix-landed"](n),
      "r8-direct-locals-misfits": (n) => workShapes["r8-direct-locals-misfits"](n),
    };
  })();
  return { cases0, shapes1 };
})();
const generated = [...outputs.cases0];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];

// The programs its auxiliary drivers built from this library (scan-count.mjs, axes.mjs, trace.mjs, reproduce.mjs and
// order.mjs in R/astra-m4-f1-review-evidence/), as their results record them.
const captured = [
  [
    "440",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nexit\n",
  ],
  [
    "441",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\nexit\n",
  ],
  [
    "442",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nlet c32=a.f32\nlet c33=a.f33\nlet c34=a.f34\nlet c35=a.f35\nlet c36=a.f36\nlet c37=a.f37\nlet c38=a.f38\nlet c39=a.f39\nlet c40=a.f40\nlet c41=a.f41\nlet c42=a.f42\nlet c43=a.f43\nlet c44=a.f44\nlet c45=a.f45\nlet c46=a.f46\nlet c47=a.f47\nlet c48=a.f48\nlet c49=a.f49\nlet c50=a.f50\nlet c51=a.f51\nlet c52=a.f52\nlet c53=a.f53\nlet c54=a.f54\nlet c55=a.f55\nlet c56=a.f56\nlet c57=a.f57\nlet c58=a.f58\nlet c59=a.f59\nlet c60=a.f60\nlet c61=a.f61\nlet c62=a.f62\nlet c63=a.f63\nexit\n",
  ],
  [
    "443",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nlet c32=a.f32\nlet c33=a.f33\nlet c34=a.f34\nlet c35=a.f35\nlet c36=a.f36\nlet c37=a.f37\nlet c38=a.f38\nlet c39=a.f39\nlet c40=a.f40\nlet c41=a.f41\nlet c42=a.f42\nlet c43=a.f43\nlet c44=a.f44\nlet c45=a.f45\nlet c46=a.f46\nlet c47=a.f47\nlet c48=a.f48\nlet c49=a.f49\nlet c50=a.f50\nlet c51=a.f51\nlet c52=a.f52\nlet c53=a.f53\nlet c54=a.f54\nlet c55=a.f55\nlet c56=a.f56\nlet c57=a.f57\nlet c58=a.f58\nlet c59=a.f59\nlet c60=a.f60\nlet c61=a.f61\nlet c62=a.f62\nlet c63=a.f63\nlet c64=a.f64\nlet c65=a.f65\nlet c66=a.f66\nlet c67=a.f67\nlet c68=a.f68\nlet c69=a.f69\nlet c70=a.f70\nlet c71=a.f71\nlet c72=a.f72\nlet c73=a.f73\nlet c74=a.f74\nlet c75=a.f75\nlet c76=a.f76\nlet c77=a.f77\nlet c78=a.f78\nlet c79=a.f79\nlet c80=a.f80\nlet c81=a.f81\nlet c82=a.f82\nlet c83=a.f83\nlet c84=a.f84\nlet c85=a.f85\nlet c86=a.f86\nlet c87=a.f87\nlet c88=a.f88\nlet c89=a.f89\nlet c90=a.f90\nlet c91=a.f91\nlet c92=a.f92\nlet c93=a.f93\nlet c94=a.f94\nlet c95=a.f95\nlet c96=a.f96\nlet c97=a.f97\nlet c98=a.f98\nlet c99=a.f99\nlet c100=a.f100\nlet c101=a.f101\nlet c102=a.f102\nlet c103=a.f103\nlet c104=a.f104\nlet c105=a.f105\nlet c106=a.f106\nlet c107=a.f107\nlet c108=a.f108\nlet c109=a.f109\nlet c110=a.f110\nlet c111=a.f111\nlet c112=a.f112\nlet c113=a.f113\nlet c114=a.f114\nlet c115=a.f115\nlet c116=a.f116\nlet c117=a.f117\nlet c118=a.f118\nlet c119=a.f119\nlet c120=a.f120\nlet c121=a.f121\nlet c122=a.f122\nlet c123=a.f123\nlet c124=a.f124\nlet c125=a.f125\nlet c126=a.f126\nlet c127=a.f127\nexit\n",
  ],
  [
    "444",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\na.g32=2\na.g33=2\na.g34=2\na.g35=2\na.g36=2\na.g37=2\na.g38=2\na.g39=2\na.g40=2\na.g41=2\na.g42=2\na.g43=2\na.g44=2\na.g45=2\na.g46=2\na.g47=2\na.g48=2\na.g49=2\na.g50=2\na.g51=2\na.g52=2\na.g53=2\na.g54=2\na.g55=2\na.g56=2\na.g57=2\na.g58=2\na.g59=2\na.g60=2\na.g61=2\na.g62=2\na.g63=2\nexit\n",
  ],
  [
    "445",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\na.g32=2\na.g33=2\na.g34=2\na.g35=2\na.g36=2\na.g37=2\na.g38=2\na.g39=2\na.g40=2\na.g41=2\na.g42=2\na.g43=2\na.g44=2\na.g45=2\na.g46=2\na.g47=2\na.g48=2\na.g49=2\na.g50=2\na.g51=2\na.g52=2\na.g53=2\na.g54=2\na.g55=2\na.g56=2\na.g57=2\na.g58=2\na.g59=2\na.g60=2\na.g61=2\na.g62=2\na.g63=2\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nlet c32=a.f32\nlet c33=a.f33\nlet c34=a.f34\nlet c35=a.f35\nlet c36=a.f36\nlet c37=a.f37\nlet c38=a.f38\nlet c39=a.f39\nlet c40=a.f40\nlet c41=a.f41\nlet c42=a.f42\nlet c43=a.f43\nlet c44=a.f44\nlet c45=a.f45\nlet c46=a.f46\nlet c47=a.f47\nlet c48=a.f48\nlet c49=a.f49\nlet c50=a.f50\nlet c51=a.f51\nlet c52=a.f52\nlet c53=a.f53\nlet c54=a.f54\nlet c55=a.f55\nlet c56=a.f56\nlet c57=a.f57\nlet c58=a.f58\nlet c59=a.f59\nlet c60=a.f60\nlet c61=a.f61\nlet c62=a.f62\nlet c63=a.f63\nexit\n",
  ],
  [
    "446",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\na.g32=2\na.g33=2\na.g34=2\na.g35=2\na.g36=2\na.g37=2\na.g38=2\na.g39=2\na.g40=2\na.g41=2\na.g42=2\na.g43=2\na.g44=2\na.g45=2\na.g46=2\na.g47=2\na.g48=2\na.g49=2\na.g50=2\na.g51=2\na.g52=2\na.g53=2\na.g54=2\na.g55=2\na.g56=2\na.g57=2\na.g58=2\na.g59=2\na.g60=2\na.g61=2\na.g62=2\na.g63=2\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nlet c32=a.f32\nlet c33=a.f33\nlet c34=a.f34\nlet c35=a.f35\nlet c36=a.f36\nlet c37=a.f37\nlet c38=a.f38\nlet c39=a.f39\nlet c40=a.f40\nlet c41=a.f41\nlet c42=a.f42\nlet c43=a.f43\nlet c44=a.f44\nlet c45=a.f45\nlet c46=a.f46\nlet c47=a.f47\nlet c48=a.f48\nlet c49=a.f49\nlet c50=a.f50\nlet c51=a.f51\nlet c52=a.f52\nlet c53=a.f53\nlet c54=a.f54\nlet c55=a.f55\nlet c56=a.f56\nlet c57=a.f57\nlet c58=a.f58\nlet c59=a.f59\nlet c60=a.f60\nlet c61=a.f61\nlet c62=a.f62\nlet c63=a.f63\nlet c64=a.f64\nlet c65=a.f65\nlet c66=a.f66\nlet c67=a.f67\nlet c68=a.f68\nlet c69=a.f69\nlet c70=a.f70\nlet c71=a.f71\nlet c72=a.f72\nlet c73=a.f73\nlet c74=a.f74\nlet c75=a.f75\nlet c76=a.f76\nlet c77=a.f77\nlet c78=a.f78\nlet c79=a.f79\nlet c80=a.f80\nlet c81=a.f81\nlet c82=a.f82\nlet c83=a.f83\nlet c84=a.f84\nlet c85=a.f85\nlet c86=a.f86\nlet c87=a.f87\nlet c88=a.f88\nlet c89=a.f89\nlet c90=a.f90\nlet c91=a.f91\nlet c92=a.f92\nlet c93=a.f93\nlet c94=a.f94\nlet c95=a.f95\nlet c96=a.f96\nlet c97=a.f97\nlet c98=a.f98\nlet c99=a.f99\nlet c100=a.f100\nlet c101=a.f101\nlet c102=a.f102\nlet c103=a.f103\nlet c104=a.f104\nlet c105=a.f105\nlet c106=a.f106\nlet c107=a.f107\nlet c108=a.f108\nlet c109=a.f109\nlet c110=a.f110\nlet c111=a.f111\nlet c112=a.f112\nlet c113=a.f113\nlet c114=a.f114\nlet c115=a.f115\nlet c116=a.f116\nlet c117=a.f117\nlet c118=a.f118\nlet c119=a.f119\nlet c120=a.f120\nlet c121=a.f121\nlet c122=a.f122\nlet c123=a.f123\nlet c124=a.f124\nlet c125=a.f125\nlet c126=a.f126\nlet c127=a.f127\nexit\n",
  ],
  [
    "447",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\na.g32=2\na.g33=2\na.g34=2\na.g35=2\na.g36=2\na.g37=2\na.g38=2\na.g39=2\na.g40=2\na.g41=2\na.g42=2\na.g43=2\na.g44=2\na.g45=2\na.g46=2\na.g47=2\na.g48=2\na.g49=2\na.g50=2\na.g51=2\na.g52=2\na.g53=2\na.g54=2\na.g55=2\na.g56=2\na.g57=2\na.g58=2\na.g59=2\na.g60=2\na.g61=2\na.g62=2\na.g63=2\na.g64=2\na.g65=2\na.g66=2\na.g67=2\na.g68=2\na.g69=2\na.g70=2\na.g71=2\na.g72=2\na.g73=2\na.g74=2\na.g75=2\na.g76=2\na.g77=2\na.g78=2\na.g79=2\na.g80=2\na.g81=2\na.g82=2\na.g83=2\na.g84=2\na.g85=2\na.g86=2\na.g87=2\na.g88=2\na.g89=2\na.g90=2\na.g91=2\na.g92=2\na.g93=2\na.g94=2\na.g95=2\na.g96=2\na.g97=2\na.g98=2\na.g99=2\na.g100=2\na.g101=2\na.g102=2\na.g103=2\na.g104=2\na.g105=2\na.g106=2\na.g107=2\na.g108=2\na.g109=2\na.g110=2\na.g111=2\na.g112=2\na.g113=2\na.g114=2\na.g115=2\na.g116=2\na.g117=2\na.g118=2\na.g119=2\na.g120=2\na.g121=2\na.g122=2\na.g123=2\na.g124=2\na.g125=2\na.g126=2\na.g127=2\nexit\n",
  ],
  [
    "448",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,f3:t,f4:t,f5:t,f6:t,f7:t,f8:t,f9:t,f10:t,f11:t,f12:t,f13:t,f14:t,f15:t,f16:t,f17:t,f18:t,f19:t,f20:t,f21:t,f22:t,f23:t,f24:t,f25:t,f26:t,f27:t,f28:t,f29:t,f30:t,f31:t,f32:t,f33:t,f34:t,f35:t,f36:t,f37:t,f38:t,f39:t,f40:t,f41:t,f42:t,f43:t,f44:t,f45:t,f46:t,f47:t,f48:t,f49:t,f50:t,f51:t,f52:t,f53:t,f54:t,f55:t,f56:t,f57:t,f58:t,f59:t,f60:t,f61:t,f62:t,f63:t,f64:t,f65:t,f66:t,f67:t,f68:t,f69:t,f70:t,f71:t,f72:t,f73:t,f74:t,f75:t,f76:t,f77:t,f78:t,f79:t,f80:t,f81:t,f82:t,f83:t,f84:t,f85:t,f86:t,f87:t,f88:t,f89:t,f90:t,f91:t,f92:t,f93:t,f94:t,f95:t,f96:t,f97:t,f98:t,f99:t,f100:t,f101:t,f102:t,f103:t,f104:t,f105:t,f106:t,f107:t,f108:t,f109:t,f110:t,f111:t,f112:t,f113:t,f114:t,f115:t,f116:t,f117:t,f118:t,f119:t,f120:t,f121:t,f122:t,f123:t,f124:t,f125:t,f126:t,f127:t,g0:1,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1,g10:1,g11:1,g12:1,g13:1,g14:1,g15:1,g16:1,g17:1,g18:1,g19:1,g20:1,g21:1,g22:1,g23:1,g24:1,g25:1,g26:1,g27:1,g28:1,g29:1,g30:1,g31:1,g32:1,g33:1,g34:1,g35:1,g36:1,g37:1,g38:1,g39:1,g40:1,g41:1,g42:1,g43:1,g44:1,g45:1,g46:1,g47:1,g48:1,g49:1,g50:1,g51:1,g52:1,g53:1,g54:1,g55:1,g56:1,g57:1,g58:1,g59:1,g60:1,g61:1,g62:1,g63:1,g64:1,g65:1,g66:1,g67:1,g68:1,g69:1,g70:1,g71:1,g72:1,g73:1,g74:1,g75:1,g76:1,g77:1,g78:1,g79:1,g80:1,g81:1,g82:1,g83:1,g84:1,g85:1,g86:1,g87:1,g88:1,g89:1,g90:1,g91:1,g92:1,g93:1,g94:1,g95:1,g96:1,g97:1,g98:1,g99:1,g100:1,g101:1,g102:1,g103:1,g104:1,g105:1,g106:1,g107:1,g108:1,g109:1,g110:1,g111:1,g112:1,g113:1,g114:1,g115:1,g116:1,g117:1,g118:1,g119:1,g120:1,g121:1,g122:1,g123:1,g124:1,g125:1,g126:1,g127:1}\nlet a=root\na.g0=2\na.g1=2\na.g2=2\na.g3=2\na.g4=2\na.g5=2\na.g6=2\na.g7=2\na.g8=2\na.g9=2\na.g10=2\na.g11=2\na.g12=2\na.g13=2\na.g14=2\na.g15=2\na.g16=2\na.g17=2\na.g18=2\na.g19=2\na.g20=2\na.g21=2\na.g22=2\na.g23=2\na.g24=2\na.g25=2\na.g26=2\na.g27=2\na.g28=2\na.g29=2\na.g30=2\na.g31=2\na.g32=2\na.g33=2\na.g34=2\na.g35=2\na.g36=2\na.g37=2\na.g38=2\na.g39=2\na.g40=2\na.g41=2\na.g42=2\na.g43=2\na.g44=2\na.g45=2\na.g46=2\na.g47=2\na.g48=2\na.g49=2\na.g50=2\na.g51=2\na.g52=2\na.g53=2\na.g54=2\na.g55=2\na.g56=2\na.g57=2\na.g58=2\na.g59=2\na.g60=2\na.g61=2\na.g62=2\na.g63=2\na.g64=2\na.g65=2\na.g66=2\na.g67=2\na.g68=2\na.g69=2\na.g70=2\na.g71=2\na.g72=2\na.g73=2\na.g74=2\na.g75=2\na.g76=2\na.g77=2\na.g78=2\na.g79=2\na.g80=2\na.g81=2\na.g82=2\na.g83=2\na.g84=2\na.g85=2\na.g86=2\na.g87=2\na.g88=2\na.g89=2\na.g90=2\na.g91=2\na.g92=2\na.g93=2\na.g94=2\na.g95=2\na.g96=2\na.g97=2\na.g98=2\na.g99=2\na.g100=2\na.g101=2\na.g102=2\na.g103=2\na.g104=2\na.g105=2\na.g106=2\na.g107=2\na.g108=2\na.g109=2\na.g110=2\na.g111=2\na.g112=2\na.g113=2\na.g114=2\na.g115=2\na.g116=2\na.g117=2\na.g118=2\na.g119=2\na.g120=2\na.g121=2\na.g122=2\na.g123=2\na.g124=2\na.g125=2\na.g126=2\na.g127=2\nlet c0=a.f0\nlet c1=a.f1\nlet c2=a.f2\nlet c3=a.f3\nlet c4=a.f4\nlet c5=a.f5\nlet c6=a.f6\nlet c7=a.f7\nlet c8=a.f8\nlet c9=a.f9\nlet c10=a.f10\nlet c11=a.f11\nlet c12=a.f12\nlet c13=a.f13\nlet c14=a.f14\nlet c15=a.f15\nlet c16=a.f16\nlet c17=a.f17\nlet c18=a.f18\nlet c19=a.f19\nlet c20=a.f20\nlet c21=a.f21\nlet c22=a.f22\nlet c23=a.f23\nlet c24=a.f24\nlet c25=a.f25\nlet c26=a.f26\nlet c27=a.f27\nlet c28=a.f28\nlet c29=a.f29\nlet c30=a.f30\nlet c31=a.f31\nlet c32=a.f32\nlet c33=a.f33\nlet c34=a.f34\nlet c35=a.f35\nlet c36=a.f36\nlet c37=a.f37\nlet c38=a.f38\nlet c39=a.f39\nlet c40=a.f40\nlet c41=a.f41\nlet c42=a.f42\nlet c43=a.f43\nlet c44=a.f44\nlet c45=a.f45\nlet c46=a.f46\nlet c47=a.f47\nlet c48=a.f48\nlet c49=a.f49\nlet c50=a.f50\nlet c51=a.f51\nlet c52=a.f52\nlet c53=a.f53\nlet c54=a.f54\nlet c55=a.f55\nlet c56=a.f56\nlet c57=a.f57\nlet c58=a.f58\nlet c59=a.f59\nlet c60=a.f60\nlet c61=a.f61\nlet c62=a.f62\nlet c63=a.f63\nexit\n",
  ],
  ["449", 'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nexit\n'],
  ["450", 'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\nexit\n'],
  [
    "451",
    'let t:string="ok"\nlet root={n:t,spare:t}\nlet other={n:null,spare:1}\nlet a=[root,root,other,root]\nexit\n',
  ],
  [
    "452",
    'let t:string="ok"\nlet root={n:t,spare:t}\nlet other={n:null,spare:1}\nlet a=[root,other]\nexit\n',
  ],
  ["453", 'let t:string="ok"\nlet root={spare:t}\nlet a=[root,{spare:1}]\nexit\n'],
  ["454", 'let t="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nexit\n'],
  [
    "455",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:"yes"}\nlet a=[root,other]\nexit\n',
  ],
  [
    "456",
    'let t:integer=1\nlet root={spare:t}\nlet other={spare:"bad"}\nlet a=[root,other]\nexit\n',
  ],
  [
    "457",
    'let t:string="ok"\nlet root={p:{spare:t}}\nlet other={p:{spare:1}}\nlet a=[root,other]\nexit\n',
  ],
  [
    "458",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=root\na=other\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs --mode=answers; --mode=work at 8 and 16 (work-small-0) and at 64 and 128 (work-0, work-1); and its auxiliary drivers scan-count.mjs, axes.mjs, trace.mjs, reproduce.mjs and order.mjs",
      "R/astra-m4-f1-review-evidence/ (each run's results)",
    ],
  ],
  sources: 458,
  sha256: "c9e1a75be035c623602a3095b772e3ef90cc5f8d2b8f38414a0b1ac8b85cec1e",
};
