// #1272's review r2 (Astra): the focused pairs `pair.mjs` ran (R/astra-m4-i1272-review-r2/focused/*.tease). The
// spot copies and probe files it read unchanged are earlier runs'.
export const cases = [
  [
    "inferred-call-left-fit-left-inline.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet result = (make() + [false]) + ["tail"]\nexit\n',
  ],
  [
    "inferred-call-left-fit-left-kept.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inferred-direct.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u }\nlet held = make()\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "inferred-nested-return.tease",
    'let u: (boolean | string)[] = [true]\nfunction make { return u + [false] }\nlet result = make() + ["tail"]\nexit\n',
  ],
  [
    "inferred-written-result.tease",
    'let u: (boolean | string)[] = [true]\nfunction make: (boolean | string)[] { return u }\nlet held = make() + [false]\nlet result = held + ["tail"]\nexit\n',
  ],
  [
    "null-only-kept.tease",
    'let u: null[] = [null]\nlet held = [1] + u\nlet result = held + ["tail"]\nexit\n',
  ],
  ["null-only.tease", 'let u: null[] = [null]\nlet result = ([1] + u) + ["tail"]\nexit\n'],
  ["open-compound.tease", 'let u: list = [1]\nlet result = [2] + u\nresult += ["tail"]\nexit\n'],
  ["open-control-left.tease", 'let u: list = [1]\nlet result = (u + [2]) + ["tail"]\nexit\n'],
  ["open-direct.tease", 'let u: list = [1]\nlet result = [2] + u\nresult[0] = "tail"\nexit\n'],
  [
    "open-right-bad-left-inline.tease",
    'let u: list = [1]\nlet result = ([2] + u) + ["tail"]\nexit\n',
  ],
  [
    "open-right-bad-left-kept.tease",
    'let u: list = [1]\nlet held = [2] + u\nlet result = held + ["tail"]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node pair.mjs "$tree" focused/*.tease > "focused-$tree.txt" || exit $?',
      "R/astra-m4-i1272-review-r2/focused.sh:4",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r3-misc" --dir $W/r3 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r3 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r3 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/tools/queue-r3.sh:28",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r2-misc" --dir $W/head -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/head \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; cd $W && for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/head > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/tools/queue.sh:25",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r3-misc" --dir $W/r3 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r3 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r3 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r3.sh:28",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r4-misc" --dir $W/r4 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r4 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r4 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r4.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r5-misc" --dir $W/r5 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r5 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r5 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r5.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r6-misc" --dir $W/r6 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r6 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r6 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r6.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r7-misc" --dir $W/r7 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r7 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r7 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r7.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r9-misc" --dir $W/r9 -- bash -c "export PATH=/home/peter/opt/node-24.18/bin:\\$PATH; cd $W/probe && timeout 30m node $T/pair.mjs $W/r9 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r9 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r9.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r2-misc" --dir $W/head -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/head \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; cd $W && for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/head > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue.sh:25",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r3-misc" --dir $W/r3 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r3 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r3 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r3.sh:28",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r4-misc" --dir $W/r4 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r4 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r4 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r4.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r5-misc" --dir $W/r5 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r5 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r5 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r5.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r6-misc" --dir $W/r6 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r6 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r6 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r6.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r7-misc" --dir $W/r7 -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/r7 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r7 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r7.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r9-misc" --dir $W/r9 -- bash -c "export PATH=/home/peter/opt/node-24.18/bin:\\$PATH; cd $W/probe && timeout 30m node $T/pair.mjs $W/r9 \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/r9 > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue-r9.sh:27",
    ],
    [
      'SX_HEAVY_MEM=4G sx-queue add --name "i1272r2-misc" --dir $W/head -- bash -c "cd $W/probe && timeout 30m node $T/pair.mjs $W/head \\$(cat $W/probe-paths.txt) > $O/probes.txt 2> $O/probes.err; cd $W && for t in paste extended2 call-union; do (cd $O && timeout 30m node $T/\\$t.mjs $W/head > $O/\\$t.out 2> $O/\\$t.err); done; echo done >> $O/probes.err"',
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/tools/queue.sh:25",
    ],
  ],
  sources: 12,
  sha256: "cd64850f2e0c316d658c47d0b0a5f7bf126135c1f27c8528061c4c4cd57b7ec3",
};
