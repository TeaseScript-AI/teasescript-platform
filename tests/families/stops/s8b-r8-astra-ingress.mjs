// original r8 astra ingress inputs; astra-m4-s8b-r8-evidence, review/builder evidence
// (R/astra-m4-s8b-r8-evidence/builder/probe7/ingress.mjs).
const fixedCases = [
  ["inline-1", "say fromJson(hostValue, default: 4)\nexit"],
  ["inline-2", "say fromJson(hostValue, default: [4])\nexit"],
  ["inline-3", "say fromJson(hostValue, default: {value: 4})\nexit"],
  ["inline-4", "let bag = fromJson(hostValue, default: {value: 4})\nsay bag.value\nexit"],
  ["inline-5", 'let bag: integer = load("sample", default: 4)\nsay bag\nexit'],
  ["inline-6", 'say load("sample", default: 4)\nexit'],
  ["inline-7", "say fromJson(hostValue, expected: integer)\nexit"],
];
export const cases = fixedCases;
export const checks = ["publication", "stops"];

for (const index of [6]) cases.splice(index, 1);

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node ingress.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8b-r8-evidence/builder/probe7/ingress.mjs",
    ],
  ],
  sources: 7,
  sha256: "acef482aeacccd28b900d80aeabf94c0382fcc36efc1359425d42071b03d17cb",
  dropped: [
    [
      "b7c63011d48175d0861efadf0d05781d4c247fa119e1338d68ad252ad1cc5e97",
      "Experimental fromJson(expected: integer) uses integer as an unbound value; the ingress stop probe did not intend a parse/name failure. (R/astra-m4-s8b-r8-evidence/builder/probe7/ingress.mjs:2–13 (ingress/default cases and makeRun stop oracle, without an error expectation); compiler name validation rejects the unbound integer.)",
    ],
  ],
};
