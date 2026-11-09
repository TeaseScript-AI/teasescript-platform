// Its id is its file name before its area was grouped, which keeps its sources' places in a stored baseline.
export const id = "1744-sol-v30-call-holes.mjs";
// The V30 calls and forms no gate source exercised (#1744): Sol's S9b scoping r2 on main dff711474 (#1072 comment
// 6649860699) found 18 calls in no gate source and no converted unit, and five more forms, and proposed an independent
// source for each (`coverage-hole-sources.json`, `additional-coverage-holes.json`; the 18 checked through both public
// routes in four modes by its `check-holes.mjs`). Presence sources for the S11 shadow gate: each construction that owns
// one adds its valid, invalid and unknown-argument companions. Host globals: none, as the check passed.
export const cases = [
  // V30:451–464
  ["randomWeighted", "let result = randomWeighted(dict{left: 1, right: 2})\nexit\n", []],
  // V30:477–484
  ["randomBeta", "let result = randomBeta(2, 5)\nexit\n", []],
  // V30:478–484
  ["randomPert", "let result = randomPert(5, 10, 20)\nexit\n", []],
  // V30:2008
  ["sign", "let result = sign(-3)\nexit\n", []],
  // V30:2035
  ["exp", "let result = exp(1)\nexit\n", []],
  // V30:2037
  ["log10", "let result = log10(100)\nexit\n", []],
  // V30:2038–2052
  ["tan", "let result = tan(45 deg)\nexit\n", []],
  // V30:2039–2052
  ["asin", "let result = asin(0.5)\nexit\n", []],
  // V30:2039–2052
  ["acos", "let result = acos(0.5)\nexit\n", []],
  // V30:2040–2052
  ["atan", "let result = atan(1)\nexit\n", []],
  // V30:2041–2052
  ["atan2", "let result = atan2(1, 1)\nexit\n", []],
  // V30:2577–2600
  ["sum", "let result = sum([1, 2])\nexit\n", []],
  // V30:2577–2600
  ["average", "let result = average([1, 2])\nexit\n", []],
  // V30:2577–2600
  ["median", "let result = median([1, 2])\nexit\n", []],
  // V30:2591–2593
  ["percentile", "let result = percentile([1, 2], 50)\nexit\n", []],
  // V30:2584–2600
  ["stddev", "let result = stddev([1, 2])\nexit\n", []],
  // V30:2622–2645
  ["linearRegression", "let result = linearRegression([1, 2])\nexit\n", []],
  // V30:2643–2645
  ["predict", "let result = predict(linearRegression([1, 2]), 2)\nexit\n", []],
  // V30:3808–3836: Plain/stage controls, camera present/absent, and actual handle lifecycle in the command construction.
  ["camera-statement", "showCamera\nexit\n", []],
  // V30:3810–3820: Retain the camera handle, read and write its supported properties, and check wrong property value domains through A39.
  ["camera-handle", "let view = showCamera\nexit\n", []],
  // V30:3813–3820: Show then hide controls, both camera layouts, and stale handle/lifecycle checks through the existing runtime.
  ["hide-camera", "hideCamera\nexit\n", []],
  // V30:6580–6607: Supply a matching and nonmatching image/script catalog, then test plain presence and missing tags.
  ["plain-tag-predicate", 'let images = findImages(where: "warm")\nexit\n', []],
  // V30:6580–6607: Catalogs with numeric/presence-only/missing tags; fitting, wrong and unknown bound types; image/script, logic and from-path controls.
  [
    "numeric-tag-predicate",
    'let minimum = 2\nlet images = findImages(where: "score" > minimum)\nexit\n',
    [],
  ],
];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'env -u NODE_OPTIONS node "$SX_TREE/tests/families/shadow.mjs" "$SX_TREE" "$SX_IN/holes" --demands 16 --out "$SX_OUT/shadow.jsonl"',
      "the lane3-1744-holes run in #1744's PR evidence (main 575c699b9, this module alone in its folder)",
    ],
  ],
  sources: 23,
  sha256: "8a390668cf84a7b606f6c0ecc4c906f9d165bc79583f72661076e612bb94b89c",
};
