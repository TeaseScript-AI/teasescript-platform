// #1249's review r2 (Astra): its growth shapes, k written integers copied twice into a record's inner fields, a good and
// a bad record, read through a list of projections or stored into projected destinations, with the bad one first or
// last; at the quick sizes 4 and 8 and the growth sizes 64 to 256 (R/astra-m4-i1249-review-r2-evidence/make-growth.py),
// run by its `run.mjs`.
function pre(k) {
  let typed = "";
  for (let i = 0; i < k; i++) typed += `let w${i}: integer = ${i}\nlet alias${i} = w${i}\nlet copied${i} = alias${i}\n`;
  typed += 'let badValue: string = "text"\n';
  const fields = Array.from({ length: k }, (_, i) => `f${i}: copied${i}`).join(", ");
  const other = Array.from({ length: k }, (_, i) => `f${i}: ` + (i === 0 ? "badValue" : `copied${i}`)).join(", ");
  return typed + `let good={outer:{inner:{${fields}}}}\nlet bad={outer:{inner:{${other}}}}\n`;
}
function shape(name, reverse) {
  return (k) => {
    const [a, b] = reverse ? ["bad", "good"] : ["good", "bad"];
    let body;
    if (name === "projection-list") {
      const parts = Array(k).fill("good.outer.inner");
      parts.splice(reverse ? 0 : parts.length, 0, "bad.outer.inner");
      body = "let xs=[" + parts.join(", ") + "]\nsay xs[0].f0\n";
    } else {
      body = "";
      for (let i = 0; i < k; i++)
        body += `let c${i}={slot:${a}.outer.inner}\nc${i}.slot=${b}.outer.inner\nsay c${i}.slot.f0\n`;
    }
    return pre(k) + body + "exit\n";
  };
}
export const shapes = {};
for (const name of ["projection-list", "projected-destinations"])
  for (const reverse of [false, true]) shapes[`${name}/${reverse}`] = shape(name, reverse);

export const sizes = [4, 8, 64, 128, 256];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "python3 make-growth.py",
      "R/astra-m4-i1249-review-r2-evidence/REPRODUCE.md:23"
    ],
    [
      "node run.mjs \"$review_tree\" growth.json growth-new.jsonl (and growth-quick.json)",
      "R/astra-m4-i1249-review-r2-evidence/REPRODUCE.md:28"
    ]
  ],
  "sources": 20,
  "sha256": "4f6a84db3b0d329a6f317fe5b0e8937ecbc9cea7e2498b894d2b8a84c1f1939f"
};
