// loaded-branch, loaded-fallback and related fixed cases; Astra review, r3
// (R/astra-m4-s8d-r3-evidence/speaker-source.mjs).
export const cases = (() => {
  const programs = {
    "loaded-branch":
      'let target = load("review.speaker.target", default: null)\nif target == null { target = player }\ntarget.add(73)\nexit\n',
    "loaded-fallback":
      'let target = (load("review.speaker.target", default: null)) otherwise player\ntarget.add(73)\nexit\n',
    function:
      "function recipient { return player }\nlet target = recipient()\ntarget.add(73)\nexit\n",
  };
  return Object.entries(programs);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node speaker-source.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-s8d-r3-evidence/speaker-source.mjs",
    ],
  ],
  sources: 3,
  sha256: "0ea1a3aefa103b34d058b10747fb7ad9de72479032aa56f962a7e427afdf838c",
};
