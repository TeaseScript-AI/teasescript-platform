export const cases = [
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
