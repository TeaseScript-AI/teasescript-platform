// #1278, Astra r2 (R/astra-m4-i1278-review-r2-evidence/builder-evidence/generators/definition-counts.mjs:22): k
// redefinitions of one object, offered twice in a choice and read: the observation control at 8, four modes at 4, 64,
// 128 and 256, and source order at 1,024 and 4,096.
function program(k) {
  return (
    Array.from({ length: k }, (_, i) => (i ? "p = " : "let p = ") + `{f: ${i + 1}}`).join("\n") +
    '\nlet options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options\nrepeat picked.f {}\nexit'
  );
}

export const shapes = { program };
export const sizes = [4, 8, 64, 128, 256, 1024, 4096];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node generators/definition-counts.mjs <out> base3 head5",
      "R/astra-m4-i1278-review-r2-evidence/builder-evidence/README.md (B1)",
    ],
  ],
  sources: 7,
  sha256: "568c5be53e80ceb8e038da656b8cfd87363bf8e015cb44a9ca7467f8182ec3a1",
};
