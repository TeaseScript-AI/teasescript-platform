// Astra review.
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
