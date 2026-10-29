// #1310; builder/review archive.
export const cases = (() => {
  const programs = [
    ["bad", 'let box = {first: {n: 1}}\nbox.first.n = "bad"\nsay "DONE"\nexit\n'],
    ["host", 'let box = {first: {n: 1}}\nbox.first.n = hostValue\nsay "DONE"\nexit\n'],
    [
      "host-read",
      'let box = {first: {n: 1}}\nbox.first.n = hostValue\nrepeat box.first.n {}\nsay "DONE"\nexit\n',
    ],
    ["direct-bad", 'let box = {n: 1}\nbox.n = "bad"\nsay "DONE"\nexit\n'],
  ];
  return programs.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
