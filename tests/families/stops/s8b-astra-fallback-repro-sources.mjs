// get, written and related fixed cases; #1165 / S8, Astra review, round unrecorded
// (R/astra-m4-s8b-evidence/fallback-repro.mjs).
export const cases = (() => {
  const sources = {
    get: 'let items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
    written:
      'let items: integer[] = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay "AFTER"\nexit\n',
    otherwise: 'let item: integer? = hostOther\nsay item otherwise hostValue\nsay "AFTER"\nexit\n',
    paired:
      "let anchor = 4\nlet value = anchor otherwise hostValue\nlet items = [2, 3]\nsay items.get(hostOther, default: hostValue)\nsay value\nexit\n",
  };
  return Object.entries(sources);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node fallback-repro.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-evidence/fallback-repro.mjs",
    ],
  ],
  sources: 4,
  sha256: "b43c5782f4aa042e15d2aa5bad44fc0a7e2985903d9c8b31f6ae5cc9e9b2e334",
};
