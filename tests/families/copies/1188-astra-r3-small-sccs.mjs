// small whole-copy SCCs and fed rings; #1188, astra-m4-i1188-design-recheck-r3-evidence, archived Python/shell evidence
// (R/astra-m4-i1188-design-recheck-r3-evidence/focused.py).
const generated = (() => {
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
// the run's other inputs with the default globals, as round-2 capture shows them (refs2/C, job 1 and 4)
const captured = [
  [
    "whole-small/False/box",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue}\nlet right={f:wordvalue}\nleft=right\nright=left\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
    ["hostValue"],
  ],
  [
    "assign-small",
    "let count:integer=11\nlet parcel={score:count}\nlet broken=[{score:false},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet final=relay.value\nfinal=parcel\nexit\n",
    ["hostValue"],
  ],
  [
    "live-small",
    "let score:integer | string=13\nlet source={score:score}\nlet grid=[{rows:[{score:false}]},{rows:[source]}]\nlet final=[grid.first.rows.first,source]\nexit\n",
    ["hostValue"],
  ],
  [
    "runtime/live",
    "let count:integer=11\nlet parcel={score:count}\nlet broken=[{score:false},parcel]\nlet final=[broken[0],parcel]\nexit\n",
    ["hostValue"],
  ],
  [
    "runtime/host",
    "let fixed:integer=5\nlet original={score:fixed}\nlet rows=[original,hostValue]\nlet copy=rows\nsay copy[0].score\nexit\n",
    ["hostValue"],
  ],
  [
    "runtime/host-store",
    "let fixed:integer=5\nlet original={score:fixed}\nlet receive=original\nreceive=hostValue\nlet copy=receive\nsay copy.score\nexit\n",
    ["hostValue"],
  ],
  [
    "runtime/clean",
    "let fixed:integer=5\nlet original={score:fixed}\nlet rows=[original,{score:6}]\nlet copy=rows\nsay copy[0].score\nexit\n",
    ["hostValue"],
  ],
];
export const cases = [...generated, ...captured];

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "3. Run `python3 generate.py` and `python3 focused.py` locally and copy `cases/` and the scripts to the laptop.",
      "R/astra-m4-i1188-design-recheck-r3-evidence/REPRODUCE.md:17",
    ],
    [
      'node "$review_root/runtime.mjs" "$review_root/$variant-d93-review" "$review_root/cases/runtime.json" "$review_root/out/runtime-$variant.jsonl"',
      "R/astra-m4-i1188-design-recheck-r3-evidence/runtime-queue.sh:9",
    ],
    [
      'node "$review_root/run.mjs" "$review_root/$variant-d93-review" "$review_root/cases/$family.json" "$review_root/out/$family-$variant-$order.jsonl" "$order"',
      "R/astra-m4-i1188-design-recheck-r3-evidence/run-one.sh:6",
    ],
    [
      'bash "$review_root/run-one.sh" "$variant" focus "$order"',
      "R/astra-m4-i1188-design-recheck-r3-evidence/focus-queue.sh:10",
    ],
  ],
  sources: 25,
  sha256: "3ac66ad180f37214af1df17f4ebac2d6df8c8c71ed450f7a1f5d39b690c1fa08",
};
