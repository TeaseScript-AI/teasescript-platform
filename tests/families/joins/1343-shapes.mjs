// #1343's growth shapes (its builder's `scripts/shapes.mjs`): #1313's k named bindings in a list beside a k-property
// object and #1304's k composite fallbacks beside a wide object, with their siblings; as the kit
// (desktop:~/work/evidence/1359/67b1d250b/tools/shapes1343.mjs, the same in 1417/a0abf39f0) that #1359's and #1417's
// answer and oracle runs loaded, at the sizes they ran it: 1, 3 and 5, and 2, 3, 5 and 9.
const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
const wide = (k, name = "f") => `{${many(k, (i) => `${name}${i}: 1`)}}`;
const at = (where, k) => (where === "first" ? 0 : where === "last" ? k : k >> 1);

// #1313: k named bindings in a list beside a k-property object, each property read through `xs[0]`
function named(
  k,
  {
    where = "amid",
    reads = true,
    object = true,
    binding = (i) => `load("k", default: hostValue)`,
  } = {},
) {
  const elements = Array.from({ length: k }, (_, i) => `l${i}`);
  if (object) elements.splice(at(where, k), 0, wide(k));
  return [
    many(k, (i) => `let l${i} = ${binding(i)}`, "\n"),
    `let xs = [${elements.join(", ")}]`,
    reads ? many(k, (i) => `let a${i}: integer = xs[0].f${i}`, "\n") : "",
    "exit",
  ].join("\n");
}

// #1304: k composite fallbacks beside a wide object
function composite(k, element, { where = "amid", wrap = (x) => x, path = "" } = {}) {
  const es = Array.from({ length: k }, (_, i) => wrap(element(i)));
  es.splice(at(where, k), 0, wrap(`{${many(k, (i) => `p${i}:1`)}}`));
  return (
    `let t:integer=1\nlet raw=hostValue\nlet xs=[${es}]\n` +
    many(k, (i) => `let n${i}:integer=xs[0].${path}p${i}`, "\n") +
    "\nexit"
  );
}
const loadOtherwise = () => '(load("k",default:hostValue) otherwise {p0:1})';

export const shapes = {
  // #1313's six
  namedAmid: (k) => named(k),
  namedFirst: (k) => named(k, { where: "first" }),
  namedLast: (k) => named(k, { where: "last" }),
  namedNoRead: (k) => named(k, { reads: false }),
  namedNoObject: (k) => named(k, { object: false }),
  namedHost: (k) => named(k, { binding: () => "hostValue" }),
  namedSmall: (k) => named(k, { binding: () => "{f0: 1}" }),
  // #1304 and its siblings
  otherwiseAmid: (k) => composite(k, loadOtherwise),
  otherwiseFirst: (k) => composite(k, loadOtherwise, { where: "first" }),
  otherwiseLast: (k) => composite(k, loadOtherwise, { where: "last" }),
  fromJsonOtherwise: (k) =>
    composite(k, () => '(fromJson("{}",default:hostValue) otherwise {p0:1})'),
  parseDefault: (k) => composite(k, () => 'fromJson("{}",default:{p0:1})'),
  loadDefaultObject: (k) => composite(k, () => 'load("k",default:{p0:1})'),
  otherwiseNested: (k) => composite(k, loadOtherwise, { wrap: (x) => `{box:${x}}`, path: "box." }),
  otherwiseDeep: (k) =>
    composite(
      k,
      () =>
        '(load("k",default:hostValue) otherwise (load("j",default:hostValue) otherwise {p0:1}))',
    ),
};

export const sizes = [1, 2, 3, 5, 9];

// the globals the recorded runs passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'q 4G oracle "node oracle-run.mjs $W/oracle-$B $W/oracle-$H $E/oracle.json gates.mjs shapes.mjs shapes1297.mjs shapes1343.mjs shapes-r1.mjs shapes-r1own.mjs shapes-r2.mjs shapes-r2peer.mjs shapes-r3.mjs shapes-r3proof.mjs r4-own-shapes.mjs r5-shapes.mjs shapes-leaf.mjs shapes-order.mjs astra-permutations.mjs"',
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1357r2-oracle-$H" --dir $T -- bash -c "timeout 90m node oracle-run.mjs $W/oracle-$H $E/oracle.json shapes.mjs shapes1297.mjs shapes1343.mjs shapes-r1.mjs shapes-r2.mjs r3/own-shapes.mjs r3/proof-shape.mjs shapes-leaf.mjs shapes-order.mjs astra-permutations.mjs > $E/oracle.log 2>&1; echo exit=\\$? >> $E/oracle.log" | tail -n 1',
      "desktop:~/work/evidence/1359/67b1d250b/tools/queue-evidence.sh:45",
    ],
    [
      'S="$S node answers.mjs $W/$t $E/answers-${s%%:*}-$t.jsonl shapes ${s%%:*}.mjs ${s#*:} || exit;"',
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:27",
    ],
    [
      'SX_HEAVY_MEM=6G sx-queue add --name "i1357-small-$t" --dir $T -- bash -c "timeout 120m bash -c \'for s in 1357:shapes 1297:shapes1297 1343:shapes1343 r1:shapes-r1 r2:shapes-r2; do node growth.mjs $W/$t \\${s#*:}.mjs all 64 $M $C > $E/growth-\\${s%%:*}-$t.jsonl || exit; done; node answers.mjs $W/$t $E/answers-1357-$t.jsonl shapes shapes.mjs 1,3,5,16 && node answers.mjs $W/$t $E/answers-1297-$t.jsonl shapes shapes1297.mjs 1,3,5 && node answers.mjs $W/$t $E/answers-1343-$t.jsonl shapes shapes1343.mjs 1,3,5 && node answers.mjs $W/$t $E/answers-r1-$t.jsonl shapes shapes-r1.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-r2-$t.jsonl shapes shapes-r2.mjs 1,3,8 && node family1297.mjs $W/$t/dist $E/family1297-$t.jsonl\' > $E/small-$t.log 2>&1; echo exit=\\$? >> $E/small-$t.log" | tail -n 1',
      "desktop:~/work/evidence/1359/67b1d250b/tools/queue-evidence3.sh:12",
    ],
    [
      'else SMALL="node answers.mjs $W/$t $E/answers-1357-$t.jsonl shapes shapes.mjs 1,3,5,16 && node answers.mjs $W/$t $E/answers-1297-$t.jsonl shapes shapes1297.mjs 1,3,5 && node answers.mjs $W/$t $E/answers-1343-$t.jsonl shapes shapes1343.mjs 1,3,5 && node answers.mjs $W/$t $E/answers-r1-$t.jsonl shapes shapes-r1.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-r2-$t.jsonl shapes shapes-r2.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-r3-$t.jsonl shapes shapes-r3.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-r3proof-$t.jsonl shapes shapes-r3proof.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-leaf-$t.jsonl shapes shapes-leaf.mjs 1,3,8 && node answers.mjs $W/$t $E/answers-order-$t.jsonl shapes shapes-order.mjs 8,16,24 && node answers.mjs $W/$t $E/answers-astra-$t.jsonl shapes astra-permutations.mjs 8,16,24 && node answers.mjs $W/$t $E/answers-peerfam-$t.jsonl shapes shapes-peerfam.mjs 32,48 && node family1297.mjs $W/$t/dist $E/family1297-$t.jsonl"; fi',
      "desktop:~/work/evidence/1359/67b1d250b/tools/queue-evidence.sh:25",
    ],
  ],
  sources: 73,
  sha256: "cd7e4754b74b7f73f6420450b3b72834e95bc15268e8707a87a4f6c4b9b3bcce",
};
