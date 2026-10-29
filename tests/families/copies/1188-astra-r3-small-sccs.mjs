// astra-m4-i1188-design-recheck-r3-evidence; archived Python/shell evidence.
export const cases = (() => {
  let cases, count, i, own, route, s, tail;
  cases = [];
  function add(name, s) {
    cases.push({ name: name, source: s + "\nexit\n" });
  }
  for (own of [false, true]) {
    for (route of ["direct", "box", "deep"]) {
      s =
        'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue}\nlet right={f:wordvalue}\nleft=right\nright=left\n';
      if (own) {
        s += "right.f=wordvalue\n";
      }
      if (route === "direct") {
        s += "let final=[left,right]";
      } else {
        if (route === "box") {
          s += "let box={a:left,b:right}\nlet final=[box.a,box.b]";
        } else {
          s += "let box={a:{v:left},b:{v:right}}\nlet final=[box.a.v,box.b.v]";
        }
      }
      add(`whole-small/${own}/${route}`, s);
    }
  }
  for (count of [2, 3]) {
    for (tail of ["direct", "copy", "box"]) {
      s =
        "let amount:integer=29\nlet origin={f:amount}\nlet fractional={f:1.75}\nlet inlet=origin\ninlet=fractional\nlet a0=inlet\n";
      for (i of Array.from({ length: count - 1 }, (_, i) => i + 1)) {
        s += `let a${i}=a${i - 1}
`;
      }
      s += `a0=a${count - 1}
`;
      if (tail === "direct") {
        s += `let final=[fractional,a${count - 1}]`;
      } else {
        if (tail === "copy") {
          s += `let copy=a${count - 1}
let final=[fractional,copy]`;
        } else {
          s += `let box={v:a${count - 1}}
let final=[fractional,box.v]`;
        }
      }
      add(`fed-small/${count}/${tail}`, s);
    }
  }
  add(
    "assign-small",
    "let count:integer=11\nlet parcel={score:count}\nlet broken=[{score:false},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet final=relay.value\nfinal=parcel",
  );
  add(
    "live-small",
    "let score:integer | string=13\nlet source={score:score}\nlet grid=[{rows:[{score:false}]},{rows:[source]}]\nlet final=[grid.first.rows.first,source]",
  );
  add(
    "runtime/rejected",
    "let count:integer=11\nlet parcel={score:count}\nlet broken=[{score:false},parcel]\nlet final=[broken[0],parcel]",
  );
  add(
    "runtime/live",
    "let count:integer=11\nlet parcel={score:count}\nlet broken=[{score:false},parcel]\nlet final=[broken[0],parcel]",
  );
  add(
    "runtime/host",
    "let fixed:integer=5\nlet original={score:fixed}\nlet rows=[original,hostValue]\nlet copy=rows\nsay copy[0].score",
  );
  add(
    "runtime/host-store",
    "let fixed:integer=5\nlet original={score:fixed}\nlet receive=original\nreceive=hostValue\nlet copy=receive\nsay copy.score",
  );
  add(
    "runtime/clean",
    "let fixed:integer=5\nlet original={score:fixed}\nlet rows=[original,{score:6}]\nlet copy=rows\nsay copy[0].score",
  );

  return cases.map((c) => [c.name, c.source]);
})();
export const checks = ["publication"];
