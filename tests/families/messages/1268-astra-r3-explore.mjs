// declaration, top_before and related fixed cases; #1273, #1268, Astra review, r3
// (R/astra-m4-i1268-review-r3-evidence/explore.mjs).
export const cases = (() => {
  const cases = {
    declaration: 'let xs: integer set = set["wrong"]\nexit\n',
    top_before: 'let xs: integer set = set["wrong"]\nlet v: integer = hostValue\nexit\n',
    top_after: 'let v: integer = hostValue\nlet xs: integer set = set["wrong"]\nexit\n',
    function_inside:
      'function f {\n let v: integer = hostValue\n let xs: integer set = set["wrong"]\n}\nf()\nexit\n',
    function_outside:
      'function f {\n let v: integer = hostValue\n}\nlet xs: integer set = set["wrong"]\nf()\nexit\n',
    call_in_initializer:
      'function f {\n let v: integer = hostValue\n return 1\n}\nlet xs: integer set = set["wrong", f()]\nexit\n',
    independent_function:
      'function f {\n let v: integer = hostValue\n}\nfunction g {\n let xs: integer set = set["wrong"]\n}\nf()\ng()\nexit\n',
    hidden_call_error:
      'function bad { return true }\nlet v: integer = hostValue\nlet xs: integer set = set["wrong", bad()]\nexit\n',
    hidden_call_error_in_function:
      'function bad { return true }\nfunction f {\n let v: integer = hostValue\n let xs: integer set = set["wrong", bad()]\n}\nf()\nexit\n',
    hidden_unknown:
      'let v: integer = hostValue\nlet xs: integer set = set["wrong", hostValue + 1]\nexit\n',
    hidden_unknown_in_function:
      'function f {\n let v: integer = hostValue\n let xs: integer set = set["wrong", hostValue + 1]\n}\nf()\nexit\n',
    missed_requirement:
      'let v: integer = hostValue\nlet xs: integer set = set["wrong", hostValue.length]\nexit\n',
    missed_other_null:
      'function hide(n) { return n }\nlet v: integer = hostValue\nlet ns: integer? = hide(null)\nlet xs: integer set = set["wrong", ns + 1]\nexit\n',
  };
  return Object.entries(cases);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node explore.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1268-review-r3-evidence/explore.mjs",
    ],
  ],
  sources: 13,
  sha256: "f3c2dfc98a42e97c24084c6c904c7edb5e2dc030fc13dee050c3bbe3f5e01842",
};
