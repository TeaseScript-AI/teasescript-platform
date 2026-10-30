// captured astra r3 verify inputs; #1273, astra-m4-i1268-review-r3-evidence, review/builder evidence
// (R/astra-m4-i1268-review-r3-evidence/verify.mjs).
const generated = [
  ["original-1", 'let xs: integer set = set["wrong"]\nexit\n'],
  ["original-2", 'let xs: integer set = set["wrong"]\nlet v: integer = hostValue\nexit\n'],
  ["original-3", 'let v: integer = hostValue\nlet xs: integer set = set["wrong"]\nexit\n'],
  [
    "original-4",
    'function f {\n let v: integer = hostValue\n let xs: integer set = set["wrong"]\n}\nf()\nexit\n',
  ],
  [
    "original-5",
    'function f {\n let v: integer = hostValue\n}\nlet xs: integer set = set["wrong"]\nf()\nexit\n',
  ],
  [
    "original-6",
    'function f {\n let v: integer = hostValue\n return 1\n}\nlet xs: integer set = set["wrong", f()]\nexit\n',
  ],
  [
    "original-7",
    'function f {\n let v: integer = hostValue\n}\nfunction g {\n let xs: integer set = set["wrong"]\n}\nf()\ng()\nexit\n',
  ],
  [
    "original-8",
    'function bad { return true }\nlet v: integer = hostValue\nlet xs: integer set = set["wrong", bad()]\nexit\n',
  ],
  [
    "original-9",
    'function bad { return true }\nfunction f {\n let v: integer = hostValue\n let xs: integer set = set["wrong", bad()]\n}\nf()\nexit\n',
  ],
  [
    "original-10",
    'let v: integer = hostValue\nlet xs: integer set = set["wrong", hostValue + 1]\nexit\n',
  ],
  [
    "original-11",
    'function f {\n let v: integer = hostValue\n let xs: integer set = set["wrong", hostValue + 1]\n}\nf()\nexit\n',
  ],
  [
    "original-12",
    'let v: integer = hostValue\nlet xs: integer set = set["wrong", hostValue.length]\nexit\n',
  ],
  [
    "original-13",
    'function hide(n) { return n }\nlet v: integer = hostValue\nlet ns: integer? = hide(null)\nlet xs: integer set = set["wrong", ns + 1]\nexit\n',
  ],
  ["original-14", '\nlet xs: integer set = set["wrong"]\nexit\n'],
  [
    "original-15",
    'function f {\n let v: integer = hostValue\n let inside: integer set = set["wrong"]\n}\nlet outside: integer set = set["wrong"]\nf()\nexit\n',
  ],
  [
    "original-16",
    'function bad { return null }\nlet v: integer = hostValue\nlet xs: integer set = set["wrong", bad() + 1]\nexit\n',
  ],
];

export const checks = ["publication"];

// The six fixed declarations verify.mjs compiled through the public and the core routes
// (R/astra-m4-i1268-review-r3-evidence/verify.mjs).
const captured = [
  [
    "missed_other_null/fixed",
    'function hide(n) { return n }\nlet v: integer = hostValue\nlet ns: integer? = hide(null)\nlet xs: (integer | string) set = set["wrong", ns + 1]\nexit\n',
  ],
  [
    "callee_nullable/fixed",
    'function bad { return null }\nlet v: integer = hostValue\nlet xs: (integer | string) set = set["wrong", bad() + 1]\nexit\n',
  ],
  [
    "hidden_unknown/fixed",
    'let v: integer = hostValue\nlet xs: (integer | string) set = set["wrong", hostValue + 1]\nexit\n',
  ],
  [
    "function_inside/fixed",
    'function f {\n let v: integer = hostValue\n let xs: (integer | string) set = set["wrong"]\n}\nf()\nexit\n',
  ],
  [
    "function_outside/fixed",
    'function f {\n let v: integer = hostValue\n}\nlet xs: (integer | string) set = set["wrong"]\nf()\nexit\n',
  ],
  [
    "call_in_initializer/fixed",
    'function f {\n let v: integer = hostValue\n return 1\n}\nlet xs: (integer | string) set = set["wrong", f()]\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "SX_HEAVY_MEM=2G SX_HEAVY_SWAP=0 node /tmp/agent-work/o4-3a-lead-astra-i1268-r3/verify.mjs",
      "R/astra-m4-i1268-review-r3.md:53",
    ],
  ],
  sources: 22,
  sha256: "cd012aff8d8025a580fa1b20251daeb8eb1caa19b98796e27b097110c488ab34",
};
