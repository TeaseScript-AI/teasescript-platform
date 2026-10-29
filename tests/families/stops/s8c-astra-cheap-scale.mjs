const shapes = {
  repeated: (n) => "let b = 1\n" + "b = 2\n".repeat(n) + "b = hostValue\n",
  fields: (n) =>
    "let b = {f0: 1}\n" +
    Array.from({ length: n }, (_, i) => `b = {f${i}: ${i}}\n`).join("") +
    "b = hostValue\n",
  fieldStores: (n) =>
    "let b = {f0: 1}\n" +
    Array.from({ length: n }, (_, i) => `b.f${i} = ${i}\n`).join("") +
    "b = hostValue\n",
  deep: (n) => `let b = ${"[".repeat(n)}1${"]".repeat(n)}\nb = hostValue\n`,
};

export const cases = Object.entries(shapes).flatMap(([name, make]) =>
  (name === "deep" ? [64, 128, 256] : [512, 1024, 2048]).map((n) => [
    name + "@" + n,
    make(n) + 'say "AFTER"\nexit\n',
  ]),
);

export const checks = ["publication", "stops"];
