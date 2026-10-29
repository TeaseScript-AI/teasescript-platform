// named-parse, named-load and related fixed cases; #1165 / S8, Astra review, r6
// (R/astra-m4-s8b-r6-evidence/probe/edges.mjs).
export const cases = (() => {
  const cases = [
    ["named-parse", "let fallback: integer = 3\nsay fromJson(hostValue, default: fallback)\nexit"],
    ["named-load", 'let fallback: boolean = false\nsay load("key", default: fallback)\nexit'],
    [
      "named-parse-list",
      "let fallback: integer[] = [3]\nsay fromJson(hostValue, default: fallback)\nexit",
    ],
    [
      "named-load-object",
      'let fallback: object = {amount: 3}\nsay load("key", default: fallback)\nexit',
    ],
    ["unrestricted-element", "let bag: list = [hostValue]\nsay bag\nexit"],
    ["unrestricted-add", "let bag: list = []\nbag.add(hostValue)\nsay bag\nexit"],
    ["own-ingress-store", "let quantity: integer = hostValue\nrepeat quantity {}\nexit"],
    ["same-source", "let quantity: integer = 3\nsay [quantity, quantity]\nexit"],
    ["own-parse", "say fromJson(hostValue, default: false)\nexit"],
    ["untyped-load", 'say load("key", default: null)\nexit'],
    ["boundary-own-read", "say 1 otherwise hostValue\nexit"],
    ["boundary-consumer", "repeat hostValue {}\nexit"],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node /home/peter/work/astra-s8-r6/probe/"$kind".mjs "$name" "$mode"',
      "R/astra-m4-s8b-r6-evidence/job.sh:8",
    ],
  ],
  sources: 12,
  sha256: "bc27f9bfad9b982432f3b80e3b182a029208d6426e540c33c033e30d547a75ed",
};
