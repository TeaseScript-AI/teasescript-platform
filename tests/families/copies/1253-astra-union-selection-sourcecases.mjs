export const cases = [
  [
    "original-1",
    'let parcel: integer dict? = fromJson(hostValue, default: null, files: false)\nsay "complete"\nexit',
  ],
  [
    "original-2",
    'let parcel = fromJson(hostValue, default: dict {"a": 1}, files: false)\nsay "complete"\nexit',
  ],
];

export const checks = ["publication"];
