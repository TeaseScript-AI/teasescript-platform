// #1165 / S8, Astra r4 (R/astra-m4-s8b-r4-evidence/oracle.mjs): the oracle's three programs, a carried property read
// beside a host store, a nested host list, and a copy overwritten by a text-valued object.
const source =
  'let chosen: number? = null\nlet bag = {chosen: chosen}\nlet alias = bag\nsay alias.chosen otherwise hostValue\nlet capacity: integer = hostValue\nlet doc = hostOther\ndoc.count = 6\nsay "READY"\nexit\n';
const store = "let shelter = {nested: [hostValue]}\nlet aside: integer = hostOther\nexit\n";
const carried =
  'let anchor = {score: 8}\nlet shadow = anchor\nlet invalid = {score: "text"}\nshadow = invalid\nsay shadow.score\nexit\n';
export const cases = Object.entries({ source, store, carried });
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["ROOT=<checkout> node oracle.mjs", "R/astra-m4-s8b-r4-evidence/README.md:14"]],
  sources: 3,
  sha256: "431e73fafda788f7873744e6e56f33bba797b9e5c62ff84aa8dcab26c5c87b5c",
};
